package analytics

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"crypto/tls"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net"
	"net/url"
	"sort"
	"strings"
	"time"

	clickhouseDriver "github.com/ClickHouse/clickhouse-go/v2"
	"github.com/ClickHouse/clickhouse-go/v2/lib/driver"
	"github.com/google/uuid"
	"github.com/weblens-project/weblens-crawler/internal/crawl"
	"github.com/weblens-project/weblens-crawler/internal/model"
	"github.com/weblens-project/weblens-crawler/migrations"
)

type Sink struct {
	connection driver.Conn
	database   string
}

type Options struct {
	Address  string
	Database string
	Username string
	Password string
	Secure   bool
}

func Open(ctx context.Context, options Options) (*Sink, error) {
	connection, err := openConnection(options, options.Database)
	if err != nil {
		return nil, err
	}
	if err := connection.Ping(ctx); err != nil {
		return nil, fmt.Errorf("ping ClickHouse: %w", err)
	}
	return &Sink{connection: connection, database: options.Database}, nil
}

func Migrate(ctx context.Context, options Options) error {
	connection, err := openConnection(options, "default")
	if err != nil {
		return err
	}
	if err := connection.Ping(ctx); err != nil {
		return fmt.Errorf("ping ClickHouse for migration: %w", err)
	}
	entries, err := fs.ReadDir(migrations.Files, "clickhouse")
	if err != nil {
		return fmt.Errorf("list ClickHouse migrations: %w", err)
	}
	sort.Slice(entries, func(i, j int) bool { return entries[i].Name() < entries[j].Name() })
	for _, entry := range entries {
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".sql") {
			continue
		}
		body, readErr := migrations.Files.ReadFile("clickhouse/" + entry.Name())
		if readErr != nil {
			return fmt.Errorf("read ClickHouse migration %s: %w", entry.Name(), readErr)
		}
		for _, statement := range splitStatements(string(body)) {
			if applyErr := connection.Exec(ctx, statement); applyErr != nil && !isObjectAlreadyExists(applyErr) {
				return fmt.Errorf("apply ClickHouse migration %s: %w", entry.Name(), applyErr)
			}
		}
	}
	return nil
}

func openConnection(options Options, database string) (driver.Conn, error) {
	if strings.TrimSpace(options.Address) == "" || strings.TrimSpace(database) == "" {
		return nil, errors.New("ClickHouse address and database are required")
	}
	connectionOptions := &clickhouseDriver.Options{
		Addr:        []string{options.Address},
		Auth:        clickhouseDriver.Auth{Database: database, Username: options.Username, Password: options.Password},
		DialTimeout: 5 * time.Second, MaxOpenConns: 10, MaxIdleConns: 5,
		ConnMaxLifetime: 30 * time.Minute,
		Compression:     &clickhouseDriver.Compression{Method: clickhouseDriver.CompressionLZ4},
	}
	if options.Secure {
		serverName, _, err := net.SplitHostPort(options.Address)
		if err != nil {
			return nil, fmt.Errorf("secure ClickHouse address must include a port: %w", err)
		}
		connectionOptions.TLS = &tls.Config{MinVersion: tls.VersionTLS12, ServerName: serverName}
	}
	return clickhouseDriver.Open(connectionOptions)
}

func splitStatements(script string) []string {
	var statements []string
	for _, candidate := range strings.Split(script, ";") {
		lines := strings.Split(candidate, "\n")
		kept := make([]string, 0, len(lines))
		for _, line := range lines {
			if !strings.HasPrefix(strings.TrimSpace(line), "--") {
				kept = append(kept, line)
			}
		}
		statement := strings.TrimSpace(strings.Join(kept, "\n"))
		if statement != "" {
			statements = append(statements, statement)
		}
	}
	return statements
}

func (s *Sink) Ping(ctx context.Context) error {
	return s.connection.Ping(ctx)
}

func (s *Sink) Close() error {
	return s.connection.Close()
}

func (s *Sink) Write(ctx context.Context, batch model.AnalyticsBatch) error {
	return s.WriteBatch(ctx, []model.AnalyticsBatch{batch})[batch.ID]
}

type preparedAnalytics struct {
	outbox  model.AnalyticsBatch
	payload model.AnalyticsPayload
}

func (s *Sink) WriteBatch(ctx context.Context, batches []model.AnalyticsBatch) map[uuid.UUID]error {
	return s.writeBatch(ctx, batches, nil)
}

type batchTiming struct {
	receiptChecks  int
	receiptLookup  time.Duration
	insertMetrics  time.Duration
	insertFindings time.Duration
	insertLinks    time.Duration
	insertReceipts time.Duration
}

func (s *Sink) writeBatch(ctx context.Context, batches []model.AnalyticsBatch, timing *batchTiming) map[uuid.UUID]error {
	results := make(map[uuid.UUID]error, len(batches))
	decoded := make([]preparedAnalytics, 0, len(batches))
	for _, batch := range batches {
		payload, err := decodeAnalyticsBatch(batch)
		if err != nil {
			results[batch.ID] = err
			continue
		}
		decoded = append(decoded, preparedAnalytics{outbox: batch, payload: payload})
	}
	if len(decoded) == 0 {
		return results
	}

	started := time.Now()
	receipts, err := s.receiptIDs(ctx, decoded)
	if timing != nil {
		timing.receiptChecks = len(decoded)
		timing.receiptLookup = time.Since(started)
	}
	if err != nil {
		return sharedFailure(results, decoded, err)
	}

	pending := make([]preparedAnalytics, 0, len(decoded))
	for _, item := range decoded {
		if _, exists := receipts[item.outbox.ID]; exists {
			results[item.outbox.ID] = nil
			continue
		}
		pending = append(pending, item)
	}
	if len(pending) == 0 {
		return results
	}

	started = time.Now()
	err = s.insertPageMetrics(ctx, pending)
	if timing != nil {
		timing.insertMetrics = time.Since(started)
	}
	if err != nil {
		return sharedFailure(results, pending, err)
	}
	started = time.Now()
	err = s.insertFindings(ctx, pending)
	if timing != nil {
		timing.insertFindings = time.Since(started)
	}
	if err != nil {
		return sharedFailure(results, pending, err)
	}
	started = time.Now()
	err = s.insertLinks(ctx, pending)
	if timing != nil {
		timing.insertLinks = time.Since(started)
	}
	if err != nil {
		return sharedFailure(results, pending, err)
	}
	started = time.Now()
	err = s.insertReceipts(ctx, pending)
	if timing != nil {
		timing.insertReceipts = time.Since(started)
	}
	if err != nil {
		return sharedFailure(results, pending, err)
	}
	for _, item := range pending {
		results[item.outbox.ID] = nil
	}
	return results
}

func decodeAnalyticsBatch(batch model.AnalyticsBatch) (model.AnalyticsPayload, error) {
	var payload model.AnalyticsPayload
	decoder := json.NewDecoder(bytes.NewReader(batch.Payload))
	decoder.DisallowUnknownFields()
	decoder.UseNumber()
	if err := decoder.Decode(&payload); err != nil {
		return model.AnalyticsPayload{}, fmt.Errorf("decode analytics payload: %w", err)
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		return model.AnalyticsPayload{}, errors.New("decode analytics payload: trailing JSON data")
	}
	if payload.OwnerID != batch.OwnerID || payload.PageID != batch.PageID || int64(payload.RecordVersion) != batch.ResultVersion {
		return model.AnalyticsPayload{}, errors.New("analytics payload identifiers do not match outbox metadata")
	}
	canonicalPayload, err := json.Marshal(payload)
	if err != nil {
		return model.AnalyticsPayload{}, fmt.Errorf("canonicalize analytics payload: %w", err)
	}
	if !equalHash(batch.PayloadSHA256, canonicalPayload) {
		return model.AnalyticsPayload{}, errors.New("analytics payload checksum mismatch")
	}
	return payload, nil
}

func (s *Sink) receiptIDs(ctx context.Context, items []preparedAnalytics) (map[uuid.UUID]struct{}, error) {
	keys := make([]clickhouseDriver.GroupSet, 0, len(items))
	for _, item := range items {
		keys = append(keys, clickhouseDriver.GroupSet{Value: []any{
			item.payload.OwnerID, item.payload.ScanID, item.outbox.ID,
		}})
	}
	rows, err := s.connection.Query(ctx, fmt.Sprintf(`
        SELECT batch_id
        FROM %s.ingestion_receipts FINAL
		WHERE (owner_id, aggregate_id, batch_id) IN (?)`, quoteIdentifier(s.database)), keys,
	)
	if err != nil {
		return nil, fmt.Errorf("read ClickHouse ingestion receipts: %w", err)
	}
	defer rows.Close()
	receipts := make(map[uuid.UUID]struct{}, len(items))
	for rows.Next() {
		var batchID uuid.UUID
		if err := rows.Scan(&batchID); err != nil {
			return nil, fmt.Errorf("scan ClickHouse ingestion receipt: %w", err)
		}
		receipts[batchID] = struct{}{}
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("read ClickHouse ingestion receipts: %w", err)
	}
	return receipts, nil
}

func sharedFailure(results map[uuid.UUID]error, pending []preparedAnalytics, err error) map[uuid.UUID]error {
	for _, item := range pending {
		results[item.outbox.ID] = err
	}
	return results
}

func (s *Sink) insertPageMetrics(ctx context.Context, items []preparedAnalytics) error {
	batch, err := s.connection.PrepareBatch(ctx, fmt.Sprintf(`INSERT INTO %s.page_metrics (
		owner_id, scan_id, retention_month, page_id, record_version, is_deleted, schema_version,
		requested_url, normalized_url, normalized_url_sha256, final_url, hostname, discovery_depth,
		fetch_outcome, error_code, error_message, status_code, content_type, content_encoding,
		redirect_count, redirect_urls, redirect_status_codes, response_bytes, decoded_body_bytes,
		dns_ms, dns_observed, connect_ms, connect_observed, tls_ms, tls_observed, ttfb_ms, ttfb_observed,
		total_ms, title, title_length, meta_description, meta_description_length, meta_keywords,
		canonical_url, canonical_relation, meta_robots, x_robots_tag, html_lang,
		h1, h2, h3, h4, h5, h6, hreflang_languages, hreflang_urls,
		open_graph_title, open_graph_description, open_graph_image_url,
		schema_org_types, schema_org_item_count, schema_org_valid_count, schema_org_error_count,
		schema_org_warning_count, schema_org_issue_codes, word_count, internal_link_count,
		external_link_count, image_count, image_missing_alt_count, script_count, stylesheet_count,
		is_indexable, indexability_reason, pagerank_score, collector_version, parser_version,
		observed_at, ingested_at
	)`, quoteIdentifier(s.database)))
	if err != nil {
		return fmt.Errorf("prepare ClickHouse page metric: %w", err)
	}
	for _, item := range items {
		payload, result := item.payload, item.payload.Result
		normalizedHash := crawl.URLHash(payload.NormalizedURL)
		hreflangLanguages := make([]string, 0, len(result.Hreflang))
		hreflangURLs := make([]string, 0, len(result.Hreflang))
		for _, entry := range result.Hreflang {
			hreflangLanguages = append(hreflangLanguages, entry.Language)
			hreflangURLs = append(hreflangURLs, entry.URL)
		}
		if err := batch.Append(
			payload.OwnerID, payload.ScanID, payload.RetentionMonth, payload.PageID,
			payload.RecordVersion, uint8(0), payload.SchemaVersion,
			payload.RequestedURL, payload.NormalizedURL, normalizedHash[:], result.FinalURL,
			payload.Hostname, payload.DiscoveryDepth, result.FetchOutcome, result.ErrorCode,
			result.ErrorMessage, uint16(max(result.StatusCode, 0)), result.ContentType, "",
			uint8(len(result.RedirectURLs)), result.RedirectURLs, result.RedirectCodes,
			result.ResponseBytes, result.ResponseBytes,
			result.DNSMillis, boolByte(result.DNSObserved), result.ConnectMillis, boolByte(result.ConnectObserved),
			result.TLSMillis, boolByte(result.TLSObserved), result.TTFBMillis, boolByte(result.TTFBObserved),
			result.TotalMillis,
			result.Title, uint16(min(len(result.Title), 65535)), result.Description,
			uint16(min(len(result.Description), 65535)), result.MetaKeywords,
			result.CanonicalURL, result.CanonicalRelation, result.MetaRobots, result.XRobotsTag,
			result.HTMLLang, result.H1, result.H2, result.H3, result.H4, result.H5, result.H6,
			hreflangLanguages, hreflangURLs, result.OpenGraphTitle, result.OpenGraphDescription,
			result.OpenGraphImageURL, result.SchemaOrgTypes, result.SchemaOrgItemCount,
			result.SchemaOrgValidCount, result.SchemaOrgErrorCount, result.SchemaOrgWarningCount,
			result.SchemaOrgIssueCodes, result.WordCount, result.InternalLinks,
			result.ExternalLinks, result.ImageCount, result.MissingAlt, result.ScriptCount,
			result.StylesheetCount, boolByte(result.IsIndexable), result.IndexabilityReason,
			float32(0), payload.CollectorVersion, payload.ParserVersion,
			result.ObservedAt, time.Now().UTC(),
		); err != nil {
			return fmt.Errorf("append ClickHouse page metric: %w", err)
		}
	}
	if err := batch.Send(); err != nil {
		return fmt.Errorf("send ClickHouse page metric: %w", err)
	}
	return nil
}

func (s *Sink) insertFindings(ctx context.Context, items []preparedAnalytics) error {
	total := 0
	for _, item := range items {
		total += len(item.payload.Result.Findings)
	}
	if total == 0 {
		return nil
	}
	batch, err := s.connection.PrepareBatch(ctx, fmt.Sprintf(`INSERT INTO %s.findings`, quoteIdentifier(s.database)))
	if err != nil {
		return fmt.Errorf("prepare ClickHouse findings: %w", err)
	}
	for _, item := range items {
		payload := item.payload
		for _, finding := range payload.Result.Findings {
			evidence, err := json.Marshal(finding.Evidence)
			if err != nil {
				return fmt.Errorf("marshal finding evidence: %w", err)
			}
			if err := batch.Append(
				payload.OwnerID, payload.ScanID, payload.RetentionMonth, payload.PageID,
				finding.FindingID, payload.RecordVersion, uint8(0), payload.SchemaVersion,
				finding.RuleID, finding.RuleVersion, finding.Category, finding.Severity,
				finding.Code, finding.Message, string(evidence), payload.Result.ObservedAt, time.Now().UTC(),
			); err != nil {
				return fmt.Errorf("append ClickHouse finding: %w", err)
			}
		}
	}
	if err := batch.Send(); err != nil {
		return fmt.Errorf("send ClickHouse findings: %w", err)
	}
	return nil
}

func (s *Sink) insertLinks(ctx context.Context, items []preparedAnalytics) error {
	total := 0
	for _, item := range items {
		total += len(item.payload.Result.Links)
	}
	if total == 0 {
		return nil
	}
	batch, err := s.connection.PrepareBatch(ctx, fmt.Sprintf(`INSERT INTO %s.page_links`, quoteIdentifier(s.database)))
	if err != nil {
		return fmt.Errorf("prepare ClickHouse page links: %w", err)
	}
	for _, item := range items {
		payload := item.payload
		for _, link := range payload.Result.Links {
			targetHash := crawl.URLHash(link.TargetURL)
			targetHost := ""
			if parsed, err := url.Parse(link.TargetURL); err == nil {
				targetHost = strings.ToLower(parsed.Hostname())
			}
			edgeID := uuid.NewSHA1(payload.PageID, []byte(fmt.Sprintf("%d:%s", link.Ordinal, link.TargetURL)))
			if err := batch.Append(
				payload.OwnerID, payload.ScanID, payload.RetentionMonth, payload.PageID,
				edgeID, payload.RecordVersion, uint8(0), payload.SchemaVersion,
				payload.NormalizedURL, link.TargetURL, targetHash[:], targetHost,
				link.AnchorText, link.Tag, link.RelValues, boolByte(link.IsInternal),
				boolByte(link.IsFollowable), link.Ordinal, payload.Result.ObservedAt, time.Now().UTC(),
			); err != nil {
				return fmt.Errorf("append ClickHouse page link: %w", err)
			}
		}
	}
	if err := batch.Send(); err != nil {
		return fmt.Errorf("send ClickHouse page links: %w", err)
	}
	return nil
}

func (s *Sink) insertReceipts(ctx context.Context, items []preparedAnalytics) error {
	batch, err := s.connection.PrepareBatch(ctx, fmt.Sprintf(`INSERT INTO %s.ingestion_receipts`, quoteIdentifier(s.database)))
	if err != nil {
		return fmt.Errorf("prepare ClickHouse receipt: %w", err)
	}
	for _, item := range items {
		if err := batch.Append(
			item.payload.OwnerID, item.payload.ScanID, item.outbox.ID, uint64(item.outbox.ResultVersion),
			item.outbox.PayloadSHA256, uint32(1), uint32(len(item.payload.Result.Findings)),
			uint32(len(item.payload.Result.Links)), item.payload.SchemaVersion, time.Now().UTC(),
		); err != nil {
			return fmt.Errorf("append ClickHouse receipt: %w", err)
		}
	}
	if err := batch.Send(); err != nil {
		return fmt.Errorf("send ClickHouse receipt: %w", err)
	}
	return nil
}

func equalHash(expected, payload []byte) bool {
	actual := sha256.Sum256(payload)
	return hmac.Equal(expected, actual[:])
}

func isObjectAlreadyExists(err error) bool {
	var exception *clickhouseDriver.Exception
	return errors.As(err, &exception) && exception.Code == 57
}

func quoteIdentifier(value string) string {
	return "`" + strings.ReplaceAll(value, "`", "``") + "`"
}

func boolByte(value bool) uint8 {
	if value {
		return 1
	}
	return 0
}

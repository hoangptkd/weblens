package analytics

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"strings"

	"github.com/google/uuid"
	"github.com/weblens-project/weblens-crawler/internal/model"
)

var ErrPageNotFound = errors.New("page report was not found")

func (s *Sink) ListPages(
	ctx context.Context,
	ownerID, scanID uuid.UUID,
	limit int,
	afterURL string,
	afterID uuid.UUID,
	filters model.PageFilters,
) ([]model.ReportPage, bool, error) {
	query := fmt.Sprintf(`
		SELECT %s
		FROM %s.page_metrics_current
		WHERE owner_id = ? AND scan_id = ?`, reportPageColumns, quoteIdentifier(s.database))
	arguments := []any{ownerID, scanID}
	if filters.IssuesOnly {
		query += fmt.Sprintf(` AND (
			lowerUTF8(fetch_outcome) NOT IN ('success', 'skipped') OR status_code >= 400
			OR page_id IN (
				SELECT page_id FROM %s.findings_current
				WHERE owner_id = ? AND scan_id = ?
					AND upperUTF8(severity) IN ('ERROR', 'CRITICAL', 'WARNING', 'WARN')
			)
		)`, quoteIdentifier(s.database))
		arguments = append(arguments, ownerID, scanID)
	}
	if len(filters.Outcomes) > 0 {
		conditions := make([]string, 0, len(filters.Outcomes))
		for _, outcome := range filters.Outcomes {
			switch outcome {
			case "SUCCESS":
				conditions = append(conditions, "(upperUTF8(fetch_outcome) = 'SUCCESS' AND status_code < 400)")
			case "WARNING":
				conditions = append(conditions, "upperUTF8(fetch_outcome) = 'SKIPPED'")
			case "FAILED":
				conditions = append(conditions, "(upperUTF8(fetch_outcome) != 'SKIPPED' AND (upperUTF8(fetch_outcome) != 'SUCCESS' OR status_code >= 400))")
			}
		}
		query += " AND (" + strings.Join(conditions, " OR ") + ")"
	}
	if filters.StatusMin != nil {
		query += " AND status_code >= ?"
		arguments = append(arguments, *filters.StatusMin)
	}
	if filters.StatusMax != nil {
		query += " AND status_code <= ?"
		arguments = append(arguments, *filters.StatusMax)
	}
	if filters.Query != "" {
		query += " AND positionCaseInsensitive(normalized_url, ?) > 0"
		arguments = append(arguments, filters.Query)
	}
	if filters.Indexable != nil {
		query += " AND is_indexable = ?"
		if *filters.Indexable {
			arguments = append(arguments, uint8(1))
		} else {
			arguments = append(arguments, uint8(0))
		}
	}
	if len(filters.ContentTypes) > 0 {
		query += " AND lowerUTF8(content_type) IN (" + placeholders(len(filters.ContentTypes)) + ")"
		for _, contentType := range filters.ContentTypes {
			arguments = append(arguments, contentType)
		}
	}
	if len(filters.Severities) > 0 || len(filters.FindingCodes) > 0 {
		query += fmt.Sprintf(` AND page_id IN (
			SELECT page_id FROM %s.findings_current
			WHERE owner_id = ? AND scan_id = ?`, quoteIdentifier(s.database))
		arguments = append(arguments, ownerID, scanID)
		if len(filters.Severities) > 0 {
			query += " AND upperUTF8(severity) IN (" + placeholders(len(filters.Severities)) + ")"
			for _, severity := range filters.Severities {
				arguments = append(arguments, severity)
			}
		}
		if len(filters.FindingCodes) > 0 {
			query += " AND upperUTF8(finding_code) IN (" + placeholders(len(filters.FindingCodes)) + ")"
			for _, code := range filters.FindingCodes {
				arguments = append(arguments, code)
			}
		}
		query += ")"
	}
	if afterURL != "" && afterID != uuid.Nil {
		query += " AND (normalized_url, page_id) > (?, ?)"
		arguments = append(arguments, afterURL, afterID)
	}
	query += " ORDER BY normalized_url, page_id LIMIT ?"
	arguments = append(arguments, limit+1)
	rows, err := s.connection.Query(ctx, query, arguments...)
	if err != nil {
		return nil, false, fmt.Errorf("query page report: %w", err)
	}
	defer rows.Close()
	pages := make([]model.ReportPage, 0)
	for rows.Next() {
		var page model.ReportPage
		var statusCode uint16
		var fetchOutcome string
		var linkCount uint64
		var hreflangLanguages, hreflangURLs []string
		var isIndexable, dnsObserved, connectObserved, tlsObserved, ttfbObserved uint8
		if err := rows.Scan(
			&page.ID, &page.ScanID, &page.URL, &page.FinalURL, &statusCode,
			&page.ContentType, &fetchOutcome, &page.ResponseTimeMS, &page.ResponseBytes,
			&page.DNSMillis, &dnsObserved, &page.ConnectMillis, &connectObserved,
			&page.TLSMillis, &tlsObserved, &page.TTFBMillis, &ttfbObserved,
			&page.Title, &page.Description, &page.MetaKeywords, &page.CanonicalURL,
			&page.CanonicalRelation, &page.MetaRobots, &page.XRobotsTag, &page.HTMLLang,
			&page.H1, &page.H2, &page.H3, &page.H4, &page.H5, &page.H6,
			&hreflangLanguages, &hreflangURLs, &page.OpenGraphTitle,
			&page.OpenGraphDescription, &page.OpenGraphImageURL, &page.SchemaOrgTypes,
			&page.SchemaOrgItemCount, &page.SchemaOrgValidCount, &page.SchemaOrgErrorCount,
			&page.SchemaOrgWarningCount, &page.SchemaOrgIssueCodes,
			&linkCount, &page.Images, &page.Scripts, &page.Stylesheets,
			&isIndexable, &page.IndexabilityReason, &page.ObservedAt,
		); err != nil {
			return nil, false, fmt.Errorf("scan page report: %w", err)
		}
		if linkCount > math.MaxUint32 {
			return nil, false, errors.New("scan page report: link count exceeds public contract")
		}
		if len(hreflangLanguages) != len(hreflangURLs) {
			return nil, false, errors.New("scan page report: hreflang arrays are inconsistent")
		}
		for index := range hreflangLanguages {
			page.Hreflang = append(page.Hreflang, model.Hreflang{Language: hreflangLanguages[index], URL: hreflangURLs[index]})
		}
		page.Links = uint32(linkCount)
		page.StatusCode = int(statusCode)
		page.Outcome = publicPageOutcome(fetchOutcome, statusCode)
		page.IsIndexable = isIndexable == 1
		page.DNSObserved, page.ConnectObserved = dnsObserved == 1, connectObserved == 1
		page.TLSObserved, page.TTFBObserved = tlsObserved == 1, ttfbObserved == 1
		page.Findings = make([]model.ReportFinding, 0)
		pages = append(pages, page)
	}
	if err := rows.Err(); err != nil {
		return nil, false, fmt.Errorf("iterate page report: %w", err)
	}
	hasMore := len(pages) > limit
	if hasMore {
		pages = pages[:limit]
	}
	pageIDs := make([]uuid.UUID, 0, len(pages))
	for _, page := range pages {
		pageIDs = append(pageIDs, page.ID)
	}
	findings, err := s.listFindingsForPages(ctx, ownerID, scanID, pageIDs)
	if err != nil {
		return nil, false, err
	}
	byPage := make(map[uuid.UUID][]model.ReportFinding)
	for _, finding := range findings {
		byPage[finding.pageID] = append(byPage[finding.pageID], finding.value)
	}
	for index := range pages {
		if pageFindings, ok := byPage[pages[index].ID]; ok {
			pages[index].Findings = pageFindings
		}
	}
	return pages, hasMore, nil
}

func (s *Sink) ScanSummary(
	ctx context.Context,
	ownerID, scanID uuid.UUID,
) (model.ScanReportSummary, error) {
	query := fmt.Sprintf(`
		SELECT
			count(),
			countIf(lowerUTF8(fetch_outcome) NOT IN ('success', 'skipped') OR status_code >= 400 OR issue_finding_count > 0),
			sum(finding_count),
			countIf(status_code >= 200 AND status_code < 300),
			countIf(status_code >= 300 AND status_code < 400),
			countIf(status_code >= 400 AND status_code < 500),
			countIf(status_code >= 500 AND status_code < 600),
			countIf(status_code < 200 OR status_code >= 600)
		FROM (
			SELECT
				page.status_code,
				page.fetch_outcome,
				ifNull(finding.finding_count, 0) AS finding_count,
				ifNull(finding.issue_finding_count, 0) AS issue_finding_count
			FROM %s.page_metrics_current AS page
			LEFT JOIN (
				SELECT owner_id, scan_id, page_id,
					count() AS finding_count,
					countIf(upperUTF8(severity) IN ('ERROR', 'CRITICAL', 'WARNING', 'WARN')) AS issue_finding_count
				FROM %s.findings_current
				WHERE owner_id = ? AND scan_id = ?
				GROUP BY owner_id, scan_id, page_id
			) AS finding
			ON page.owner_id = finding.owner_id
				AND page.scan_id = finding.scan_id
				AND page.page_id = finding.page_id
			WHERE page.owner_id = ? AND page.scan_id = ?
		)`, quoteIdentifier(s.database), quoteIdentifier(s.database))
	var summary model.ScanReportSummary
	err := s.connection.QueryRow(ctx, query, ownerID, scanID, ownerID, scanID).Scan(
		&summary.TotalURLCount,
		&summary.IssuePageCount,
		&summary.FindingCount,
		&summary.Status2xxCount,
		&summary.Status3xxCount,
		&summary.Status4xxCount,
		&summary.Status5xxCount,
		&summary.NoResponseCount,
	)
	if err != nil {
		return model.ScanReportSummary{}, fmt.Errorf("query scan report summary: %w", err)
	}
	return summary, nil
}

const reportPageColumns = `page_id, scan_id, normalized_url, final_url, status_code,
	content_type, fetch_outcome, total_ms, response_bytes,
	dns_ms, dns_observed, connect_ms, connect_observed, tls_ms, tls_observed, ttfb_ms, ttfb_observed,
	title, meta_description, meta_keywords, canonical_url, canonical_relation, meta_robots,
	x_robots_tag, html_lang, h1, h2, h3, h4, h5, h6, hreflang_languages, hreflang_urls,
	open_graph_title, open_graph_description, open_graph_image_url, schema_org_types,
	schema_org_item_count, schema_org_valid_count, schema_org_error_count, schema_org_warning_count,
	schema_org_issue_codes, internal_link_count + external_link_count, image_count, script_count,
	stylesheet_count, is_indexable, indexability_reason, observed_at`

func (s *Sink) GetPage(ctx context.Context, ownerID, pageID uuid.UUID) (model.ReportPage, error) {
	var page model.ReportPage
	var statusCode uint16
	var fetchOutcome string
	var linkCount uint64
	var hreflangLanguages, hreflangURLs []string
	var isIndexable, dnsObserved, connectObserved, tlsObserved, ttfbObserved uint8
	err := s.connection.QueryRow(ctx, fmt.Sprintf(`
		SELECT %s
		FROM %s.page_metrics_current
		WHERE owner_id = ? AND page_id = ?
		LIMIT 1`, reportPageColumns, quoteIdentifier(s.database)), ownerID, pageID).Scan(
		&page.ID, &page.ScanID, &page.URL, &page.FinalURL, &statusCode,
		&page.ContentType, &fetchOutcome, &page.ResponseTimeMS, &page.ResponseBytes,
		&page.DNSMillis, &dnsObserved, &page.ConnectMillis, &connectObserved,
		&page.TLSMillis, &tlsObserved, &page.TTFBMillis, &ttfbObserved,
		&page.Title, &page.Description, &page.MetaKeywords, &page.CanonicalURL,
		&page.CanonicalRelation, &page.MetaRobots, &page.XRobotsTag, &page.HTMLLang,
		&page.H1, &page.H2, &page.H3, &page.H4, &page.H5, &page.H6,
		&hreflangLanguages, &hreflangURLs, &page.OpenGraphTitle,
		&page.OpenGraphDescription, &page.OpenGraphImageURL, &page.SchemaOrgTypes,
		&page.SchemaOrgItemCount, &page.SchemaOrgValidCount, &page.SchemaOrgErrorCount,
		&page.SchemaOrgWarningCount, &page.SchemaOrgIssueCodes,
		&linkCount, &page.Images, &page.Scripts, &page.Stylesheets,
		&isIndexable, &page.IndexabilityReason, &page.ObservedAt,
	)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return model.ReportPage{}, ErrPageNotFound
		}
		return model.ReportPage{}, fmt.Errorf("query page detail: %w", err)
	}
	if linkCount > math.MaxUint32 {
		return model.ReportPage{}, errors.New("query page detail: link count exceeds public contract")
	}
	if len(hreflangLanguages) != len(hreflangURLs) {
		return model.ReportPage{}, errors.New("query page detail: hreflang arrays are inconsistent")
	}
	for index := range hreflangLanguages {
		page.Hreflang = append(page.Hreflang, model.Hreflang{Language: hreflangLanguages[index], URL: hreflangURLs[index]})
	}
	page.Links = uint32(linkCount)
	page.StatusCode = int(statusCode)
	page.Outcome = publicPageOutcome(fetchOutcome, statusCode)
	page.IsIndexable = isIndexable == 1
	page.DNSObserved, page.ConnectObserved = dnsObserved == 1, connectObserved == 1
	page.TLSObserved, page.TTFBObserved = tlsObserved == 1, ttfbObserved == 1
	page.Findings = make([]model.ReportFinding, 0)
	findings, err := s.listFindings(ctx, ownerID, page.ScanID, pageID)
	if err != nil {
		return model.ReportPage{}, err
	}
	for _, finding := range findings {
		page.Findings = append(page.Findings, finding.value)
	}
	return page, nil
}

func (s *Sink) listFindingsForPages(
	ctx context.Context,
	ownerID, scanID uuid.UUID,
	pageIDs []uuid.UUID,
) ([]pageFinding, error) {
	if len(pageIDs) == 0 {
		return []pageFinding{}, nil
	}
	query := fmt.Sprintf(`
		SELECT page_id, finding_id, severity, finding_code, message, evidence_json
		FROM %s.findings_current
		WHERE owner_id = ? AND scan_id = ? AND page_id IN (%s)
		ORDER BY page_id, severity, rule_id, finding_id`, quoteIdentifier(s.database), placeholders(len(pageIDs)))
	arguments := make([]any, 0, 2+len(pageIDs))
	arguments = append(arguments, ownerID, scanID)
	for _, pageID := range pageIDs {
		arguments = append(arguments, pageID)
	}
	return s.queryFindings(ctx, query, arguments...)
}

type pageFinding struct {
	pageID uuid.UUID
	value  model.ReportFinding
}

func (s *Sink) listFindings(ctx context.Context, ownerID, scanID, pageID uuid.UUID) ([]pageFinding, error) {
	query := fmt.Sprintf(`
		SELECT page_id, finding_id, severity, finding_code, message, evidence_json
		FROM %s.findings_current
		WHERE owner_id = ? AND scan_id = ?`, quoteIdentifier(s.database))
	arguments := []any{ownerID, scanID}
	if pageID != uuid.Nil {
		query += " AND page_id = ?"
		arguments = append(arguments, pageID)
	}
	query += " ORDER BY page_id, severity, rule_id, finding_id LIMIT 5000"
	return s.queryFindings(ctx, query, arguments...)
}

func (s *Sink) queryFindings(ctx context.Context, query string, arguments ...any) ([]pageFinding, error) {
	rows, err := s.connection.Query(ctx, query, arguments...)
	if err != nil {
		return nil, fmt.Errorf("query findings report: %w", err)
	}
	defer rows.Close()
	findings := make([]pageFinding, 0)
	for rows.Next() {
		var finding pageFinding
		var evidenceJSON string
		if err := rows.Scan(
			&finding.pageID, &finding.value.ID, &finding.value.Severity,
			&finding.value.Title, &finding.value.Description, &evidenceJSON,
		); err != nil {
			return nil, fmt.Errorf("scan finding report: %w", err)
		}
		finding.value.Evidence = make(map[string]any)
		if err := json.Unmarshal([]byte(evidenceJSON), &finding.value.Evidence); err != nil {
			return nil, fmt.Errorf("decode finding evidence: %w", err)
		}
		findings = append(findings, finding)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate findings report: %w", err)
	}
	return findings, nil
}

func placeholders(count int) string {
	return strings.TrimSuffix(strings.Repeat("?,", count), ",")
}

func publicPageOutcome(fetchOutcome string, statusCode uint16) string {
	if strings.EqualFold(fetchOutcome, "SUCCESS") && statusCode < 400 {
		return "SUCCESS"
	}
	if strings.EqualFold(fetchOutcome, "SKIPPED") {
		return "WARNING"
	}
	return "FAILED"
}

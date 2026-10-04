package analytics

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"strings"
	"testing"
	"time"

	clickhouseDriver "github.com/ClickHouse/clickhouse-go/v2"
	"github.com/ClickHouse/clickhouse-go/v2/lib/driver"
	"github.com/google/uuid"
	"github.com/weblens-project/weblens-crawler/internal/model"
)

func TestSecureConnectionRequiresHostAndPort(t *testing.T) {
	_, err := openConnection(Options{Address: "clickhouse.example", Database: "analytics", Secure: true}, "analytics", 7)
	if err == nil {
		t.Fatal("secure address without a port was accepted")
	}
}

type reportConnectionStub struct {
	driver.Conn
	queries, closed int
	rowsClosed      bool
	failure         error
}

func (c *reportConnectionStub) Query(_ context.Context, query string, _ ...any) (driver.Rows, error) {
	c.queries++
	return &reportRowsStub{connection: c, remaining: strings.Contains(query, "page_metrics_current")}, nil
}

func (c *reportConnectionStub) QueryRow(context.Context, string, ...any) driver.Row {
	c.queries++
	return &reportRowStub{failure: c.failure}
}

func (c *reportConnectionStub) Stats() driver.Stats { return driver.Stats{MaxOpenConns: 7} }
func (c *reportConnectionStub) Close() error        { c.closed++; return c.failure }

type reportRowsStub struct {
	driver.Rows
	connection *reportConnectionStub
	remaining  bool
}

func (r *reportRowsStub) Next() bool           { result := r.remaining; r.remaining = false; return result }
func (*reportRowsStub) Scan(dest ...any) error { *dest[0].(*uuid.UUID) = uuid.New(); return nil }
func (r *reportRowsStub) Close() error         { r.connection.rowsClosed = true; return nil }
func (r *reportRowsStub) Err() error           { return r.connection.failure }

type reportRowStub struct {
	driver.Row
	failure error
}

func (r *reportRowStub) Scan(...any) error { return r.failure }

func TestReportsUseReadPoolAndReleaseRowsOnFailure(t *testing.T) {
	for _, failure := range []error{nil, context.DeadlineExceeded} {
		read, write := &reportConnectionStub{failure: failure}, &reportConnectionStub{}
		sink := &Sink{connection: write, readConnection: read, readSlots: make(chan struct{}, 1), database: "analytics", logger: slog.New(slog.NewTextHandler(io.Discard, nil))}
		_, _, pageErr := sink.ListPages(context.Background(), uuid.New(), uuid.New(), 10, "", uuid.Nil, model.PageFilters{})
		_, summaryErr := sink.ScanSummary(context.Background(), uuid.New(), uuid.New())
		_, detailErr := sink.GetPage(context.Background(), uuid.New(), uuid.New())
		if read.queries < 3 || write.queries != 0 || !read.rowsClosed {
			t.Fatalf("report used write pool or leaked rows: read=%d write=%d closed=%v", read.queries, write.queries, read.rowsClosed)
		}
		if failure != nil && (!errors.Is(pageErr, failure) || !errors.Is(summaryErr, failure) || !errors.Is(detailErr, failure)) {
			t.Fatal("report hid a ClickHouse failure")
		}
		if err := sink.Close(); !errors.Is(err, failure) || read.closed != 1 || write.closed != 1 {
			t.Fatalf("pool close did not release both pools: err=%v read=%d write=%d", err, read.closed, write.closed)
		}
	}
}

func TestReportAdmissionDeadlineDoesNotCallClickHouse(t *testing.T) {
	read := &reportConnectionStub{}
	sink := &Sink{readConnection: read, readSlots: make(chan struct{}, 1), logger: slog.New(slog.NewTextHandler(io.Discard, nil))}
	sink.readSlots <- struct{}{}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
	defer cancel()
	_, err := sink.ScanSummary(ctx, uuid.New(), uuid.New())
	if !errors.Is(err, context.DeadlineExceeded) || read.queries != 0 || len(sink.readSlots) != 1 {
		t.Fatalf("admission deadline called ClickHouse or lost another caller's slot: err=%v queries=%d slots=%d", err, read.queries, len(sink.readSlots))
	}
}

func TestDecodeAnalyticsBatchAcceptsJSONBNormalizedPayload(t *testing.T) {
	batch := analyticsBatchFixture(t)
	var normalized map[string]any
	decoder := json.NewDecoder(bytes.NewReader(batch.Payload))
	decoder.UseNumber()
	if err := decoder.Decode(&normalized); err != nil {
		t.Fatalf("decode analytics fixture: %v", err)
	}
	normalizedPayload, err := json.MarshalIndent(normalized, "", "  ")
	if err != nil {
		t.Fatalf("normalize analytics fixture: %v", err)
	}
	batch.Payload = normalizedPayload

	payload, err := decodeAnalyticsBatch(batch)

	if err != nil {
		t.Fatalf("decode JSONB-normalized payload: %v", err)
	}
	if payload.PageID != batch.PageID {
		t.Fatalf("expected page %s, got %s", batch.PageID, payload.PageID)
	}
}

func TestDecodeAnalyticsBatchRejectsSemanticPayloadChange(t *testing.T) {
	batch := analyticsBatchFixture(t)
	var tampered map[string]any
	if err := json.Unmarshal(batch.Payload, &tampered); err != nil {
		t.Fatalf("decode analytics fixture: %v", err)
	}
	tampered["hostname"] = "tampered.example"
	tamperedPayload, err := json.Marshal(tampered)
	if err != nil {
		t.Fatalf("encode tampered analytics fixture: %v", err)
	}
	batch.Payload = tamperedPayload

	_, err = decodeAnalyticsBatch(batch)

	if err == nil || err.Error() != "analytics payload checksum mismatch" {
		t.Fatalf("expected checksum mismatch, got %v", err)
	}
}

func TestObjectAlreadyExistsOnlyAcceptsClickHouseCode57(t *testing.T) {
	if !isObjectAlreadyExists(&clickhouseDriver.Exception{Code: 57}) {
		t.Fatal("expected ClickHouse code 57 to be accepted")
	}
	if isObjectAlreadyExists(&clickhouseDriver.Exception{Code: 60}) {
		t.Fatal("did not expect ClickHouse code 60 to be accepted")
	}
	if isObjectAlreadyExists(errors.New("table already exists")) {
		t.Fatal("did not expect an untyped error to be accepted")
	}
}

func analyticsBatchFixture(t *testing.T) model.AnalyticsBatch {
	t.Helper()
	ownerID, scanID, pageID := uuid.New(), uuid.New(), uuid.New()
	now := time.Date(2026, time.September, 12, 8, 30, 0, 0, time.UTC)
	payload := model.AnalyticsPayload{
		SchemaVersion: 1,
		OwnerID:       ownerID,
		ScanID:        scanID,
		RetentionMonth: time.Date(
			now.Year(), now.Month(), 1, 0, 0, 0, 0, time.UTC,
		),
		PageID:           pageID,
		RecordVersion:    1,
		RequestedURL:     "https://example.com/",
		NormalizedURL:    "https://example.com/",
		FinalURL:         "https://example.com/",
		Hostname:         "example.com",
		CollectorVersion: "test-collector-v1",
		ParserVersion:    "test-parser-v1",
		Result: model.PageResult{
			FinalURL:     "https://example.com/",
			FetchOutcome: "SUCCESS",
			StatusCode:   200,
			ContentType:  "text/html",
			ObservedAt:   now,
			Findings: []model.Finding{{
				FindingID: uuid.New(), RuleID: "numeric-evidence", RuleVersion: 1,
				Category: "CONTENT", Severity: "INFO", Code: "NUMERIC_EVIDENCE",
				Message: "Preserve an exact integer.", Evidence: map[string]any{"exact": int64(9_007_199_254_740_993)},
			}},
		},
	}
	encoded, err := json.Marshal(payload)
	if err != nil {
		t.Fatalf("encode analytics fixture: %v", err)
	}
	checksum := sha256.Sum256(encoded)
	return model.AnalyticsBatch{
		ID:            uuid.New(),
		OwnerID:       ownerID,
		PageID:        pageID,
		ResultVersion: 1,
		Payload:       encoded,
		PayloadSHA256: checksum[:],
	}
}

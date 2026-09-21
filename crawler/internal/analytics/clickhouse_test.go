package analytics

import (
	"bytes"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"testing"
	"time"

	clickhouseDriver "github.com/ClickHouse/clickhouse-go/v2"
	"github.com/google/uuid"
	"github.com/weblens-project/weblens-crawler/internal/model"
)

func TestSecureConnectionRequiresHostAndPort(t *testing.T) {
	_, err := openConnection(Options{Address: "clickhouse.example", Database: "analytics", Secure: true}, "analytics")
	if err == nil {
		t.Fatal("secure address without a port was accepted")
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

package httpapi

import (
	"context"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"

	"github.com/google/uuid"
	"github.com/weblens-project/weblens-crawler/internal/contracts"
	"github.com/weblens-project/weblens-crawler/internal/model"
)

const testServiceToken = "test-service-token-that-is-at-least-32-bytes"

type fakeCommandStore struct {
	called bool
}

func (store *fakeCommandStore) AcceptCommand(_ context.Context, _ contracts.ScanCommandEnvelope) (bool, error) {
	store.called = true
	return false, nil
}

func (store *fakeCommandStore) AcceptCancellation(_ context.Context, _ contracts.ScanCancelCommandEnvelope) (bool, error) {
	store.called = true
	return false, nil
}

func (*fakeCommandStore) Ping(context.Context) error { return nil }

func (*fakeCommandStore) GetReportState(_ context.Context, ownerID, scanID uuid.UUID) (model.ReportState, error) {
	return model.ReportState{OwnerID: ownerID, ScanID: scanID}, nil
}

func (*fakeCommandStore) ListPages(context.Context, uuid.UUID, uuid.UUID, int, string, uuid.UUID, model.PageFilters) ([]model.ReportPage, bool, error) {
	return []model.ReportPage{}, false, nil
}

func (*fakeCommandStore) ScanSummary(context.Context, uuid.UUID, uuid.UUID) (model.ScanReportSummary, error) {
	return model.ScanReportSummary{}, nil
}

func (*fakeCommandStore) GetPage(context.Context, uuid.UUID, uuid.UUID) (model.ReportPage, error) {
	return model.ReportPage{}, nil
}

func TestCommandEndpointRequiresServiceToken(t *testing.T) {
	t.Parallel()
	store := &fakeCommandStore{}
	server := NewServer(store, store, testServiceToken, testLogger())
	request := httptest.NewRequest(http.MethodPost, "/internal/v1/commands/scans", strings.NewReader("{}"))
	response := httptest.NewRecorder()
	server.Handler().ServeHTTP(response, request)
	if response.Code != http.StatusUnauthorized || store.called {
		t.Fatalf("unexpected response: status=%d called=%v", response.Code, store.called)
	}
	if response.Header().Get("Content-Type") != "application/problem+json" || response.Header().Get("X-Correlation-ID") == "" {
		t.Fatalf("problem response is missing standard headers: %v", response.Header())
	}
}

func TestCommandEndpointRejectsWrongServiceToken(t *testing.T) {
	t.Parallel()
	store := &fakeCommandStore{}
	server := NewServer(store, store, testServiceToken, testLogger())
	request := httptest.NewRequest(http.MethodPost, "/internal/v1/commands/scans", strings.NewReader("{}"))
	request.Header.Set("X-WebLens-Service-Token", "a-different-service-token-at-least-32-bytes")
	response := httptest.NewRecorder()
	server.Handler().ServeHTTP(response, request)
	if response.Code != http.StatusUnauthorized || store.called {
		t.Fatalf("unexpected response: status=%d called=%v", response.Code, store.called)
	}
}

func TestCommandEndpointRejectsBodyLargerThan64KiB(t *testing.T) {
	t.Parallel()
	store := &fakeCommandStore{}
	server := NewServer(store, store, testServiceToken, testLogger())
	request := httptest.NewRequest(
		http.MethodPost,
		"/internal/v1/commands/scans",
		strings.NewReader(strings.Repeat("x", maxCommandBody+1)),
	)
	request.Header.Set("X-WebLens-Service-Token", testServiceToken)
	response := httptest.NewRecorder()

	server.Handler().ServeHTTP(response, request)

	if response.Code != http.StatusRequestEntityTooLarge || store.called {
		t.Fatalf("unexpected response: status=%d called=%v", response.Code, store.called)
	}
}

func TestPageFiltersAreNormalizedAndValidated(t *testing.T) {
	t.Parallel()
	request := httptest.NewRequest(http.MethodGet,
		"/internal/v1/reports/scans/id/pages?outcome=failed&outcome=SUCCESS&statusMin=400&statusMax=599&q=docs&indexable=false&contentType=Text%2FHTML&severity=warning&findingCode=title.missing",
		nil,
	)
	filters, err := pageFiltersQuery(request)
	if err != nil {
		t.Fatal(err)
	}
	if len(filters.Outcomes) != 2 || filters.Outcomes[0] != "FAILED" || filters.Outcomes[1] != "SUCCESS" {
		t.Fatalf("unexpected outcomes: %#v", filters.Outcomes)
	}
	if filters.StatusMin == nil || *filters.StatusMin != 400 || filters.StatusMax == nil || *filters.StatusMax != 599 {
		t.Fatalf("unexpected status range: %#v", filters)
	}
	if filters.Indexable == nil || *filters.Indexable || filters.ContentTypes[0] != "text/html" {
		t.Fatalf("unexpected normalized filters: %#v", filters)
	}
}

func TestPageCursorIsBoundToFilters(t *testing.T) {
	t.Parallel()
	store := &fakeCommandStore{}
	server := NewServer(store, store, testServiceToken, testLogger())
	cursor := encodePageCursor(pageCursor{URL: "https://example.com/", ID: uuid.New(), Filter: "another-filter"})
	request := httptest.NewRequest(http.MethodGet,
		"/internal/v1/reports/scans/"+uuid.NewString()+"/pages?ownerId="+uuid.NewString()+"&issuesOnly=true&cursor="+url.QueryEscape(cursor),
		nil,
	)
	request.Header.Set("X-WebLens-Service-Token", testServiceToken)
	response := httptest.NewRecorder()

	server.Handler().ServeHTTP(response, request)

	if response.Code != http.StatusBadRequest {
		t.Fatalf("expected filter-bound cursor rejection, got %d", response.Code)
	}
}

func testLogger() *slog.Logger {
	return slog.New(slog.NewTextHandler(io.Discard, nil))
}

package crawl

import (
	"context"
	"io"
	"log/slog"
	"sync/atomic"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/weblens-project/weblens-crawler/internal/model"
)

type idlePageStore struct {
	claimCount atomic.Int32
}

func (s *idlePageStore) ClaimPage(context.Context, uuid.UUID, time.Duration, time.Duration) (*model.PageLease, error) {
	s.claimCount.Add(1)
	return nil, nil
}

func (*idlePageStore) ExtendPageLease(context.Context, model.PageLease, time.Duration) error {
	return nil
}

func (*idlePageStore) CommitPageResult(context.Context, model.PageLease, model.PageResult) error {
	return nil
}

func (*idlePageStore) ReclaimExpired(context.Context) error {
	return nil
}

func (*idlePageStore) AnalyticsBackpressured(context.Context, time.Duration) (bool, error) {
	return false, nil
}

func TestHighWorkerLimitDoesNotMultiplyIdleDatabasePolling(t *testing.T) {
	store := &idlePageStore{}
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	engine := NewEngine(store, nil, 10_000, 20*time.Millisecond, 30*time.Second, time.Second, 15*time.Minute, logger)
	ctx, cancel := context.WithTimeout(context.Background(), 110*time.Millisecond)
	defer cancel()

	engine.Run(ctx)

	claims := store.claimCount.Load()
	if claims < 2 || claims > 10 {
		t.Fatalf("idle dispatcher made %d claims; expected polling independent from 10000 worker slots", claims)
	}
}

func TestBuildResultDoesNotAddContentFindingsToHTTPErrorPage(t *testing.T) {
	pageID := uuid.New()
	result := buildResult(model.PageLease{PageID: pageID}, FetchResult{
		FinalURL: "https://example.com/missing", StatusCode: 404, ContentType: "text/html",
		Body: []byte("<html><body><img src='missing.png'></body></html>"),
	})
	if result.FetchOutcome != "HTTP_ERROR" || len(result.Findings) != 1 || result.Findings[0].Code != "HTTP_ERROR" {
		t.Fatalf("unexpected HTTP error findings: outcome=%s findings=%#v", result.FetchOutcome, result.Findings)
	}
}

func TestBuildResultClassifiesSafetyBoundaryAsSkippedInformation(t *testing.T) {
	result := buildResult(model.PageLease{PageID: uuid.New()}, FetchResult{ErrorCode: "ssrf_blocked"})
	if result.FetchOutcome != "SKIPPED" || len(result.Findings) != 1 ||
		result.Findings[0].Code != "FETCH_BLOCKED_BY_POLICY" || result.Findings[0].Severity != "INFO" {
		t.Fatalf("unexpected policy-block result: %#v", result)
	}
}

func TestBuildResultVersionsStaticHTMLFindingsAndKeepsBoundedEvidence(t *testing.T) {
	result := buildResult(model.PageLease{PageID: uuid.New()}, FetchResult{
		FinalURL: "https://example.com/", StatusCode: 200, ContentType: "text/html",
		Body: []byte("<html><body><img src='missing.png'></body></html>"),
	})
	if len(result.Findings) != 4 {
		t.Fatalf("expected four static HTML findings, got %#v", result.Findings)
	}
	for _, finding := range result.Findings {
		if finding.RuleVersion != 2 || finding.Evidence["source"] != "static_html" {
			t.Fatalf("unexpected finding version or evidence: %#v", finding)
		}
	}
}

func TestBuildResultAddsOnlyEvidenceBackedSEOWarnings(t *testing.T) {
	result := buildResult(model.PageLease{PageID: uuid.New()}, FetchResult{
		FinalURL: "https://example.com/", StatusCode: 200, ContentType: "text/html",
		Body: []byte(`<html><head><title>Example</title><meta name="robots" content="noindex">
			<link rel="canonical" href="/one"><link rel="canonical" href="mailto:bad@example.com">
			<link rel="alternate" hreflang="" href="/bad">
			<script type="application/ld+json">{invalid}</script>
		</head><body><h1>Example</h1></body></html>`),
	})
	codes := make(map[string]bool)
	for _, finding := range result.Findings {
		codes[finding.Code] = true
	}
	for _, code := range []string{"CANONICAL_INVALID", "CANONICAL_MULTIPLE", "CANONICAL_NOINDEX_CONFLICT", "HREFLANG_INVALID", "STRUCTURED_DATA_INVALID"} {
		if !codes[code] {
			t.Fatalf("expected %s in findings: %#v", code, result.Findings)
		}
	}
}

func TestBuildResultReportsTerminalRedirectAndRedirectChain(t *testing.T) {
	result := buildResult(model.PageLease{PageID: uuid.New()}, FetchResult{
		FinalURL: "https://example.com/final", StatusCode: 302, ContentType: "text/plain",
		Redirects: []RedirectHop{{URL: "https://example.com/one", StatusCode: 301}, {URL: "https://example.com/two", StatusCode: 302}},
	})
	codes := make(map[string]bool)
	for _, finding := range result.Findings {
		codes[finding.Code] = true
	}
	if !codes["HTTP_REDIRECT_RESPONSE"] || !codes["REDIRECT_CHAIN"] {
		t.Fatalf("unexpected redirect findings: %#v", result.Findings)
	}
}

package crawl

import (
	"context"
	"errors"
	"log/slog"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/google/uuid"
	"github.com/weblens-project/weblens-crawler/internal/model"
)

type pageStore interface {
	ClaimPage(context.Context, uuid.UUID, time.Duration, time.Duration) (*model.PageLease, error)
	ExtendPageLease(context.Context, model.PageLease, time.Duration) error
	CommitPageResult(context.Context, model.PageLease, model.PageResult) error
	ReclaimExpired(context.Context) error
	AnalyticsBackpressured(context.Context, time.Duration) (bool, error)
}

type Engine struct {
	store         pageStore
	fetcher       *Fetcher
	robots        *RobotsCache
	workers       int
	pollInterval  time.Duration
	leaseDuration time.Duration
	hostDelay     time.Duration
	backlogAge    time.Duration
	backpressured atomic.Bool
	logger        *slog.Logger
}

func NewEngine(
	store pageStore,
	fetcher *Fetcher,
	workers int,
	pollInterval, leaseDuration, hostDelay, backlogAge time.Duration,
	logger *slog.Logger,
) *Engine {
	return &Engine{
		store: store, fetcher: fetcher, robots: NewRobotsCache(fetcher, "WebLensCrawler"),
		workers: workers, pollInterval: pollInterval, leaseDuration: leaseDuration,
		hostDelay: hostDelay, backlogAge: backlogAge, logger: logger,
	}
}

func (e *Engine) Run(ctx context.Context) {
	e.refreshBackpressure(ctx)
	var components sync.WaitGroup
	components.Add(1)
	go func() {
		defer components.Done()
		e.runReclaimer(ctx)
	}()
	e.runDispatcher(ctx)
	components.Wait()
}

func (e *Engine) runDispatcher(ctx context.Context) {
	// workers là trần số page fetch đồng thời, không phải số vòng polling.
	// Một dispatcher claim tuần tự để 10.000 slot không tạo connection storm khi
	// frontier đang rỗng; slot chỉ giữ chỗ trong lúc page thật sự được xử lý.
	slots := make(chan struct{}, e.workers)
	var active sync.WaitGroup
	defer active.Wait()

	for {
		if e.backpressured.Load() {
			if !waitForContext(ctx, e.pollInterval) {
				return
			}
			continue
		}

		select {
		case slots <- struct{}{}:
		case <-ctx.Done():
			return
		}

		lease, err := e.store.ClaimPage(ctx, uuid.New(), e.leaseDuration, e.hostDelay)
		if err != nil {
			<-slots
			if ctx.Err() != nil {
				return
			}
			e.logger.Error("claim page failed", "error", err)
			if !waitForContext(ctx, e.pollInterval) {
				return
			}
			continue
		}
		if lease == nil {
			<-slots
			if !waitForContext(ctx, e.pollInterval) {
				return
			}
			continue
		}

		active.Add(1)
		go func(pageLease model.PageLease) {
			defer active.Done()
			defer func() { <-slots }()
			e.process(ctx, pageLease)
		}(*lease)
	}
}

func waitForContext(ctx context.Context, duration time.Duration) bool {
	timer := time.NewTimer(duration)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return false
	case <-timer.C:
		return true
	}
}

func (e *Engine) process(parent context.Context, lease model.PageLease) {
	deadline := lease.AcceptedAt.Add(lease.MaxDuration)
	ctx, cancel := context.WithDeadline(parent, deadline)
	defer cancel()
	heartbeatDone := make(chan struct{})
	go func() {
		defer close(heartbeatDone)
		interval := max(e.leaseDuration/3, time.Second)
		ticker := time.NewTicker(interval)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				if err := e.store.ExtendPageLease(ctx, lease, e.leaseDuration); err != nil {
					e.logger.Warn("page lease heartbeat failed", "scanId", lease.ScanID, "pageId", lease.PageID, "error", err)
					cancel()
					return
				}
			}
		}
	}()
	result := model.PageResult{FinalURL: lease.NormalizedURL, ObservedAt: time.Now().UTC()}
	if !e.robots.Allowed(ctx, lease.NormalizedURL, lease.Hostname, lease.MaxRedirects) {
		result.FetchOutcome = "SKIPPED"
		result.ErrorCode = "ROBOTS_DISALLOWED"
		result.ErrorMessage = "The target robots policy disallows this page."
	} else {
		fetched := e.fetcher.Fetch(ctx, lease.NormalizedURL, lease.Hostname, lease.MaxResponseBytes, lease.MaxRedirects)
		result = buildResult(lease, fetched)
	}
	cancel()
	<-heartbeatDone
	if err := e.store.CommitPageResult(parent, lease, result); err != nil && !errors.Is(err, model.ErrStaleLease) {
		e.logger.Error("commit page result failed", "scanId", lease.ScanID, "pageId", lease.PageID, "error", err)
	}
}

func buildResult(lease model.PageLease, fetched FetchResult) model.PageResult {
	result := model.PageResult{
		FinalURL: fetched.FinalURL, ErrorCode: fetched.ErrorCode,
		ErrorMessage: fetched.ErrorMessage, StatusCode: fetched.StatusCode,
		ContentType: fetched.ContentType, XRobotsTag: fetched.XRobotsTag,
		ResponseBytes: uint64(max(fetched.BodyBytes, 0)),
		DNSMillis:     durationMillis(fetched.DNSDuration), ConnectMillis: durationMillis(fetched.ConnectDuration),
		TLSMillis: durationMillis(fetched.TLSDuration), TTFBMillis: durationMillis(fetched.TTFBDuration),
		DNSObserved: fetched.DNSObserved, ConnectObserved: fetched.ConnectObserved,
		TLSObserved: fetched.TLSObserved, TTFBObserved: fetched.TTFBObserved,
		TotalMillis: durationMillis(fetched.TotalDuration),
		ObservedAt:  time.Now().UTC(),
	}
	if result.FinalURL == "" {
		result.FinalURL = lease.NormalizedURL
	}
	for _, redirect := range fetched.Redirects {
		result.RedirectURLs = append(result.RedirectURLs, redirect.URL)
		result.RedirectCodes = append(result.RedirectCodes, uint16(max(redirect.StatusCode, 0)))
	}
	if fetched.ErrorCode != "" {
		if isCrawlPolicyBlock(fetched.ErrorCode) {
			result.FetchOutcome = "SKIPPED"
			result.Findings = append(result.Findings, finding(lease.PageID, "fetch.policy-blocked", 1, "TECHNICAL", "INFO", "FETCH_BLOCKED_BY_POLICY", "Page was not fetched because it was outside the configured crawl safety boundary.", map[string]any{"errorCode": fetched.ErrorCode}))
		} else {
			result.FetchOutcome = "FAILED"
			result.Findings = append(result.Findings, finding(lease.PageID, "fetch.failed", 1, "TECHNICAL", "ERROR", "FETCH_FAILED", "Page fetch failed.", map[string]any{"errorCode": fetched.ErrorCode}))
		}
		return result
	}
	if fetched.StatusCode >= 400 {
		result.FetchOutcome = "HTTP_ERROR"
		result.Findings = append(result.Findings, finding(lease.PageID, "http.error", 1, "TECHNICAL", "ERROR", "HTTP_ERROR", "Page returned an HTTP error status.", map[string]any{"statusCode": fetched.StatusCode}))
	} else {
		result.FetchOutcome = "SUCCESS"
	}
	if fetched.StatusCode >= 300 && fetched.StatusCode < 400 {
		result.Findings = append(result.Findings, finding(lease.PageID, "http.redirect-response", 1, "TECHNICAL", "WARNING", "HTTP_REDIRECT_RESPONSE", "The final response is still a redirect rather than a content response.", map[string]any{"statusCode": fetched.StatusCode}))
	}
	if len(fetched.Redirects) > 1 {
		result.Findings = append(result.Findings, finding(lease.PageID, "redirect.chain", 1, "SEO", "WARNING", "REDIRECT_CHAIN", "The request followed more than one redirect before reaching the final response.", map[string]any{"redirectCount": len(fetched.Redirects)}))
	}
	if !IsHTMLContentType(fetched.ContentType) {
		return result
	}
	data, err := ParseHTML(fetched.Body, result.FinalURL, lease.Hostname)
	if err != nil {
		result.FetchOutcome = "FAILED"
		result.ErrorCode = "HTML_PARSE_FAILED"
		result.ErrorMessage = "HTML could not be parsed."
		return result
	}
	result.Title, result.Description, result.MetaKeywords = data.Title, data.MetaDescription, data.MetaKeywords
	result.CanonicalURL, result.CanonicalRelation = data.CanonicalURL, data.CanonicalRelation
	result.MetaRobots, result.HTMLLang = data.MetaRobots, data.HTMLLang
	result.H1, result.H2, result.H3 = data.H1, data.H2, data.H3
	result.H4, result.H5, result.H6 = data.H4, data.H5, data.H6
	for _, entry := range data.Hreflang {
		result.Hreflang = append(result.Hreflang, model.Hreflang{Language: entry.Language, URL: entry.URL})
	}
	result.OpenGraphTitle = data.OpenGraphTitle
	result.OpenGraphDescription = data.OpenGraphDescription
	result.OpenGraphImageURL = data.OpenGraphImageURL
	result.SchemaOrgTypes = data.SchemaOrgTypes
	result.SchemaOrgItemCount = uint16(data.SchemaOrgItemCount)
	result.SchemaOrgValidCount = uint16(data.SchemaOrgValidCount)
	result.SchemaOrgErrorCount = uint16(data.SchemaOrgErrorCount)
	result.SchemaOrgWarningCount = uint16(data.SchemaOrgWarningCount)
	result.SchemaOrgIssueCodes = data.SchemaOrgIssueCodes
	result.WordCount = uint32(data.WordCount)
	result.ImageCount, result.MissingAlt = uint32(data.ImageCount), uint32(data.ImageMissingAltCount)
	result.ScriptCount, result.StylesheetCount = uint32(data.ScriptCount), uint32(data.StylesheetCount)
	result.IsIndexable, result.IndexabilityReason = indexability(fetched.StatusCode, data.MetaRobots, fetched.XRobotsTag)
	for index, link := range data.Links {
		converted := model.DiscoveredLink{
			TargetURL: link.TargetURL, AnchorText: link.AnchorText, Tag: link.Tag,
			RelValues: link.RelValues, IsInternal: link.IsInternal,
			IsFollowable: link.IsFollowable, Ordinal: uint32(index),
		}
		result.Links = append(result.Links, converted)
		if link.IsInternal {
			result.InternalLinks++
		} else {
			result.ExternalLinks++
		}
	}
	if fetched.StatusCode >= 200 && fetched.StatusCode < 300 && len(fetched.Body) > 0 {
		staticHTML := map[string]any{"source": "static_html"}
		if data.Title == "" {
			result.Findings = append(result.Findings, finding(lease.PageID, "title.missing", 2, "CONTENT", "WARNING", "TITLE_MISSING", "The static HTML response does not contain a non-empty title.", staticHTML))
		}
		if data.MetaDescription == "" {
			result.Findings = append(result.Findings, finding(lease.PageID, "meta-description.missing", 2, "CONTENT", "INFO", "META_DESCRIPTION_MISSING", "The static HTML response does not contain a meta description.", staticHTML))
		}
		if len(data.H1) == 0 {
			result.Findings = append(result.Findings, finding(lease.PageID, "h1.missing", 2, "CONTENT", "WARNING", "H1_MISSING", "The static HTML response does not contain a level-one heading with a detectable accessible name.", staticHTML))
		}
		if data.ImageMissingAltCount > 0 {
			result.Findings = append(result.Findings, finding(lease.PageID, "image.alt.missing", 2, "CONTENT", "INFO", "IMAGE_ALT_MISSING", "One or more images in the static HTML have no detectable text alternative and are not marked decorative.", map[string]any{
				"count": data.ImageMissingAltCount, "sampleOrdinals": data.ImageMissingAltSample, "source": "static_html",
			}))
		}
		if data.CanonicalInvalid > 0 {
			result.Findings = append(result.Findings, finding(lease.PageID, "canonical.invalid", 1, "SEO", "WARNING", "CANONICAL_INVALID", "One or more canonical link declarations do not contain a valid HTTP(S) URL.", map[string]any{"count": data.CanonicalInvalid, "source": "static_html"}))
		}
		if data.CanonicalDeclared > 1 {
			result.Findings = append(result.Findings, finding(lease.PageID, "canonical.multiple", 1, "SEO", "WARNING", "CANONICAL_MULTIPLE", "The static HTML contains multiple canonical link declarations.", map[string]any{"count": data.CanonicalDeclared, "source": "static_html"}))
		}
		if data.CanonicalRelation == "NON_SELF" && (result.IndexabilityReason == "META_ROBOTS_NOINDEX" || result.IndexabilityReason == "X_ROBOTS_TAG_NOINDEX" || result.IndexabilityReason == "META_AND_X_ROBOTS_NOINDEX") {
			result.Findings = append(result.Findings, finding(lease.PageID, "canonical.noindex-conflict", 1, "SEO", "WARNING", "CANONICAL_NOINDEX_CONFLICT", "The page combines a non-self canonical URL with a noindex directive.", map[string]any{"source": "static_html"}))
		}
		if data.HreflangInvalid > 0 {
			result.Findings = append(result.Findings, finding(lease.PageID, "hreflang.invalid", 1, "SEO", "WARNING", "HREFLANG_INVALID", "One or more alternate hreflang declarations are missing a language or valid HTTP(S) URL.", map[string]any{"count": data.HreflangInvalid, "source": "static_html"}))
		}
		if data.SchemaOrgErrorCount > 0 {
			result.Findings = append(result.Findings, finding(lease.PageID, "structured-data.invalid", 1, "SEO", "WARNING", "STRUCTURED_DATA_INVALID", "The static HTML contains structured data that could not be parsed.", map[string]any{"count": data.SchemaOrgErrorCount, "issueCodes": data.SchemaOrgIssueCodes, "source": "static_html"}))
		}
	}
	return result
}

func isCrawlPolicyBlock(errorCode string) bool {
	return errorCode == "ssrf_blocked" || errorCode == "redirect_out_of_scope"
}

func indexability(statusCode int, metaRobots, xRobotsTag string) (bool, string) {
	if statusCode < 200 || statusCode >= 300 {
		return false, "HTTP_STATUS_NOT_INDEXABLE"
	}
	metaNoindex := hasNoindexDirective(metaRobots)
	headerNoindex := hasGenericXRobotsNoindex(xRobotsTag)
	if metaNoindex && headerNoindex {
		return false, "META_AND_X_ROBOTS_NOINDEX"
	}
	if headerNoindex {
		return false, "X_ROBOTS_TAG_NOINDEX"
	}
	if metaNoindex {
		return false, "META_ROBOTS_NOINDEX"
	}
	return true, "INDEXABLE"
}

func hasNoindexDirective(value string) bool {
	for _, token := range strings.FieldsFunc(strings.ToLower(value), func(character rune) bool {
		return character == ',' || character == ';' || character == ' ' || character == '\t' || character == '\r' || character == '\n'
	}) {
		if token == "noindex" || token == "none" {
			return true
		}
	}
	return false
}

func hasGenericXRobotsNoindex(value string) bool {
	for _, line := range strings.Split(value, "\n") {
		targeted := false
		for _, part := range strings.Split(line, ",") {
			part = strings.TrimSpace(part)
			prefix, remainder, hasColon := strings.Cut(part, ":")
			if hasColon {
				switch strings.ToLower(strings.TrimSpace(prefix)) {
				case "max-snippet", "max-image-preview", "max-video-preview", "unavailable_after":
				default:
					targeted = true
					part = remainder
				}
			}
			if !targeted && hasNoindexDirective(part) {
				return true
			}
		}
	}
	return false
}

func durationMillis(value time.Duration) uint32 {
	if value <= 0 {
		return 0
	}
	return uint32(min(value.Milliseconds(), int64(^uint32(0))))
}

func finding(pageID uuid.UUID, ruleID string, ruleVersion uint32, category, severity, code, message string, evidence map[string]any) model.Finding {
	if evidence == nil {
		evidence = map[string]any{}
	}
	return model.Finding{
		FindingID: uuid.NewSHA1(pageID, []byte(ruleID+":"+strconv.FormatUint(uint64(ruleVersion), 10))), RuleID: ruleID,
		RuleVersion: ruleVersion, Category: category, Severity: severity, Code: code,
		Message: message, Evidence: evidence,
	}
}

func (e *Engine) runReclaimer(ctx context.Context) {
	ticker := time.NewTicker(5 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			if err := e.store.ReclaimExpired(ctx); err != nil {
				e.logger.Error("reclaim expired leases failed", "error", err)
			}
			e.refreshBackpressure(ctx)
		}
	}
}

func (e *Engine) refreshBackpressure(ctx context.Context) {
	blocked, err := e.store.AnalyticsBackpressured(ctx, e.backlogAge)
	if err != nil {
		if !e.backpressured.Swap(true) {
			e.logger.Error("analytics backlog check failed; page claiming paused", "error", err)
		}
		return
	}
	previous := e.backpressured.Swap(blocked)
	if blocked && !previous {
		e.logger.Warn("analytics backlog exceeded limit; page claiming paused", "maximumAge", e.backlogAge)
	} else if !blocked && previous {
		e.logger.Info("analytics backlog recovered; page claiming resumed")
	}
}

// Adapted from SEObserver/CrawlObserver internal/fetcher at commit
// 1cc8d7e822e1ffc4b92b437ceb452bad8a01cfc8 (AGPL-3.0).
package crawl

import (
	"context"
	"crypto/tls"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptrace"
	"net/url"
	"strings"
	"sync"
	"time"
)

var ErrOutOfScopeRedirect = errors.New("redirect leaves the registered hostname")

type requestPolicyKey struct{}

type requestPolicy struct {
	hostname     string
	maxRedirects int
	redirects    []RedirectHop
}

type RedirectHop struct {
	URL        string `json:"url"`
	StatusCode int    `json:"statusCode"`
}

type FetchResult struct {
	RequestedURL    string
	FinalURL        string
	StatusCode      int
	ContentType     string
	XRobotsTag      string
	Body            []byte
	BodyBytes       int64
	BodyTruncated   bool
	TotalDuration   time.Duration
	DNSDuration     time.Duration
	ConnectDuration time.Duration
	TLSDuration     time.Duration
	TTFBDuration    time.Duration
	DNSObserved     bool
	ConnectObserved bool
	TLSObserved     bool
	TTFBObserved    bool
	Redirects       []RedirectHop
	ErrorCode       string
	ErrorMessage    string
}

type fetchTimingTrace struct {
	mu               sync.Mutex
	requestStarted   time.Time
	dnsStarted       time.Time
	connectStarted   map[string]time.Time
	tlsStarted       time.Time
	dnsDuration      time.Duration
	connectDuration  time.Duration
	tlsDuration      time.Duration
	ttfbDuration     time.Duration
	dnsObserved      bool
	connectObserved  bool
	tlsObserved      bool
	ttfbObserved     bool
	connectSucceeded bool
}

func newFetchTimingTrace(requestStarted time.Time) *fetchTimingTrace {
	return &fetchTimingTrace{
		requestStarted: requestStarted,
		connectStarted: make(map[string]time.Time),
	}
}

func (t *fetchTimingTrace) clientTrace() *httptrace.ClientTrace {
	return &httptrace.ClientTrace{
		DNSStart: func(httptrace.DNSStartInfo) {
			t.mu.Lock()
			t.dnsStarted = time.Now()
			t.mu.Unlock()
		},
		DNSDone: func(httptrace.DNSDoneInfo) {
			t.mu.Lock()
			if !t.dnsStarted.IsZero() {
				t.dnsDuration += time.Since(t.dnsStarted)
				t.dnsObserved = true
				t.dnsStarted = time.Time{}
			}
			t.mu.Unlock()
		},
		ConnectStart: func(network, address string) {
			t.mu.Lock()
			t.connectStarted[network+"\x00"+address] = time.Now()
			t.mu.Unlock()
		},
		ConnectDone: func(network, address string, err error) {
			t.mu.Lock()
			key := network + "\x00" + address
			started, ok := t.connectStarted[key]
			delete(t.connectStarted, key)
			if ok {
				duration := time.Since(started)
				if err == nil {
					t.connectDuration = duration
					t.connectObserved = true
					t.connectSucceeded = true
				} else if !t.connectSucceeded {
					t.connectDuration = duration
					t.connectObserved = true
				}
			}
			t.mu.Unlock()
		},
		TLSHandshakeStart: func() {
			t.mu.Lock()
			t.tlsStarted = time.Now()
			t.mu.Unlock()
		},
		TLSHandshakeDone: func(_ tls.ConnectionState, _ error) {
			t.mu.Lock()
			if !t.tlsStarted.IsZero() {
				t.tlsDuration += time.Since(t.tlsStarted)
				t.tlsObserved = true
				t.tlsStarted = time.Time{}
			}
			t.mu.Unlock()
		},
		GotFirstResponseByte: func() {
			t.mu.Lock()
			// Redirect responses also emit this callback. Keeping the latest value
			// makes TTFB represent time from the initial request to the final response.
			t.ttfbDuration = time.Since(t.requestStarted)
			t.ttfbObserved = true
			t.mu.Unlock()
		},
	}
}

func (t *fetchTimingTrace) apply(result *FetchResult) {
	t.mu.Lock()
	defer t.mu.Unlock()
	result.DNSDuration = t.dnsDuration
	result.ConnectDuration = t.connectDuration
	result.TLSDuration = t.tlsDuration
	result.TTFBDuration = t.ttfbDuration
	result.DNSObserved = t.dnsObserved
	result.ConnectObserved = t.connectObserved
	result.TLSObserved = t.tlsObserved
	result.TTFBObserved = t.ttfbObserved
}

type Fetcher struct {
	client    *http.Client
	userAgent string
}

func NewFetcher(userAgent string, timeout time.Duration, hostConcurrency int, localTargetsOnly bool) *Fetcher {
	dialer := NewSafeDialer(localTargetsOnly)
	transport := &http.Transport{
		Proxy:                  nil,
		DialContext:            dialer.DialContext,
		ForceAttemptHTTP2:      true,
		MaxIdleConns:           max(100, hostConcurrency),
		MaxIdleConnsPerHost:    hostConcurrency,
		MaxConnsPerHost:        hostConcurrency,
		IdleConnTimeout:        90 * time.Second,
		TLSHandshakeTimeout:    10 * time.Second,
		ResponseHeaderTimeout:  15 * time.Second,
		ExpectContinueTimeout:  time.Second,
		MaxResponseHeaderBytes: 1 << 20,
	}
	client := &http.Client{Timeout: timeout, Transport: transport}
	client.CheckRedirect = func(request *http.Request, previous []*http.Request) error {
		policy, ok := request.Context().Value(requestPolicyKey{}).(*requestPolicy)
		if !ok {
			return errors.New("missing redirect policy")
		}
		if len(previous) > policy.maxRedirects {
			return errors.New("redirect limit exceeded")
		}
		if !strings.EqualFold(request.URL.Hostname(), policy.hostname) {
			return fmt.Errorf("%w: %s", ErrOutOfScopeRedirect, request.URL.Hostname())
		}
		if request.Response != nil && len(previous) > 0 {
			policy.redirects = append(policy.redirects, RedirectHop{
				URL: previous[len(previous)-1].URL.String(), StatusCode: request.Response.StatusCode,
			})
		}
		return nil
	}
	return &Fetcher{client: client, userAgent: userAgent}
}

func (f *Fetcher) Fetch(ctx context.Context, targetURL, hostname string, maxBodyBytes int64, maxRedirects int) (result FetchResult) {
	result = FetchResult{RequestedURL: targetURL}
	started := time.Now()
	timings := newFetchTimingTrace(started)
	defer func() {
		result.TotalDuration = time.Since(started)
		timings.apply(&result)
	}()

	policy := &requestPolicy{hostname: hostname, maxRedirects: maxRedirects}
	ctx = context.WithValue(ctx, requestPolicyKey{}, policy)
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, targetURL, nil)
	if err != nil {
		result.ErrorCode, result.ErrorMessage = "invalid_url", boundedMessage(err.Error())
		return
	}
	request.Header.Set("User-Agent", f.userAgent)
	request.Header.Set("Accept", "text/html,application/xhtml+xml;q=0.9")
	request = request.WithContext(httptrace.WithClientTrace(request.Context(), timings.clientTrace()))

	response, err := f.client.Do(request)
	if err != nil {
		result.ErrorCode, result.ErrorMessage = categorizeFetchError(err), boundedMessage(err.Error())
		return
	}
	defer response.Body.Close()

	result.FinalURL = response.Request.URL.String()
	result.StatusCode = response.StatusCode
	result.ContentType = response.Header.Get("Content-Type")
	// Preserve header-field boundaries so user-agent-scoped directives are not
	// mistaken for generic indexing directives.
	result.XRobotsTag = bounded(strings.Join(response.Header.Values("X-Robots-Tag"), "\n"), 512)
	result.Redirects = append(result.Redirects, policy.redirects...)
	reader := io.LimitReader(response.Body, maxBodyBytes+1)
	body, err := io.ReadAll(reader)
	if err != nil {
		result.ErrorCode, result.ErrorMessage = "body_read_failed", boundedMessage(err.Error())
		return
	}
	if int64(len(body)) > maxBodyBytes {
		body = body[:maxBodyBytes]
		result.BodyTruncated = true
	}
	result.Body = body
	result.BodyBytes = int64(len(body))
	return
}

func (f *Fetcher) Client() *http.Client { return f.client }

func IsHTMLContentType(value string) bool {
	lower := strings.ToLower(value)
	return value == "" || strings.Contains(lower, "text/html") || strings.Contains(lower, "application/xhtml+xml")
}

func categorizeFetchError(err error) string {
	if errors.Is(err, ErrUnsafeAddress) {
		return "ssrf_blocked"
	}
	if errors.Is(err, ErrOutOfScopeRedirect) {
		return "redirect_out_of_scope"
	}
	if errors.Is(err, context.DeadlineExceeded) {
		return "timeout"
	}
	var dnsError *net.DNSError
	if errors.As(err, &dnsError) {
		return "dns_failed"
	}
	var urlError *url.Error
	if errors.As(err, &urlError) && urlError.Timeout() {
		return "timeout"
	}
	return "network_failed"
}

func boundedMessage(value string) string {
	value = strings.TrimSpace(value)
	if len(value) > 500 {
		return value[:500]
	}
	return value
}

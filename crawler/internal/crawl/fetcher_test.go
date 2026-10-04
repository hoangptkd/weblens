package crawl

import (
	"context"
	"net"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"net/url"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func TestFetcherControlledHTTPResponses(t *testing.T) {
	var privateHits atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		switch request.URL.Path {
		case "/static":
			response.Header().Set("Content-Type", "text/html")
			_, _ = response.Write([]byte(`<html><head><title>Fixture</title></head><body><a href="/next?utm_source=x#part">Next</a><a href="https://external.test/">External</a></body></html>`))
		case "/next":
			_, _ = response.Write([]byte("<title>Next</title>"))
		case "/redirect":
			http.Redirect(response, request, "/next", http.StatusFound)
		case "/chain-one":
			http.Redirect(response, request, "/chain-two", http.StatusMovedPermanently)
		case "/chain-two":
			http.Redirect(response, request, "/next", http.StatusFound)
		case "/loop":
			http.Redirect(response, request, "/loop", http.StatusFound)
		case "/private-redirect":
			http.Redirect(response, request, serverLoopbackURL(request)+"/private", http.StatusFound)
		case "/private":
			privateHits.Add(1)
		case "/missing":
			response.WriteHeader(http.StatusNotFound)
		case "/error":
			response.WriteHeader(http.StatusServiceUnavailable)
		case "/binary":
			response.Header().Set("Content-Type", "application/octet-stream")
			_, _ = response.Write([]byte("binary"))
		case "/malformed":
			_, _ = response.Write([]byte("<html><body><a href='/next'>link"))
		case "/large":
			_, _ = response.Write([]byte(strings.Repeat("x", 129)))
		case "/slow":
			time.Sleep(100 * time.Millisecond)
			_, _ = response.Write([]byte("late"))
		}
	}))
	t.Cleanup(server.Close)
	target := fixtureURL(t, server.URL)
	fetcher := NewFetcher("WebLensFixtureTest", time.Second, 2, true)
	useFixtureResolver(t, fetcher)
	fetch := func(path string, limit int64, redirects int) FetchResult {
		return fetcher.Fetch(context.Background(), target+"/"+path, "fixture.test", limit, redirects)
	}

	static := fetch("static", 1<<20, 3)
	if static.ErrorCode != "" || static.StatusCode != 200 {
		t.Fatalf("static page failed: %+v", static)
	}
	parsed, err := ParseHTML(static.Body, static.FinalURL, "fixture.test")
	if err != nil || len(parsed.Links) != 2 || !parsed.Links[0].IsInternal || parsed.Links[1].IsInternal ||
		!strings.HasSuffix(parsed.Links[0].TargetURL, "/next") {
		t.Fatalf("static link discovery failed: data=%+v err=%v", parsed, err)
	}
	if result := fetch("redirect", 128, 1); result.ErrorCode != "" || result.StatusCode != 200 || len(result.Redirects) != 1 {
		t.Fatalf("single redirect failed: %+v", result)
	}
	if result := fetch("chain-one", 128, 2); result.ErrorCode != "" || result.StatusCode != 200 || len(result.Redirects) != 2 {
		t.Fatalf("redirect chain failed: %+v", result)
	}
	if result := fetch("chain-one", 128, 1); result.ErrorCode == "" {
		t.Fatalf("redirect limit was ignored: %+v", result)
	}
	if result := fetch("loop", 128, 2); result.ErrorCode == "" {
		t.Fatalf("redirect loop was not bounded: %+v", result)
	}
	if result := fetch("private-redirect", 128, 2); result.ErrorCode != "redirect_out_of_scope" || privateHits.Load() != 0 {
		t.Fatalf("out-of-scope redirect reached private listener: %+v hits=%d", result, privateHits.Load())
	}
	for path, status := range map[string]int{"missing": 404, "error": 503, "binary": 200, "empty": 200} {
		if result := fetch(path, 128, 0); result.ErrorCode != "" || result.StatusCode != status {
			t.Fatalf("%s response failed: %+v", path, result)
		}
	}
	if result := fetch("large", 128, 0); !result.BodyTruncated || result.BodyBytes != 128 {
		t.Fatalf("response byte limit was ignored: %+v", result)
	}
	malformed := fetch("malformed", 128, 0)
	if _, err := ParseHTML(malformed.Body, malformed.FinalURL, "fixture.test"); err != nil {
		t.Fatalf("malformed HTML was not tolerated: %v", err)
	}
	slowFetcher := NewFetcher("WebLensFixtureTest", 20*time.Millisecond, 1, true)
	useFixtureResolver(t, slowFetcher)
	if result := slowFetcher.Fetch(context.Background(), target+"/slow", "fixture.test", 128, 0); result.ErrorCode != "timeout" {
		t.Fatalf("slow response did not time out: %+v", result)
	}
}

func serverLoopbackURL(request *http.Request) string {
	return "http://127.0.0.1:" + strings.Split(request.Host, ":")[1]
}

func TestFetcherMeasuresNetworkPhasesAndTotalDuration(t *testing.T) {
	t.Parallel()
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, _ *http.Request) {
		time.Sleep(20 * time.Millisecond)
		response.Header().Set("Content-Type", "text/html")
		_, _ = response.Write([]byte("<html><title>Timing fixture</title></html>"))
	}))
	t.Cleanup(server.Close)

	target := fixtureURL(t, server.URL)
	fetcher := NewFetcher("WebLensTimingTest", 2*time.Second, 2, true)
	useFixtureResolver(t, fetcher)
	result := fetcher.Fetch(context.Background(), target, "fixture.test", 1<<20, 3)

	if result.ErrorCode != "" {
		t.Fatalf("fetch failed: %s (%s)", result.ErrorCode, result.ErrorMessage)
	}
	if !result.DNSObserved {
		t.Fatalf("expected an observed DNS phase, got observed=%v duration=%s", result.DNSObserved, result.DNSDuration)
	}
	// A loopback connect can complete within one clock tick; observation is the invariant.
	if !result.ConnectObserved {
		t.Fatalf("expected an observed connect phase, got observed=%v duration=%s", result.ConnectObserved, result.ConnectDuration)
	}
	if result.TLSObserved {
		t.Fatal("plain HTTP request must not report a TLS handshake")
	}
	if !result.TTFBObserved || result.TTFBDuration < 15*time.Millisecond {
		t.Fatalf("expected TTFB to include the delayed response, got observed=%v duration=%s", result.TTFBObserved, result.TTFBDuration)
	}
	if result.TotalDuration < result.TTFBDuration || result.TotalDuration <= 0 {
		t.Fatalf("invalid total duration %s for TTFB %s", result.TotalDuration, result.TTFBDuration)
	}
}

func TestFetcherDoesNotInventConnectionPhasesWhenKeepAliveIsReused(t *testing.T) {
	t.Parallel()
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, _ *http.Request) {
		response.Header().Set("Content-Type", "text/html")
		_, _ = response.Write([]byte("<html><title>Keep-alive fixture</title></html>"))
	}))
	t.Cleanup(server.Close)

	target := fixtureURL(t, server.URL)
	fetcher := NewFetcher("WebLensTimingTest", 2*time.Second, 1, true)
	useFixtureResolver(t, fetcher)
	first := fetcher.Fetch(context.Background(), target, "fixture.test", 1<<20, 3)
	second := fetcher.Fetch(context.Background(), target, "fixture.test", 1<<20, 3)

	if first.ErrorCode != "" || second.ErrorCode != "" {
		t.Fatalf("fixture fetch failed: first=%s second=%s", first.ErrorCode, second.ErrorCode)
	}
	if !first.ConnectObserved {
		t.Fatal("first request should establish a connection")
	}
	if second.ConnectObserved || second.DNSObserved || second.TLSObserved {
		t.Fatalf(
			"reused connection reported phases: dns=%v connect=%v tls=%v",
			second.DNSObserved,
			second.ConnectObserved,
			second.TLSObserved,
		)
	}
	if !second.TTFBObserved {
		t.Fatalf(
			"reused connection must still report TTFB: observed=%v ttfb=%s total=%s",
			second.TTFBObserved,
			second.TTFBDuration,
			second.TotalDuration,
		)
	}
}

func fixtureURL(t *testing.T, raw string) string {
	t.Helper()
	parsed, err := url.Parse(raw)
	if err != nil {
		t.Fatalf("parse fixture URL: %v", err)
	}
	_, port, err := net.SplitHostPort(parsed.Host)
	if err != nil {
		t.Fatalf("split fixture host: %v", err)
	}
	parsed.Host = net.JoinHostPort("fixture.test", port)
	return parsed.String()
}

func useFixtureResolver(t *testing.T, fetcher *Fetcher) {
	t.Helper()
	transport, ok := fetcher.Client().Transport.(*http.Transport)
	if !ok {
		t.Fatal("fetcher transport is not *http.Transport")
	}
	transport.DialContext = newSafeDialerWithResolver(staticResolver{
		addresses: []netip.Addr{netip.MustParseAddr("127.0.0.1")},
	}, true).DialContext
}

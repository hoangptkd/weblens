package crawl

import (
	"strings"
	"testing"
)

func TestParseHTMLExtractsBoundedDeterministicSignals(t *testing.T) {
	t.Parallel()
	body := strings.NewReader(`<!doctype html><html lang="vi"><head>
		<title>WebLens</title><meta name="description" content="Giám sát website">
		<link rel="canonical" href="/home?utm_source=test"></head><body>
		<h1>Tổng quan</h1><h2>Chi tiết</h2><p>Một hai ba</p>
		<img src="a.png"><img src="b.png" alt="Mô tả">
		<a href="/docs?utm_campaign=x">Tài liệu</a>
		<a href="https://other.example/path" rel="nofollow">Ngoài</a>
		</body></html>`)
	data, err := ParseHTML([]byte(readAll(t, body)), "https://example.com/start", "example.com")
	if err != nil {
		t.Fatalf("ParseHTML returned an error: %v", err)
	}
	if data.Title != "WebLens" || data.CanonicalURL != "https://example.com/home" {
		t.Fatalf("unexpected metadata: title=%q canonical=%q", data.Title, data.CanonicalURL)
	}
	if len(data.Links) != 2 || !data.Links[0].IsInternal || data.Links[1].IsFollowable {
		t.Fatalf("unexpected links: %#v", data.Links)
	}
	if data.ImageCount != 2 || data.ImageMissingAltCount != 1 || data.WordCount < 5 {
		t.Fatalf("unexpected counts: %#v", data)
	}
}

func TestParseHTMLExtractsAdvancedSEOSignals(t *testing.T) {
	t.Parallel()
	body := `<!doctype html><html lang="vi"><head>
		<meta NAME="keywords" content="crawler, SEO">
		<meta property="OG:TITLE" content="WebLens Social">
		<meta property="og:description" content="Mô tả chia sẻ">
		<meta property="og:image" content="/social.webp">
		<link rel="canonical" href="https://example.com/page">
		<link rel="alternate" hreflang="vi-VN" href="/vi/page">
		<link rel="stylesheet" href="/app.css">
		<script type="application/ld+json">{"@context":"https://schema.org","@graph":[{"@type":"Article"},{"@type":["WebPage","CreativeWork"]}]}</script>
		<script type="application/ld+json">{invalid}</script>
	</head><body><h3>Ba</h3><h4>Bốn</h4><h5>Năm</h5><h6>Sáu</h6>
		<div itemscope itemtype="https://schema.org/BreadcrumbList"></div><script src="/app.js"></script></body></html>`

	data, err := ParseHTML([]byte(body), "https://example.com/page", "example.com")
	if err != nil {
		t.Fatalf("ParseHTML returned an error: %v", err)
	}
	if data.MetaKeywords != "crawler, SEO" || data.CanonicalRelation != "SELF" {
		t.Fatalf("unexpected SEO metadata: %#v", data)
	}
	if data.OpenGraphTitle != "WebLens Social" || data.OpenGraphImageURL != "https://example.com/social.webp" {
		t.Fatalf("unexpected Open Graph metadata: %#v", data)
	}
	if len(data.Hreflang) != 1 || data.Hreflang[0].URL != "https://example.com/vi/page" {
		t.Fatalf("unexpected hreflang: %#v", data.Hreflang)
	}
	if data.CanonicalDeclared != 1 || data.CanonicalInvalid != 0 || data.HreflangInvalid != 0 {
		t.Fatalf("unexpected SEO declaration counters: %#v", data)
	}
	if len(data.SchemaOrgTypes) != 4 || data.SchemaOrgErrorCount != 1 {
		t.Fatalf("unexpected structured-data summary: %#v", data)
	}
	if data.ScriptCount != 3 || data.StylesheetCount != 1 {
		t.Fatalf("unexpected asset counts: scripts=%d stylesheets=%d", data.ScriptCount, data.StylesheetCount)
	}
}

func TestParseHTMLDistinguishesDecorativeAndNamedImages(t *testing.T) {
	t.Parallel()
	body := `<!doctype html><html><head><title>Images</title></head><body>
		<span id="chart-label">Biểu đồ doanh thu</span>
		<h1><img src="logo.svg" alt="WebLens"></h1>
		<img src="missing.png">
		<img src="decorative.png" alt="">
		<img src="whitespace.png" alt="  ">
		<img src="presentational.png" role="presentation">
		<img src="aria-label.png" aria-label="Ảnh đại diện">
		<img src="aria-labelledby.png" aria-labelledby="chart-label">
		<img src="hidden.png" hidden>
	</body></html>`

	data, err := ParseHTML([]byte(body), "https://example.com/", "example.com")
	if err != nil {
		t.Fatalf("ParseHTML returned an error: %v", err)
	}
	if len(data.H1) != 1 || data.H1[0] != "WebLens" {
		t.Fatalf("expected image alternative to name H1, got %#v", data.H1)
	}
	if data.ImageMissingAltCount != 2 || len(data.ImageMissingAltSample) != 2 ||
		data.ImageMissingAltSample[0] != 2 || data.ImageMissingAltSample[1] != 4 {
		t.Fatalf("unexpected missing image alternatives: count=%d samples=%v", data.ImageMissingAltCount, data.ImageMissingAltSample)
	}
}

func TestParseHTMLCombinesGenericRobotsMetaTags(t *testing.T) {
	t.Parallel()
	body := `<html><head>
		<meta name="robots" content="follow">
		<meta NAME="ROBOTS" content="noindex">
	</head><body></body></html>`

	data, err := ParseHTML([]byte(body), "https://example.com/", "example.com")
	if err != nil {
		t.Fatalf("ParseHTML returned an error: %v", err)
	}
	if data.MetaRobots != "follow, noindex" {
		t.Fatalf("unexpected combined robots directives: %q", data.MetaRobots)
	}
}

func TestParseHTMLCountsInvalidAndDuplicateSEODeclarations(t *testing.T) {
	t.Parallel()
	body := `<html><head>
		<link rel="canonical" href="/first">
		<link rel="canonical" href="mailto:invalid@example.com">
		<link rel="alternate" hreflang="" href="/missing-language">
		<link rel="alternate" hreflang="vi" href="mailto:invalid@example.com">
	</head><body></body></html>`

	data, err := ParseHTML([]byte(body), "https://example.com/", "example.com")
	if err != nil {
		t.Fatalf("ParseHTML returned an error: %v", err)
	}
	if data.CanonicalURL != "https://example.com/first" || data.CanonicalDeclared != 2 ||
		data.CanonicalInvalid != 1 || data.HreflangInvalid != 2 {
		t.Fatalf("unexpected invalid SEO declaration counters: %#v", data)
	}
}

func TestParseHTMLCapsHeadingsAndPreservesVietnameseUTF8(t *testing.T) {
	t.Parallel()
	var body strings.Builder
	body.WriteString("<html><head><title>")
	body.WriteString(strings.Repeat("ế", 2000))
	body.WriteString("</title></head><body>")
	for index := 0; index < 200; index++ {
		body.WriteString("<h3>Tiêu đề</h3>")
	}
	body.WriteString("</body></html>")

	data, err := ParseHTML([]byte(body.String()), "https://example.com/", "example.com")
	if err != nil {
		t.Fatalf("ParseHTML returned an error: %v", err)
	}
	if len(data.Title) > 2048 || !strings.HasSuffix(data.Title, "ế") {
		t.Fatalf("title cap broke UTF-8 or byte policy: bytes=%d", len(data.Title))
	}
	if len(data.H3) != 150 {
		t.Fatalf("expected 150 H3 values after cap, got %d", len(data.H3))
	}
}

func TestIndexabilityCombinesMetaAndResponseHeader(t *testing.T) {
	t.Parallel()
	tests := []struct {
		name       string
		statusCode int
		meta       string
		header     string
		indexable  bool
		reason     string
	}{
		{name: "indexable", statusCode: 200, indexable: true, reason: "INDEXABLE"},
		{name: "meta", statusCode: 200, meta: "noindex,follow", reason: "META_ROBOTS_NOINDEX"},
		{name: "header", statusCode: 200, header: "noindex", reason: "X_ROBOTS_TAG_NOINDEX"},
		{name: "both", statusCode: 200, meta: "noindex", header: "noindex", reason: "META_AND_X_ROBOTS_NOINDEX"},
		{name: "meta none", statusCode: 200, meta: "none", reason: "META_ROBOTS_NOINDEX"},
		{name: "targeted header ignored", statusCode: 200, header: "googlebot: noindex", indexable: true, reason: "INDEXABLE"},
		{name: "generic before targeted header", statusCode: 200, header: "noindex, googlebot: nofollow", reason: "X_ROBOTS_TAG_NOINDEX"},
		{name: "generic header after targeted header", statusCode: 200, header: "googlebot: noindex\nnoindex", reason: "X_ROBOTS_TAG_NOINDEX"},
		{name: "substring is not directive", statusCode: 200, meta: "x-noindex-test", indexable: true, reason: "INDEXABLE"},
		{name: "redirect status", statusCode: 302, reason: "HTTP_STATUS_NOT_INDEXABLE"},
		{name: "status", statusCode: 404, reason: "HTTP_STATUS_NOT_INDEXABLE"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			indexable, reason := indexability(test.statusCode, test.meta, test.header)
			if indexable != test.indexable || reason != test.reason {
				t.Fatalf("got (%t, %q), want (%t, %q)", indexable, reason, test.indexable, test.reason)
			}
		})
	}
}

func readAll(t *testing.T, reader *strings.Reader) string {
	t.Helper()
	buffer := make([]byte, reader.Len())
	if _, err := reader.Read(buffer); err != nil {
		t.Fatalf("read fixture: %v", err)
	}
	return string(buffer)
}

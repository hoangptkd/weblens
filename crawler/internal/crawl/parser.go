// Adapted from SEObserver/CrawlObserver internal/parser at commit
// 1cc8d7e822e1ffc4b92b437ceb452bad8a01cfc8 (AGPL-3.0).
package crawl

import (
	"bytes"
	"encoding/json"
	"net/url"
	"strings"
	"unicode"
	"unicode/utf8"

	"github.com/PuerkitoBio/goquery"
)

type PageData struct {
	Title                 string
	MetaDescription       string
	MetaKeywords          string
	CanonicalURL          string
	CanonicalRelation     string
	CanonicalDeclared     int
	CanonicalInvalid      int
	MetaRobots            string
	HTMLLang              string
	H1                    []string
	H2                    []string
	H3                    []string
	H4                    []string
	H5                    []string
	H6                    []string
	Hreflang              []Hreflang
	HreflangInvalid       int
	OpenGraphTitle        string
	OpenGraphDescription  string
	OpenGraphImageURL     string
	SchemaOrgTypes        []string
	SchemaOrgItemCount    int
	SchemaOrgValidCount   int
	SchemaOrgErrorCount   int
	SchemaOrgWarningCount int
	SchemaOrgIssueCodes   []string
	WordCount             int
	ImageCount            int
	ImageMissingAltCount  int
	ImageMissingAltSample []int
	ScriptCount           int
	StylesheetCount       int
	Links                 []Link
}

type Hreflang struct {
	Language string `json:"language"`
	URL      string `json:"url"`
}

type Link struct {
	TargetURL    string   `json:"targetUrl"`
	AnchorText   string   `json:"anchorText"`
	Tag          string   `json:"tag"`
	RelValues    []string `json:"relValues"`
	IsInternal   bool     `json:"isInternal"`
	IsFollowable bool     `json:"isFollowable"`
}

func ParseHTML(body []byte, pageURL, scopeHostname string) (PageData, error) {
	document, err := goquery.NewDocumentFromReader(bytes.NewReader(body))
	if err != nil {
		return PageData{}, err
	}
	base, err := url.Parse(pageURL)
	if err != nil {
		return PageData{}, err
	}
	data := PageData{
		Title:                firstText(document, "title", 2048),
		MetaDescription:      metaContent(document, "description", 4096),
		MetaKeywords:         metaContent(document, "keywords", 4096),
		MetaRobots:           metaContents(document, "robots", 512),
		HTMLLang:             bounded(strings.TrimSpace(document.Find("html").First().AttrOr("lang", "")), 64),
		OpenGraphTitle:       propertyContent(document, "og:title", 2048),
		OpenGraphDescription: propertyContent(document, "og:description", 4096),
		WordCount:            countWords(document.Find("body").Text()),
	}
	data.CanonicalURL, data.CanonicalDeclared, data.CanonicalInvalid = canonical(document, base)
	labels := labelledTextByID(document)
	data.H1 = headingTexts(document, labels, "h1", "1", 50, 2048)
	data.H2 = headingTexts(document, labels, "h2", "2", 100, 2048)
	data.H3 = headingTexts(document, labels, "h3", "3", 150, 2048)
	data.H4 = headingTexts(document, labels, "h4", "4", 100, 2048)
	data.H5 = headingTexts(document, labels, "h5", "5", 50, 2048)
	data.H6 = headingTexts(document, labels, "h6", "6", 50, 2048)
	data.CanonicalRelation = canonicalRelation(data.CanonicalURL, base.String())
	data.OpenGraphImageURL = resolvedPropertyURL(document, "og:image", base, 8192)
	data.Hreflang, data.HreflangInvalid = hreflangLinks(document, base)
	extractStructuredData(document, &data)
	data.ScriptCount = document.Find("script").Length()
	document.Find("link").Each(func(_ int, selection *goquery.Selection) {
		if containsToken(tokenValues(selection.AttrOr("rel", "")), "stylesheet") {
			data.StylesheetCount++
		}
	})
	document.Find("img").Each(func(index int, image *goquery.Selection) {
		data.ImageCount++
		if imageNeedsTextAlternative(image, labels) {
			data.ImageMissingAltCount++
			if len(data.ImageMissingAltSample) < 10 {
				data.ImageMissingAltSample = append(data.ImageMissingAltSample, index+1)
			}
		}
	})
	document.Find("a, area").EachWithBreak(func(_ int, selection *goquery.Selection) bool {
		if len(data.Links) >= 2000 {
			return false
		}
		href := strings.TrimSpace(selection.AttrOr("href", ""))
		if href == "" || isNonHTTPReference(href) {
			return true
		}
		resolved, resolveErr := ResolveURL(base.String(), href)
		if resolveErr != nil {
			return true
		}
		rel := tokenValues(selection.AttrOr("rel", ""))
		data.Links = append(data.Links, Link{
			TargetURL: resolved, AnchorText: bounded(strings.TrimSpace(selection.Text()), 2048),
			Tag: goquery.NodeName(selection), RelValues: rel,
			IsInternal: IsHTTPURLInScope(resolved, scopeHostname), IsFollowable: !containsToken(rel, "nofollow"),
		})
		return true
	})
	return data, nil
}

func propertyContent(document *goquery.Document, property string, limit int) string {
	var result string
	document.Find("meta").EachWithBreak(func(_ int, selection *goquery.Selection) bool {
		if strings.EqualFold(strings.TrimSpace(selection.AttrOr("property", "")), property) {
			result = bounded(strings.TrimSpace(selection.AttrOr("content", "")), limit)
			return false
		}
		return true
	})
	return result
}

func resolvedPropertyURL(document *goquery.Document, property string, base *url.URL, limit int) string {
	raw := propertyContent(document, property, limit)
	if raw == "" {
		return ""
	}
	resolved, err := ResolveURL(base.String(), raw)
	if err != nil {
		return ""
	}
	return bounded(resolved, limit)
}

func canonicalRelation(canonicalURL, pageURL string) string {
	if canonicalURL == "" {
		return "MISSING"
	}
	canonicalNormalized, canonicalErr := NormalizeURL(canonicalURL)
	pageNormalized, pageErr := NormalizeURL(pageURL)
	if canonicalErr == nil && pageErr == nil && canonicalNormalized == pageNormalized {
		return "SELF"
	}
	return "NON_SELF"
}

func hreflangLinks(document *goquery.Document, base *url.URL) ([]Hreflang, int) {
	values := make([]Hreflang, 0)
	invalid := 0
	document.Find("link").EachWithBreak(func(_ int, selection *goquery.Selection) bool {
		if len(values) >= 100 {
			return false
		}
		if !containsToken(tokenValues(selection.AttrOr("rel", "")), "alternate") {
			return true
		}
		language := bounded(strings.TrimSpace(selection.AttrOr("hreflang", "")), 64)
		href := strings.TrimSpace(selection.AttrOr("href", ""))
		if language == "" || href == "" {
			invalid++
			return true
		}
		resolved, err := ResolveURL(base.String(), href)
		if err != nil || !isHTTPURL(resolved) {
			invalid++
			return true
		}
		values = append(values, Hreflang{Language: language, URL: bounded(resolved, 8192)})
		return true
	})
	return values, invalid
}

const (
	maxJSONLDBlocks = 20
	maxJSONLDBytes  = 1 << 20
)

func extractStructuredData(document *goquery.Document, data *PageData) {
	types := make([]string, 0)
	seen := make(map[string]struct{})
	totalBytes := 0
	blocks := 0
	document.Find("script").EachWithBreak(func(_ int, selection *goquery.Selection) bool {
		if blocks >= maxJSONLDBlocks || totalBytes >= maxJSONLDBytes {
			return false
		}
		if !strings.EqualFold(strings.TrimSpace(selection.AttrOr("type", "")), "application/ld+json") {
			return true
		}
		blocks++
		raw := []byte(strings.TrimSpace(selection.Text()))
		remaining := maxJSONLDBytes - totalBytes
		if len(raw) > remaining {
			raw = raw[:remaining]
			data.SchemaOrgWarningCount++
			addIssueCode(data, "JSON_LD_INPUT_TRUNCATED")
		}
		totalBytes += len(raw)
		var value any
		if len(raw) == 0 || json.Unmarshal(raw, &value) != nil {
			data.SchemaOrgErrorCount++
			addIssueCode(data, "JSON_LD_INVALID")
			return true
		}
		before := data.SchemaOrgItemCount
		collectSchemaTypes(value, &types, seen, &data.SchemaOrgItemCount)
		if data.SchemaOrgItemCount == before {
			data.SchemaOrgWarningCount++
			addIssueCode(data, "JSON_LD_TYPE_MISSING")
		} else {
			data.SchemaOrgValidCount++
		}
		return true
	})
	document.Find("[itemscope][itemtype]").EachWithBreak(func(_ int, selection *goquery.Selection) bool {
		if len(types) >= 100 {
			return false
		}
		for _, rawType := range strings.Fields(selection.AttrOr("itemtype", "")) {
			addSchemaType(schemaTypeName(rawType), &types, seen)
			data.SchemaOrgItemCount++
			data.SchemaOrgValidCount++
		}
		return true
	})
	data.SchemaOrgTypes = types
}

func collectSchemaTypes(value any, types *[]string, seen map[string]struct{}, itemCount *int) {
	switch typed := value.(type) {
	case []any:
		for _, item := range typed {
			collectSchemaTypes(item, types, seen, itemCount)
		}
	case map[string]any:
		if rawType, ok := typed["@type"]; ok {
			before := len(*types)
			switch typeValue := rawType.(type) {
			case string:
				addSchemaType(schemaTypeName(typeValue), types, seen)
			case []any:
				for _, candidate := range typeValue {
					if text, ok := candidate.(string); ok {
						addSchemaType(schemaTypeName(text), types, seen)
					}
				}
			}
			if len(*types) > before {
				(*itemCount)++
			}
		}
		for key, child := range typed {
			if key == "@type" {
				continue
			}
			collectSchemaTypes(child, types, seen, itemCount)
		}
	}
}

func schemaTypeName(value string) string {
	value = strings.TrimSpace(value)
	if parsed, err := url.Parse(value); err == nil && parsed.IsAbs() {
		if fragment := parsed.Fragment; fragment != "" {
			value = fragment
		} else if path := strings.Trim(parsed.Path, "/"); path != "" {
			parts := strings.Split(path, "/")
			value = parts[len(parts)-1]
		}
	}
	return bounded(value, 255)
}

func addSchemaType(value string, values *[]string, seen map[string]struct{}) {
	if value == "" || len(*values) >= 100 {
		return
	}
	key := strings.ToLower(value)
	if _, exists := seen[key]; exists {
		return
	}
	seen[key] = struct{}{}
	*values = append(*values, value)
}

func addIssueCode(data *PageData, code string) {
	if len(data.SchemaOrgIssueCodes) >= 20 {
		return
	}
	for _, existing := range data.SchemaOrgIssueCodes {
		if existing == code {
			return
		}
	}
	data.SchemaOrgIssueCodes = append(data.SchemaOrgIssueCodes, code)
}

func firstText(document *goquery.Document, selector string, limit int) string {
	return bounded(strings.TrimSpace(document.Find(selector).First().Text()), limit)
}

func metaContent(document *goquery.Document, name string, limit int) string {
	var result string
	document.Find("meta").EachWithBreak(func(_ int, selection *goquery.Selection) bool {
		if strings.EqualFold(strings.TrimSpace(selection.AttrOr("name", "")), name) {
			result = bounded(strings.TrimSpace(selection.AttrOr("content", "")), limit)
			return false
		}
		return true
	})
	return result
}

func metaContents(document *goquery.Document, name string, limit int) string {
	values := make([]string, 0)
	document.Find("meta").Each(func(_ int, selection *goquery.Selection) {
		if !strings.EqualFold(strings.TrimSpace(selection.AttrOr("name", "")), name) {
			return
		}
		if value := strings.TrimSpace(selection.AttrOr("content", "")); value != "" {
			values = append(values, value)
		}
	})
	return bounded(strings.Join(values, ", "), limit)
}

func canonical(document *goquery.Document, base *url.URL) (string, int, int) {
	result, declared, invalid := "", 0, 0
	document.Find("link").Each(func(_ int, selection *goquery.Selection) {
		if containsToken(tokenValues(selection.AttrOr("rel", "")), "canonical") {
			declared++
			href := strings.TrimSpace(selection.AttrOr("href", ""))
			if href == "" {
				invalid++
				return
			}
			if resolved, err := ResolveURL(base.String(), href); err == nil && isHTTPURL(resolved) && result == "" {
				result = bounded(resolved, 8192)
			} else if err != nil || !isHTTPURL(resolved) {
				invalid++
			}
		}
	})
	return result, declared, invalid
}

func isHTTPURL(raw string) bool {
	value, err := url.Parse(raw)
	return err == nil && value.User == nil && (value.Scheme == "http" || value.Scheme == "https") && value.Hostname() != ""
}

func headingTexts(document *goquery.Document, labels map[string]string, selector, ariaLevel string, maxItems, maxLength int) []string {
	values := make([]string, 0)
	appendValue := func(selection *goquery.Selection) bool {
		if len(values) >= maxItems {
			return false
		}
		value := bounded(accessibleText(selection, labels), maxLength)
		if value != "" {
			values = append(values, value)
		}
		return true
	}
	document.Find(selector).EachWithBreak(func(_ int, selection *goquery.Selection) bool {
		return appendValue(selection)
	})
	document.Find("[role][aria-level]").EachWithBreak(func(_ int, selection *goquery.Selection) bool {
		if goquery.NodeName(selection) == selector ||
			!containsToken(tokenValues(selection.AttrOr("role", "")), "heading") ||
			strings.TrimSpace(selection.AttrOr("aria-level", "")) != ariaLevel {
			return true
		}
		return appendValue(selection)
	})
	return values
}

func labelledTextByID(document *goquery.Document) map[string]string {
	labels := make(map[string]string)
	document.Find("[id]").Each(func(_ int, selection *goquery.Selection) {
		id := strings.TrimSpace(selection.AttrOr("id", ""))
		if id == "" {
			return
		}
		value := strings.TrimSpace(selection.AttrOr("aria-label", ""))
		if value == "" {
			value = strings.TrimSpace(selection.Text())
		}
		if value != "" {
			labels[id] = bounded(value, 2048)
		}
	})
	return labels
}

func accessibleText(selection *goquery.Selection, labels map[string]string) string {
	labelled := make([]string, 0)
	for _, id := range strings.Fields(selection.AttrOr("aria-labelledby", "")) {
		if value := strings.TrimSpace(labels[id]); value != "" {
			labelled = append(labelled, value)
		}
	}
	if len(labelled) > 0 {
		return strings.Join(labelled, " ")
	}
	if value := strings.TrimSpace(selection.AttrOr("aria-label", "")); value != "" {
		return value
	}
	if value := strings.TrimSpace(selection.Text()); value != "" {
		return value
	}
	if goquery.NodeName(selection) == "img" {
		if value := strings.TrimSpace(selection.AttrOr("alt", "")); value != "" {
			return value
		}
		return strings.TrimSpace(selection.AttrOr("title", ""))
	}
	images := make([]string, 0)
	selection.Find("img").EachWithBreak(func(_ int, image *goquery.Selection) bool {
		if len(images) >= 10 {
			return false
		}
		if value := accessibleText(image, labels); value != "" {
			images = append(images, value)
		}
		return true
	})
	return strings.Join(images, " ")
}

func imageNeedsTextAlternative(image *goquery.Selection, labels map[string]string) bool {
	if _, hidden := image.Attr("hidden"); hidden || strings.EqualFold(strings.TrimSpace(image.AttrOr("aria-hidden", "")), "true") {
		return false
	}
	if accessibleText(image, labels) != "" {
		return false
	}
	role := tokenValues(image.AttrOr("role", ""))
	if containsToken(role, "none") || containsToken(role, "presentation") {
		return false
	}
	alt, hasAlt := image.Attr("alt")
	return !hasAlt || alt != ""
}

func countWords(value string) int {
	count, inWord := 0, false
	for _, character := range value {
		if unicode.IsLetter(character) || unicode.IsDigit(character) {
			if !inWord {
				count++
			}
			inWord = true
		} else {
			inWord = false
		}
	}
	return count
}

func tokenValues(value string) []string {
	parts := strings.Fields(strings.ToLower(value))
	if len(parts) > 32 {
		parts = parts[:32]
	}
	return parts
}

func containsToken(values []string, expected string) bool {
	for _, value := range values {
		if value == expected {
			return true
		}
	}
	return false
}

func isNonHTTPReference(value string) bool {
	lower := strings.ToLower(value)
	return strings.HasPrefix(lower, "#") || strings.HasPrefix(lower, "mailto:") ||
		strings.HasPrefix(lower, "tel:") || strings.HasPrefix(lower, "javascript:") ||
		strings.HasPrefix(lower, "data:")
}

func bounded(value string, limit int) string {
	if len(value) > limit {
		value = value[:limit]
		for !utf8.ValidString(value) {
			value = value[:len(value)-1]
		}
	}
	return value
}

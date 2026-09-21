package model

import (
	"encoding/json"
	"errors"
	"time"

	"github.com/google/uuid"
)

var ErrStaleLease = errors.New("lease is stale")

type PageLease struct {
	RetentionMonth   time.Time
	PageID           uuid.UUID
	ExecutionID      uuid.UUID
	ScanID           uuid.UUID
	OwnerID          uuid.UUID
	WebsiteID        uuid.UUID
	CorrelationID    uuid.UUID
	NormalizedURL    string
	Hostname         string
	DiscoveryDepth   int
	LeaseOwner       uuid.UUID
	LeaseGeneration  int64
	HostSlotNo       int
	HostGeneration   int64
	MaxPages         int
	MaxDepth         int
	MaxResponseBytes int64
	MaxDuration      time.Duration
	MaxRedirects     int
	CollectorVersion string
	AcceptedAt       time.Time
}

type PageResult struct {
	FinalURL              string
	FetchOutcome          string
	ErrorCode             string
	ErrorMessage          string
	StatusCode            int
	ContentType           string
	RedirectURLs          []string
	RedirectCodes         []uint16
	ResponseBytes         uint64
	DNSMillis             uint32
	ConnectMillis         uint32
	TLSMillis             uint32
	TTFBMillis            uint32
	DNSObserved           bool
	ConnectObserved       bool
	TLSObserved           bool
	TTFBObserved          bool
	TotalMillis           uint32
	Title                 string
	Description           string
	MetaKeywords          string
	CanonicalURL          string
	CanonicalRelation     string
	MetaRobots            string
	XRobotsTag            string
	IndexabilityReason    string
	HTMLLang              string
	H1                    []string
	H2                    []string
	H3                    []string
	H4                    []string
	H5                    []string
	H6                    []string
	Hreflang              []Hreflang
	OpenGraphTitle        string
	OpenGraphDescription  string
	OpenGraphImageURL     string
	SchemaOrgTypes        []string
	SchemaOrgItemCount    uint16
	SchemaOrgValidCount   uint16
	SchemaOrgErrorCount   uint16
	SchemaOrgWarningCount uint16
	SchemaOrgIssueCodes   []string
	WordCount             uint32
	InternalLinks         uint32
	ExternalLinks         uint32
	ImageCount            uint32
	MissingAlt            uint32
	ScriptCount           uint32
	StylesheetCount       uint32
	IsIndexable           bool
	Links                 []DiscoveredLink
	Findings              []Finding
	ObservedAt            time.Time
}

type Hreflang struct {
	Language string `json:"language"`
	URL      string `json:"url"`
}

type DiscoveredLink struct {
	TargetURL    string   `json:"targetUrl"`
	AnchorText   string   `json:"anchorText"`
	Tag          string   `json:"tag"`
	RelValues    []string `json:"relValues"`
	IsInternal   bool     `json:"isInternal"`
	IsFollowable bool     `json:"isFollowable"`
	Ordinal      uint32   `json:"ordinal"`
}

type Finding struct {
	FindingID   uuid.UUID      `json:"findingId"`
	RuleID      string         `json:"ruleId"`
	RuleVersion uint32         `json:"ruleVersion"`
	Category    string         `json:"category"`
	Severity    string         `json:"severity"`
	Code        string         `json:"code"`
	Message     string         `json:"message"`
	Evidence    map[string]any `json:"evidence"`
}

type AnalyticsPayload struct {
	SchemaVersion    uint16     `json:"schemaVersion"`
	OwnerID          uuid.UUID  `json:"ownerId"`
	ScanID           uuid.UUID  `json:"scanId"`
	RetentionMonth   time.Time  `json:"retentionMonth"`
	PageID           uuid.UUID  `json:"pageId"`
	RecordVersion    uint64     `json:"recordVersion"`
	RequestedURL     string     `json:"requestedUrl"`
	NormalizedURL    string     `json:"normalizedUrl"`
	FinalURL         string     `json:"finalUrl"`
	Hostname         string     `json:"hostname"`
	DiscoveryDepth   uint16     `json:"discoveryDepth"`
	Result           PageResult `json:"result"`
	CollectorVersion string     `json:"collectorVersion"`
	ParserVersion    string     `json:"parserVersion"`
}

type AnalyticsBatch struct {
	ID               uuid.UUID
	RetentionMonth   time.Time
	ExecutionID      uuid.UUID
	OwnerID          uuid.UUID
	PageID           uuid.UUID
	ResultVersion    int64
	Payload          json.RawMessage
	PayloadSHA256    []byte
	DeliveryAttempts int
	LeaseOwner       uuid.UUID
}

type OutboxMessage struct {
	MessageID        uuid.UUID
	AggregateType    string
	AggregateID      uuid.UUID
	AggregateVersion int64
	EventType        string
	ContractVersion  int
	CorrelationID    uuid.UUID
	Payload          json.RawMessage
	CreatedAt        time.Time
	DeliveryAttempts int
	LeaseOwner       uuid.UUID
}

type ReportState struct {
	ScanID                  uuid.UUID  `json:"scanId"`
	OwnerID                 uuid.UUID  `json:"ownerId"`
	Status                  string     `json:"status"`
	AnalyticsExpectedCount  int        `json:"analyticsExpectedCount"`
	AnalyticsPublishedCount int        `json:"analyticsPublishedCount"`
	AnalyticsWatermark      *time.Time `json:"analyticsWatermark,omitempty"`
}

type ReportFinding struct {
	ID          uuid.UUID      `json:"id"`
	Severity    string         `json:"severity"`
	Title       string         `json:"title"`
	Description string         `json:"description"`
	Evidence    map[string]any `json:"evidence"`
}

type ReportPage struct {
	ID                    uuid.UUID       `json:"id"`
	ScanID                uuid.UUID       `json:"scanId"`
	URL                   string          `json:"url"`
	FinalURL              string          `json:"finalUrl"`
	StatusCode            int             `json:"statusCode,omitempty"`
	ContentType           string          `json:"contentType,omitempty"`
	Outcome               string          `json:"outcome"`
	ResponseTimeMS        uint32          `json:"responseTimeMs,omitempty"`
	ResponseBytes         uint64          `json:"responseBytes,omitempty"`
	Title                 string          `json:"title,omitempty"`
	Description           string          `json:"description,omitempty"`
	MetaKeywords          string          `json:"metaKeywords,omitempty"`
	CanonicalURL          string          `json:"canonicalUrl,omitempty"`
	CanonicalRelation     string          `json:"canonicalRelation"`
	MetaRobots            string          `json:"metaRobots,omitempty"`
	XRobotsTag            string          `json:"xRobotsTag,omitempty"`
	HTMLLang              string          `json:"htmlLang,omitempty"`
	IsIndexable           bool            `json:"indexable"`
	IndexabilityReason    string          `json:"indexabilityReason"`
	H1                    []string        `json:"h1"`
	H2                    []string        `json:"h2"`
	H3                    []string        `json:"h3"`
	H4                    []string        `json:"h4"`
	H5                    []string        `json:"h5"`
	H6                    []string        `json:"h6"`
	Hreflang              []Hreflang      `json:"hreflang"`
	OpenGraphTitle        string          `json:"openGraphTitle,omitempty"`
	OpenGraphDescription  string          `json:"openGraphDescription,omitempty"`
	OpenGraphImageURL     string          `json:"openGraphImageUrl,omitempty"`
	SchemaOrgTypes        []string        `json:"schemaOrgTypes"`
	SchemaOrgItemCount    uint16          `json:"schemaOrgItemCount"`
	SchemaOrgValidCount   uint16          `json:"schemaOrgValidCount"`
	SchemaOrgErrorCount   uint16          `json:"schemaOrgErrorCount"`
	SchemaOrgWarningCount uint16          `json:"schemaOrgWarningCount"`
	SchemaOrgIssueCodes   []string        `json:"schemaOrgIssueCodes"`
	Links                 uint32          `json:"links"`
	Images                uint32          `json:"images"`
	Scripts               uint32          `json:"scripts"`
	Stylesheets           uint32          `json:"stylesheets"`
	DNSMillis             uint32          `json:"dnsMillis,omitempty"`
	ConnectMillis         uint32          `json:"connectMillis,omitempty"`
	TLSMillis             uint32          `json:"tlsMillis,omitempty"`
	TTFBMillis            uint32          `json:"ttfbMillis,omitempty"`
	DNSObserved           bool            `json:"dnsObserved"`
	ConnectObserved       bool            `json:"connectObserved"`
	TLSObserved           bool            `json:"tlsObserved"`
	TTFBObserved          bool            `json:"ttfbObserved"`
	Findings              []ReportFinding `json:"findings"`
	ObservedAt            time.Time       `json:"observedAt"`
}

type ScanPagesReport struct {
	State      ReportState       `json:"state"`
	Summary    ScanReportSummary `json:"summary"`
	Items      []ReportPage      `json:"items"`
	NextCursor string            `json:"nextCursor,omitempty"`
}

type PageFilters struct {
	IssuesOnly   bool
	Outcomes     []string
	StatusMin    *int
	StatusMax    *int
	Query        string
	Indexable    *bool
	ContentTypes []string
	Severities   []string
	FindingCodes []string
}

type ScanReportSummary struct {
	TotalURLCount   uint64 `json:"totalUrlCount"`
	IssuePageCount  uint64 `json:"issuePageCount"`
	FindingCount    uint64 `json:"findingCount"`
	Status2xxCount  uint64 `json:"status2xxCount"`
	Status3xxCount  uint64 `json:"status3xxCount"`
	Status4xxCount  uint64 `json:"status4xxCount"`
	Status5xxCount  uint64 `json:"status5xxCount"`
	NoResponseCount uint64 `json:"noResponseCount"`
}

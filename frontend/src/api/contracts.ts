export interface ApiPage<T> {
  items: T[]
  page: number
  size: number
  totalItems: number
  totalPages: number
}

export interface ApiFieldError {
  field: string
  message: string
}

export interface ApiProblemDetail {
  title?: string
  detail?: string
  status?: number
  code?: string
  correlationId?: string
  fieldErrors?: ApiFieldError[]
}

export type ApiUserStatus = 'ACTIVE' | 'DISABLED'

export interface ApiUser {
  id: string
  email: string
  displayName: string
  status: ApiUserStatus
}

export interface ApiAuthSession {
  user: ApiUser
  accessToken: string
  tokenType: 'Bearer'
  expiresAt: string
}

export interface ApiLatestScan {
  id: string
  status: ApiScanStatus
  createdAt: string
  finishedAt: string | null
  processedPages: number
  failedPages: number
}

export interface ApiWebsite {
  id: string
  name: string
  canonicalUrl: string
  hostname: string
  status: 'ACTIVE' | 'ARCHIVED'
  latestScan: ApiLatestScan | null
  pageCount: number
  failedPageCount: number
  createdAt: string
  updatedAt: string
}

export interface ApiDashboardSummary {
  activeWebsites: number
  scansLast30Days: number
  activeScans: number
  processedPages: number
  succeededPages: number
  failedPages: number
}

export type ApiScanStatus =
  | 'QUEUED'
  | 'RUNNING'
  | 'CANCEL_REQUESTED'
  | 'COMPLETED'
  | 'PARTIAL_SUCCESS'
  | 'FAILED'
  | 'CANCELLED'

export interface ApiScanProgress {
  discovered: number
  queued: number
  processed: number
  succeeded: number
  failed: number
  limit: number
}

export interface ApiEffectiveScanConfig {
  maxPages: number
  maxDepth: number
  maxResponseBytes: number
  maxDurationSeconds: number
  maxRedirects: number
  concurrency: number
}

export interface ApiScan {
  id: string
  websiteId: string
  status: ApiScanStatus
  createdAt: string
  startedAt: string | null
  finishedAt: string | null
  durationMs: number | null
  progress: ApiScanProgress
  effectiveConfig: ApiEffectiveScanConfig
  collectorVersion: string
  terminalReason: { code: string; message: string } | null
}

export interface ApiFinding {
  id: string
  severity: 'critical' | 'warning' | 'info'
  title: string
  description: string
  evidence: string
}

export interface ApiScanPage {
  id: string
  scanId: string
  path: string
  url: string
  statusCode?: number | null
  outcome: 'success' | 'warning' | 'failed'
  responseTimeMs?: number | null
  responseBytes?: number | null
  title?: string | null
  description?: string | null
  metaKeywords?: string | null
  canonicalUrl?: string | null
  canonicalRelation: 'MISSING' | 'SELF' | 'NON_SELF'
  metaRobots?: string | null
  xRobotsTag?: string | null
  htmlLang?: string | null
  indexable: boolean
  indexabilityReason: string
  h1?: string | null
  h1Values: string[]
  h2: string[]
  h3: string[]
  h4: string[]
  h5: string[]
  h6: string[]
  hreflang: Array<{ language: string; url: string }>
  openGraph: { title?: string | null; description?: string | null; imageUrl?: string | null }
  structuredData: {
    types: string[]
    itemCount: number
    validCount: number
    errorCount: number
    warningCount: number
    issueCodes: string[]
  }
  links: number
  images: number
  scripts: number
  stylesheets: number
  timing: {
    dnsMillis?: number | null
    connectMillis?: number | null
    tlsMillis?: number | null
    ttfbMillis?: number | null
    totalMillis?: number | null
  }
  findings: ApiFinding[]
  observedAt: string
}

export interface ApiScanPages {
  items: ApiScanPage[]
  summary: {
    totalUrlCount: number
    issuePageCount: number
    findingCount: number
    status2xxCount: number
    status3xxCount: number
    status4xxCount: number
    status5xxCount: number
    noResponseCount: number
  }
  analyticsExpectedCount: number
  analyticsPublishedCount: number
  analyticsWatermark: string | null
  fresh: boolean
  nextCursor?: string | null
}

export interface ApiCapture {
  id: string
  scanId: string
  pageId: string
  status: import('../domain/types').CaptureStatus
  targetUrl: string
  measurementProfile: string
  analyticsExpectedCount: number
  analyticsPublishedCount: number
  objectCount: number
  totalObjectBytes: number
  terminalCode?: string | null
  terminalMessage?: string | null
  createdAt: string
}

export interface ApiCaptureSnapshot {
  id: string
  captureRequestId: string
  scanId: string
  scanPageId: string
  status: import('../domain/types').CaptureStatus
  createdAt: string
  finalUrl: string
  viewport: string
  measurementProfile: string
  browserVersion: string
  resourceCount: number
  capturedResourceCount: number
  totalBytes: number
  rendered: NonNullable<import('../domain/types').PageSnapshot['rendered']>
  diff: NonNullable<import('../domain/types').PageSnapshot['diff']>
  performance: NonNullable<import('../domain/types').PageSnapshot['performance']>
  artifacts: NonNullable<import('../domain/types').PageSnapshot['artifacts']>
  reconstruction: import('../domain/types').StaticReconstruction | null
  resources: import('../domain/types').CapturedResource[]
}

export interface ApiSiteCloneArtifact {
  id: string
  kind: 'ARCHIVE_SHARD' | 'MANIFEST'
  shardNumber: number
  filename: string
  byteSize: number
  sha256: string
  expiresAt: string
}

export interface ApiSiteClone {
  id: string
  websiteId?: string | null
  scanId: string
  targetUrl: string
  status: import('../domain/types').SiteCloneStatus
  discoveredCount: number
  processedCount: number
  succeededCount: number
  failedCount: number
  artifactCount: number
  totalArchiveBytes: number
  terminalCode?: string | null
  terminalMessage?: string | null
  createdAt: string
  startedAt?: string | null
  finishedAt?: string | null
  artifacts: ApiSiteCloneArtifact[]
}

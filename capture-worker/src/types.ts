export interface StaticObservation {
  title: string | null
  description: string | null
  canonicalUrl: string | null
  h1: string | null
  links: number
  images: number
  schemaOrgTypes: string[]
  observedAt: string | null
}

export interface CaptureCommandPayload {
  captureRequestId: string
  ownerId: string
  scanId: string
  pageId: string
  targetUrl: string
  viewportWidth: number
  viewportHeight: number
  timeoutSeconds: number
  maxTotalBytes: number
  maxResourceBytes: number
  maxNetworkRequests: number
  maxResourceBodies: number
  measurementProfile: string
  staticObservation: StaticObservation
}

export interface CaptureCommandEnvelope {
  messageId: string
  aggregateType: 'CAPTURE'
  aggregateId: string
  aggregateVersion: number
  messageType: 'CAPTURE_REQUESTED'
  contractVersion: 1
  correlationId: string
  occurredAt: string
  payload: CaptureCommandPayload
}

export interface SiteCloneCommandPayload {
  siteCloneRequestId: string
  ownerId: string
  scanId: string
  rootUrl: string
  maxPages: number
  maxInputBytes: number
  maxArchiveBytes: number
  maxShardBytes: number
  pageConcurrency: number
  maxRetriesPerPage: number
  maxDurationSeconds: number
  archiveRetentionDays: number
  metadataRetentionDays: number
  sameOriginOnly: true
}

export interface SiteCloneRequestedEnvelope {
  messageId: string
  aggregateType: 'SITE_CLONE'
  aggregateId: string
  aggregateVersion: number
  messageType: 'SITE_CLONE_REQUESTED'
  contractVersion: 1
  correlationId: string
  occurredAt: string
  payload: SiteCloneCommandPayload
}

export interface SiteCloneCancelEnvelope {
  messageId: string
  aggregateType: 'SITE_CLONE'
  aggregateId: string
  aggregateVersion: number
  messageType: 'SITE_CLONE_CANCEL_REQUESTED'
  contractVersion: 1
  correlationId: string
  occurredAt: string
  payload: {
    siteCloneRequestId: string
    ownerId: string
    requestedAt: string
  }
}

export type SiteCloneCommandEnvelope = SiteCloneRequestedEnvelope | SiteCloneCancelEnvelope

export interface SiteBundleFile {
  kind: 'DOCUMENT' | 'RESOURCE'
  localPath: string
  sourceUrl: string
  contentType: string
  body: Buffer
}

export interface SiteResourceGap {
  sourceUrl: string
  resourceType: string
  reason: string
}

export interface SitePageBundle {
  schemaVersion: 1
  pageId: string
  sourceFinalUrl: string
  publicFinalUrl: string
  mainPath: string
  capturedAt: string
  resourceGaps?: SiteResourceGap[]
  design?: {
    locale: string
    semanticRole: import('./design-clone.js').SemanticRole
    routeTemplate: string
    layoutFingerprint: string | null
    layoutFingerprintVersion: string
  }
  files: SiteBundleFile[]
}

export interface CapturePageOptions {
  mainPath?: string
  contentAddressedResources?: boolean
  includeSiteBundle?: boolean
  preserveUnmatchedReferences?: boolean
  captureScreenshot?: boolean
  browserContext?: import('playwright').BrowserContext
  browserVersion?: string
}

export interface RenderedMetadata {
  title: string
  description: string
  canonicalUrl: string
  metaRobots: string
  h1: string[]
  wordCount: number
  linkCount: number
  imageCount: number
  openGraph: { title: string; description: string; imageUrl: string }
  schemaOrgTypes: string[]
}

export interface DiffSummary {
  staticObservedAt: string | null
  renderedObservedAt: string
  titleChanged: boolean
  descriptionChanged: boolean
  canonicalChanged: boolean
  h1Changed: boolean
  contentChanged: boolean
  linkCountDelta: number
  imageCountDelta: number
  schemaTypesChanged: boolean
}

export interface Measurement {
  status: 'AVAILABLE' | 'UNAVAILABLE'
  value: number | null
  unit: 'ms' | 'score'
  source: 'PLAYWRIGHT_LAB'
  profileVersion: string
  unavailableReason: string | null
}

export interface PerformanceSummary {
  lcp: Measurement
  cls: Measurement
  ttfb: Measurement
}

export interface NetworkRecord {
  requestId: string
  sequence: number
  url: string
  method: string
  resourceType: string
  statusCode: number
  mimeType: string
  responseBytes: number
  durationMs: number
  failureCode: string
}

export interface ResourceBody {
  resourceId: string
  sequence: number
  url: string
  resourceType: string
  mimeType: string
  body: Buffer
  wasTruncated: boolean
}

export interface CloneInputResource {
  sequence: number
  sourceUrl: string
  publicUrl: string
  resourceType: string
  mimeType: string
  body: Buffer | null
  wasTruncated: boolean
  skipReason: string | null
}

export interface ReconstructionBuild {
  status: 'PUBLISHED' | 'PARTIAL' | 'FAILED'
  engineVersion: string
  discoveredCount: number
  packagedCount: number
  skippedCount: number
  inputBytes: number
  archiveBytes: number | null
  completenessCode: string | null
  failureCode: string | null
  archivePath: string | null
  temporaryDirectory: string | null
  manifest: Buffer | null
  siteBundle: Omit<SitePageBundle, 'pageId'> | null
}

export interface CaptureResult {
  finalUrl: string
  html: Buffer
  screenshot: Buffer
  rendered: RenderedMetadata
  diff: DiffSummary
  performance: PerformanceSummary
  network: NetworkRecord[]
  resourceBodies: ResourceBody[]
  browserVersion: string
  observedAt: string
  totalTransferBytes: number
  reconstruction: ReconstructionBuild
}

export interface StoredObject {
  bucket: string
  key: string
  bytes: number
  sha256: Buffer
  contentType: string
}

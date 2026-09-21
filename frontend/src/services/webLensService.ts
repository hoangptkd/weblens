import type {
  Capture,
  DashboardSummary,
  PageResult,
  PageSnapshot,
  Scan,
  ScanPageRecord,
  ScanPagesReport,
  SiteClone,
  Website,
} from '../domain/types'

export interface PageRequest {
  page: number
  size: number
}

export interface WebsiteListRequest extends PageRequest {
  statuses?: Array<'ACTIVE' | 'ARCHIVED'>
  q?: string
  hostname?: string
  createdFrom?: string
  createdTo?: string
  updatedFrom?: string
  updatedTo?: string
  hasActiveScan?: boolean
  sort?: string
}

export interface ScanListRequest extends PageRequest {
  statuses?: Scan['status'][]
  createdFrom?: string
  createdTo?: string
  terminalCode?: string
  minFailedPages?: number
  sort?: string
}

export interface SiteCloneListRequest extends PageRequest {
  statuses?: SiteClone['status'][]
  q?: string
  createdFrom?: string
  createdTo?: string
  terminalCode?: string
  sort?: string
}

export interface ScanPageFilters {
  issuesOnly?: boolean
  outcomes?: Array<'success' | 'warning' | 'failed'>
  statusMin?: number
  statusMax?: number
  q?: string
  indexable?: boolean
  contentTypes?: string[]
  severities?: Array<'info' | 'warning' | 'error' | 'critical'>
  findingCodes?: string[]
}

export interface WebLensService {
  getDashboardSummary(): Promise<DashboardSummary>
  listWebsites(request: WebsiteListRequest): Promise<PageResult<Website>>
  getWebsite(id: string): Promise<Website>
  createWebsite(name: string, url: string): Promise<Website>
  listScans(websiteId: string, request: ScanListRequest): Promise<PageResult<Scan>>
  getScan(id: string): Promise<Scan>
  startScan(websiteId: string, idempotencyKey: string): Promise<Scan>
  cancelScan(id: string): Promise<Scan>
  listScanPages(scanId: string, cursor?: string, limit?: number, filters?: ScanPageFilters): Promise<ScanPagesReport>
  getScanPage(id: string): Promise<ScanPageRecord>
  startCapture(pageId: string, idempotencyKey: string): Promise<Capture>
  getCapture(id: string): Promise<Capture>
  getLatestCapture(scanId: string, pageId: string): Promise<Capture | null>
  getSnapshot(id: string): Promise<PageSnapshot>
  getCaptureScreenshot(id: string): Promise<Blob>
  getCapturedResource(captureId: string, resourceId: string): Promise<Blob>
  getReconstructionArchive(reconstructionId: string): Promise<Blob>
  listSiteClones(request: SiteCloneListRequest): Promise<PageResult<SiteClone>>
  startSiteClone(url: string, idempotencyKey: string): Promise<SiteClone>
  getSiteClone(siteCloneId: string): Promise<SiteClone>
  getSiteCloneProgress(siteCloneId: string, filters: { after: number; status: string; q: string }): Promise<import('../domain/types').SiteCloneProgress>
  cancelSiteClone(siteCloneId: string): Promise<SiteClone>
  getSiteCloneArtifact(siteCloneId: string, artifactId: string): Promise<Blob>
}

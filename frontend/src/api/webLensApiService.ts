import type { Capture, PageResult, PageSnapshot, Scan, ScanPageRecord, ScanPagesReport, SiteClone, Website } from '../domain/types'
import type { WebLensService } from '../services/webLensService'
import { apiBlobRequest, apiRequest } from './apiClient'
import type { ApiCapture, ApiCaptureSnapshot, ApiDashboardSummary, ApiPage, ApiScan, ApiScanPage, ApiScanPages, ApiSiteClone, ApiWebsite } from './contracts'

export const webLensService: WebLensService = {
  async getDashboardSummary() {
    return apiRequest<ApiDashboardSummary>('/api/v1/dashboard/summary')
  },

  async listWebsites(request) {
    const query = new URLSearchParams({
      page: String(request.page),
      size: String(request.size),
      sort: request.sort ?? 'updatedAt,desc',
    })
    appendMany(query, 'status', request.statuses ?? ['ACTIVE'])
    appendOptional(query, 'q', request.q)
    appendOptional(query, 'hostname', request.hostname)
    appendOptional(query, 'createdFrom', request.createdFrom)
    appendOptional(query, 'createdTo', request.createdTo)
    appendOptional(query, 'updatedFrom', request.updatedFrom)
    appendOptional(query, 'updatedTo', request.updatedTo)
    if (request.hasActiveScan !== undefined) query.set('hasActiveScan', String(request.hasActiveScan))
    const page = await apiRequest<ApiPage<ApiWebsite>>(`/api/v1/websites?${query}`)
    return mapPage(page, mapWebsite)
  },

  async getWebsite(id) {
    return mapWebsite(await apiRequest<ApiWebsite>(`/api/v1/websites/${encodeURIComponent(id)}`))
  },

  async createWebsite(name, url) {
    return mapWebsite(await apiRequest<ApiWebsite>('/api/v1/websites', {
      method: 'POST',
      body: JSON.stringify({ name, url }),
    }))
  },

  async listScans(websiteId, request) {
    const query = new URLSearchParams({
      page: String(request.page),
      size: String(request.size),
      sort: request.sort ?? 'createdAt,desc',
    })
    appendMany(query, 'status', request.statuses)
    appendOptional(query, 'createdFrom', request.createdFrom)
    appendOptional(query, 'createdTo', request.createdTo)
    appendOptional(query, 'terminalCode', request.terminalCode)
    if (request.minFailedPages !== undefined) query.set('minFailedPages', String(request.minFailedPages))
    const page = await apiRequest<ApiPage<ApiScan>>(
      `/api/v1/websites/${encodeURIComponent(websiteId)}/scans?${query}`,
    )
    return mapPage(page, mapScan)
  },

  async getScan(id) {
    return mapScan(await apiRequest<ApiScan>(`/api/v1/scans/${encodeURIComponent(id)}`))
  },

  async startScan(websiteId, idempotencyKey) {
    return mapScan(await apiRequest<ApiScan>(`/api/v1/websites/${encodeURIComponent(websiteId)}/scans`, {
      method: 'POST',
      headers: { 'Idempotency-Key': idempotencyKey },
    }))
  },

  async cancelScan(id) {
    return mapScan(await apiRequest<ApiScan>(`/api/v1/scans/${encodeURIComponent(id)}/cancellations`, {
      method: 'POST',
    }))
  },

  async listScanPages(scanId, cursor, limit = 200, filters = {}): Promise<ScanPagesReport> {
    const query = new URLSearchParams({ limit: String(limit), issuesOnly: String(filters.issuesOnly ?? false) })
    if (cursor) query.set('cursor', cursor)
    appendMany(query, 'outcome', filters.outcomes)
    if (filters.statusMin !== undefined) query.set('statusMin', String(filters.statusMin))
    if (filters.statusMax !== undefined) query.set('statusMax', String(filters.statusMax))
    appendOptional(query, 'q', filters.q)
    if (filters.indexable !== undefined) query.set('indexable', String(filters.indexable))
    appendMany(query, 'contentType', filters.contentTypes)
    appendMany(query, 'severity', filters.severities)
    appendMany(query, 'findingCode', filters.findingCodes)
    const response = await apiRequest<ApiScanPages>(`/api/v1/scans/${encodeURIComponent(scanId)}/pages?${query}`)
    return {
      items: response.items.map(mapScanPage),
      summary: response.summary,
      analyticsExpectedCount: response.analyticsExpectedCount,
      analyticsPublishedCount: response.analyticsPublishedCount,
      analyticsWatermark: response.analyticsWatermark ? formatInstant(response.analyticsWatermark) : null,
      fresh: response.fresh,
      nextCursor: response.nextCursor ?? undefined,
    }
  },

  async getScanPage(pageId): Promise<ScanPageRecord> {
    return mapScanPage(await apiRequest<ApiScanPage>(`/api/v1/scan-pages/${encodeURIComponent(pageId)}`))
  },

  async startCapture(pageId, idempotencyKey): Promise<Capture> {
    return mapCapture(await apiRequest<ApiCapture>(`/api/v1/scan-pages/${encodeURIComponent(pageId)}/captures`, {
      method: 'POST',
      headers: { 'Idempotency-Key': idempotencyKey },
    }))
  },

  async getCapture(captureId): Promise<Capture> {
    return mapCapture(await apiRequest<ApiCapture>(`/api/v1/captures/${encodeURIComponent(captureId)}`))
  },

  async getLatestCapture(scanId, pageId): Promise<Capture | null> {
    const source = await apiRequest<ApiCapture | undefined>(`/api/v1/scans/${encodeURIComponent(scanId)}/scan-pages/${encodeURIComponent(pageId)}/captures/latest-ready`)
    return source ? mapCapture(source) : null
  },

  async getSnapshot(captureId): Promise<PageSnapshot> {
    const source = await apiRequest<ApiCaptureSnapshot>(`/api/v1/captures/${encodeURIComponent(captureId)}/snapshot`)
    return {
      id: source.id,
      scanPageId: source.scanPageId,
      status: source.status,
      createdAt: formatInstant(source.createdAt),
      finalUrl: source.finalUrl,
      viewport: source.viewport,
      resourceCount: source.resourceCount,
      capturedResourceCount: source.capturedResourceCount,
      totalBytes: source.totalBytes,
      measurementProfile: source.measurementProfile,
      browserVersion: source.browserVersion,
      rendered: source.rendered,
      diff: source.diff,
      performance: source.performance,
      artifacts: source.artifacts,
      reconstruction: source.reconstruction,
      resources: source.resources,
    }
  },

  async getCaptureScreenshot(captureId): Promise<Blob> {
    return apiBlobRequest(`/api/v1/captures/${encodeURIComponent(captureId)}/artifacts/screenshot`)
  },

  async getCapturedResource(captureId, resourceId): Promise<Blob> {
    return apiBlobRequest(
      `/api/v1/captures/${encodeURIComponent(captureId)}/resources/${encodeURIComponent(resourceId)}/content`,
    )
  },

  async getReconstructionArchive(reconstructionId): Promise<Blob> {
    return apiBlobRequest(
      `/api/v1/reconstructions/${encodeURIComponent(reconstructionId)}/artifacts/archive`,
    )
  },

  async listSiteClones(request) {
    const query = new URLSearchParams({
      page: String(request.page),
      size: String(request.size),
      sort: request.sort ?? 'createdAt,desc',
    })
    appendMany(query, 'status', request.statuses)
    appendOptional(query, 'q', request.q)
    appendOptional(query, 'createdFrom', request.createdFrom)
    appendOptional(query, 'createdTo', request.createdTo)
    appendOptional(query, 'terminalCode', request.terminalCode)
    const page = await apiRequest<ApiPage<ApiSiteClone>>(`/api/v1/site-clones?${query}`)
    return mapPage(page, mapSiteClone)
  },

  async startSiteClone(url, idempotencyKey): Promise<SiteClone> {
    return mapSiteClone(await apiRequest<ApiSiteClone>('/api/v1/site-clones', {
      method: 'POST',
      headers: { 'Idempotency-Key': idempotencyKey },
      body: JSON.stringify({ url }),
    }))
  },

  async getSiteClone(siteCloneId): Promise<SiteClone> {
    return mapSiteClone(await apiRequest<ApiSiteClone>(`/api/v1/site-clones/${encodeURIComponent(siteCloneId)}`))
  },

  async getSiteCloneProgress(siteCloneId, filters) {
    const query = new URLSearchParams({ after: String(filters.after), limit: '50', status: filters.status, q: filters.q })
    return apiRequest<import('../domain/types').SiteCloneProgress>(`/api/v1/site-clones/${encodeURIComponent(siteCloneId)}/progress?${query}`)
  },

  async cancelSiteClone(siteCloneId): Promise<SiteClone> {
    return mapSiteClone(await apiRequest<ApiSiteClone>(
      `/api/v1/site-clones/${encodeURIComponent(siteCloneId)}/cancellations`,
      { method: 'POST' },
    ))
  },

  async getSiteCloneArtifact(siteCloneId, artifactId): Promise<Blob> {
    return apiBlobRequest(
      `/api/v1/site-clones/${encodeURIComponent(siteCloneId)}/artifacts/${encodeURIComponent(artifactId)}`,
    )
  },

  async startSiteCloneBrowserSession(siteCloneId) {
    return apiRequest(`/api/v1/site-clones/${encodeURIComponent(siteCloneId)}/browser-session`, {
      method: 'POST',
    })
  },

  async getSiteCloneBrowserSession(siteCloneId) {
    return apiRequest(`/api/v1/site-clones/${encodeURIComponent(siteCloneId)}/browser-session`)
  },

  async getSiteCloneBrowserScreenshot(siteCloneId) {
    return apiBlobRequest(`/api/v1/site-clones/${encodeURIComponent(siteCloneId)}/browser-session/screenshot`)
  },

  async sendSiteCloneBrowserAction(siteCloneId, action) {
    return apiRequest(`/api/v1/site-clones/${encodeURIComponent(siteCloneId)}/browser-session/actions`, {
      method: 'POST',
      body: JSON.stringify(action),
    })
  },

  async readySiteCloneBrowserSession(siteCloneId) {
    return apiRequest(`/api/v1/site-clones/${encodeURIComponent(siteCloneId)}/browser-session/ready`, {
      method: 'POST',
    })
  },

  async closeSiteCloneBrowserSession(siteCloneId) {
    await apiRequest(`/api/v1/site-clones/${encodeURIComponent(siteCloneId)}/browser-session`, {
      method: 'DELETE',
    })
  },
}

function appendOptional(query: URLSearchParams, name: string, value?: string) {
  const normalized = value?.trim()
  if (normalized) query.set(name, normalized)
}

function appendMany(query: URLSearchParams, name: string, values?: string[]) {
  values?.forEach((value) => query.append(name, value))
}

function mapPage<S, T>(source: ApiPage<S>, mapper: (item: S) => T): PageResult<T> {
  return {
    items: source.items.map(mapper),
    page: source.page,
    size: source.size,
    totalItems: source.totalItems,
    totalPages: source.totalPages,
  }
}

function mapScanPage(source: ApiScanPage): ScanPageRecord {
  return {
    id: source.id,
    scanId: source.scanId,
    path: source.path,
    url: source.url,
    statusCode: source.statusCode ?? undefined,
    outcome: source.outcome,
    responseTimeMs: source.responseTimeMs ?? undefined,
    responseBytes: source.responseBytes ?? undefined,
    title: source.title ?? undefined,
		description: source.description ?? undefined,
		metaKeywords: source.metaKeywords ?? undefined,
		canonicalUrl: source.canonicalUrl ?? undefined,
		canonicalRelation: source.canonicalRelation,
		metaRobots: source.metaRobots ?? undefined,
		xRobotsTag: source.xRobotsTag ?? undefined,
		htmlLang: source.htmlLang ?? undefined,
		indexable: source.indexable,
		indexabilityReason: source.indexabilityReason,
    h1: source.h1 ?? undefined,
		h1Values: source.h1Values,
		h2: source.h2,
		h3: source.h3,
		h4: source.h4,
		h5: source.h5,
		h6: source.h6,
		hreflang: source.hreflang,
		openGraph: {
			title: source.openGraph.title ?? undefined,
			description: source.openGraph.description ?? undefined,
			imageUrl: source.openGraph.imageUrl ?? undefined,
		},
		structuredData: source.structuredData,
    links: source.links,
    images: source.images,
    scripts: source.scripts,
    stylesheets: source.stylesheets,
		timing: {
			dnsMillis: source.timing.dnsMillis ?? undefined,
			connectMillis: source.timing.connectMillis ?? undefined,
			tlsMillis: source.timing.tlsMillis ?? undefined,
			ttfbMillis: source.timing.ttfbMillis ?? undefined,
			totalMillis: source.timing.totalMillis ?? undefined,
		},
    findings: source.findings,
    observedAt: formatInstant(source.observedAt),
  }
}

function mapWebsite(source: ApiWebsite): Website {
  return {
    id: source.id,
    name: source.name,
    url: source.canonicalUrl,
    hostname: source.hostname,
    latestScanId: source.latestScan?.id,
    latestStatus: source.latestScan?.status,
    updatedAt: formatInstant(source.updatedAt),
    pageCount: source.pageCount,
    failedPageCount: source.failedPageCount,
  }
}

function mapScan(source: ApiScan): Scan {
  return {
    id: source.id,
    websiteId: source.websiteId,
    status: source.status,
    createdAt: formatInstant(source.createdAt),
    startedAt: source.startedAt ? formatInstant(source.startedAt) : undefined,
    finishedAt: source.finishedAt ? formatInstant(source.finishedAt) : undefined,
    duration: formatDuration(source.durationMs),
    progress: source.progress,
    collectorVersion: source.collectorVersion,
    effectiveConfig: source.effectiveConfig,
    terminalReason: source.terminalReason ?? undefined,
  }
}

function formatInstant(value: string): string {
  return new Intl.DateTimeFormat('vi-VN', {
    dateStyle: 'short',
    timeStyle: 'short',
  }).format(new Date(value))
}

function formatDuration(milliseconds: number | null): string {
  if (milliseconds === null) return '—'
  const totalSeconds = Math.floor(milliseconds / 1000)
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
}

function mapCapture(source: ApiCapture): Capture {
  return {
    id: source.id,
    scanId: source.scanId,
    pageId: source.pageId,
    status: source.status,
    targetUrl: source.targetUrl,
    measurementProfile: source.measurementProfile,
    analyticsExpectedCount: source.analyticsExpectedCount,
    analyticsPublishedCount: source.analyticsPublishedCount,
    objectCount: source.objectCount,
    totalObjectBytes: source.totalObjectBytes,
    terminalCode: source.terminalCode ?? undefined,
    terminalMessage: source.terminalMessage ?? undefined,
    createdAt: formatInstant(source.createdAt),
  }
}

function mapSiteClone(source: ApiSiteClone): SiteClone {
  return {
    id: source.id,
    websiteId: source.websiteId ?? undefined,
    scanId: source.scanId,
    targetUrl: source.targetUrl,
    status: source.status,
    discoveredCount: source.discoveredCount,
    processedCount: source.processedCount,
    succeededCount: source.succeededCount,
    failedCount: source.failedCount,
    artifactCount: source.artifactCount,
    totalArchiveBytes: source.totalArchiveBytes,
    terminalCode: source.terminalCode ?? undefined,
    terminalMessage: source.terminalMessage ?? undefined,
    createdAt: formatInstant(source.createdAt),
    startedAt: source.startedAt ? formatInstant(source.startedAt) : undefined,
    finishedAt: source.finishedAt ? formatInstant(source.finishedAt) : undefined,
    artifacts: source.artifacts.map((artifact) => ({
      ...artifact,
      expiresAt: formatInstant(artifact.expiresAt),
    })),
  }
}

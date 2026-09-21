import type { Config } from './config.js'

export interface CrawlerPageTarget {
  id: string
  scanId: string
  url: string
  finalUrl: string | null
  outcome: 'success' | 'warning' | 'failed'
  statusCode: number
  contentType: string
  canonicalUrl: string
  htmlLang: string
  hreflang: Array<{ language: string; url: string }>
  h1: string[]
  h2: string[]
  schemaOrgTypes: string[]
  scripts: number
  stylesheets: number
}

interface PageBatch {
  items: CrawlerPageTarget[]
  nextCursor?: string | null
}

export class CrawlerReportClient {
  constructor(private readonly config: Pick<Config, 'crawlerReportBaseUrl' | 'serviceToken'>) {}

  async listPages(ownerId: string, scanId: string, cursor?: string): Promise<PageBatch> {
    const url = new URL(`/internal/v1/reports/scans/${encodeURIComponent(scanId)}/pages`, this.config.crawlerReportBaseUrl)
    url.searchParams.set('ownerId', ownerId)
    url.searchParams.set('limit', '500')
    if (cursor) url.searchParams.set('cursor', cursor)
    const batch = await this.request<PageBatch>(url)
    return { ...batch, items: batch.items.map(normalizePage) }
  }

  async getPage(ownerId: string, pageId: string): Promise<CrawlerPageTarget> {
    const url = new URL(`/internal/v1/reports/pages/${encodeURIComponent(pageId)}`, this.config.crawlerReportBaseUrl)
    url.searchParams.set('ownerId', ownerId)
    return normalizePage(await this.request<CrawlerPageTarget>(url))
  }

  private async request<T>(url: URL): Promise<T> {
    const response = await fetch(url, {
      headers: { 'X-WebLens-Service-Token': this.config.serviceToken },
      signal: AbortSignal.timeout(15_000),
    })
    if (!response.ok) throw new Error(`CRAWLER_REPORT_HTTP_${response.status}`)
    return await response.json() as T
  }
}

function normalizePage(page: CrawlerPageTarget): CrawlerPageTarget {
  const outcome = String(page.outcome).toLowerCase()
  return {
    ...page,
    outcome: outcome === 'success' || outcome === 'warning' ? outcome : 'failed',
    statusCode: Number.isInteger(page.statusCode) ? page.statusCode : 0,
    contentType: page.contentType ?? '',
    canonicalUrl: page.canonicalUrl ?? '',
    htmlLang: page.htmlLang ?? '',
    hreflang: Array.isArray(page.hreflang) ? page.hreflang : [],
    h1: Array.isArray(page.h1) ? page.h1 : [],
    h2: Array.isArray(page.h2) ? page.h2 : [],
    schemaOrgTypes: Array.isArray(page.schemaOrgTypes) ? page.schemaOrgTypes : [],
    scripts: Number.isInteger(page.scripts) ? page.scripts : 0,
    stylesheets: Number.isInteger(page.stylesheets) ? page.stylesheets : 0,
  }
}

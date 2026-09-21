import { createHash } from 'node:crypto'
import { parse } from 'parse5'

export const DESIGN_CLONE_POLICY_VERSION = 'design-clone-v1'
export const LAYOUT_FINGERPRINT_VERSION = 'dom-structure-v1'

export type SemanticRole =
  | 'HOME'
  | 'MARKETING_LANDING'
  | 'PRODUCT_LIST'
  | 'PRODUCT_DETAIL'
  | 'PRICING'
  | 'CONTACT'
  | 'DOWNLOAD'
  | 'PARTNER'
  | 'AFFILIATE'
  | 'AUTH_LOGIN'
  | 'AUTH_REGISTER'
  | 'AUTH_FORGOT_PASSWORD'
  | 'AUTH_VERIFY_OR_STATUS'
  | 'BLOG_INDEX'
  | 'BLOG_DETAIL'
  | 'USE_CASE_INDEX'
  | 'USE_CASE_DETAIL'
  | 'COMPARISON_DETAIL'
  | 'LEGAL_TEXT'
  | 'ERROR_4XX'
  | 'ERROR_5XX'
  | 'UNKNOWN'

export type DesignRejectionReason =
  | 'ALTERNATE_LOCALE'
  | 'TRACKING_OR_QUERY_VARIANT'
  | 'CANONICAL_DUPLICATE'
  | 'SEMANTIC_TEMPLATE_DUPLICATE'
  | 'LAYOUT_DUPLICATE'
  | 'NON_HTML'
  | 'EXTERNAL_ORIGIN'
  | 'ROBOTS_OR_POLICY_BLOCKED'
  | 'HTTP_FAILURE'
  | 'BUDGET_LIMITED'

export interface DesignPageInput {
  id: string
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

export interface DesignCandidate {
  page: DesignPageInput
  normalizedUrl: string
  locale: string
  semanticRole: SemanticRole
  routeTemplate: string
}

export interface DesignRejection {
  page: DesignPageInput
  normalizedUrl: string
  reason: DesignRejectionReason
}

export interface DesignSelection {
  locale: string
  discoveredCount: number
  selected: DesignCandidate[]
  rejected: DesignRejection[]
}

export function describeDesignPage(rootUrl: string, page: DesignPageInput): DesignCandidate {
  const normalizedUrl = normalizeDesignUrl(page.finalUrl || page.url)
  const rootLocale = localeFromPath(new URL(normalizeDesignUrl(rootUrl))) || normalizeLocale(page.htmlLang) || 'und'
  const locale = inferPageLocale(new URL(normalizedUrl), page)
  const semanticRole = classifySemanticRole(normalizedUrl, page.statusCode, page.h1)
  return {
    page,
    normalizedUrl,
    locale: locale === 'und' ? rootLocale : locale,
    semanticRole,
    routeTemplate: inferRouteTemplate(normalizedUrl, semanticRole, rootLocale),
  }
}

interface HtmlNode {
  nodeName?: string
  tagName?: string
  value?: string
  attrs?: Array<{ name: string; value: string }>
  childNodes?: HtmlNode[]
}

const TRACKING_QUERY = /^(?:utm_.+|ref|from|gclid|fbclid)$/iu
const DOWNLOAD_EXTENSION = /\.(?:7z|avi|csv|docx?|exe|gz|mp3|mp4|mov|pdf|rar|tar|webm|xlsx?|zip)$/iu
const STATIC_EXTENSION = /\.(?:avif|bmp|css|gif|ico|jpe?g|js|json|map|png|svg|webp|woff2?|xml)$/iu
const IDENTIFIER_SEGMENT = /^(?:\d+|[0-9a-f]{16,}|[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12})$/iu

export function selectDesignPages(
  rootUrl: string,
  pages: DesignPageInput[],
  budgetLimited = false,
): DesignSelection {
  const normalizedRoot = normalizeDesignUrl(rootUrl)
  const rootOrigin = new URL(normalizedRoot).origin
  const ordered = [...pages].sort((left, right) => pageOrder(left, right))
  const rootPage = ordered.find((page) => {
    const raw = page.finalUrl || page.url
    return safeNormalize(raw) === normalizedRoot
  })
  const locale = inferRootLocale(normalizedRoot, rootPage)
  const candidates: Array<DesignCandidate & {
    identity: string
    staticHint: string
    hadQuery: boolean
    canonicalSelfReference: boolean
  }> = []
  const rejected: DesignRejection[] = []

  for (const page of ordered) {
    const rawUrl = page.finalUrl || page.url
    let parsed: URL
    try {
      parsed = new URL(rawUrl)
    } catch {
      rejected.push(rejection(page, '', 'HTTP_FAILURE'))
      continue
    }
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.origin !== rootOrigin) {
      rejected.push(rejection(page, redactUrl(rawUrl), 'EXTERNAL_ORIGIN'))
      continue
    }
    const normalizedUrl = normalizeDesignUrl(rawUrl)
    if (!isHtmlPage(page, parsed)) {
      rejected.push(rejection(page, normalizedUrl, 'NON_HTML'))
      continue
    }
    if (page.outcome === 'warning') {
      rejected.push(rejection(page, normalizedUrl, 'ROBOTS_OR_POLICY_BLOCKED'))
      continue
    }
    if ((page.outcome === 'failed' || page.statusCode === 0)
        && !(page.statusCode >= 400 && page.statusCode < 600)) {
      rejected.push(rejection(page, normalizedUrl, 'HTTP_FAILURE'))
      continue
    }
    if (isPolicyBlocked(parsed)) {
      rejected.push(rejection(page, normalizedUrl, 'ROBOTS_OR_POLICY_BLOCKED'))
      continue
    }
    const pageLocale = inferPageLocale(parsed, page)
    if (locale !== 'und' && pageLocale !== 'und' && pageLocale !== locale) {
      rejected.push(rejection(page, normalizedUrl, 'ALTERNATE_LOCALE'))
      continue
    }
    const semanticRole = classifySemanticRole(normalizedUrl, page.statusCode, page.h1)
    const routeTemplate = inferRouteTemplate(normalizedUrl, semanticRole, locale)
    const canonical = sameOriginCanonical(page.canonicalUrl, rootOrigin)
    const identity = stripQuery(canonical || normalizedUrl)
    candidates.push({
      page,
      normalizedUrl,
      locale: pageLocale === 'und' ? locale : pageLocale,
      semanticRole,
      routeTemplate,
      identity,
      staticHint: staticLayoutHint(page),
      hadQuery: new URL(rawUrl).search.length > 0,
      canonicalSelfReference: canonical !== null && stripQuery(canonical) === stripQuery(normalizedUrl),
    })
  }

  const canonicalWinners = new Map<string, typeof candidates[number]>()
  for (const candidate of [...candidates].sort(candidateOrder)) {
    const winner = canonicalWinners.get(candidate.identity)
    if (!winner) {
      canonicalWinners.set(candidate.identity, candidate)
      continue
    }
    rejected.push(rejection(
      candidate.page,
      candidate.normalizedUrl,
      sameOriginCanonical(candidate.page.canonicalUrl, rootOrigin)
        ? 'CANONICAL_DUPLICATE'
        : 'TRACKING_OR_QUERY_VARIANT',
    ))
  }

  const groupWinners = new Map<string, typeof candidates[number]>()
  for (const candidate of [...canonicalWinners.values()].sort(candidateOrder)) {
    const key = `${candidate.semanticRole}\n${candidate.routeTemplate}\n${candidate.staticHint}`
    const winner = groupWinners.get(key)
    if (!winner) {
      groupWinners.set(key, candidate)
      continue
    }
    rejected.push(rejection(candidate.page, candidate.normalizedUrl, 'SEMANTIC_TEMPLATE_DUPLICATE'))
  }

  const selected = [...groupWinners.values()].sort((left, right) => pageOrder(left.page, right.page))
    .map(({
      identity: _identity,
      staticHint: _staticHint,
      hadQuery: _hadQuery,
      canonicalSelfReference: _canonicalSelfReference,
      ...candidate
    }) => candidate)
  if (budgetLimited && ordered.length > 1) {
    const bounded = ordered.at(-1)!
    const boundedUrl = safeNormalize(bounded.finalUrl || bounded.url)
    const selectedIndex = selected.findIndex((candidate) => candidate.page.id === bounded.id)
    if (selectedIndex >= 0) selected.splice(selectedIndex, 1)
    const rejectedIndex = rejected.findIndex((candidate) => candidate.page.id === bounded.id)
    if (rejectedIndex >= 0) rejected.splice(rejectedIndex, 1)
    rejected.push(rejection(bounded, boundedUrl, 'BUDGET_LIMITED'))
  }
  return {
    locale,
    discoveredCount: pages.length,
    selected,
    rejected: rejected.sort((left, right) => pageOrder(left.page, right.page)),
  }
}

export function normalizeDesignUrl(rawUrl: string): string {
  const url = new URL(rawUrl)
  url.username = ''
  url.password = ''
  url.hash = ''
  for (const key of [...url.searchParams.keys()]) {
    if (TRACKING_QUERY.test(key)) url.searchParams.delete(key)
  }
  url.searchParams.sort()
  if (url.pathname.length > 1) url.pathname = url.pathname.replace(/\/+$/u, '')
  return url.toString()
}

export function classifySemanticRole(
  rawUrl: string,
  statusCode = 200,
  headings: readonly string[] = [],
): SemanticRole {
  if (statusCode >= 500 && statusCode < 600) return 'ERROR_5XX'
  if (statusCode >= 400 && statusCode < 500) return 'ERROR_4XX'
  const url = new URL(rawUrl)
  const segments = url.pathname.toLowerCase().split('/').filter(Boolean)
  const path = `/${segments.join('/')}`
  const text = headings.join(' ').toLowerCase()
  if (segments.length === 0 || (segments.length === 1 && isLocale(segments[0]!))) return 'HOME'
  if (matches(path, /\/(?:login|log-in|sign-in|signin|dang-nhap)(?:\/|$)/u)) return 'AUTH_LOGIN'
  if (matches(path, /\/(?:register|sign-up|signup|create-account|dang-ky)(?:\/|$)/u)) return 'AUTH_REGISTER'
  if (matches(path, /\/(?:forgot|forgot-password|reset-password|recover|quen-mat-khau)(?:\/|$)/u)) {
    return 'AUTH_FORGOT_PASSWORD'
  }
  if (matches(path, /\/(?:verify|verify-email|verification|email-verification|activate|confirm-email|auth-status|account-status)(?:\/|$)/u)) {
    return 'AUTH_VERIFY_OR_STATUS'
  }
  if (matches(path, /\/(?:pricing|plans|bang-gia)(?:\/|$)/u)) return 'PRICING'
  if (matches(path, /\/(?:contact|contact-us|lien-he)(?:\/|$)/u)) return 'CONTACT'
  if (matches(path, /\/(?:download|downloads|tai-ve)(?:\/|$)/u)) return 'DOWNLOAD'
  if (matches(path, /\/(?:partners?|doi-tac)(?:\/|$)/u)) return 'PARTNER'
  if (matches(path, /\/(?:affiliate|affiliates)(?:\/|$)/u)) return 'AFFILIATE'
  if (matches(path, /\/(?:privacy|terms|legal|cookies?|policy|dieu-khoan)(?:\/|$)/u)) return 'LEGAL_TEXT'
  if (matches(path, /\/(?:vs|compare|comparison)\//u)) return 'COMPARISON_DETAIL'
  const blogIndex = indexWithin(segments, ['blog', 'blogs', 'news', 'articles', 'tin-tuc'])
  if (blogIndex >= 0) return segments.length === blogIndex + 1 ? 'BLOG_INDEX' : 'BLOG_DETAIL'
  const useCaseIndex = indexWithin(segments, ['use-case', 'use-cases', 'case-study', 'case-studies'])
  if (useCaseIndex >= 0) return segments.length === useCaseIndex + 1 ? 'USE_CASE_INDEX' : 'USE_CASE_DETAIL'
  const productIndex = indexWithin(segments, ['product', 'products', 'san-pham'])
  if (productIndex >= 0) return segments.length === productIndex + 1 ? 'PRODUCT_LIST' : 'PRODUCT_DETAIL'
  if (/\b(?:sign in|log in|đăng nhập)\b/iu.test(text)) return 'AUTH_LOGIN'
  if (/\b(?:sign up|register|đăng ký)\b/iu.test(text)) return 'AUTH_REGISTER'
  return segments.length <= (isLocale(segments[0]!) ? 2 : 1) ? 'MARKETING_LANDING' : 'UNKNOWN'
}

export function inferRouteTemplate(rawUrl: string, role: SemanticRole, locale = 'und'): string {
  if (role === 'ERROR_4XX') return '/{error-4xx}'
  if (role === 'ERROR_5XX') return '/{error-5xx}'
  const url = new URL(rawUrl)
  const segments = url.pathname.split('/').filter(Boolean)
  const start = locale !== 'und' && segments[0]?.toLowerCase() === locale ? 1 : 0
  const detailRoles = new Set<SemanticRole>([
    'PRODUCT_DETAIL', 'BLOG_DETAIL', 'USE_CASE_DETAIL', 'COMPARISON_DETAIL',
  ])
  const templated = segments.map((segment, index) => {
    if (IDENTIFIER_SEGMENT.test(segment)) return '{id}'
    if (detailRoles.has(role) && index === segments.length - 1 && index >= start) return '{slug}'
    return segment.toLowerCase()
  })
  return `/${templated.join('/')}` || '/'
}

export function layoutFingerprint(html: Buffer | string): string | null {
  try {
    const document = parse(Buffer.isBuffer(html) ? html.toString('utf8') : html) as unknown as HtmlNode
    const tokens: string[] = []
    let visited = 0
    const walk = (node: HtmlNode): void => {
      if (visited >= 50_000) return
      if (node.tagName) {
        visited += 1
        const classValue = node.attrs?.find((attribute) => attribute.name.toLowerCase() === 'class')?.value ?? ''
        const classes = classValue.split(/\s+/u).filter(Boolean).sort().slice(0, 32).join('.')
        const role = node.attrs?.find((attribute) => attribute.name.toLowerCase() === 'role')?.value.trim().toLowerCase() ?? ''
        tokens.push(`<${node.tagName.toLowerCase()}${classes ? `.${classes}` : ''}${role ? `[role=${role}]` : ''}>`)
      }
      node.childNodes?.forEach(walk)
      if (node.tagName) tokens.push(`</${node.tagName.toLowerCase()}>`)
    }
    walk(document)
    if (visited === 0) return null
    return createHash('sha256').update(tokens.join(''), 'utf8').digest('hex')
  } catch {
    return null
  }
}

function inferRootLocale(rootUrl: string, rootPage: DesignPageInput | undefined): string {
  const url = new URL(rootUrl)
  return localeFromPath(url)
    || normalizeLocale(rootPage?.htmlLang)
    || localeFromCanonical(rootPage?.canonicalUrl, url.origin)
    || localeFromHreflang(url, rootPage?.hreflang)
    || 'und'
}

function inferPageLocale(url: URL, page: DesignPageInput): string {
  return localeFromPath(url)
    || normalizeLocale(page.htmlLang)
    || localeFromCanonical(page.canonicalUrl, url.origin)
    || localeFromHreflang(url, page.hreflang)
    || 'und'
}

function localeFromCanonical(rawCanonical: string | null | undefined, origin: string): string | null {
  if (!rawCanonical?.trim()) return null
  try {
    const canonical = new URL(rawCanonical, origin)
    return canonical.origin === origin ? localeFromPath(canonical) : null
  } catch {
    return null
  }
}

function localeFromHreflang(
  pageUrl: URL,
  entries: Array<{ language: string; url: string }> | undefined,
): string | null {
  const pageIdentity = stripQuery(normalizeDesignUrl(pageUrl.toString()))
  for (const entry of entries ?? []) {
    const language = normalizeLocale(entry.language)
    if (!language) continue
    try {
      const alternate = new URL(entry.url, pageUrl)
      if (alternate.origin === pageUrl.origin
          && stripQuery(normalizeDesignUrl(alternate.toString())) === pageIdentity) return language
    } catch {
      // Ignore malformed hreflang entries from untrusted pages.
    }
  }
  return null
}

function localeFromPath(url: URL): string | null {
  const first = url.pathname.split('/').filter(Boolean)[0]
  return first && isLocale(first) ? normalizeLocale(first) : null
}

function normalizeLocale(value: string | null | undefined): string | null {
  const normalized = value?.trim().replaceAll('_', '-').toLowerCase()
  return normalized && isLocale(normalized) ? normalized : null
}

function isLocale(value: string): boolean {
  return /^[a-z]{2,3}(?:-[a-z]{2}|-[0-9]{3})?$/iu.test(value)
}

function sameOriginCanonical(rawCanonical: string, origin: string): string | null {
  if (!rawCanonical.trim()) return null
  try {
    const canonical = new URL(rawCanonical, origin)
    return canonical.origin === origin ? normalizeDesignUrl(canonical.toString()) : null
  } catch {
    return null
  }
}

function isHtmlPage(page: DesignPageInput, url: URL): boolean {
  const contentType = page.contentType.split(';')[0]?.trim().toLowerCase() ?? ''
  if (contentType && contentType !== 'text/html' && contentType !== 'application/xhtml+xml') return false
  return !DOWNLOAD_EXTENSION.test(url.pathname) && !STATIC_EXTENSION.test(url.pathname)
}

function isPolicyBlocked(url: URL): boolean {
  return /\/(?:api|feeds?|robots\.txt|sitemaps?)(?:\/|\.|$)/iu.test(url.pathname)
}

function staticLayoutHint(page: DesignPageInput): string {
  // ponytail: crawler metadata is the bounded pre-render layout proxy; add a
  // deterministic sample per group if production fixtures show false merges.
  return [
    Math.trunc(page.statusCode / 100),
    page.h1.length,
    page.h2.length,
    page.scripts,
    page.stylesheets,
    [...page.schemaOrgTypes].map((value) => value.toLowerCase()).sort().join(','),
  ].join('|')
}

function candidateOrder(
  left: DesignCandidate & { hadQuery: boolean; canonicalSelfReference: boolean },
  right: DesignCandidate & { hadQuery: boolean; canonicalSelfReference: boolean },
): number {
  return Number(left.hadQuery) - Number(right.hadQuery)
    || Number(right.canonicalSelfReference) - Number(left.canonicalSelfReference)
    || statusRank(left.page.statusCode) - statusRank(right.page.statusCode)
    || left.normalizedUrl.length - right.normalizedUrl.length
    || left.normalizedUrl.localeCompare(right.normalizedUrl)
    || left.page.id.localeCompare(right.page.id)
}

function statusRank(status: number): number {
  if (status >= 200 && status < 300) return 0
  if (status >= 300 && status < 400) return 1
  if (status >= 400 && status < 500) return 2
  if (status >= 500 && status < 600) return 3
  return 4
}

function pageOrder(left: DesignPageInput, right: DesignPageInput): number {
  const leftUrl = left.finalUrl || left.url
  const rightUrl = right.finalUrl || right.url
  return leftUrl.localeCompare(rightUrl) || left.id.localeCompare(right.id)
}

function stripQuery(rawUrl: string): string {
  const url = new URL(rawUrl)
  url.search = ''
  return url.toString()
}

function safeNormalize(rawUrl: string): string {
  try { return normalizeDesignUrl(rawUrl) } catch { return '' }
}

function redactUrl(rawUrl: string): string {
  try {
    const url = new URL(rawUrl)
    url.username = ''
    url.password = ''
    url.hash = ''
    for (const key of [...url.searchParams.keys()]) url.searchParams.set(key, '[REDACTED]')
    return url.toString()
  } catch {
    return ''
  }
}

function rejection(page: DesignPageInput, normalizedUrl: string, reason: DesignRejectionReason): DesignRejection {
  return { page, normalizedUrl, reason }
}

function matches(value: string, expression: RegExp): boolean {
  return expression.test(value)
}

function indexWithin(segments: string[], values: string[]): number {
  return segments.findIndex((segment) => values.includes(segment))
}

import { createHash, randomUUID } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { posix } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { parse, serialize } from 'parse5'
import { ZipFile } from 'yazl'
import { sanitizeUrl } from './capture.js'
import { DESIGN_CLONE_POLICY_VERSION, LAYOUT_FINGERPRINT_VERSION } from './design-clone.js'
import { log } from './log.js'
import type {
  SitePageBundle,
  SiteBundleFile,
} from './types.js'
import type {
  SitePageBundleReference,
  SitePageOutcome,
  SiteRoute,
} from './site-database.js'

interface HtmlNode {
  tagName?: string
  value?: string
  attrs?: Array<{ name: string; value: string }>
  childNodes?: HtmlNode[]
}

export interface SiteArchivePart {
  path: string
  logicalFilename: string
  shardNumber: number
  bytes: number
  sha256Hex: string
}

export interface SiteArchiveBuild {
  temporaryDirectory: string
  parts: SiteArchivePart[]
  manifest: Buffer
}

interface RepresentativePage {
  reference: SitePageBundleReference
  sourceFinalUrl: string
  publicFinalUrl: string
  design: SitePageBundle['design']
}

export function sitePagePath(rootUrl: string, targetUrl: string, pageId: string): string {
  if (normalizeRawUrl(rootUrl) === normalizeRawUrl(targetUrl)) return 'index.html'
  return posix.join('pages', `${pageId}.html`)
}

export function rawUrlHash(rawUrl: string): Buffer {
  return createHash('sha256').update(normalizeRawUrl(rawUrl), 'utf8').digest()
}

export function encodeSiteBundle(bundle: SitePageBundle): Buffer {
  return Buffer.from(JSON.stringify({
    ...bundle,
    files: bundle.files.map((file) => ({ ...file, bodyBase64: file.body.toString('base64'), body: undefined })),
  }), 'utf8')
}

export function decodeSiteBundle(encoded: Buffer, expectedPageId: string): SitePageBundle {
  const value = JSON.parse(encoded.toString('utf8')) as {
    schemaVersion?: number
    pageId?: string
    sourceFinalUrl?: string
    publicFinalUrl?: string
    mainPath?: string
    capturedAt?: string
    design?: SitePageBundle['design']
    files?: Array<Omit<SiteBundleFile, 'body'> & { bodyBase64?: string }>
  }
  if (value.schemaVersion !== 1 || value.pageId !== expectedPageId
      || typeof value.sourceFinalUrl !== 'string' || typeof value.publicFinalUrl !== 'string'
      || typeof value.mainPath !== 'string' || typeof value.capturedAt !== 'string'
      || !Array.isArray(value.files) || value.files.length === 0 || value.files.length > 101) {
    throw new Error('INVALID_SITE_PAGE_BUNDLE')
  }
  const files = value.files.map((file): SiteBundleFile => {
    if ((file.kind !== 'DOCUMENT' && file.kind !== 'RESOURCE')
        || typeof file.localPath !== 'string' || typeof file.sourceUrl !== 'string'
        || typeof file.contentType !== 'string' || typeof file.bodyBase64 !== 'string') {
      throw new Error('INVALID_SITE_PAGE_BUNDLE')
    }
    const body = Buffer.from(file.bodyBase64, 'base64')
    if (body.length === 0 || body.length > 52_428_800) throw new Error('INVALID_SITE_PAGE_BUNDLE')
    return {
      kind: file.kind,
      localPath: safeArchivePath(file.localPath),
      sourceUrl: file.sourceUrl,
      contentType: file.contentType,
      body,
    }
  })
  const design = decodeDesignMetadata(value.design)
  return {
    schemaVersion: 1,
    pageId: value.pageId,
    sourceFinalUrl: value.sourceFinalUrl,
    publicFinalUrl: value.publicFinalUrl,
    mainPath: safeArchivePath(value.mainPath),
    capturedAt: value.capturedAt,
    ...(design ? { design } : {}),
    files,
  }
}

function decodeDesignMetadata(value: SitePageBundle['design'] | undefined): SitePageBundle['design'] | undefined {
  if (value === undefined) return undefined
  if (!value || typeof value.locale !== 'string' || value.locale.length > 35
      || typeof value.semanticRole !== 'string' || value.semanticRole.length > 64
      || typeof value.routeTemplate !== 'string' || value.routeTemplate.length > 512
      || (value.layoutFingerprint !== null && !/^[0-9a-f]{64}$/u.test(value.layoutFingerprint))
      || value.layoutFingerprintVersion !== LAYOUT_FINGERPRINT_VERSION) {
    throw new Error('INVALID_SITE_PAGE_DESIGN_METADATA')
  }
  return value
}

export function rewriteSiteNavigation(
  html: Buffer,
  sourceUrl: string,
  sourcePath: string,
  routes: ReadonlyMap<string, string>,
): Buffer {
  const document = parse(html.toString('utf8')) as unknown as HtmlNode
  visit(document, (node) => {
    if (node.tagName !== 'a' && node.tagName !== 'area') return
    const href = node.attrs?.find((attribute) => attribute.name.toLowerCase() === 'href')
    if (!href || !href.value || /^(?:data|blob|about|javascript|mailto|tel):/iu.test(href.value)) return
    try {
      const target = new URL(href.value, sourceUrl)
      const fragment = target.hash
      target.hash = ''
      const route = routes.get(rawUrlHash(target.toString()).toString('hex'))
      href.value = route
        ? relativeArchivePath(sourcePath, route) + fragment
        : sanitizeUrl(target.toString()) + fragment
    } catch {
      href.value = ''
    }
  })
  return Buffer.from(serialize(document as never), 'utf8')
}

export async function buildSiteArchives(
  rootUrl: string,
  bundles: SitePageBundleReference[],
  outcomes: SitePageOutcome[],
  routes: SiteRoute[],
  maxShardBytes: number,
  maxArchiveBytes: number,
  loadBundle: (reference: SitePageBundleReference) => Promise<Buffer>,
  budgets?: { maxPages: number; maxInputBytes: number },
): Promise<SiteArchiveBuild> {
  const temporaryDirectory = await mkdtemp(posix.join(tmpdir().replaceAll('\\', '/'), 'weblens-site-clone-'))
  const written = new Map<string, string>()
  const canonicalResourcePath = new Map<string, string>()
  const resourceAliases = new Map<string, string>()
  const parts: SiteArchivePart[] = []
  const archiveLabel = `${new Date().toISOString().replaceAll('-', '').replaceAll(':', '').replace('.', '')}-${randomUUID().slice(0, 8)}`
  let totalArchiveInput = 0
  let current: OpenShard | null = null

  const ensureShard = async (nextBytes: number): Promise<OpenShard> => {
    if (nextBytes > maxShardBytes) throw new Error('SITE_FILE_EXCEEDS_SHARD_BUDGET')
    if (current && current.inputBytes > 0 && current.inputBytes + nextBytes > maxShardBytes) {
      parts.push(await closeShard(current, maxShardBytes))
      current = null
    }
    if (!current) current = openShard(temporaryDirectory, parts.length + 1, archiveLabel)
    return current
  }

  try {
    const indexed: RepresentativePage[] = []
    for (const reference of bundles) {
      const bundle = decodeSiteBundle(await loadBundle(reference), reference.pageId)
      indexed.push({
        reference,
        sourceFinalUrl: bundle.sourceFinalUrl,
        publicFinalUrl: bundle.publicFinalUrl,
        design: bundle.design,
      })
    }
    const representatives = selectRepresentatives(indexed)
    const sourceUrlToLocalPath = new Map<string, string>()
    for (const { reference } of representatives.selected) {
      const bundle = decodeSiteBundle(await loadBundle(reference), reference.pageId)
      for (const file of bundle.files) {
        if (file.kind !== 'RESOURCE') continue
        const path = safeArchivePath(file.localPath)
        const hash = createHash('sha256').update(file.body).digest('hex')
        const representation = posix.extname(path).toLowerCase()
          || file.contentType.split(';')[0]?.trim().toLowerCase()
          || 'application/octet-stream'
        const contentKey = `${hash}\n${representation}`
        const canonical = canonicalResourcePath.get(contentKey)
        let effectivePath: string
        if (canonical && canonical.toLowerCase() !== path.toLowerCase()) {
          resourceAliases.set(path.toLowerCase(), canonical)
          effectivePath = canonical
        } else {
          canonicalResourcePath.set(contentKey, path)
          effectivePath = path
        }
        // Map source URL → local archive path for CSS rewrite during assembly.
        // Multiple pages may capture the same resource; first occurrence wins.
        const normalizedUrl = normalizeSourceUrl(file.sourceUrl)
        if (!sourceUrlToLocalPath.has(normalizedUrl)) {
          sourceUrlToLocalPath.set(normalizedUrl, effectivePath)
        }
      }
    }
    const keptPaths = new Set(representatives.selected.map(({ reference }) => reference.localPath))
    const routeMap = new Map(
      routes.filter((route) => keptPaths.has(route.localPath))
        .map((route) => [route.urlSha256Hex, route.localPath]),
    )
    for (const selected of representatives.selected) {
      routeMap.set(rawUrlHash(selected.sourceFinalUrl).toString('hex'), selected.reference.localPath)
      routeMap.set(rawUrlHash(selected.publicFinalUrl).toString('hex'), selected.reference.localPath)
    }

    for (const { reference } of representatives.selected) {
      const bundle = decodeSiteBundle(await loadBundle(reference), reference.pageId)
      for (const file of bundle.files) {
        const path = safeArchivePath(file.kind === 'DOCUMENT' ? reference.localPath : file.localPath)
        if (file.kind === 'RESOURCE' && resourceAliases.has(path.toLowerCase())) continue
        const body = file.kind === 'DOCUMENT'
          ? rewriteSiteNavigation(
              rewriteSiteResourceAliases(file.body, path, resourceAliases),
              bundle.sourceFinalUrl,
              path,
              routeMap,
            )
          : rewriteCssWithSourceUrls(file.body, file.contentType, file.sourceUrl, path, sourceUrlToLocalPath, resourceAliases)
        const hash = createHash('sha256').update(body).digest('hex')
        const existing = written.get(path.toLowerCase())
        if (existing) {
          if (existing !== hash) {
            log('error', 'site archive path collision', {
              archivePath: path, existingHash: existing.slice(0, 16),
              newHash: hash.slice(0, 16), pageId: reference.pageId,
            })
            throw new Error('SITE_ARCHIVE_PATH_COLLISION')
          }
          continue
        }
        written.set(path.toLowerCase(), hash)
        totalArchiveInput += body.length
        if (totalArchiveInput > maxArchiveBytes) throw new Error('SITE_ARCHIVE_BUDGET_EXCEEDED')
        const estimatedBytes = body.length + zipEntryOverhead(path)
        const shard = await ensureShard(estimatedBytes)
        shard.zip.addBuffer(body, path, { compress: shouldCompress(file.contentType, path) })
        shard.inputBytes += estimatedBytes
      }
    }
    if (current) parts.push(await closeShard(current, maxShardBytes))
    if (parts.length === 0) throw new Error('SITE_ARCHIVE_EMPTY')

    const manifestPages = outcomes.map((page) => {
      const layoutDuplicate = representatives.rejected.get(page.pageId)
      const selected = representatives.byPageId.get(page.pageId)
      return {
        pageId: page.pageId,
        sourceUrl: sanitizeUrl(page.publicUrl),
        localPath: selected ? page.localPath : null,
        status: layoutDuplicate ? 'REJECTED' : page.status,
        reason: layoutDuplicate ?? page.failureCode,
        ...(selected?.design ?? {}),
      }
    })
    const reasonCounts = countReasons(manifestPages.map((page) => page.reason))
    const rejectedPages = manifestPages.filter((page) => page.reason).slice(0, 1_000)
    const grouped = new Set(representatives.selected.map(({ reference, design }) => (
      `${design?.semanticRole ?? 'UNKNOWN'}\n${design?.routeTemplate ?? reference.localPath}`
    ))).size
    const manifest = Buffer.from(JSON.stringify({
      schemaVersion: 2,
      kind: 'DESIGN_SITE_ARCHIVE',
      engine: {
        name: 'pagesource-adapter',
        version: 'weblens-site-2/pagesource-0.1.2@f59ed61',
        policyVersion: DESIGN_CLONE_POLICY_VERSION,
      },
      generatedAt: new Date().toISOString(),
      rootUrl: sanitizeUrl(rootUrl),
      extraction: 'Tải tất cả shard ZIP và giải nén vào cùng một thư mục.',
      policy: {
        sameOriginOnly: true,
        designClone: true,
        screenshot: false,
        maxPages: budgets?.maxPages ?? outcomes.length,
        maxInputBytes: budgets?.maxInputBytes ?? null,
        maxResourceBodiesPerPage: 100,
        maxShardBytes,
        maxArchiveBytes,
      },
      locale: representatives.selected.find(({ design }) => design)?.design?.locale ?? 'und',
      counts: {
        discovered: outcomes.length,
        rejected: manifestPages.filter((page) => page.reason).length,
        grouped,
        rendered: bundles.length,
        packaged: representatives.selected.length,
      },
      completenessCode: manifestPages.some((page) => page.status === 'FAILED')
        ? 'PARTIAL_RENDER_FAILURE'
        : manifestPages.some((page) => page.reason === 'CANCELLED')
          ? 'PARTIAL_CANCELLED'
          : 'REPRESENTATIVE_COMPLETE',
      layoutFingerprintVersion: LAYOUT_FINGERPRINT_VERSION,
      representatives: representatives.selected.map(({ reference, design, publicFinalUrl }) => ({
        semanticRole: design?.semanticRole ?? 'UNKNOWN',
        routeTemplate: design?.routeTemplate ?? reference.localPath,
        representativeUrl: sanitizeUrl(publicFinalUrl),
        localPath: reference.localPath,
        layoutFingerprint: design?.layoutFingerprint ?? null,
      })),
      routeMapping: representatives.selected.map(({ reference, publicFinalUrl }) => ({
        sourceUrl: sanitizeUrl(publicFinalUrl),
        localPath: reference.localPath,
      })),
      rejected: {
        reasonCounts,
        listed: rejectedPages,
        omittedCount: Math.max(0, manifestPages.filter((page) => page.reason).length - rejectedPages.length),
      },
      parts: parts.map((part) => ({
        shardNumber: part.shardNumber,
        filename: part.logicalFilename,
        bytes: part.bytes,
        sha256: part.sha256Hex,
      })),
      pages: manifestPages,
    }, null, 2), 'utf8')
    return { temporaryDirectory, parts, manifest }
  } catch (error) {
    await rm(temporaryDirectory, { recursive: true, force: true }).catch(() => undefined)
    throw error
  }
}

export async function cleanupSiteArchives(build: SiteArchiveBuild | null): Promise<void> {
  if (build) await rm(build.temporaryDirectory, { recursive: true, force: true }).catch(() => undefined)
}

function selectRepresentatives(
  indexed: RepresentativePage[],
): {
  selected: RepresentativePage[]
  rejected: Map<string, 'LAYOUT_DUPLICATE'>
  byPageId: Map<string, RepresentativePage>
} {
  const groups = new Map<string, RepresentativePage>()
  const rejected = new Map<string, 'LAYOUT_DUPLICATE'>()
  for (const item of [...indexed].sort((left, right) => (
    left.reference.ordinal - right.reference.ordinal || left.reference.pageId.localeCompare(right.reference.pageId)
  ))) {
    const design = item.design
    const key = design
      ? `${design.semanticRole}\n${design.routeTemplate}\n${design.layoutFingerprint ?? 'FINGERPRINT_UNAVAILABLE'}`
      : `LEGACY\n${item.reference.pageId}`
    if (groups.has(key)) rejected.set(item.reference.pageId, 'LAYOUT_DUPLICATE')
    else groups.set(key, item)
  }
  const selected = [...groups.values()]
  return { selected, rejected, byPageId: new Map(selected.map((item) => [item.reference.pageId, item])) }
}

function countReasons(reasons: Array<string | null>): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const reason of reasons) {
    if (reason) counts[reason] = (counts[reason] ?? 0) + 1
  }
  return Object.fromEntries(Object.entries(counts).sort(([left], [right]) => left.localeCompare(right)))
}

interface OpenShard {
  shardNumber: number
  path: string
  logicalFilename: string
  zip: ZipFile
  completion: Promise<void>
  inputBytes: number
}

function openShard(directory: string, shardNumber: number, archiveLabel: string): OpenShard {
  const logicalFilename = `weblens-site-clone-${archiveLabel}.part-${String(shardNumber).padStart(4, '0')}.zip`
  const path = posix.join(directory, `${randomUUID()}.zip`)
  const zip = new ZipFile()
  const completion = pipeline(zip.outputStream, createWriteStream(path, { flags: 'wx' }))
  return { shardNumber, path, logicalFilename, zip, completion, inputBytes: 0 }
}

async function closeShard(shard: OpenShard, maxShardBytes: number): Promise<SiteArchivePart> {
  shard.zip.end()
  await shard.completion
  const bytes = (await stat(shard.path)).size
  if (bytes <= 0 || bytes > maxShardBytes) throw new Error('SITE_SHARD_SIZE_OUT_OF_BOUNDS')
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(shard.path)) hash.update(chunk as Buffer)
  return {
    path: shard.path,
    logicalFilename: shard.logicalFilename,
    shardNumber: shard.shardNumber,
    bytes,
    sha256Hex: hash.digest('hex'),
  }
}

function shouldCompress(contentType: string, path: string): boolean {
  const mime = contentType.split(';')[0]?.trim().toLowerCase() ?? ''
  return mime.startsWith('text/')
    || ['application/javascript', 'application/json', 'application/xml', 'image/svg+xml'].includes(mime)
    || /\.(?:css|html?|js|json|svg|xml)$/iu.test(path)
}

function visit(node: HtmlNode, action: (node: HtmlNode) => void): void {
  action(node)
  node.childNodes?.forEach((child) => visit(child, action))
}

function rewriteSiteResourceAliases(
  html: Buffer,
  sourcePath: string,
  aliases: ReadonlyMap<string, string>,
): Buffer {
  if (aliases.size === 0) return html
  const document = parse(html.toString('utf8')) as unknown as HtmlNode
  visit(document, (node) => {
    for (const attribute of node.attrs ?? []) {
      const name = attribute.name.toLowerCase()
      if (name === 'src' || name === 'poster' || (name === 'href' && node.tagName !== 'a' && node.tagName !== 'area')) {
        attribute.value = rewriteArchiveReference(attribute.value, sourcePath, aliases)
      } else if (name === 'srcset') {
        attribute.value = attribute.value.split(',').map((candidate) => {
          const [raw, ...descriptor] = candidate.trim().split(/\s+/u)
          return raw ? [rewriteArchiveReference(raw, sourcePath, aliases), ...descriptor].join(' ') : ''
        }).filter(Boolean).join(', ')
      } else if (name === 'style') {
        attribute.value = rewriteCssText(attribute.value, sourcePath, aliases)
      }
    }
    if (node.tagName === 'style') {
      for (const child of node.childNodes ?? []) {
        if (typeof child.value === 'string') child.value = rewriteCssText(child.value, sourcePath, aliases)
      }
    }
  })
  return Buffer.from(serialize(document as never), 'utf8')
}

function rewriteCssResourceAliases(
  body: Buffer,
  contentType: string,
  sourcePath: string,
  aliases: ReadonlyMap<string, string>,
): Buffer {
  const mime = contentType.split(';')[0]?.trim().toLowerCase() ?? ''
  if (mime !== 'text/css' && !/\.css$/iu.test(sourcePath)) return body
  return Buffer.from(rewriteCssText(body.toString('utf8'), sourcePath, aliases), 'utf8')
}

function rewriteCssText(css: string, sourcePath: string, aliases: ReadonlyMap<string, string>): string {
  const urls = css.replace(/url\(\s*(['"]?)(.*?)\1\s*\)/giu, (_match, quote: string, raw: string) => (
    `url(${quote}${rewriteArchiveReference(raw, sourcePath, aliases)}${quote})`
  ))
  return urls.replace(/@import\s+(['"])(.*?)\1/giu, (_match, quote: string, raw: string) => (
    `@import ${quote}${rewriteArchiveReference(raw, sourcePath, aliases)}${quote}`
  ))
}

function rewriteArchiveReference(
  raw: string,
  sourcePath: string,
  aliases: ReadonlyMap<string, string>,
): string {
  if (!raw || raw.startsWith('#') || /^(?:[a-z][a-z0-9+.-]*:|\/\/)/iu.test(raw)) return raw
  const match = /^([^?#]*)([?#].*)?$/u.exec(raw)
  const path = match?.[1]
  if (!path) return raw
  try {
    const resolved = safeArchivePath(path.startsWith('/')
      ? path
      : posix.join(posix.dirname(sourcePath), path))
    const canonical = aliases.get(resolved.toLowerCase())
    return canonical ? relativeArchivePath(sourcePath, canonical) + (match?.[2] ?? '') : raw
  } catch {
    return raw
  }
}

function safeArchivePath(value: string): string {
  const normalized = posix.normalize(value.normalize('NFC').replaceAll('\\', '/')).replace(/^\/+/, '')
  if (!normalized || normalized === '.' || normalized.startsWith('../') || normalized.includes('/../')) {
    throw new Error('INVALID_SITE_ARCHIVE_PATH')
  }
  if (!/^[a-z0-9._/-]+$/iu.test(normalized)) throw new Error('INVALID_SITE_ARCHIVE_PATH')
  return normalized.slice(0, 512)
}

function relativeArchivePath(from: string, to: string): string {
  return posix.relative(posix.dirname(from), to) || posix.basename(to)
}

function zipEntryOverhead(path: string): number {
  // Local header, central-directory entry, descriptor and UTF-8 filename. The
  // extra margin keeps the emitted ZIP below the configured shard byte ceiling.
  return 256 + (2 * Buffer.byteLength(path, 'utf8'))
}

function normalizeRawUrl(rawUrl: string): string {
  const url = new URL(rawUrl)
  url.username = ''
  url.password = ''
  url.hash = ''
  if (url.pathname.length > 1) url.pathname = url.pathname.replace(/\/+$/u, '')
  return url.toString()
}

/**
 * Rewrite CSS url() and @import references from original server URLs to local
 * archive paths. Unlike rewriteCssResourceAliases (which only remaps archive-
 * internal aliases), this resolves each reference against the CSS file's source
 * URL and looks up the complete sourceUrl→localPath map built from ALL pages.
 *
 * For non-CSS resources the body is returned unchanged.
 */
function rewriteCssWithSourceUrls(
  body: Buffer,
  contentType: string,
  cssSourceUrl: string,
  cssLocalPath: string,
  sourceUrls: ReadonlyMap<string, string>,
  aliases: ReadonlyMap<string, string>,
): Buffer {
  const mime = contentType.split(';')[0]?.trim().toLowerCase() ?? ''
  if (mime !== 'text/css' && !/\.css$/iu.test(cssLocalPath)) return body

  const rewriteRef = (raw: string): string => {
    if (!raw || raw.startsWith('#') || /^(?:data|blob|about|javascript):/iu.test(raw)) return raw
    try {
      // Resolve relative/root-relative URL against the CSS file's original server URL.
      const resolved = new URL(raw, cssSourceUrl)
      const fragment = resolved.hash
      resolved.hash = ''
      const localPath = sourceUrls.get(normalizeSourceUrl(resolved.toString()))
      if (!localPath) return sanitizeUrl(resolved.toString()) + fragment
      // Apply alias mapping for dedup (e.g. two different paths, same content).
      const canonical = aliases.get(localPath.toLowerCase()) ?? localPath
      return relativeArchivePath(cssLocalPath, canonical) + fragment
    } catch {
      return raw
    }
  }

  let css = body.toString('utf8')
  css = css.replace(/url\(\s*(['"]?)(.*?)\1\s*\)/giu, (_match, quote: string, raw: string) => (
    `url(${quote}${rewriteRef(raw)}${quote})`
  ))
  css = css.replace(/@import\s+(['"])(.*?)\1/giu, (_match, quote: string, raw: string) => (
    `@import ${quote}${rewriteRef(raw)}${quote}`
  ))
  return Buffer.from(css, 'utf8')
}

function normalizeSourceUrl(raw: string): string {
  try {
    const url = new URL(raw)
    url.hash = ''
    return url.toString()
  } catch {
    return raw
  }
}

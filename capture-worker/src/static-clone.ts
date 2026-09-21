import { createHash, randomUUID } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { posix } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { ZipFile } from 'yazl'
import type { CloneInputResource, ReconstructionBuild } from './types.js'

export const STATIC_CLONE_ENGINE_VERSION = 'weblens-1/pagesource-0.1.2@f59ed61'
export const STATIC_CLONE_MAX_FILES = 100
export const STATIC_CLONE_MAX_INPUT_BYTES = 52_428_800
export const STATIC_CLONE_MAX_ARCHIVE_BYTES = 67_108_864

interface PlannedResource extends CloneInputResource {
  localPath: string | null
}

export interface StaticClonePlan {
  finalUrl: string
  mainPath: string
  resources: PlannedResource[]
  replacements: Record<string, string>
}

export interface StaticClonePlanOptions {
  mainPath?: string
  contentAddressedResources?: boolean
}

interface ManifestFile {
  kind: 'DOCUMENT' | 'RESOURCE'
  sourceUrl: string
  sourceUrlSha256: string
  localPath: string | null
  resourceType: string
  mimeType: string
  status: 'PACKAGED' | 'SKIPPED'
  bytes: number
  sha256: string | null
  truncated: boolean
  reason: string | null
}

/**
 * URL-to-path, MIME-extension and collision behavior is adapted from Pagesource
 * 0.1.2 by Tim Farrelly (MIT), commit f59ed61dfc42a901b412a4cc6803fc238e879405.
 * WebLens adds traversal protection, deterministic redaction and strict budgets.
 */
export function planStaticClone(
  finalUrl: string,
  resources: CloneInputResource[],
  htmlBytes = 0,
  options: StaticClonePlanOptions = {},
): StaticClonePlan {
  const mainPath = options.mainPath ?? inferExtension(urlToLocalPath(finalUrl), 'text/html')
  const used = new Set<string>([mainPath.toLowerCase()])
  const contentPaths = new Map<string, string>()
  const replacements: Record<string, string> = {}
  let plannedFiles = 1
  let plannedBytes = htmlBytes
  const planned = resources.map((resource): PlannedResource => {
    if (resource.skipReason || !resource.body) return { ...resource, localPath: null }
    if (!isSameOrigin(resource.sourceUrl, finalUrl)) {
      return { ...resource, localPath: null, skipReason: 'EXTERNAL_ORIGIN' }
    }
    const bodyHash = sha256(resource.body)
    const desired = options.contentAddressedResources
      ? inferExtension(posix.join('assets', bodyHash), resource.mimeType)
      : inferExtension(urlToLocalPath(resource.sourceUrl), resource.mimeType)
    const contentKey = resource.resourceType === 'stylesheet'
      ? `${desired}\n${normalizeResourceUrl(resource.sourceUrl)}`
      : desired
    const existingPath = options.contentAddressedResources ? contentPaths.get(contentKey) : undefined
    if (existingPath) {
      replacements[normalizeResourceUrl(resource.sourceUrl)] = relativeArchivePath(mainPath, existingPath)
      return { ...resource, localPath: existingPath }
    }
    if (plannedFiles >= STATIC_CLONE_MAX_FILES) {
      return { ...resource, localPath: null, skipReason: 'FILE_COUNT_BUDGET_EXCEEDED' }
    }
    if (plannedBytes + resource.body.length > STATIC_CLONE_MAX_INPUT_BYTES) {
      return { ...resource, localPath: null, skipReason: 'CLONE_INPUT_BUDGET_EXCEEDED' }
    }
    const localPath = deduplicatePath(desired, used)
    if (options.contentAddressedResources) contentPaths.set(contentKey, localPath)
    replacements[normalizeResourceUrl(resource.sourceUrl)] = relativeArchivePath(mainPath, localPath)
    plannedFiles += 1
    plannedBytes += resource.body.length
    return { ...resource, localPath }
  })
  return { finalUrl, mainPath, resources: planned, replacements }
}

export async function buildStaticClone(
  plan: StaticClonePlan,
  rewrittenHtml: Buffer,
): Promise<ReconstructionBuild> {
  const discoveredCount = 1 + plan.resources.length
  if (rewrittenHtml.length > STATIC_CLONE_MAX_INPUT_BYTES) {
    return failed(discoveredCount, 'CLONE_INPUT_BUDGET_EXCEEDED')
  }

  const selected: Array<{ resource: PlannedResource; body: Buffer }> = []
  const selectedPaths = new Set<string>()
  let inputBytes = rewrittenHtml.length
  let contentFileCount = 1
  let budgetSkipped = false
  for (const resource of plan.resources) {
    if (!resource.body || !resource.localPath || resource.skipReason) continue
    if (contentFileCount >= STATIC_CLONE_MAX_FILES
      || inputBytes + resource.body.length > STATIC_CLONE_MAX_INPUT_BYTES) {
      resource.localPath = null
      resource.skipReason = contentFileCount >= STATIC_CLONE_MAX_FILES
        ? 'FILE_COUNT_BUDGET_EXCEEDED'
        : 'CLONE_INPUT_BUDGET_EXCEEDED'
      budgetSkipped = true
      continue
    }
    const body = resource.resourceType === 'stylesheet'
      ? Buffer.from(rewriteCss(resource.body.toString('utf8'), resource.sourceUrl, resource.localPath, plan), 'utf8')
      : resource.body
    if (selectedPaths.has(resource.localPath.toLowerCase())) continue
    if (inputBytes + body.length > STATIC_CLONE_MAX_INPUT_BYTES) {
      resource.localPath = null
      resource.skipReason = 'CLONE_INPUT_BUDGET_EXCEEDED'
      budgetSkipped = true
      continue
    }
    inputBytes += body.length
    contentFileCount += 1
    selectedPaths.add(resource.localPath.toLowerCase())
    selected.push({ resource, body })
  }

  const files: ManifestFile[] = [manifestFile(
    'DOCUMENT', plan.finalUrl, plan.mainPath, 'document', 'text/html', rewrittenHtml, false, null,
  )]
  for (const resource of plan.resources) {
    const selectedBody = selected.find((item) => item.resource.localPath === resource.localPath)?.body ?? null
    files.push(selectedBody && resource.localPath
      ? manifestFile(
          'RESOURCE', resource.sourceUrl, resource.localPath, resource.resourceType,
          resource.mimeType, selectedBody, resource.wasTruncated, null,
        )
      : {
          kind: 'RESOURCE', sourceUrl: redactUrl(resource.sourceUrl || resource.publicUrl),
          sourceUrlSha256: sha256Text(resource.sourceUrl || resource.publicUrl), localPath: null,
          resourceType: resource.resourceType, mimeType: resource.mimeType, status: 'SKIPPED',
          bytes: resource.body?.length ?? 0, sha256: resource.body ? sha256(resource.body) : null,
          truncated: resource.wasTruncated, reason: resource.skipReason ?? 'BODY_UNAVAILABLE',
        })
  }

  const skippedCount = files.filter((file) => file.status === 'SKIPPED').length
  const truncated = files.some((file) => file.truncated)
  const completenessCode = skippedCount > 0 || truncated
    ? (budgetSkipped ? 'BUDGET_LIMITED' : truncated ? 'TRUNCATED_RESOURCE' : 'RESOURCE_GAPS')
    : 'COMPLETE'
  const status: ReconstructionBuild['status'] = completenessCode === 'COMPLETE' ? 'PUBLISHED' : 'PARTIAL'
  const manifest = Buffer.from(JSON.stringify({
    schemaVersion: 1,
    kind: 'STATIC_PAGE_ARCHIVE',
    engine: { name: 'pagesource-adapter', version: STATIC_CLONE_ENGINE_VERSION },
    generatedAt: new Date().toISOString(),
    policy: {
      sameOriginOnly: true,
      maxFiles: STATIC_CLONE_MAX_FILES,
      maxInputBytes: STATIC_CLONE_MAX_INPUT_BYTES,
      maxArchiveBytes: STATIC_CLONE_MAX_ARCHIVE_BYTES,
    },
    completenessCode,
    files,
  }, null, 2), 'utf8')

  const temporaryDirectory = await mkdtemp(posix.join(tmpdir().replaceAll('\\', '/'), 'weblens-clone-'))
  const archivePath = posix.join(temporaryDirectory, `${randomUUID()}.zip`)
  try {
    const zip = new ZipFile()
    zip.addBuffer(rewrittenHtml, plan.mainPath, { compress: false })
    for (const item of selected) zip.addBuffer(item.body, item.resource.localPath!, { compress: false })
    zip.addBuffer(manifest, 'manifest.json', { compress: false })
    zip.end()
    await pipeline(zip.outputStream, createWriteStream(archivePath, { flags: 'wx' }))
    const archiveBytes = (await stat(archivePath)).size
    if (archiveBytes <= 0 || archiveBytes > STATIC_CLONE_MAX_ARCHIVE_BYTES) {
      await rm(temporaryDirectory, { recursive: true, force: true })
      return failed(discoveredCount, 'CLONE_ARCHIVE_BUDGET_EXCEEDED')
    }
    return {
      status,
      engineVersion: STATIC_CLONE_ENGINE_VERSION,
      discoveredCount,
      packagedCount: contentFileCount,
      skippedCount,
      inputBytes,
      archiveBytes,
      completenessCode,
      failureCode: null,
      archivePath,
      temporaryDirectory,
      manifest,
      siteBundle: {
        schemaVersion: 1,
        sourceFinalUrl: plan.finalUrl,
        publicFinalUrl: redactUrl(plan.finalUrl),
        mainPath: plan.mainPath,
        capturedAt: new Date().toISOString(),
        files: [
          {
            kind: 'DOCUMENT', localPath: plan.mainPath, sourceUrl: plan.finalUrl,
            contentType: 'text/html; charset=utf-8', body: rewrittenHtml,
          },
          ...selected.map(({ resource, body }) => ({
            kind: 'RESOURCE' as const,
            localPath: resource.localPath!,
            sourceUrl: resource.sourceUrl,
            contentType: resource.mimeType || 'application/octet-stream',
            // For stylesheets: store original body so multi-page assembly can
            // rewrite CSS once with the complete resource map from all pages.
            // Single-page static clone ZIP already uses the rewritten `body`.
            body: resource.resourceType === 'stylesheet' ? resource.body! : body,
          })),
        ],
      },
    }
  } catch {
    await rm(temporaryDirectory, { recursive: true, force: true }).catch(() => undefined)
    return failed(discoveredCount, 'CLONE_ARCHIVE_WRITE_FAILED')
  }
}

export async function cleanupStaticClone(build: ReconstructionBuild): Promise<void> {
  if (build.temporaryDirectory) {
    await rm(build.temporaryDirectory, { recursive: true, force: true }).catch(() => undefined)
  }
}

export function replacementForReference(raw: string, baseUrl: string, replacements: Record<string, string>): string {
  if (!raw || /^(?:data|blob|about|javascript|chrome|chrome-extension):/iu.test(raw)) return raw
  try {
    const absolute = new URL(raw, baseUrl)
    const fragment = absolute.hash
    absolute.hash = ''
    const replacement = replacements[normalizeResourceUrl(absolute.toString())]
    if (replacement) return replacement + fragment
    return redactUrl(absolute.toString()) + fragment
  } catch {
    return ''
  }
}

export function rewriteCss(css: string, sourceUrl: string, sourcePath: string, plan: StaticClonePlan): string {
  const rewriteReference = (raw: string): string => {
    if (!raw || /^(?:data|blob|about|javascript):/iu.test(raw)) return raw
    try {
      const absolute = new URL(raw, sourceUrl)
      const fragment = absolute.hash
      absolute.hash = ''
      const target = plan.resources.find((resource) => (
        resource.localPath && normalizeResourceUrl(resource.sourceUrl) === normalizeResourceUrl(absolute.toString())
      ))?.localPath
      if (target) return relativeArchivePath(sourcePath, target) + fragment
      return redactUrl(absolute.toString()) + fragment
    } catch {
      return ''
    }
  }
  const urls = css.replace(/url\(\s*(['"]?)(.*?)\1\s*\)/giu, (_match, quote: string, raw: string) => {
    if (!raw || /^(?:data|blob|about|javascript):/iu.test(raw)) return `url(${quote}${raw}${quote})`
    return `url(${quote}${rewriteReference(raw)}${quote})`
  })
  return urls.replace(/@import\s+(['"])(.*?)\1/giu, (_match, quote: string, raw: string) => (
    `@import ${quote}${rewriteReference(raw)}${quote}`
  ))
}

export function sanitizePathComponent(value: string): string {
  let result = value.normalize('NFC')
    .replace(/[<>:"|?*\u0000-\u001f\\/]/gu, '_')
    .replace(/[^a-z0-9._-]/giu, '_')
    .replace(/[. ]+$/u, '')
  if (!result || result === '.' || result === '..') result = '_'
  const base = (result.split('.')[0] ?? '').toUpperCase()
  if (/^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/u.test(base)) result = `_${result}`
  if (result.length > 100) {
    const extensionIndex = result.lastIndexOf('.')
    const extension = extensionIndex > 0 ? result.slice(extensionIndex, extensionIndex + 21) : ''
    result = result.slice(0, Math.max(1, 100 - extension.length)) + extension
  }
  return result
}

export function urlToLocalPath(raw: string): string {
  const url = new URL(raw)
  const host = sanitizePathComponent(url.host.replaceAll(':', '_'))
  const rawParts = url.pathname.split('/').filter(Boolean)
  const parts = rawParts.map((part) => sanitizePathComponent(safeDecode(part)))
  if (parts.length === 0 || url.pathname.endsWith('/')) parts.push('index.html')
  return posix.join(host, ...parts)
}

export function inferExtension(path: string, contentType: string): string {
  if (posix.basename(path).includes('.')) return path
  const extension = MIME_EXTENSIONS[contentType.split(';')[0]?.trim().toLowerCase() ?? ''] ?? ''
  return path + extension
}

function manifestFile(
  kind: ManifestFile['kind'], sourceUrl: string, localPath: string, resourceType: string,
  mimeType: string, body: Buffer, truncated: boolean, reason: string | null,
): ManifestFile {
  return {
    kind, sourceUrl: redactUrl(sourceUrl), sourceUrlSha256: sha256Text(sourceUrl), localPath,
    resourceType, mimeType, status: 'PACKAGED', bytes: body.length, sha256: sha256(body),
    truncated, reason,
  }
}

function failed(discoveredCount: number, failureCode: string): ReconstructionBuild {
  return {
    status: 'FAILED', engineVersion: STATIC_CLONE_ENGINE_VERSION, discoveredCount,
    packagedCount: 0, skippedCount: Math.max(0, discoveredCount - 1), inputBytes: 0,
    archiveBytes: null, completenessCode: null, failureCode,
    archivePath: null, temporaryDirectory: null, manifest: null,
    siteBundle: null,
  }
}

function deduplicatePath(path: string, used: Set<string>): string {
  let candidate = path
  let counter = 1
  while (used.has(candidate.toLowerCase())) {
    const extension = posix.extname(path)
    candidate = posix.join(posix.dirname(path), `${posix.basename(path, extension)}_${counter}${extension}`)
    counter += 1
  }
  used.add(candidate.toLowerCase())
  return candidate
}

function relativeArchivePath(from: string, to: string): string {
  const value = posix.relative(posix.dirname(from), to)
  return value || posix.basename(to)
}

function isSameOrigin(left: string, right: string): boolean {
  try { return new URL(left).origin === new URL(right).origin } catch { return false }
}

function normalizeResourceUrl(raw: string): string {
  const url = new URL(raw)
  url.hash = ''
  return url.toString()
}

function redactUrl(raw: string): string {
  try {
    const url = new URL(raw)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return `${url.protocol}[OMITTED]`
    url.username = ''
    url.password = ''
    url.hash = ''
    for (const key of [...url.searchParams.keys()]) {
      url.searchParams.delete(key)
      url.searchParams.append(key, '[REDACTED]')
    }
    return url.toString().slice(0, 8192)
  } catch { return '' }
}

function safeDecode(value: string): string {
  try { return decodeURIComponent(value) } catch { return value }
}

function sha256(value: Buffer): string {
  return createHash('sha256').update(value).digest('hex')
}

function sha256Text(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

const MIME_EXTENSIONS: Record<string, string> = {
  'text/html': '.html', 'text/css': '.css', 'text/javascript': '.js',
  'application/javascript': '.js', 'application/x-javascript': '.js',
  'image/png': '.png', 'image/jpeg': '.jpg', 'image/gif': '.gif',
  'image/svg+xml': '.svg', 'image/webp': '.webp', 'image/avif': '.avif',
  'image/x-icon': '.ico', 'image/vnd.microsoft.icon': '.ico',
  'font/woff': '.woff', 'font/woff2': '.woff2', 'font/ttf': '.ttf',
  'font/otf': '.otf', 'application/font-woff': '.woff',
  'application/font-woff2': '.woff2', 'application/x-font-woff': '.woff',
  'application/x-font-ttf': '.ttf', 'application/vnd.ms-fontobject': '.eot',
}

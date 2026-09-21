import assert from 'node:assert/strict'
import { readFile, stat } from 'node:fs/promises'
import { test } from 'node:test'
import { inflateRawSync } from 'node:zlib'
import {
  buildSiteArchives,
  cleanupSiteArchives,
  decodeSiteBundle,
  encodeSiteBundle,
  rawUrlHash,
  rewriteSiteNavigation,
} from './site-archive.js'
import type { SitePageBundle } from './types.js'

test('rewriteSiteNavigation chỉ tạo link local cho page thực sự có route', () => {
  const routes = new Map([
    [rawUrlHash('https://example.com/about').toString('hex'), 'pages/about.html'],
  ])
  const result = rewriteSiteNavigation(
    Buffer.from('<a href="/about#team">About</a><a href="/missing?secret=1">Missing</a>'),
    'https://example.com/',
    'index.html',
    routes,
  ).toString('utf8')

  assert.match(result, /href="pages\/about\.html#team"/u)
  assert.match(result, /href="https:\/\/example\.com\/missing\?secret=%5BREDACTED%5D"/u)
  assert.doesNotMatch(result, /secret=1/u)
})

test('buildSiteArchives deduplicate asset và giữ mỗi shard dưới budget', async () => {
  const first = bundle('page-1', 'https://example.com/', 'index.html', 'A')
  const second = bundle('page-2', 'https://example.com/about', 'pages/page-2.html', 'B')
  first.files.push({
    kind: 'RESOURCE', localPath: 'assets/shared.woff2', sourceUrl: 'https://example.com/shared.woff2',
    contentType: 'font/woff2', body: Buffer.from('x'.repeat(600)),
  })
  second.files[0]!.body = Buffer.from(`<html><script src="../assets/shared-copy.js"></script>${'B'.repeat(600)}</html>`)
  second.files[1]!.localPath = 'assets/shared-copy.js'
  const encoded = new Map([
    ['page-1', encodeSiteBundle(first)],
    ['page-2', encodeSiteBundle(second)],
  ])
  const references = [first, second].map((value, ordinal) => ({
    pageId: value.pageId,
    ordinal,
    publicUrl: value.publicFinalUrl,
    localPath: value.mainPath,
    bucket: 'test',
    key: value.pageId,
    bytes: encoded.get(value.pageId)!.length,
    sha256Hex: '0'.repeat(64),
  }))
  const routes = [first, second].map((value) => ({
    urlSha256Hex: rawUrlHash(value.sourceFinalUrl).toString('hex'),
    localPath: value.mainPath,
  }))
  const outcomes = references.map((value) => ({
    pageId: value.pageId,
    publicUrl: value.publicUrl,
    localPath: value.localPath,
    status: 'SUCCEEDED',
    failureCode: null,
  }))
  const build = await buildSiteArchives(
    'https://example.com/', references, outcomes, routes, 2_048, 10_000,
    async (reference) => encoded.get(reference.pageId)!,
  )

  try {
    assert.ok(build.parts.length >= 2)
    assert.equal(new Set(build.parts.map((part) => part.logicalFilename)).size, build.parts.length)
    assert.ok(build.parts.every((part, index) => new RegExp(
      `^weblens-site-clone-\\d{8}T\\d{9}Z-[0-9a-f]{8}\\.part-${String(index + 1).padStart(4, '0')}\\.zip$`,
    ).test(part.logicalFilename)))
    for (const part of build.parts) assert.ok((await stat(part.path)).size <= 2_048)
    const manifest = JSON.parse(build.manifest.toString('utf8')) as {
      kind: string; pages: unknown[]; parts: Array<{ bytes: number; sha256: string }>
    }
    assert.equal(manifest.kind, 'DESIGN_SITE_ARCHIVE')
    assert.equal(manifest.pages.length, 2)
    assert.equal(manifest.parts.length, build.parts.length)
    assert.ok(manifest.parts.every((part) => part.bytes > 0 && /^[0-9a-f]{64}$/u.test(part.sha256)))
    const entries = new Map<string, Buffer>()
    for (const part of build.parts) {
      for (const entry of zipEntries(await readFile(part.path))) entries.set(...entry)
    }
    assert.ok(entries.has('assets/shared.js'))
    assert.ok(entries.has('assets/shared.woff2'))
    assert.ok(!entries.has('assets/shared-copy.js'))
    assert.match(entries.get('pages/page-2.html')?.toString('utf8') ?? '', /src="\.\.\/assets\/shared\.js"/u)
  } finally {
    await cleanupSiteArchives(build)
  }
})

test('buildSiteArchives từ chối collision có nội dung khác nhau', async () => {
  const first = bundle('page-1', 'https://example.com/', 'index.html', 'A')
  const second = bundle('page-2', 'https://example.com/about', 'pages/page-2.html', 'B')
  second.files[1]!.body = Buffer.from('different-content')
  const encoded = new Map([
    ['page-1', encodeSiteBundle(first)],
    ['page-2', encodeSiteBundle(second)],
  ])
  const references = [first, second].map((value, ordinal) => ({
    pageId: value.pageId, ordinal, publicUrl: value.publicFinalUrl, localPath: value.mainPath,
    bucket: 'test', key: value.pageId, bytes: encoded.get(value.pageId)!.length,
    sha256Hex: '0'.repeat(64),
  }))

  await assert.rejects(
    buildSiteArchives(
      'https://example.com/', references, [], [], 10_000, 20_000,
      async (reference) => encoded.get(reference.pageId)!,
    ),
    /SITE_ARCHIVE_PATH_COLLISION/u,
  )
})

test('buildSiteArchives rewrites shared CSS using resources from all pages', async () => {
  // Two pages share the same original CSS, but each page captured a different image.
  // This is the exact scenario that previously caused SITE_ARCHIVE_PATH_COLLISION.
  const { createHash: hash } = await import('node:crypto')
  const sharedCssBody = Buffer.from(
    '.hero { background: url("https://example.com/img-a.png?v=1#hero") }'
    + ' .team { background: url("https://example.com/img-b.png") }'
    + ' .missing { background: url("../icons/missing.svg?token=secret#logo") }',
  )
  const imgA = Buffer.from('image-a-content-' + 'x'.repeat(100))
  const imgB = Buffer.from('image-b-content-' + 'y'.repeat(100))
  const cssHash = hash('sha256').update(sharedCssBody).digest('hex')
  const imgAHash = hash('sha256').update(imgA).digest('hex')
  const imgBHash = hash('sha256').update(imgB).digest('hex')

  const first: SitePageBundle = {
    schemaVersion: 1, pageId: 'page-1',
    sourceFinalUrl: 'https://example.com/', publicFinalUrl: 'https://example.com/',
    mainPath: 'index.html', capturedAt: new Date().toISOString(),
    files: [
      { kind: 'DOCUMENT', localPath: 'index.html', sourceUrl: 'https://example.com/',
        contentType: 'text/html',
        body: Buffer.from(`<html><link rel="stylesheet" href="assets/${cssHash}.css"><div class="hero">${'A'.repeat(300)}</div></html>`) },
      { kind: 'RESOURCE', localPath: `assets/${cssHash}.css`, sourceUrl: 'https://example.com/main.css',
        contentType: 'text/css', body: sharedCssBody },
      { kind: 'RESOURCE', localPath: `assets/${imgAHash}.png`, sourceUrl: 'https://example.com/img-a.png?v=1',
        contentType: 'image/png', body: imgA },
    ],
  }
  const second: SitePageBundle = {
    schemaVersion: 1, pageId: 'page-2',
    sourceFinalUrl: 'https://example.com/about', publicFinalUrl: 'https://example.com/about',
    mainPath: 'pages/page-2.html', capturedAt: new Date().toISOString(),
    files: [
      { kind: 'DOCUMENT', localPath: 'pages/page-2.html', sourceUrl: 'https://example.com/about',
        contentType: 'text/html',
        body: Buffer.from(`<html><link rel="stylesheet" href="../assets/${cssHash}.css"><div class="team">${'B'.repeat(300)}</div></html>`) },
      { kind: 'RESOURCE', localPath: `assets/${cssHash}.css`, sourceUrl: 'https://example.com/main.css',
        contentType: 'text/css', body: sharedCssBody },
      { kind: 'RESOURCE', localPath: `assets/${imgBHash}.png`, sourceUrl: 'https://example.com/img-b.png',
        contentType: 'image/png', body: imgB },
    ],
  }

  const encoded = new Map([
    ['page-1', encodeSiteBundle(first)],
    ['page-2', encodeSiteBundle(second)],
  ])
  const references = [first, second].map((value, ordinal) => ({
    pageId: value.pageId, ordinal, publicUrl: value.publicFinalUrl, localPath: value.mainPath,
    bucket: 'test', key: value.pageId, bytes: encoded.get(value.pageId)!.length,
    sha256Hex: '0'.repeat(64),
  }))
  const outcomes = references.map((value) => ({
    pageId: value.pageId, publicUrl: value.publicUrl, localPath: value.localPath,
    status: 'SUCCEEDED', failureCode: null,
  }))
  const routes = [first, second].map((value) => ({
    urlSha256Hex: rawUrlHash(value.sourceFinalUrl).toString('hex'),
    localPath: value.mainPath,
  }))

  const build = await buildSiteArchives(
    'https://example.com/', references, outcomes, routes, 50_000, 100_000,
    async (reference) => encoded.get(reference.pageId)!,
  )

  try {
    assert.ok(build.parts.length >= 1)
    const entries = new Map<string, Buffer>()
    for (const part of build.parts) {
      for (const entry of zipEntries(await readFile(part.path))) entries.set(...entry)
    }
    const cssContent = entries.get(`assets/${cssHash}.css`)?.toString('utf8') ?? ''
    // CSS should reference both local image paths (assembled from both pages)
    assert.match(cssContent, new RegExp(imgAHash, 'u'), 'CSS should contain reference to img-a')
    assert.match(cssContent, new RegExp(imgBHash, 'u'), 'CSS should contain reference to img-b')
    // CSS should NOT contain original server URLs for captured resources
    assert.doesNotMatch(cssContent, /example\.com\/img-a/u)
    assert.doesNotMatch(cssContent, /example\.com\/img-b/u)
    assert.match(cssContent, new RegExp(`${imgAHash}\\.png#hero`, 'u'))
    assert.match(cssContent, /https:\/\/example\.com\/icons\/missing\.svg\?token=%5BREDACTED%5D#logo/u)
    assert.doesNotMatch(cssContent, /\.\.\/icons\/missing\.svg/u)
  } finally {
    await cleanupSiteArchives(build)
  }
})

test('decodeSiteBundle từ chối path traversal', () => {
  const encoded = Buffer.from(JSON.stringify({
    schemaVersion: 1,
    pageId: 'page-1',
    sourceFinalUrl: 'https://example.com/',
    publicFinalUrl: 'https://example.com/',
    mainPath: '../escape.html',
    capturedAt: new Date().toISOString(),
    files: [{
      kind: 'DOCUMENT', localPath: '../escape.html', sourceUrl: 'https://example.com/',
      contentType: 'text/html', bodyBase64: Buffer.from('<html></html>').toString('base64'),
    }],
  }))

  assert.throws(() => decodeSiteBundle(encoded, 'page-1'), /INVALID_SITE_ARCHIVE_PATH/u)
})

test('decodeSiteBundle từ chối archive path Unicode gây nhầm lẫn', () => {
  const encoded = encodeSiteBundle(bundle('page-1', 'https://example.com/', 'pages/café.html', 'A'))
  assert.throws(() => decodeSiteBundle(encoded, 'page-1'), /INVALID_SITE_ARCHIVE_PATH/u)
})

test('assembly chỉ giữ một representative cho cùng role, template và fingerprint', async () => {
  const first = bundle('page-1', 'https://example.com/error-a', 'pages/error-a.html', 'A')
  const second = bundle('page-2', 'https://example.com/error-b', 'pages/error-b.html', 'B')
  const design = {
    locale: 'en', semanticRole: 'ERROR_4XX' as const, routeTemplate: '/{error-4xx}',
    layoutFingerprint: 'a'.repeat(64), layoutFingerprintVersion: 'dom-structure-v1',
  }
  first.design = design
  second.design = design
  const encoded = new Map([
    ['page-1', encodeSiteBundle(first)],
    ['page-2', encodeSiteBundle(second)],
  ])
  const references = [first, second].map((value, ordinal) => ({
    pageId: value.pageId, ordinal, publicUrl: value.publicFinalUrl, localPath: value.mainPath,
    bucket: 'test', key: value.pageId, bytes: encoded.get(value.pageId)!.length, sha256Hex: '0'.repeat(64),
  }))
  const outcomes = references.map((value) => ({
    pageId: value.pageId, publicUrl: value.publicUrl, localPath: value.localPath,
    status: 'SUCCEEDED', failureCode: null,
  }))
  let loadCount = 0
  const build = await buildSiteArchives(
    'https://example.com/', references, outcomes, [], 10_000, 20_000,
    async (reference) => {
      loadCount += 1
      return encoded.get(reference.pageId)!
    },
  )

  try {
    const manifest = JSON.parse(build.manifest.toString('utf8')) as {
      counts: { rendered: number; packaged: number }
      rejected: { reasonCounts: Record<string, number> }
      pages: Array<{ pageId: string; localPath: string | null; reason: string | null }>
    }
    assert.deepEqual(manifest.counts, { discovered: 2, rejected: 1, grouped: 1, rendered: 2, packaged: 1 })
    assert.equal(loadCount, 4)
    assert.equal(manifest.rejected.reasonCounts['LAYOUT_DUPLICATE'], 1)
    assert.equal(manifest.pages.find((page) => page.pageId === 'page-2')?.localPath, null)
  } finally {
    await cleanupSiteArchives(build)
  }
})

test('ZIP dùng Deflate cho text và store cho PNG đã nén', async () => {
  const value = bundle('page-1', 'https://example.com/', 'index.html', 'A')
  value.files.push({
    kind: 'RESOURCE', localPath: 'assets/image.png', sourceUrl: 'https://example.com/image.png',
    contentType: 'image/png', body: Buffer.from([0x89, 0x50, 0x4e, 0x47, ...new Array(512).fill(0)]),
  })
  const encoded = encodeSiteBundle(value)
  const reference = {
    pageId: value.pageId, ordinal: 0, publicUrl: value.publicFinalUrl, localPath: value.mainPath,
    bucket: 'test', key: value.pageId, bytes: encoded.length, sha256Hex: '0'.repeat(64),
  }
  const build = await buildSiteArchives(
    'https://example.com/', [reference], [{
      pageId: value.pageId, publicUrl: value.publicFinalUrl, localPath: value.mainPath,
      status: 'SUCCEEDED', failureCode: null,
    }], [{ urlSha256Hex: rawUrlHash(value.sourceFinalUrl).toString('hex'), localPath: value.mainPath }],
    20_000, 30_000, async () => encoded,
  )

  try {
    const methods = zipCompressionMethods(await readFile(build.parts[0]!.path))
    assert.equal(methods.get('index.html'), 8)
    assert.equal(methods.get('assets/image.png'), 0)
  } finally {
    await cleanupSiteArchives(build)
  }
})

function bundle(
  pageId: string,
  sourceFinalUrl: string,
  mainPath: string,
  marker: string,
): SitePageBundle {
  return {
    schemaVersion: 1,
    pageId,
    sourceFinalUrl,
    publicFinalUrl: sourceFinalUrl,
    mainPath,
    capturedAt: new Date().toISOString(),
    files: [
      {
        kind: 'DOCUMENT', localPath: mainPath, sourceUrl: sourceFinalUrl,
        contentType: 'text/html',
        body: Buffer.from(`<html><body>${marker.repeat(600)}</body></html>`),
      },
      {
        kind: 'RESOURCE', localPath: 'assets/shared.js', sourceUrl: 'https://example.com/shared.js',
        contentType: 'application/javascript', body: Buffer.from('x'.repeat(600)),
      },
    ],
  }
}

function zipCompressionMethods(zip: Buffer): Map<string, number> {
  const result = new Map<string, number>()
  for (let offset = 0; offset + 46 <= zip.length; offset += 1) {
    if (zip.readUInt32LE(offset) !== 0x02014b50) continue
    const method = zip.readUInt16LE(offset + 10)
    const nameLength = zip.readUInt16LE(offset + 28)
    const extraLength = zip.readUInt16LE(offset + 30)
    const commentLength = zip.readUInt16LE(offset + 32)
    const name = zip.subarray(offset + 46, offset + 46 + nameLength).toString('utf8')
    result.set(name, method)
    offset += 45 + nameLength + extraLength + commentLength
  }
  return result
}

function zipEntries(zip: Buffer): Map<string, Buffer> {
  const result = new Map<string, Buffer>()
  for (let offset = 0; offset + 46 <= zip.length; offset += 1) {
    if (zip.readUInt32LE(offset) !== 0x02014b50) continue
    const method = zip.readUInt16LE(offset + 10)
    const compressedSize = zip.readUInt32LE(offset + 20)
    const nameLength = zip.readUInt16LE(offset + 28)
    const extraLength = zip.readUInt16LE(offset + 30)
    const commentLength = zip.readUInt16LE(offset + 32)
    const localOffset = zip.readUInt32LE(offset + 42)
    const name = zip.subarray(offset + 46, offset + 46 + nameLength).toString('utf8')
    const localNameLength = zip.readUInt16LE(localOffset + 26)
    const localExtraLength = zip.readUInt16LE(localOffset + 28)
    const bodyOffset = localOffset + 30 + localNameLength + localExtraLength
    const compressed = zip.subarray(bodyOffset, bodyOffset + compressedSize)
    result.set(name, method === 8 ? inflateRawSync(compressed) : Buffer.from(compressed))
    offset += 45 + nameLength + extraLength + commentLength
  }
  return result
}

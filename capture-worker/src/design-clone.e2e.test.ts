import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { inflateRawSync } from 'node:zlib'
import { test } from 'node:test'
import { layoutFingerprint, selectDesignPages, type DesignPageInput } from './design-clone.js'
import {
  buildSiteArchives,
  cleanupSiteArchives,
  encodeSiteBundle,
  rawUrlHash,
  sitePagePath,
} from './site-archive.js'
import type { SitePageBundle } from './types.js'

test('fixture Design Clone giữ representative, một locale, link hợp lệ và không có screenshot', async () => {
  const pages = designFixture()
  const selection = selectDesignPages('https://example.com/vi/', pages)
  assert.equal(selection.locale, 'vi')
  assert.equal(selection.selected.length, 11)
  assert.equal(selection.rejected.filter((item) => item.reason === 'ALTERNATE_LOCALE').length, 1)
  assert.equal(selection.rejected.filter((item) => item.reason === 'SEMANTIC_TEMPLATE_DUPLICATE').length, 100)
  assert.equal(selection.rejected.filter((item) => item.reason === 'CANONICAL_DUPLICATE').length, 1)
  assert.equal(selection.rejected.filter((item) => item.reason === 'TRACKING_OR_QUERY_VARIANT').length, 1)

  const encoded = new Map<string, Buffer>()
  const references = selection.selected.map((candidate, ordinal) => {
    const localPath = sitePagePath('https://example.com/vi/', candidate.normalizedUrl, candidate.page.id)
    const html = fixtureHtml(candidate.page.statusCode, candidate.semanticRole, candidate.page.id === 'root')
    const bundle: SitePageBundle = {
      schemaVersion: 1,
      pageId: candidate.page.id,
      sourceFinalUrl: candidate.normalizedUrl,
      publicFinalUrl: candidate.normalizedUrl,
      mainPath: localPath,
      capturedAt: '2026-09-20T00:00:00.000Z',
      design: {
        locale: candidate.locale,
        semanticRole: candidate.semanticRole,
        routeTemplate: candidate.routeTemplate,
        layoutFingerprint: layoutFingerprint(html),
        layoutFingerprintVersion: 'dom-structure-v1',
      },
      files: [
        { kind: 'DOCUMENT', localPath, sourceUrl: candidate.normalizedUrl, contentType: 'text/html', body: html },
        {
          kind: 'RESOURCE', localPath: 'assets/shared.css', sourceUrl: 'https://example.com/shared.css',
          contentType: 'text/css', body: Buffer.from('body{color:#123}', 'utf8'),
        },
      ],
    }
    const value = encodeSiteBundle(bundle)
    encoded.set(candidate.page.id, value)
    return {
      pageId: candidate.page.id,
      ordinal,
      publicUrl: candidate.normalizedUrl,
      localPath,
      bucket: 'fixture',
      key: candidate.page.id,
      bytes: value.length,
      sha256Hex: '0'.repeat(64),
    }
  })
  const outcomes = [
    ...references.map((reference) => ({
      pageId: reference.pageId,
      publicUrl: reference.publicUrl,
      localPath: reference.localPath,
      status: 'SUCCEEDED',
      failureCode: null,
    })),
    ...selection.rejected.map((rejection, ordinal) => ({
      pageId: rejection.page.id,
      publicUrl: rejection.normalizedUrl,
      localPath: `rejected/${ordinal}.html`,
      status: 'CANCELLED',
      failureCode: rejection.reason,
    })),
  ]
  const routes = references.map((reference) => ({
    urlSha256Hex: rawUrlHash(reference.publicUrl).toString('hex'),
    localPath: reference.localPath,
  }))
  const build = await buildSiteArchives(
    'https://example.com/vi/', references, outcomes, routes, 1_048_576, 4_194_304,
    async (reference) => encoded.get(reference.pageId)!,
  )

  try {
    assert.equal(build.parts.length, 1)
    const entries = zipEntries(await readFile(build.parts[0]!.path))
    assert.equal([...entries.keys()].filter((name) => name === 'assets/shared.css').length, 1)
    assert.ok([...entries.keys()].every((name) => !/screenshot/iu.test(name)))
    const index = entries.get('index.html')?.toString('utf8') ?? ''
    assert.match(index, /href="pages\/login\.html"/u)
    assert.match(index, /href="https:\/\/example\.com\/vi\/blog\/post-99"/u)

    const manifest = JSON.parse(build.manifest.toString('utf8')) as {
      locale: string
      counts: { discovered: number; rendered: number; packaged: number }
      representatives: Array<{ semanticRole: string; layoutFingerprint: string | null }>
      routeMapping: Array<{ sourceUrl: string; localPath: string }>
      rejected: { reasonCounts: Record<string, number> }
      policy: { screenshot: boolean }
    }
    assert.equal(manifest.locale, 'vi')
    assert.deepEqual(manifest.counts, { discovered: 114, rejected: 103, grouped: 10, rendered: 11, packaged: 11 })
    assert.equal(manifest.policy.screenshot, false)
    assert.equal(manifest.routeMapping.length, 11)
    assert.equal(manifest.rejected.reasonCounts['ALTERNATE_LOCALE'], 1)
    assert.equal(manifest.representatives.filter((item) => item.semanticRole === 'ERROR_4XX').length, 2)
    const authRepresentatives = manifest.representatives.filter((item) => item.semanticRole.startsWith('AUTH_'))
    assert.equal(authRepresentatives.length, 3)
    assert.equal(new Set(authRepresentatives.map((item) => item.layoutFingerprint)).size, 1)
    assert.ok(manifest.representatives.every((item) => item.layoutFingerprint !== null))
  } finally {
    await cleanupSiteArchives(build)
  }
})

function designFixture(): DesignPageInput[] {
  const pages = [
    page('root', 'https://example.com/vi/'),
    page('login', 'https://example.com/vi/login'),
    page('register', 'https://example.com/vi/register'),
    page('forgot', 'https://example.com/vi/forgot-password'),
    page('blog-index', 'https://example.com/vi/blog'),
    page('use-case-index', 'https://example.com/vi/use-cases'),
    page('use-case-detail', 'https://example.com/vi/use-cases/teams'),
    page('error-403', 'https://example.com/vi/forbidden', 403),
    page('error-404', 'https://example.com/vi/missing', 404),
    { ...page('error-410', 'https://example.com/vi/gone', 410), stylesheets: 2 },
    page('pricing', 'https://example.com/vi/pricing'),
  ]
  for (let index = 0; index < 100; index++) {
    pages.push(page(`blog-${index}`, `https://example.com/vi/blog/post-${index}`))
  }
  const canonicalCopy = page('pricing-copy', 'https://example.com/vi/pricing-copy')
  canonicalCopy.canonicalUrl = '/vi/pricing'
  pages.find((item) => item.id === 'pricing')!.canonicalUrl = '/vi/pricing'
  pages.push(canonicalCopy)
  pages.push(page('pricing-query', 'https://example.com/vi/pricing?utm_source=newsletter'))
  pages.push({ ...page('english', 'https://example.com/en/blog'), htmlLang: 'en' })
  return pages
}

function page(id: string, url: string, statusCode = 200): DesignPageInput {
  return {
    id,
    url,
    finalUrl: url,
    outcome: statusCode >= 400 ? 'failed' : 'success',
    statusCode,
    contentType: 'text/html; charset=utf-8',
    canonicalUrl: '',
    htmlLang: url.includes('/vi/') ? 'vi' : 'en',
    hreflang: [],
    h1: ['Fixture'],
    h2: [],
    schemaOrgTypes: ['WebPage'],
    scripts: 1,
    stylesheets: 1,
  }
}

function fixtureHtml(statusCode: number, role: string, withLinks: boolean): Buffer {
  const errorVariant = statusCode === 410 ? '<aside class="expired"></aside>' : ''
  const layoutClass = role.startsWith('AUTH_') ? 'auth' : role.toLowerCase()
  const links = withLinks
    ? '<a href="/vi/login">Login</a><a href="/vi/blog/post-99">Discarded</a>'
    : ''
  return Buffer.from(
    `<html><body><main class="${layoutClass}"><section>${links}</section>${errorVariant}</main></body></html>`,
    'utf8',
  )
}

function zipEntries(zip: Buffer): Map<string, Buffer> {
  const entries = new Map<string, Buffer>()
  for (let offset = 0; offset + 46 <= zip.length; offset += 1) {
    if (zip.readUInt32LE(offset) !== 0x02014b50) continue
    const method = zip.readUInt16LE(offset + 10)
    const compressedSize = zip.readUInt32LE(offset + 20)
    const nameLength = zip.readUInt16LE(offset + 28)
    const extraLength = zip.readUInt16LE(offset + 30)
    const commentLength = zip.readUInt16LE(offset + 32)
    const localOffset = zip.readUInt32LE(offset + 42)
    const name = zip.subarray(offset + 46, offset + 46 + nameLength).toString('utf8')
    assert.equal(zip.readUInt32LE(localOffset), 0x04034b50)
    const localNameLength = zip.readUInt16LE(localOffset + 26)
    const localExtraLength = zip.readUInt16LE(localOffset + 28)
    const bodyOffset = localOffset + 30 + localNameLength + localExtraLength
    const compressed = zip.subarray(bodyOffset, bodyOffset + compressedSize)
    entries.set(name, method === 8 ? inflateRawSync(compressed) : Buffer.from(compressed))
    offset += 45 + nameLength + extraLength + commentLength
  }
  return entries
}

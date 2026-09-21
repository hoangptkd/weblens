import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import {
  buildStaticClone,
  cleanupStaticClone,
  inferExtension,
  planStaticClone,
  replacementForReference,
  rewriteCss,
  sanitizePathComponent,
  urlToLocalPath,
} from './static-clone.js'
import type { CloneInputResource } from './types.js'

test('ánh xạ URL thành path portable và chặn traversal/tên dành riêng', () => {
  assert.equal(urlToLocalPath('https://example.com/'), 'example.com/index.html')
  assert.equal(urlToLocalPath('https://example.com/%2e%2e/CON/app'), 'example.com/_CON/app')
  assert.equal(urlToLocalPath('https://example.com/a%2Fb/app'), 'example.com/a_b/app')
  assert.equal(inferExtension('example.com/assets/site', 'text/css; charset=utf-8'), 'example.com/assets/site.css')
  assert.equal(sanitizePathComponent('hello?.js'), 'hello_.js')
  assert.equal(sanitizePathComponent('café.html'), 'caf_.html')
})

test('query variant được tách path collision nhưng không lộ query value khi rewrite', () => {
  const resources = [
    input('https://example.com/app.js?token=secret-one', 'script', 'application/javascript', 'one'),
    input('https://example.com/app.js?token=secret-two', 'script', 'application/javascript', 'two'),
    input('https://cdn.example.net/app.js?token=external-secret', 'script', 'application/javascript', 'external'),
  ]
  const plan = planStaticClone('https://example.com/', resources, 20)
  assert.equal(plan.resources[0]?.localPath, 'example.com/app.js')
  assert.equal(plan.resources[1]?.localPath, 'example.com/app_1.js')
  assert.equal(plan.resources[2]?.skipReason, 'EXTERNAL_ORIGIN')
  assert.equal(
    replacementForReference('/app.js?token=secret-two', 'https://example.com/', plan.replacements),
    'app_1.js',
  )
  const redacted = replacementForReference(
    'https://cdn.example.net/app.js?token=external-secret',
    'https://example.com/',
    plan.replacements,
  )
  assert.doesNotMatch(redacted, /external-secret/u)
  assert.match(redacted, /REDACTED/u)
})

test('content-addressed resources giữ extension và chỉ deduplicate representation tương thích', () => {
  const resources = [
    input('https://example.com/shared-a', 'script', 'application/javascript', 'same-body'),
    input('https://example.com/shared-b', 'script', 'text/javascript', 'same-body'),
    input('https://example.com/shared-c', 'font', 'font/woff2', 'same-body'),
    input('https://example.com/styles/app', 'stylesheet', 'text/css', 'body{color:#123}'),
  ]
  const plan = planStaticClone('https://example.com/', resources, 20, { contentAddressedResources: true })

  assert.equal(plan.resources[0]?.localPath, plan.resources[1]?.localPath)
  assert.match(plan.resources[0]?.localPath ?? '', /^assets\/[0-9a-f]{64}\.js$/u)
  assert.match(plan.resources[2]?.localPath ?? '', /^assets\/[0-9a-f]{64}\.woff2$/u)
  assert.notEqual(plan.resources[0]?.localPath, plan.resources[2]?.localPath)
  assert.match(plan.resources[3]?.localPath ?? '', /^assets\/[0-9a-f]{64}\.css$/u)
})

test('tạo ZIP bounded và manifest trung thực cho partial clone', async () => {
  const resources = [
    input('https://example.com/styles/site?theme=private', 'stylesheet', 'text/css',
      'body{background:url("../img/hero.png?sig=secret")}', true),
    input('https://example.com/img/hero.png?sig=secret', 'image', 'image/png', 'png'),
    { ...input('https://example.com/missing.js', 'script', 'application/javascript', ''), body: null,
      skipReason: 'BODY_UNAVAILABLE' },
  ]
  const plan = planStaticClone('https://example.com/', resources, 30)
  const css = rewriteCss(resources[0]!.body!.toString('utf8'), resources[0]!.sourceUrl,
    plan.resources[0]!.localPath!, plan)
  assert.doesNotMatch(css, /sig=secret/u)
  assert.match(css, /hero\.png/u)
  const imported = rewriteCss(
    '@import "https://example.com/styles/site?theme=private";',
    'https://example.com/base.css',
    'example.com/base.css',
    plan,
  )
  assert.doesNotMatch(imported, /theme=private/u)
  assert.match(imported, /styles\/site\.css/u)

  const build = await buildStaticClone(plan, Buffer.from('<html><body>clone</body></html>'))
  try {
    assert.equal(build.status, 'PARTIAL')
    assert.equal(build.packagedCount, 3)
    assert.equal(build.skippedCount, 1)
    assert.ok(build.archivePath)
    assert.ok(build.archiveBytes && build.archiveBytes > 0)
    const signature = (await readFile(build.archivePath!)).subarray(0, 4).toString('hex')
    assert.equal(signature, '504b0304')
    const manifest = JSON.parse(build.manifest!.toString('utf8')) as { completenessCode: string; files: unknown[] }
    assert.equal(manifest.completenessCode, 'TRUNCATED_RESOURCE')
    assert.equal(manifest.files.length, 4)
    assert.doesNotMatch(build.manifest!.toString('utf8'), /private|secret/u)
  } finally {
    await cleanupStaticClone(build)
  }
})

function input(
  sourceUrl: string,
  resourceType: string,
  mimeType: string,
  value: string,
  wasTruncated = false,
): CloneInputResource {
  return {
    sequence: 1,
    sourceUrl,
    publicUrl: sourceUrl.replace(/=.*/u, '=[REDACTED]'),
    resourceType,
    mimeType,
    body: Buffer.from(value),
    wasTruncated,
    skipReason: null,
  }
}

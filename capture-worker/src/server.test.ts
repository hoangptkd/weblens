import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { test } from 'node:test'
import type { AddressInfo } from 'node:net'
import type { Config } from './config.js'
import type { CaptureDatabase } from './database.js'
import type { SiteCloneDatabase } from './site-database.js'
import { startServer } from './server.js'
import type { InteractiveBrowserSessionManager } from './browser-session.js'

const token = 'capture-worker-test-token-at-least-32-bytes'
const ownerId = '11111111-1111-1111-1111-111111111111'
const captureId = '22222222-2222-2222-2222-222222222222'
const resourceId = '33333333-3333-3333-3333-333333333333'
const reconstructionId = '44444444-4444-4444-4444-444444444444'
const siteArtifactId = '55555555-5555-5555-5555-555555555555'

test('chỉ trả artifact qua service token, owner scope và kiểm tra integrity', async () => {
  const screenshot = Buffer.from([0xff, 0xd8, 0xff, 0xd9])
  const resource = Buffer.from('<script>untrusted()</script>', 'utf8')
  const archive = Buffer.from('PK\u0003\u0004static-clone', 'binary')
  const siteArchive = Buffer.from('PK\u0003\u0004site-clone', 'binary')
  const expiresAt = new Date(Date.now() + 60_000)
  const artifactCreatedAt = new Date('2026-09-21T10:21:00.123Z')
  let corruptResource = false
  let archiveState: 'PUBLISHED' | 'DELETE_PENDING' = 'PUBLISHED'
  const database = {
    ping: async () => undefined,
    acceptCommand: async () => false,
    getSnapshot: async () => null,
    getReconstruction: async (requestedOwnerId: string, requestedCaptureId: string) => (
      requestedOwnerId === ownerId && requestedCaptureId === captureId
        ? {
            reconstruction_id: reconstructionId,
            reconstruction_status: 'PARTIAL',
            reconstruction_kind: 'STATIC_PAGE_ARCHIVE',
            engine_version: 'test-engine',
            packaged_count: 2,
            skipped_count: 1,
            archive_bytes: archive.length,
            completeness_code: 'RESOURCE_GAPS',
            failure_code: null,
            reconstruction_expires_at: expiresAt,
            reconstruction_download_available: true,
          }
        : null
    ),
    getReconstructionArchiveReference: async (requestedOwnerId: string, requestedReconstructionId: string) => (
      requestedOwnerId === ownerId && requestedReconstructionId === reconstructionId
        ? {
            bucket: 'captures', key: 'owner/capture/clone.zip', bytes: archive.length,
            sha256Hex: createHash('sha256').update(archive).digest('hex'), expiresAt, state: archiveState,
          }
        : null
    ),
    getScreenshotReference: async (requestedOwnerId: string, requestedCaptureId: string) => {
      if (requestedOwnerId !== ownerId || requestedCaptureId !== captureId) return null
      return {
        bucket: 'captures', key: 'owner/capture/screenshot.jpg', bytes: screenshot.length,
        sha256Hex: createHash('sha256').update(screenshot).digest('hex'), expiresAt,
      }
    },
    getResourceReference: async (
      requestedOwnerId: string,
      requestedCaptureId: string,
      requestedResourceId: string,
    ) => {
      if (requestedOwnerId !== ownerId || requestedCaptureId !== captureId || requestedResourceId !== resourceId) {
        return null
      }
      return {
        bucket: 'captures', key: 'owner/capture/resource.bin', contentType: 'application/javascript',
        bytes: resource.length, sha256Hex: createHash('sha256').update(resource).digest('hex'), expiresAt,
      }
    },
  } satisfies Pick<
    CaptureDatabase,
    'ping' | 'acceptCommand' | 'getSnapshot' | 'getScreenshotReference' | 'getResourceReference'
    | 'getReconstruction' | 'getReconstructionArchiveReference'
  >
  const analytics = { ping: async () => undefined, listResources: async () => [] }
  const storage = {
    get: async (bucket: string, key: string) => {
      assert.equal(bucket, 'captures')
      if (key === 'owner/capture/screenshot.jpg') return screenshot
      if (key === 'owner/capture/clone.zip') return archive
      if (key === 'owner/site-clone/archive.zip') return siteArchive
      assert.equal(key, 'owner/capture/resource.bin')
      return corruptResource ? Buffer.from('corrupt', 'utf8') : resource
    },
  }
  const siteDatabase: Pick<SiteCloneDatabase, 'acceptCommand' | 'getReport' | 'getArtifact' | 'getProgress'> = {
    acceptCommand: async () => false, getReport: async () => null,
    getArtifact: async (owner, job, artifact) => owner === ownerId && job === captureId && artifact === siteArtifactId
      ? {
          id: siteArtifactId, createdAt: artifactCreatedAt, kind: 'ARCHIVE_SHARD', shardNumber: 1,
          logicalFilename: 'weblens-site-clone.part-0001.zip', bucket: 'captures',
          key: 'owner/site-clone/archive.zip', contentType: 'application/zip', bytes: siteArchive.length,
          sha256Hex: createHash('sha256').update(siteArchive).digest('hex'), expiresAt, state: 'PUBLISHED',
        }
      : null,
    getProgress: async (owner, id, after, limit, status, q) => {
      if (owner !== ownerId) return null
      assert.equal(id, captureId)
      assert.equal(after, 12); assert.equal(limit, 20); assert.equal(status, 'FAILED'); assert.equal(q, '/about')
      return { available: true, jobId: id, scanId: resourceId, correlationId: reconstructionId,
        phase: 'RUNNING', ingestionComplete: true, observedAt: new Date(), updatedAt: new Date(),
        startedAt: new Date(), finishedAt: null, phaseAttemptCount: 0, phaseRetryAt: new Date(),
        phaseLeaseExpired: false, terminalCode: null,
        counts: { QUEUED: 0, RENDERING: 0, SUCCEEDED: 1, FAILED: 1, CANCELLED: 0 }, activePages: [], items: [], nextAfter: null }
    },
  }
  const browserStatus = {
    status: 'AWAITING_USER' as const, currentUrl: 'https://example.com/login',
    expiresAt: new Date(Date.now() + 60_000).toISOString(), viewportWidth: 1365, viewportHeight: 768,
  }
  let receivedAction: unknown = null
  const browserSessions: Pick<InteractiveBrowserSessionManager, 'start' | 'status' | 'screenshot' | 'act' | 'ready' | 'close'> = {
    start: async (owner, clone) => {
      assert.equal(owner, ownerId); assert.equal(clone, captureId); return browserStatus
    },
    status: (owner, clone) => owner === ownerId && clone === captureId ? browserStatus : null,
    screenshot: async (owner, clone) => owner === ownerId && clone === captureId ? screenshot : null,
    act: async (owner, clone, action) => {
      if (owner !== ownerId || clone !== captureId) return null
      receivedAction = action
      return browserStatus
    },
    ready: (owner, clone) => owner === ownerId && clone === captureId ? { ...browserStatus, status: 'READY' } : null,
    close: async (owner, clone) => owner === ownerId && clone === captureId,
  }
  const server = startServer(config(), database, analytics, storage, siteDatabase, browserSessions)
  await once(server, 'listening')
  const port = (server.address() as AddressInfo).port
  const path = `/internal/v1/reports/captures/${captureId}/artifacts/screenshot?ownerId=${ownerId}`

  try {
    const sessionPath = `/internal/v1/browser-sessions/site-clones/${captureId}`
    const startedSession = await fetch(`http://127.0.0.1:${port}${sessionPath}`, {
      method: 'POST', headers: { 'X-WebLens-Service-Token': token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ownerId, targetUrl: 'https://example.com/' }),
    })
    assert.equal(startedSession.status, 201)
    assert.equal((await fetch(`http://127.0.0.1:${port}${sessionPath}?ownerId=${resourceId}`,
      { headers: { 'X-WebLens-Service-Token': token } })).status, 404)
    const secret = 'otp-that-must-not-be-returned'
    const actionResponse = await fetch(`http://127.0.0.1:${port}${sessionPath}/actions`, {
      method: 'POST', headers: { 'X-WebLens-Service-Token': token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ownerId, action: { type: 'type', text: secret } }),
    })
    assert.equal(actionResponse.status, 200)
    assert.deepEqual(receivedAction, { type: 'type', text: secret })
    assert.equal((await actionResponse.text()).includes(secret), false)

    const progressPath = `/internal/v1/reports/site-clones/${captureId}/progress?ownerId=${ownerId}&after=12&limit=20&status=FAILED&q=%2Fabout`
    assert.equal((await fetch(`http://127.0.0.1:${port}${progressPath}`)).status, 401)
    const progressResponse = await fetch(`http://127.0.0.1:${port}${progressPath}`, { headers: { 'X-WebLens-Service-Token': token } })
    assert.equal(progressResponse.status, 200)
    assert.equal(progressResponse.headers.get('cache-control'), 'no-store')
    const progressBody = await progressResponse.json() as { phase: string; counts: { FAILED: number } }
    assert.equal(progressBody.phase, 'RUNNING'); assert.equal(progressBody.counts.FAILED, 1)
    assert.equal((await fetch(`http://127.0.0.1:${port}${progressPath.replace(ownerId, resourceId)}`,
      { headers: { 'X-WebLens-Service-Token': token } })).status, 404)
    assert.equal((await fetch(`http://127.0.0.1:${port}${progressPath.replace(ownerId, 'invalid')}`,
      { headers: { 'X-WebLens-Service-Token': token } })).status, 400)
    const unauthorized = await fetch(`http://127.0.0.1:${port}${path}`)
    assert.equal(unauthorized.status, 401)
    assert.equal(unauthorized.headers.get('content-type'), 'application/problem+json')
    const unauthorizedProblem = await unauthorized.json() as Record<string, unknown>
    assert.equal(unauthorizedProblem['code'], 'SERVICE_AUTHENTICATION_REQUIRED')
    assert.equal(unauthorizedProblem['instance'], path.split('?', 1)[0])
    assert.equal(unauthorizedProblem['correlationId'], unauthorized.headers.get('x-correlation-id'))

    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      headers: { 'X-WebLens-Service-Token': token },
    })
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('content-type'), 'image/jpeg')
    assert.equal(response.headers.get('etag'), `"sha256-${createHash('sha256').update(screenshot).digest('hex')}"`)
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), screenshot)

    const resourcePath = `/internal/v1/reports/captures/${captureId}/resources/${resourceId}/content?ownerId=${ownerId}`
    const resourceResponse = await fetch(`http://127.0.0.1:${port}${resourcePath}`, {
      headers: { 'X-WebLens-Service-Token': token },
    })
    assert.equal(resourceResponse.status, 200)
    assert.equal(resourceResponse.headers.get('content-type'), 'application/octet-stream')
    assert.match(resourceResponse.headers.get('content-disposition') ?? '', /^attachment;/u)
    assert.equal(resourceResponse.headers.get('cache-control'), 'no-store')
    assert.equal(resourceResponse.headers.get('x-content-type-options'), 'nosniff')
    assert.deepEqual(Buffer.from(await resourceResponse.arrayBuffer()), resource)

    const siteArchiveResponse = await fetch(
      `http://127.0.0.1:${port}/internal/v1/reports/site-clones/${captureId}/artifacts/${siteArtifactId}?ownerId=${ownerId}`,
      { headers: { 'X-WebLens-Service-Token': token } },
    )
    assert.equal(siteArchiveResponse.status, 200)
    assert.equal(
      siteArchiveResponse.headers.get('content-disposition'),
      'attachment; filename="weblens-site-clone-20260921T102100123Z-55555555.part-0001.zip"',
    )
    assert.deepEqual(Buffer.from(await siteArchiveResponse.arrayBuffer()), siteArchive)

    const reconstructionResponse = await fetch(
      `http://127.0.0.1:${port}/internal/v1/reports/captures/${captureId}/reconstruction?ownerId=${ownerId}`,
      { headers: { 'X-WebLens-Service-Token': token } },
    )
    assert.equal(reconstructionResponse.status, 200)
    assert.deepEqual(await reconstructionResponse.json(), {
      id: reconstructionId,
      status: 'PARTIAL',
      kind: 'STATIC_PAGE_ARCHIVE',
      engineVersion: 'test-engine',
      packagedCount: 2,
      skippedCount: 1,
      archiveBytes: archive.length,
      completenessCode: 'RESOURCE_GAPS',
      failureCode: null,
      expiresAt: expiresAt.toISOString(),
      downloadAvailable: true,
    })

    const archiveResponse = await fetch(
      `http://127.0.0.1:${port}/internal/v1/reports/reconstructions/${reconstructionId}/artifacts/archive?ownerId=${ownerId}`,
      { headers: { 'X-WebLens-Service-Token': token } },
    )
    assert.equal(archiveResponse.status, 200)
    assert.equal(archiveResponse.headers.get('content-type'), 'application/zip')
    assert.match(archiveResponse.headers.get('content-disposition') ?? '', /^attachment;/u)
    assert.equal(archiveResponse.headers.get('cache-control'), 'no-store')
    assert.equal(archiveResponse.headers.get('x-content-type-options'), 'nosniff')
    assert.deepEqual(Buffer.from(await archiveResponse.arrayBuffer()), archive)

    archiveState = 'DELETE_PENDING'
    const deletingArchive = await fetch(
      `http://127.0.0.1:${port}/internal/v1/reports/reconstructions/${reconstructionId}/artifacts/archive?ownerId=${ownerId}`,
      { headers: { 'X-WebLens-Service-Token': token } },
    )
    assert.equal(deletingArchive.status, 410)
    archiveState = 'PUBLISHED'

    const wrongOwner = await fetch(`http://127.0.0.1:${port}${resourcePath.replace(ownerId, captureId)}`, {
      headers: { 'X-WebLens-Service-Token': token },
    })
    assert.equal(wrongOwner.status, 404)

    expiresAt.setTime(Date.now() - 1)
    const expired = await fetch(`http://127.0.0.1:${port}${resourcePath}`, {
      headers: { 'X-WebLens-Service-Token': token },
    })
    assert.equal(expired.status, 410)
    assert.equal((await expired.json() as { code: string }).code, 'CAPTURE_ARTIFACT_GONE')

    expiresAt.setTime(Date.now() + 60_000)
    corruptResource = true
    const corrupted = await fetch(`http://127.0.0.1:${port}${resourcePath}`, {
      headers: { 'X-WebLens-Service-Token': token },
    })
    assert.equal(corrupted.status, 503)
    assert.equal((await corrupted.json() as { code: string }).code, 'CAPTURE_ARTIFACT_INTEGRITY_FAILED')
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  }
})

function config(): Config {
  return {
    host: '127.0.0.1',
    port: 0,
    serviceToken: token,
    databaseUrl: 'postgresql://unused',
    clickhouseUrl: 'http://unused',
    clickhouseDatabase: 'unused',
    clickhouseUsername: 'unused',
    clickhousePassword: 'unused',
    s3Endpoint: 'http://unused',
    s3Region: 'unused',
    s3AccessKey: 'unused',
    s3SecretKey: 'unused',
    s3Bucket: 'captures',
    controlEventUrl: 'http://unused',
    controlSiteCloneEventUrl: 'http://unused',
    crawlerReportBaseUrl: 'http://unused',
    concurrency: 1,
    workerPollMillis: 100,
    analyticsPollMillis: 100,
    eventPollMillis: 100,
    reconstructionGcPollMillis: 1_000,
    siteCloneConcurrency: 1,
    siteClonePollMillis: 100,
    migrateClickHouseOnStart: true,
  }
}

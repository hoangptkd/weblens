import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import { SiteCloneWorker } from './site-worker.js'
import type { Config } from './config.js'
import type { SiteCloneDatabase, ClaimedSitePage, ClaimedSitePhase } from './site-database.js'
import { encodeSiteBundle } from './site-archive.js'
import type { ObjectStorage } from './storage.js'
import type { InteractiveBrowserSessionManager } from './browser-session.js'
import type { CaptureResult, StoredObject } from './types.js'

test('a lost COMMIT response never deletes the possibly committed page bundle', async () => {
  for (const ambiguous of [true, false]) {
    const deleted: string[] = []
    let committed = false
    const database = {
      completePage: async () => {
        committed = ambiguous
        if (ambiguous) throw new Error('COMMIT_ACK_LOST')
        return false
      },
      failPage: async () => undefined,
    } as unknown as SiteCloneDatabase
    const storage = {
      put: async (key: string, body: Buffer, contentType: string): Promise<StoredObject> => ({
        bucket: 'test', key, bytes: body.length, sha256: createHash('sha256').update(body).digest(), contentType,
      }),
      delete: async (object: StoredObject) => { deleted.push(object.key) },
    } as unknown as ObjectStorage
    const sessions = { status: () => null, waitForReady: async () => null } as unknown as InteractiveBrowserSessionManager
    const rendered = { html: Buffer.from('<html><body>page</body></html>'), reconstruction: {
      temporaryDirectory: null, siteBundle: { schemaVersion: 1, sourceFinalUrl: 'https://example.com/',
        publicFinalUrl: 'https://example.com/', mainPath: 'index.html', capturedAt: new Date().toISOString(),
        files: [{ kind: 'DOCUMENT', localPath: 'index.html', sourceUrl: 'https://example.com/',
          contentType: 'text/html', body: Buffer.from('page') }] },
    } } as unknown as CaptureResult
    const worker = new SiteCloneWorker({ crawlerReportBaseUrl: 'http://127.0.0.1:1' } as Config,
      database, storage, sessions, async () => rendered)
    const work = { jobId: 'job', pageId: 'job', ownerId: 'owner', scanId: 'scan', correlationId: 'correlation',
      rootUrl: 'https://example.com/', publicUrl: 'https://example.com/', localPath: 'index.html',
      attemptCount: 1, maxRetries: 3, leaseOwner: 'worker', leaseGeneration: 1 } satisfies ClaimedSitePage
    await (worker as unknown as { processPage: (page: ClaimedSitePage) => Promise<void> }).processPage(work)
    assert.equal(committed, ambiguous)
    assert.equal(deleted.length, ambiguous ? 0 : 1)
  }
})

test('lost publication COMMIT response cleans staging only, never final archive objects', async () => {
  const deleted: string[] = []
  const published: string[] = []
  const bundle = encodeSiteBundle({ schemaVersion: 1, pageId: 'page', sourceFinalUrl: 'https://example.com/',
    publicFinalUrl: 'https://example.com/', mainPath: 'index.html', capturedAt: new Date().toISOString(),
    files: [{ kind: 'DOCUMENT', localPath: 'index.html', sourceUrl: 'https://example.com/',
      contentType: 'text/html', body: Buffer.from('<html><body>evidence</body></html>') }] })
  const database = {
    listBundles: async () => [{ pageId: 'page', ordinal: 0, publicUrl: 'https://example.com/',
      localPath: 'index.html', bucket: 'test', key: 'bundle', bytes: bundle.length,
      sha256Hex: createHash('sha256').update(bundle).digest('hex') }],
    listPageOutcomes: async () => [], listRoutes: async () => [], stageArtifacts: async () => undefined,
    publishArtifacts: async () => { throw new Error('COMMIT_ACK_LOST') },
    retryAssembly: async () => undefined,
  } as unknown as SiteCloneDatabase
  const put = async (key: string, body: Buffer, contentType: string): Promise<StoredObject> => ({
    bucket: 'test', key, bytes: body.length, sha256: createHash('sha256').update(body).digest(), contentType,
  })
  const storage = { get: async () => bundle, put,
    putFile: async (key: string, path: string, type: string) => put(key, await readFile(path), type),
    verify: async () => undefined,
    copy: async (object: StoredObject, key: string) => { published.push(key); return { ...object, key } },
    delete: async (object: StoredObject) => { deleted.push(object.key) },
  } as unknown as ObjectStorage
  const worker = new SiteCloneWorker({ crawlerReportBaseUrl: 'http://127.0.0.1:1' } as Config,
    database, storage, {} as InteractiveBrowserSessionManager)
  const phase = { id: 'job', ownerId: 'owner', scanId: 'scan', correlationId: 'correlation',
    rootUrl: 'https://example.com/', leaseOwner: 'worker', leaseGeneration: 2, attemptCount: 1,
    payload: { maxPages: 5, maxInputBytes: 1024 * 1024, maxShardBytes: 1024 * 1024, maxArchiveBytes: 2 * 1024 * 1024 },
  } as ClaimedSitePhase
  await (worker as unknown as { assemble: (job: ClaimedSitePhase) => Promise<void> }).assemble(phase)
  assert.equal(published.length, 2)
  assert.equal(deleted.length, 2)
  assert.ok(deleted.every((key) => key.startsWith('site-clone-staging/')))
  assert.ok(published.every((key) => !deleted.includes(key)))
})

test('event loop keeps polling after the database fails to record retry', async () => {
  let claims = 0
  let worker: SiteCloneWorker
  const database = {
    claimEvent: async () => {
      if (++claims === 1) return { messageId: 'event', payload: {}, leaseOwner: 'worker' }
      worker.stop()
      return null
    },
    retryEvent: async () => { throw new Error('DATABASE_UNAVAILABLE') },
  } as unknown as SiteCloneDatabase
  worker = new SiteCloneWorker({ crawlerReportBaseUrl: 'http://127.0.0.1:1', siteClonePollMillis: 1,
    controlSiteCloneEventUrl: 'http://127.0.0.1:1', serviceToken: 'test' } as Config,
    database, {} as ObjectStorage, {} as InteractiveBrowserSessionManager)
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => new Response(null, { status: 503 })
  try {
    await (worker as unknown as { eventLoop: (id: string) => Promise<void> }).eventLoop('worker')
    assert.equal(claims, 2)
  } finally { globalThis.fetch = originalFetch }
})

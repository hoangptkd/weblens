import { createHash, randomUUID, timingSafeEqual } from 'node:crypto'
import { capturePage } from './capture.js'
import type { Config } from './config.js'
import { CrawlerReportClient } from './crawler-client.js'
import {
  describeDesignPage,
  layoutFingerprint,
  LAYOUT_FINGERPRINT_VERSION,
  selectDesignPages,
} from './design-clone.js'
import { log } from './log.js'
import { ObjectStorage } from './storage.js'
import {
  buildSiteArchives,
  cleanupSiteArchives,
  encodeSiteBundle,
  rawUrlHash,
  sitePagePath,
  type SiteArchiveBuild,
} from './site-archive.js'
import { SiteCloneDatabase, type ClaimedSitePage, type ClaimedSitePhase } from './site-database.js'
import type { CaptureCommandPayload, SitePageBundle } from './types.js'

export class SiteCloneWorker {
  private running = true
  private readonly crawler: CrawlerReportClient

  constructor(
    private readonly config: Config,
    private readonly database: SiteCloneDatabase,
    private readonly storage: ObjectStorage,
  ) {
    this.crawler = new CrawlerReportClient(config)
  }

  start(): Promise<void>[] {
    const loops: Promise<void>[] = [
      this.ingestionLoop(randomUUID()),
      this.assemblyLoop(randomUUID()),
      this.eventLoop(randomUUID()),
      this.cancellationLoop(),
      this.garbageCollectionLoop(),
    ]
    for (let index = 0; index < this.config.siteCloneConcurrency; index++) {
      loops.push(this.pageLoop(randomUUID()))
    }
    return loops
  }

  stop(): void {
    this.running = false
  }

  private async ingestionLoop(workerId: string): Promise<void> {
    while (this.running) {
      const job = await this.database.claimIngestion(workerId).catch((error: unknown) => {
        log('warn', 'site clone ingestion claim failed', { errorType: errorName(error) })
        return null
      })
      if (!job) {
        await delay(this.config.siteClonePollMillis)
        continue
      }
      try {
        await this.ingest(job)
      } catch (error) {
        await this.database.retryIngestion(job, boundedErrorCode(error)).catch(() => undefined)
        log('warn', 'site clone target ingestion failed', {
          siteCloneRequestId: job.id,
          errorType: errorName(error),
        })
      }
    }
  }

  private async ingest(job: ClaimedSitePhase): Promise<void> {
    log('info', 'site clone selection started', { siteCloneRequestId: job.id, scanId: job.scanId,
      correlationId: job.correlationId, phase: 'INGESTING', attempt: job.attemptCount })
    let cursor: string | undefined
    let reachedLimit = false
    const discovered: import('./crawler-client.js').CrawlerPageTarget[] = []
    do {
      if (!await this.database.extendPhaseLease(job)) throw new Error('STALE_SITE_INGESTION_LEASE')
      const batch = await this.crawler.listPages(job.ownerId, job.scanId, cursor)
      for (const page of batch.items) {
        if (discovered.length >= job.payload.maxPages) {
          reachedLimit = true
          break
        }
        discovered.push(page)
      }
      cursor = batch.nextCursor || undefined
    } while (cursor && !reachedLimit)

    const selection = selectDesignPages(job.rootUrl, discovered, reachedLimit)
    const seenPaths = new Set<string>()
    let ordinal = 0
    const targets: import('./site-database.js').SiteTargetInput[] = []
    for (const candidate of selection.selected) {
      let localPath = sitePagePath(job.rootUrl, candidate.normalizedUrl, candidate.page.id)
      while (seenPaths.has(localPath.toLowerCase())) localPath = `pages/${candidate.page.id}-${ordinal}.html`
      seenPaths.add(localPath.toLowerCase())
      targets.push({
        pageId: candidate.page.id,
        ordinal,
        publicUrl: sanitizeForDatabase(candidate.normalizedUrl),
        urlSha256: rawUrlHash(candidate.normalizedUrl),
        localPath,
      })
      ordinal += 1
    }
    for (const rejection of selection.rejected) {
      const normalizedUrl = rejection.normalizedUrl || rejection.page.finalUrl || rejection.page.url
      let localPath = `rejected/${rejection.page.id}.html`
      while (seenPaths.has(localPath.toLowerCase())) localPath = `rejected/${rejection.page.id}-${ordinal}.html`
      seenPaths.add(localPath.toLowerCase())
      targets.push({
        pageId: rejection.page.id,
        ordinal,
        publicUrl: sanitizeForDatabase(normalizedUrl),
        urlSha256: createHash('sha256').update(`${normalizedUrl}\n${rejection.page.id}`, 'utf8').digest(),
        localPath,
        status: 'CANCELLED',
        failureCode: rejection.reason,
      })
      ordinal += 1
    }
    for (let index = 0; index < targets.length; index += 250) {
      if (!await this.database.extendPhaseLease(job)) throw new Error('STALE_SITE_INGESTION_LEASE')
      await this.database.addTargets(job, targets.slice(index, index + 250))
    }
    await this.database.finishIngestion(job)
    log('info', 'site clone selection completed', { siteCloneRequestId: job.id, scanId: job.scanId,
      correlationId: job.correlationId, phase: 'INGESTING', selectedCount: selection.selected.length,
      skippedCount: selection.rejected.length })
  }

  private async pageLoop(workerId: string): Promise<void> {
    while (this.running) {
      const page = await this.database.claimPage(workerId).catch((error: unknown) => {
        log('warn', 'site clone page claim failed', { errorType: errorName(error) })
        return null
      })
      if (!page) {
        await delay(this.config.siteClonePollMillis)
        continue
      }
      await this.processPage(page)
    }
  }

  private async processPage(work: ClaimedSitePage): Promise<void> {
    const started = Date.now()
    const trace = { siteCloneRequestId: work.jobId, scanId: work.scanId, correlationId: work.correlationId,
      pageId: work.pageId, attempt: work.attemptCount, leaseGeneration: work.leaseGeneration, phase: 'RENDERING' }
    log('info', 'site clone page started', trace)
    const heartbeat = setInterval(() => {
      void this.database.extendPageLease(work).catch((error: unknown) => log('warn', 'site page heartbeat failed', {
        siteCloneRequestId: work.jobId,
        pageId: work.pageId,
        errorType: errorName(error),
      }))
    }, 15_000)
    let result: Awaited<ReturnType<typeof capturePage>> | null = null
    let uploaded: import('./types.js').StoredObject | null = null
    try {
      const target = await this.crawler.getPage(work.ownerId, work.pageId)
      const targetUrl = target.finalUrl || target.url
      if (!targetUrl || new URL(targetUrl).origin !== new URL(work.rootUrl).origin) {
        throw new Error('SITE_PAGE_ORIGIN_CHANGED')
      }
      result = await capturePage(captureCommand(work, targetUrl), {
        mainPath: work.localPath,
        contentAddressedResources: true,
        includeSiteBundle: true,
        preserveUnmatchedReferences: true,
        captureScreenshot: false,
      })
      const partial = result.reconstruction.siteBundle
      if (!partial) throw new Error('SITE_PAGE_BUNDLE_MISSING')
      const descriptor = describeDesignPage(work.rootUrl, target)
      const bundle: SitePageBundle = {
        ...partial,
        pageId: work.pageId,
        design: {
          locale: descriptor.locale,
          semanticRole: descriptor.semanticRole,
          routeTemplate: descriptor.routeTemplate,
          layoutFingerprint: layoutFingerprint(result.html),
          layoutFingerprintVersion: LAYOUT_FINGERPRINT_VERSION,
        },
      }
      const encoded = encodeSiteBundle(bundle)
      const inputBytes = bundle.files.reduce((sum, file) => sum + file.body.length, 0)
      uploaded = await this.storage.put(
        `${work.ownerId}/site-clones/${work.jobId}/pages/${work.pageId}/${work.leaseGeneration}.json`,
        encoded,
        'application/json',
      )
      const accepted = await this.database.completePage(work, uploaded, inputBytes)
      if (!accepted) await this.storage.delete(uploaded)
      log('info', 'site clone page completed', {
        ...trace, accepted, durationMs: Date.now() - started,
      })
    } catch (error) {
      log('warn', 'site clone page attempt failed', { ...trace, errorCode: boundedErrorCode(error),
        durationMs: Date.now() - started, retryEligible: work.attemptCount < work.maxRetries })
      if (uploaded) await this.storage.delete(uploaded).catch(() => undefined)
      await this.database.failPage(work, boundedErrorCode(error)).catch((databaseError: unknown) => {
        log('warn', 'site clone page failure persistence failed', {
          siteCloneRequestId: work.jobId,
          pageId: work.pageId,
          errorType: errorName(databaseError),
        })
      })
    } finally {
      clearInterval(heartbeat)
      if (result) {
        const { cleanupStaticClone } = await import('./static-clone.js')
        await cleanupStaticClone(result.reconstruction)
      }
    }
  }

  private async assemblyLoop(workerId: string): Promise<void> {
    while (this.running) {
      const job = await this.database.claimAssembly(workerId).catch((error: unknown) => {
        log('warn', 'site clone assembly claim failed', { errorType: errorName(error) })
        return null
      })
      if (!job) {
        await delay(this.config.siteClonePollMillis)
        continue
      }
      await this.assemble(job)
    }
  }

  private async assemble(job: ClaimedSitePhase): Promise<void> {
    const started = Date.now()
    log('info', 'site clone assembly started', { siteCloneRequestId: job.id, scanId: job.scanId,
      correlationId: job.correlationId, phase: 'ASSEMBLING', attempt: job.attemptCount })
    const heartbeat = setInterval(() => {
      void this.database.extendPhaseLease(job).catch((error: unknown) => log('warn', 'site assembly heartbeat failed', {
        siteCloneRequestId: job.id,
        errorType: errorName(error),
      }))
    }, 15_000)
    let build: SiteArchiveBuild | null = null
    const staged: import('./types.js').StoredObject[] = []
    const uploaded: import('./types.js').StoredObject[] = []
    try {
      const [bundles, outcomes, routes] = await Promise.all([
        this.database.listBundles(job),
        this.database.listPageOutcomes(job.id),
        this.database.listRoutes(job.id),
      ])
      build = await buildSiteArchives(
        job.rootUrl,
        bundles,
        outcomes,
        routes,
        job.payload.maxShardBytes,
        job.payload.maxArchiveBytes,
        async (reference) => {
          const value = await this.storage.get(reference.bucket, reference.key)
          verifyBytes(value, reference.bytes, reference.sha256Hex)
          return value
        },
        { maxPages: job.payload.maxPages, maxInputBytes: job.payload.maxInputBytes },
      )
      const archiveBuild = build
      for (const part of archiveBuild.parts) {
        staged.push(await this.storage.putFile(
          `site-clone-staging/${job.ownerId}/${job.id}/${job.leaseGeneration}/${part.logicalFilename}`,
          part.path,
          'application/zip',
          job.payload.maxShardBytes,
        ))
      }
      staged.push(await this.storage.put(
        `site-clone-staging/${job.ownerId}/${job.id}/${job.leaseGeneration}/manifest.json`,
        archiveBuild.manifest,
        'application/json',
      ))
      await Promise.all(staged.map((object) => this.storage.verify(object)))
      const artifactInputs = staged.map((object, index): import('./site-database.js').SiteArtifactInput => {
        const filename = object.contentType === 'application/json'
          ? 'manifest.json'
          : archiveBuild.parts[index]!.logicalFilename
        const finalObject = {
          ...object,
          key: `${job.ownerId}/site-clones/${job.id}/artifacts/${job.leaseGeneration}/${filename}`,
        }
        return object.contentType === 'application/json'
          ? { kind: 'MANIFEST', shardNumber: 0, logicalFilename: filename, object: finalObject }
          : { kind: 'ARCHIVE_SHARD', shardNumber: archiveBuild.parts[index]!.shardNumber, logicalFilename: filename,
              object: finalObject }
      })
      await this.database.stageArtifacts(job, artifactInputs)
      for (let index = 0; index < staged.length; index++) {
        uploaded.push(await this.storage.copy(
          staged[index]!,
          artifactInputs[index]!.object.key,
        ))
      }
      await Promise.all(uploaded.map((object) => this.storage.verify(object)))
      await this.database.publishArtifacts(job, artifactInputs)
      await Promise.allSettled(staged.map((object) => this.storage.delete(object)))
      log('info', 'site clone archive published', {
        siteCloneRequestId: job.id,
        scanId: job.scanId, correlationId: job.correlationId, phase: 'PUBLISH', durationMs: Date.now() - started,
        shardCount: archiveBuild.parts.length,
      })
    } catch (error) {
      await Promise.allSettled([...staged, ...uploaded].map((object) => this.storage.delete(object)))
      await this.database.retryAssembly(job, boundedErrorCode(error)).catch(() => undefined)
      log('warn', 'site clone assembly failed', {
        siteCloneRequestId: job.id,
        scanId: job.scanId, correlationId: job.correlationId, phase: 'ASSEMBLING', attempt: job.attemptCount,
        errorCode: boundedErrorCode(error),
      })
    } finally {
      clearInterval(heartbeat)
      await cleanupSiteArchives(build)
    }
  }

  private async cancellationLoop(): Promise<void> {
    while (this.running) {
      await this.database.reconcileCancellations().catch((error: unknown) => log('warn', 'site clone cancellation reconciliation failed', {
        errorType: errorName(error),
      }))
      await delay(this.config.siteClonePollMillis)
    }
  }

  private async garbageCollectionLoop(): Promise<void> {
    while (this.running) {
      const deletion = await this.database.claimObjectForDeletion().catch((error: unknown) => {
        log('warn', 'site clone garbage-collection claim failed', { errorType: errorName(error) })
        return null
      })
      if (!deletion) {
        await delay(this.config.reconstructionGcPollMillis)
        continue
      }
      try {
        await this.storage.delete(deletion.object)
        await this.database.completeObjectDeletion(deletion)
        log('info', 'site clone object deleted', {
          siteCloneRequestId: deletion.jobId,
          objectType: deletion.type,
        })
      } catch (error) {
        await this.database.retryObjectDeletion(deletion).catch(() => undefined)
        log('warn', 'site clone object deletion failed', {
          siteCloneRequestId: deletion.jobId,
          objectType: deletion.type,
          errorType: errorName(error),
        })
      }
    }
  }

  private async eventLoop(workerId: string): Promise<void> {
    while (this.running) {
      const event = await this.database.claimEvent(workerId).catch(() => null)
      if (!event) {
        await delay(this.config.siteClonePollMillis)
        continue
      }
      try {
        const response = await fetch(this.config.controlSiteCloneEventUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-WebLens-Service-Token': this.config.serviceToken,
            'Idempotency-Key': event.messageId,
          },
          body: JSON.stringify(event.payload),
          signal: AbortSignal.timeout(10_000),
        })
        if (!response.ok) throw new Error(`CONTROL_HTTP_${response.status}`)
        await this.database.completeEvent(event)
      } catch {
        await this.database.retryEvent(event, 'CONTROL_DELIVERY_FAILED')
      }
    }
  }
}

function captureCommand(work: ClaimedSitePage, targetUrl: string): CaptureCommandPayload {
  return {
    captureRequestId: randomUUID(),
    ownerId: work.ownerId,
    scanId: work.scanId,
    pageId: work.pageId,
    targetUrl,
    viewportWidth: 1365,
    viewportHeight: 768,
    timeoutSeconds: 30,
    maxTotalBytes: 52_428_800,
    maxResourceBytes: 10_485_760,
    maxNetworkRequests: 500,
    maxResourceBodies: 100,
    measurementProfile: 'desktop-lab-v1',
    staticObservation: {
      title: null,
      description: null,
      canonicalUrl: null,
      h1: null,
      links: 0,
      images: 0,
      schemaOrgTypes: [],
      observedAt: null,
    },
  }
}

function verifyBytes(value: Buffer, bytes: number, sha256Hex: string): void {
  if (value.length !== bytes || !/^[0-9a-f]{64}$/u.test(sha256Hex)) {
    throw new Error('SITE_PAGE_BUNDLE_INTEGRITY_FAILED')
  }
  const actual = createHash('sha256').update(value).digest()
  const expected = Buffer.from(sha256Hex, 'hex')
  if (!timingSafeEqual(actual, expected)) throw new Error('SITE_PAGE_BUNDLE_INTEGRITY_FAILED')
}

function sanitizeForDatabase(rawUrl: string): string {
  const url = new URL(rawUrl)
  url.username = ''
  url.password = ''
  url.hash = ''
  url.search = ''
  return url.toString().slice(0, 8192)
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds))
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : 'UnknownError'
}

function boundedErrorCode(error: unknown): string {
  const raw = error instanceof Error ? error.message : 'SITE_CLONE_FAILED'
  // Browser/HTTP errors may embed URLs and credentials. Only symbolic codes are reportable.
  return /^[A-Z][A-Z0-9_]{0,63}$/u.test(raw) ? raw : 'SITE_CLONE_OPERATION_FAILED'
}

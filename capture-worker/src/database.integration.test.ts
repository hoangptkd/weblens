import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { test } from 'node:test'
import { Pool } from 'pg'
import { CaptureDatabase } from './database.js'
import { SiteCloneDatabase } from './site-database.js'
import type {
  CaptureCommandEnvelope,
  CaptureResult,
  SiteCloneRequestedEnvelope,
  StoredObject,
} from './types.js'

const databaseUrl = process.env.CAPTURE_TEST_DATABASE_URL

test('duplicate command, lease fencing và analytical completion giữ đúng invariant', {
  skip: databaseUrl ? false : 'CAPTURE_TEST_DATABASE_URL chưa được cấu hình',
}, async () => {
  const admin = new Pool({ connectionString: databaseUrl! })
  const schemaName = `weblens_test_${randomUUID().replaceAll('-', '')}`
  await admin.query(`create schema "${schemaName}"`)
  const isolatedUrl = new URL(databaseUrl!)
  isolatedUrl.searchParams.set('options', `-csearch_path=${schemaName}`)
  const database = new CaptureDatabase(isolatedUrl.toString())
  const command = commandEnvelope()

  try {
    await database.migrate()
    const migrations = await database.pool.query<{ version: string }>(
      'select version from capture_schema_migrations order by version',
    )
    assert.deepEqual(migrations.rows.map((row) => row.version), [
      '001_create_capture_runtime.sql',
      '002_create_static_reconstruction.sql',
      '003_index_staged_reconstruction_gc.sql',
      '004_create_site_reconstruction.sql',
      '005_bound_site_reconstruction_phases.sql',
    ])
    assert.equal(await database.acceptCommand(command), false)
    assert.equal(await database.acceptCommand(command), true)
    await assert.rejects(
      database.acceptCommand({ ...command, payload: { ...command.payload, targetUrl: 'https://example.org/' } }),
      /MESSAGE_ID_COLLISION/u,
    )

    const firstLease = await database.claimJob(randomUUID())
    assert.ok(firstLease)
    await database.pool.query(
      "update capture_jobs set lease_expires_at=now()-interval '1 second' where id=$1",
      [command.aggregateId],
    )
    const secondLease = await database.claimJob(randomUUID())
    assert.ok(secondLease)
    assert.ok(secondLease.leaseGeneration > firstLease.leaseGeneration)

    const result = captureResult()
    const resource = {
      resourceId: randomUUID(), sequence: 1, url: 'https://example.com/app.js',
      resourceType: 'script', mimeType: 'application/javascript',
      body: Buffer.from('console.log("evidence")', 'utf8'), wasTruncated: false,
    }
    result.resourceBodies = [resource]
    const htmlObject = storedObject('html', result.html)
    const screenshotObject = storedObject('screenshot', result.screenshot)
    const resourceObject = storedObject('resource', resource.body)
    const archiveObject = storedObject('archive', Buffer.from('zip-evidence'))
    const manifestObject = storedObject('manifest', Buffer.from('{"schemaVersion":1}'))
    result.reconstruction.archiveBytes = archiveObject.bytes
    await assert.rejects(
      database.stageResult(firstLease, result, htmlObject, screenshotObject, [], null),
      /STALE_CAPTURE_LEASE/u,
    )
    await assert.rejects(
      database.stageReconstructionArtifacts(firstLease, { archive: archiveObject, manifest: manifestObject }),
      /STALE_CAPTURE_LEASE/u,
    )
    await database.stageReconstructionArtifacts(
      secondLease,
      { archive: archiveObject, manifest: manifestObject },
    )
    const stagedArtifacts = await database.pool.query<{ state: string }>(
      'select state from reconstruction_artifacts order by kind',
    )
    assert.deepEqual(stagedArtifacts.rows.map((row) => row.state), ['STAGED', 'STAGED'])
    await database.stageResult(
      secondLease, result, htmlObject, screenshotObject, [{ resource, object: resourceObject }],
      { archive: archiveObject, manifest: manifestObject },
    )
    const publishedArtifacts = await database.pool.query<{ state: string }>(
      'select state from reconstruction_artifacts order by kind',
    )
    assert.deepEqual(publishedArtifacts.rows.map((row) => row.state), ['PUBLISHED', 'PUBLISHED'])

    const claims = await Promise.all([
      database.claimAnalytics(randomUUID()),
      database.claimAnalytics(randomUUID()),
    ])
    const claimed = claims.filter((value) => value !== null)
    assert.equal(claimed.length, 1)
    await database.completeAnalytics(claimed[0]!)

    const snapshot = await database.getSnapshot(command.payload.ownerId, command.aggregateId)
    assert.equal(snapshot?.['status'], 'COMPLETED')
    assert.equal(snapshot?.['final_url'], 'https://example.com/')
    assert.equal(await database.getScreenshotReference(randomUUID(), command.aggregateId), null)
    assert.equal((await database.getScreenshotReference(command.payload.ownerId, command.aggregateId))?.bytes, 4)
    assert.equal(await database.getResourceReference(randomUUID(), command.aggregateId, resource.resourceId), null)
    assert.equal(await database.getResourceReference(command.payload.ownerId, randomUUID(), resource.resourceId), null)
    const reference = await database.getResourceReference(
      command.payload.ownerId,
      command.aggregateId,
      resource.resourceId,
    )
    assert.equal(reference?.bytes, resource.body.length)
    assert.equal(reference?.key, resourceObject.key)
    const reconstruction = await database.getReconstruction(command.payload.ownerId, command.aggregateId)
    assert.equal(reconstruction?.['reconstruction_status'], 'PUBLISHED')
    assert.equal(reconstruction?.['packaged_count'], 1)
    const reconstructionId = String(reconstruction?.['reconstruction_id'])
    assert.equal(await database.getReconstructionArchiveReference(randomUUID(), reconstructionId), null)
    const archiveReference = await database.getReconstructionArchiveReference(
      command.payload.ownerId,
      reconstructionId,
    )
    assert.equal(archiveReference?.key, archiveObject.key)
    assert.equal(archiveReference?.bytes, archiveObject.bytes)
    assert.equal(archiveReference?.state, 'PUBLISHED')

    await database.pool.query(
      "update reconstruction_artifacts set delete_after=created_at+interval '1 millisecond'",
    )
    const firstExpiredArtifact = await database.claimReconstructionArtifactForDeletion()
    const secondExpiredArtifact = await database.claimReconstructionArtifactForDeletion()
    assert.ok(firstExpiredArtifact)
    assert.ok(secondExpiredArtifact)
    assert.notEqual(firstExpiredArtifact.id, secondExpiredArtifact.id)
    await database.completeReconstructionArtifactDeletion(firstExpiredArtifact)
    await database.completeReconstructionArtifactDeletion(secondExpiredArtifact)
    const expiredReconstruction = await database.getReconstruction(
      command.payload.ownerId,
      command.aggregateId,
    )
    assert.equal(expiredReconstruction?.['reconstruction_status'], 'EXPIRED')
    const expiredReference = await database.getReconstructionArchiveReference(
      command.payload.ownerId,
      reconstructionId,
    )
    assert.equal(expiredReference?.state, 'DELETED')

    const cloneFailureCommand = commandEnvelope()
    await database.acceptCommand(cloneFailureCommand)
    const cloneFailureLease = await database.claimJob(randomUUID())
    assert.ok(cloneFailureLease)
    const cloneFailureResult = captureResult()
    cloneFailureResult.reconstruction = {
      ...cloneFailureResult.reconstruction,
      status: 'FAILED',
      packagedCount: 0,
      inputBytes: 0,
      archiveBytes: null,
      completenessCode: null,
      failureCode: 'CLONE_ARCHIVE_GENERATION_FAILED',
    }
    await database.stageResult(
      cloneFailureLease,
      cloneFailureResult,
      storedObject('failure-html', cloneFailureResult.html),
      storedObject('failure-screenshot', cloneFailureResult.screenshot),
      [],
      null,
    )
    const cloneFailureAnalytics = await database.claimAnalytics(randomUUID())
    assert.ok(cloneFailureAnalytics)
    await database.completeAnalytics(cloneFailureAnalytics)
    const captureWithFailedClone = await database.getSnapshot(
      cloneFailureCommand.payload.ownerId,
      cloneFailureCommand.aggregateId,
    )
    assert.equal(captureWithFailedClone?.['status'], 'COMPLETED')
    assert.equal(captureWithFailedClone?.['reconstruction_status'], 'FAILED')
    assert.equal(captureWithFailedClone?.['failure_code'], 'CLONE_ARCHIVE_GENERATION_FAILED')

    const gcRaceCommand = commandEnvelope()
    await database.acceptCommand(gcRaceCommand)
    const gcRaceLease = await database.claimJob(randomUUID())
    assert.ok(gcRaceLease)
    const gcRaceResult = captureResult()
    const gcRaceArchive = storedObject('gc-race-archive', Buffer.from('gc-race-zip'))
    const gcRaceManifest = storedObject('gc-race-manifest', Buffer.from('{"schemaVersion":1}'))
    gcRaceResult.reconstruction.archiveBytes = gcRaceArchive.bytes
    await database.stageReconstructionArtifacts(
      gcRaceLease,
      { archive: gcRaceArchive, manifest: gcRaceManifest },
    )
    await database.pool.query(
      "update reconstruction_artifacts set delete_after=created_at+interval '1 millisecond' "
        + 'where reconstruction_job_id=(select id from reconstruction_jobs where capture_job_id=$1)',
      [gcRaceCommand.aggregateId],
    )
    const gcClaim = await database.claimReconstructionArtifactForDeletion()
    assert.ok(gcClaim)
    await database.stageResult(
      gcRaceLease,
      gcRaceResult,
      storedObject('gc-race-html', gcRaceResult.html),
      storedObject('gc-race-screenshot', gcRaceResult.screenshot),
      [],
      { archive: gcRaceArchive, manifest: gcRaceManifest },
    )
    const gcRaceReconstruction = await database.getReconstruction(
      gcRaceCommand.payload.ownerId,
      gcRaceCommand.aggregateId,
    )
    assert.equal(gcRaceReconstruction?.['reconstruction_status'], 'FAILED')
    assert.equal(gcRaceReconstruction?.['failure_code'], 'CLONE_ARTIFACT_STAGE_INCOMPLETE')
  } finally {
    await database.close()
    await admin.query(`drop schema "${schemaName}" cascade`)
    await admin.end()
  }
})

test('site clone migration, phase retry, page fencing, cancellation partial và GC giữ invariant', {
  skip: databaseUrl ? false : 'CAPTURE_TEST_DATABASE_URL chưa được cấu hình',
}, async () => {
  const admin = new Pool({ connectionString: databaseUrl! })
  const schemaName = `weblens_site_test_${randomUUID().replaceAll('-', '')}`
  await admin.query(`create schema "${schemaName}"`)
  const isolatedUrl = new URL(databaseUrl!)
  isolatedUrl.searchParams.set('options', `-csearch_path=${schemaName}`)
  const database = new CaptureDatabase(isolatedUrl.toString())
  const sites = new SiteCloneDatabase(database.pool)

  try {
    await database.migrate()
    const command = siteCloneCommand()
    assert.equal(await sites.acceptCommand(command), false)
    assert.equal(await sites.acceptCommand(command), true)

    const ingestion = await sites.claimIngestion(randomUUID())
    assert.ok(ingestion)
    const firstPageId = randomUUID()
    const secondPageId = randomUUID()
    await sites.addTargets(ingestion, [
      target(firstPageId, 0, 'https://example.com/', 'index.html'),
      target(secondPageId, 1, 'https://example.com/about', `pages/${secondPageId}.html`),
    ])
    await sites.finishIngestion(ingestion)

    const stalePage = await sites.claimPage(randomUUID())
    assert.ok(stalePage)
    const progress = await sites.getProgress(command.payload.ownerId, command.aggregateId, -1, 1, 'ALL', '')
    assert.ok(progress)
    assert.equal(progress.phase, 'RUNNING')
    assert.equal(progress.ingestionComplete, true)
    assert.equal(progress.counts.RENDERING, 1)
    assert.equal(progress.counts.QUEUED, 1)
    assert.equal(progress.activePages[0]?.pageId, stalePage.pageId)
    assert.equal(progress.items.length, 1)
    assert.equal(progress.nextAfter, 0)
    await database.pool.query(`update site_reconstruction_pages set public_url=$3
      where site_reconstruction_job_id=$1 and page_id=$2`,
    [command.aggregateId, secondPageId, 'https://user:secret@example.com/about?token=private#secret'])
    const next = await sites.getProgress(command.payload.ownerId, command.aggregateId, progress.nextAfter!, 1, 'ALL', '')
    assert.equal(next?.items[0]?.pageId, secondPageId)
    assert.equal(next?.items[0]?.url, 'https://example.com/about')
    assert.equal(next?.nextAfter, null)
    assert.equal(await sites.getProgress(randomUUID(), command.aggregateId, -1, 50, 'ALL', ''), null)
    await assert.rejects(sites.getProgress(command.payload.ownerId, command.aggregateId, -1, 101, 'ALL', ''), /INVALID_SITE_PROGRESS_FILTER/u)
    await assert.rejects(sites.getProgress(command.payload.ownerId, command.aggregateId, -2, 50, 'ALL', ''), /INVALID_SITE_PROGRESS_FILTER/u)
    await assert.rejects(sites.getProgress(command.payload.ownerId, command.aggregateId, -1, 50, 'INVALID', ''), /INVALID_SITE_PROGRESS_FILTER/u)
    const searched = await sites.getProgress(command.payload.ownerId, command.aggregateId, -1, 50, 'QUEUED', '/about')
    assert.equal(searched?.items.length, 1)
    await database.pool.query(
      "update site_reconstruction_pages set lease_expires_at=now()-interval '1 second' "
        + 'where site_reconstruction_job_id=$1 and page_id=$2',
      [command.aggregateId, stalePage.pageId],
    )
    await database.pool.query(
      "update site_reconstruction_pages set available_at=now()+interval '1 hour' "
        + 'where site_reconstruction_job_id=$1 and page_id<>$2 and status=\'QUEUED\'',
      [command.aggregateId, stalePage.pageId],
    )
    const expiredProgress = await sites.getProgress(command.payload.ownerId, command.aggregateId, -1, 50, 'RENDERING', '')
    assert.equal(expiredProgress?.activePages[0]?.leaseExpired, true)
    const winningPage = await sites.claimPage(randomUUID())
    assert.ok(winningPage)
    assert.equal(winningPage.pageId, stalePage.pageId)
    assert.ok(winningPage.leaseGeneration > stalePage.leaseGeneration)
    const bundleObject = storedObject('site-page-bundle', Buffer.from('{"bundle":true}'))
    await assert.rejects(
      sites.completePage(stalePage, bundleObject, 15),
      /STALE_SITE_PAGE_LEASE/u,
    )
    assert.equal(await sites.completePage(winningPage, bundleObject, 15), true)
    const completed = await sites.getProgress(command.payload.ownerId, command.aggregateId, -1, 50, 'SUCCEEDED', '')
    assert.equal(completed?.items[0]?.pageId, winningPage.pageId)
    assert.equal(completed?.items[0]?.attemptCount, 2)
    assert.ok(completed?.items[0]?.finishedAt)
    assert.equal(completed?.activePages.length, 0)
    await database.pool.query(
      "update site_reconstruction_pages set bundle_delete_after=now()-interval '1 second' "
        + 'where site_reconstruction_job_id=$1 and page_id=$2',
      [command.aggregateId, winningPage.pageId],
    )
    assert.equal(await sites.claimObjectForDeletion(), null)

    const cancelMessageId = randomUUID()
    await sites.acceptCommand({
      messageId: cancelMessageId,
      aggregateType: 'SITE_CLONE',
      aggregateId: command.aggregateId,
      aggregateVersion: 2,
      messageType: 'SITE_CLONE_CANCEL_REQUESTED',
      contractVersion: 1,
      correlationId: command.correlationId,
      occurredAt: new Date().toISOString(),
      payload: {
        siteCloneRequestId: command.aggregateId,
        ownerId: command.payload.ownerId,
        requestedAt: new Date().toISOString(),
      },
    })
    await sites.reconcileCancellations()
    const assembly = await sites.claimAssembly(randomUUID())
    assert.ok(assembly)
    await sites.publishArtifacts(assembly, [
      {
        kind: 'ARCHIVE_SHARD', shardNumber: 1, logicalFilename: 'part-1.zip',
        object: storedObject('site-archive', Buffer.from('zip')),
      },
      {
        kind: 'MANIFEST', shardNumber: 0, logicalFilename: 'manifest.json',
        object: storedObject('site-manifest', Buffer.from('{"schemaVersion":1}')),
      },
    ])
    const publishedRetention = await database.pool.query<{
      state: string; retained: boolean
    }>(`select state,delete_after>now()+interval '6 days' as retained
      from site_reconstruction_artifacts where site_reconstruction_job_id=$1`, [command.aggregateId])
    assert.ok(publishedRetention.rows.every((row) => row.state === 'PUBLISHED' && row.retained))
    const partial = await sites.getReport(command.payload.ownerId, command.aggregateId)
    assert.equal(partial?.['status'], 'PARTIAL')
    assert.equal(partial?.['succeeded_count'], 1)

    const pageBundleDeletion = await sites.claimObjectForDeletion()
    assert.ok(pageBundleDeletion)
    assert.equal(pageBundleDeletion.type, 'PAGE_BUNDLE')
    await sites.completeObjectDeletion(pageBundleDeletion)

    await database.pool.query(
      "update site_reconstruction_artifacts set delete_after=created_at+interval '1 millisecond'",
    )
    for (let index = 0; index < 2; index++) {
      const deletion = await sites.claimObjectForDeletion()
      assert.ok(deletion)
      assert.equal(deletion.type, 'ARTIFACT')
      await sites.completeObjectDeletion(deletion)
    }
    const expired = await sites.getReport(command.payload.ownerId, command.aggregateId)
    assert.equal(expired?.['status'], 'EXPIRED')

    const retryCommand = siteCloneCommand()
    await sites.acceptCommand(retryCommand)
    for (let attempt = 1; attempt <= 3; attempt++) {
      const phase = await sites.claimIngestion(randomUUID())
      assert.ok(phase)
      assert.equal(phase.attemptCount, attempt)
      await sites.retryIngestion(phase, 'CRAWLER_REPORT_UNAVAILABLE')
      await database.pool.query(
        'update site_reconstruction_jobs set phase_available_at=now() where id=$1',
        [retryCommand.aggregateId],
      )
    }
    const failed = await sites.getReport(retryCommand.payload.ownerId, retryCommand.aggregateId)
    assert.equal(failed?.['status'], 'FAILED')
    assert.equal(failed?.['terminal_code'], 'CRAWLER_REPORT_UNAVAILABLE')

    const publishRetryCommand = siteCloneCommand()
    await sites.acceptCommand(publishRetryCommand)
    const publishRetryIngestion = await sites.claimIngestion(randomUUID())
    assert.ok(publishRetryIngestion)
    const publishRetryPageId = randomUUID()
    await sites.addTargets(publishRetryIngestion, [
      target(publishRetryPageId, 0, 'https://example.com/', 'index.html'),
      {
        ...target(randomUUID(), 1, 'https://example.com/en/', 'rejected/en.html'),
        status: 'CANCELLED',
        failureCode: 'ALTERNATE_LOCALE',
      },
    ])
    await sites.finishIngestion(publishRetryIngestion)
    const publishRetryPage = await sites.claimPage(randomUUID())
    assert.ok(publishRetryPage)
    await sites.completePage(
      publishRetryPage,
      storedObject('publish-retry-bundle', Buffer.from('{"bundle":true}')),
      15,
    )
    const firstAssembly = await sites.claimAssembly(randomUUID())
    assert.ok(firstAssembly)
    assert.equal((await sites.listBundles(firstAssembly)).length, 1)
    const stagedArtifacts = [
      {
        kind: 'ARCHIVE_SHARD' as const, shardNumber: 1, logicalFilename: 'part-1.zip',
        object: storedObject('publish-retry-archive', Buffer.from('zip')),
      },
      {
        kind: 'MANIFEST' as const, shardNumber: 0, logicalFilename: 'manifest.json',
        object: storedObject('publish-retry-manifest', Buffer.from('{"schemaVersion":2}')),
      },
    ]
    await sites.stageArtifacts(firstAssembly, stagedArtifacts)
    const stagingRetention = await database.pool.query<{
      state: string; expires_within_day: boolean
    }>(`select state,delete_after<=now()+interval '25 hours' as expires_within_day
      from site_reconstruction_artifacts where site_reconstruction_job_id=$1`, [publishRetryCommand.aggregateId])
    assert.ok(stagingRetention.rows.every((row) => row.state === 'STAGED' && row.expires_within_day))
    await sites.retryAssembly(firstAssembly, 'MINIO_UPLOAD_FAILED')
    const removedStage = await database.pool.query<{ count: string }>(
      'select count(*)::text as count from site_reconstruction_artifacts where site_reconstruction_job_id=$1',
      [publishRetryCommand.aggregateId],
    )
    assert.equal(removedStage.rows[0]?.count, '0')
    await database.pool.query(
      'update site_reconstruction_jobs set phase_available_at=now() where id=$1',
      [publishRetryCommand.aggregateId],
    )
    const secondAssembly = await sites.claimAssembly(randomUUID())
    assert.ok(secondAssembly)
    assert.equal((await sites.listBundles(secondAssembly)).length, 1)
    await sites.publishArtifacts(secondAssembly, stagedArtifacts)
    const published = await sites.getReport(publishRetryCommand.payload.ownerId, publishRetryCommand.aggregateId)
    assert.equal(published?.['status'], 'PUBLISHED')
  } finally {
    await database.close()
    await admin.query(`drop schema "${schemaName}" cascade`)
    await admin.end()
  }
})

function commandEnvelope(): CaptureCommandEnvelope {
  const captureRequestId = randomUUID()
  return {
    messageId: randomUUID(),
    aggregateType: 'CAPTURE',
    aggregateId: captureRequestId,
    aggregateVersion: 0,
    messageType: 'CAPTURE_REQUESTED',
    contractVersion: 1,
    correlationId: randomUUID(),
    occurredAt: new Date().toISOString(),
    payload: {
      captureRequestId,
      ownerId: randomUUID(),
      scanId: randomUUID(),
      pageId: randomUUID(),
      targetUrl: 'https://example.com/',
      viewportWidth: 1365,
      viewportHeight: 768,
      timeoutSeconds: 30,
      maxTotalBytes: 52_428_800,
      maxResourceBytes: 10_485_760,
      maxNetworkRequests: 500,
      maxResourceBodies: 100,
      measurementProfile: 'desktop-lab-v1',
      staticObservation: {
        title: 'Example Domain', description: null, canonicalUrl: null, h1: 'Example Domain',
        links: 1, images: 0, schemaOrgTypes: [], observedAt: new Date().toISOString(),
      },
    },
  }
}

function captureResult(): CaptureResult {
  const unavailable = {
    status: 'UNAVAILABLE' as const,
    value: null,
    unit: 'ms' as const,
    source: 'PLAYWRIGHT_LAB' as const,
    profileVersion: 'desktop-lab-v1',
    unavailableReason: 'NO_ENTRY',
  }
  return {
    finalUrl: 'https://example.com/',
    html: Buffer.from('<html></html>'),
    screenshot: Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
    rendered: {
      title: 'Example Domain', description: '', canonicalUrl: '', metaRobots: '', h1: ['Example Domain'],
      wordCount: 2, linkCount: 1, imageCount: 0,
      openGraph: { title: '', description: '', imageUrl: '' }, schemaOrgTypes: [],
    },
    diff: {
      staticObservedAt: new Date().toISOString(), renderedObservedAt: new Date().toISOString(),
      titleChanged: false, descriptionChanged: false, canonicalChanged: false, h1Changed: false,
      contentChanged: false, linkCountDelta: 0, imageCountDelta: 0, schemaTypesChanged: false,
    },
    performance: { lcp: unavailable, cls: { ...unavailable, unit: 'score' }, ttfb: unavailable },
    network: [],
    resourceBodies: [],
    browserVersion: 'test-browser',
    observedAt: new Date().toISOString(),
    totalTransferBytes: 1,
    reconstruction: {
      status: 'PUBLISHED',
      engineVersion: 'weblens-1/pagesource-0.1.2@f59ed61',
      discoveredCount: 1,
      packagedCount: 1,
      skippedCount: 0,
      inputBytes: 13,
      archiveBytes: null,
      completenessCode: 'COMPLETE',
      failureCode: null,
      archivePath: null,
      temporaryDirectory: null,
      manifest: null,
      siteBundle: null,
    },
  }
}

function storedObject(kind: string, bytes: Buffer): StoredObject {
  return {
    bucket: 'weblens-captures',
    key: `integration/${kind}`,
    bytes: bytes.length,
    sha256: createHash('sha256').update(bytes).digest(),
    contentType: kind.includes('screenshot') ? 'image/jpeg'
      : kind.includes('archive') ? 'application/zip'
        : kind.includes('manifest') ? 'application/json'
          : 'text/html; charset=utf-8',
  }
}

function siteCloneCommand(): SiteCloneRequestedEnvelope {
  const siteCloneRequestId = randomUUID()
  return {
    messageId: randomUUID(),
    aggregateType: 'SITE_CLONE',
    aggregateId: siteCloneRequestId,
    aggregateVersion: 1,
    messageType: 'SITE_CLONE_REQUESTED',
    contractVersion: 1,
    correlationId: randomUUID(),
    occurredAt: new Date().toISOString(),
    payload: {
      siteCloneRequestId,
      ownerId: randomUUID(),
      scanId: randomUUID(),
      rootUrl: 'https://example.com/',
      maxPages: 100_000,
      maxInputBytes: 214_748_364_800,
      maxArchiveBytes: 53_687_091_200,
      maxShardBytes: 268_435_456,
      pageConcurrency: 4,
      maxRetriesPerPage: 3,
      maxDurationSeconds: 604_800,
      archiveRetentionDays: 7,
      metadataRetentionDays: 30,
      sameOriginOnly: true,
    },
  }
}

function target(pageId: string, ordinal: number, publicUrl: string, localPath: string) {
  return {
    pageId,
    ordinal,
    publicUrl,
    urlSha256: createHash('sha256').update(publicUrl).digest(),
    localPath,
  }
}

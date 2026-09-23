import { createHash, randomUUID, timingSafeEqual } from 'node:crypto'
import type { Pool, PoolClient } from 'pg'
import type {
  SiteCloneCommandEnvelope,
  SiteCloneRequestedEnvelope,
  StoredObject,
} from './types.js'

export interface SiteProgressPage {
  pageId: string
  ordinal: number
  url: string
  status: string
  attemptCount: number
  failureCode: string | null
  startedAt: Date | null
  finishedAt: Date | null
  updatedAt: Date
  retryAt: Date
  leaseExpired: boolean
}

export interface SiteProgress {
  available: boolean
  jobId: string
  scanId: string
  correlationId: string
  phase: string
  ingestionComplete: boolean
  observedAt: Date
  updatedAt: Date
  startedAt: Date | null
  finishedAt: Date | null
  phaseAttemptCount: number
  phaseRetryAt: Date
  phaseLeaseExpired: boolean
  terminalCode: string | null
  counts: Record<'QUEUED' | 'RENDERING' | 'SUCCEEDED' | 'FAILED' | 'CANCELLED', number>
  activePages: SiteProgressPage[]
  items: SiteProgressPage[]
  nextAfter: number | null
}

function progressPage(page: SiteProgressPage): SiteProgressPage {
  // Reporting does not need credentials, query values or fragments from target URLs.
  try {
    const url = new URL(page.url)
    url.username = ''; url.password = ''; url.search = ''; url.hash = ''
    return { ...page, url: url.toString() }
  } catch {
    return { ...page, url: '[invalid URL]' }
  }
}

export interface SiteTargetInput {
  pageId: string
  ordinal: number
  publicUrl: string
  urlSha256: Buffer
  localPath: string
  status?: 'QUEUED' | 'CANCELLED'
  failureCode?: string | null
}

export interface ClaimedSitePhase {
  id: string
  ownerId: string
  scanId: string
  correlationId: string
  rootUrl: string
  payload: SiteCloneRequestedEnvelope['payload']
  leaseOwner: string
  leaseGeneration: number
  attemptCount: number
}

export interface ClaimedSitePage {
  jobId: string
  ownerId: string
  scanId: string
  correlationId: string
  rootUrl: string
  pageId: string
  publicUrl: string
  localPath: string
  leaseOwner: string
  leaseGeneration: number
  attemptCount: number
  maxRetries: number
}

export interface SitePageBundleReference {
  pageId: string
  ordinal: number
  publicUrl: string
  localPath: string
  bucket: string
  key: string
  bytes: number
  sha256Hex: string
}

export interface SiteRoute {
  urlSha256Hex: string
  localPath: string
}

export interface SitePageOutcome {
  pageId: string
  publicUrl: string
  localPath: string
  status: string
  failureCode: string | null
}

export interface SiteArtifactInput {
  kind: 'ARCHIVE_SHARD' | 'MANIFEST'
  shardNumber: number
  logicalFilename: string
  object: StoredObject
}

export interface SiteArtifactReference {
  id: string
  createdAt: Date
  kind: 'ARCHIVE_SHARD' | 'MANIFEST'
  shardNumber: number
  logicalFilename: string
  bucket: string
  key: string
  contentType: string
  bytes: number
  sha256Hex: string
  expiresAt: Date
  state: 'PUBLISHED' | 'DELETE_PENDING' | 'DELETED'
}

export interface ClaimedSiteEvent {
  messageId: string
  payload: Record<string, unknown>
  leaseOwner: string
}

export interface ClaimedSiteObjectDeletion {
  type: 'ARTIFACT' | 'PAGE_BUNDLE'
  jobId: string
  objectId: string
  object: StoredObject
}

export class SiteCloneDatabase {
  constructor(private readonly pool: Pool) {}

  async acceptCommand(envelope: SiteCloneCommandEnvelope): Promise<boolean> {
    return envelope.messageType === 'SITE_CLONE_REQUESTED'
      ? this.acceptRequested(envelope)
      : this.acceptCancellation(envelope)
  }

  async claimIngestion(workerId: string): Promise<ClaimedSitePhase | null> {
    const result = await this.pool.query<SitePhaseRow>(`with candidate as (
        select id from site_reconstruction_jobs
        where status='INGESTING'
          and phase_available_at<=now()
          and (phase_lease_owner is null or phase_lease_expires_at<=now())
        order by created_at,id for update skip locked limit 1
      ) update site_reconstruction_jobs job
      set phase_lease_owner=$1,phase_lease_generation=phase_lease_generation+1,
          phase_lease_expires_at=now()+interval '60 seconds',updated_at=now()
      from candidate where job.id=candidate.id
      returning job.id,job.owner_id,job.scan_id,job.correlation_id,job.root_url,
        job.command_payload_sha256,job.phase_lease_owner,job.phase_lease_generation,
        job.phase_attempt_count+1 as phase_attempt_count,
        job.max_pages,job.max_input_bytes,job.max_archive_bytes,job.max_shard_bytes,
        job.page_concurrency,job.max_retries_per_page,job.archive_retention_days,
        job.metadata_retention_days,job.same_origin_only,job.max_duration_seconds`, [workerId])
    return result.rows[0] ? phaseFromRow(result.rows[0]) : null
  }

  async extendPhaseLease(job: ClaimedSitePhase): Promise<boolean> {
    const result = await this.pool.query(`update site_reconstruction_jobs
      set phase_lease_expires_at=now()+case when status='ASSEMBLING'
            then interval '5 minutes' else interval '60 seconds' end,
          updated_at=now()
      where id=$1 and phase_lease_owner=$2 and phase_lease_generation=$3
        and status in ('INGESTING','ASSEMBLING')`, [job.id, job.leaseOwner, job.leaseGeneration])
    return result.rowCount === 1
  }

  async addTargets(job: ClaimedSitePhase, targets: SiteTargetInput[]): Promise<number> {
    if (targets.length === 0) return 0
    const client = await this.pool.connect()
    try {
      await client.query('begin')
      const lease = await client.query(`select id from site_reconstruction_jobs
        where id=$1 and status='INGESTING' and phase_lease_owner=$2
          and phase_lease_generation=$3 and phase_lease_expires_at>now() for update`,
      [job.id, job.leaseOwner, job.leaseGeneration])
      if (!lease.rowCount) throw new Error('STALE_SITE_INGESTION_LEASE')
      const parameters: unknown[] = [job.id]
      const values = targets.map((target, index) => {
        const offset = 2 + (index * 7)
        parameters.push(
          target.pageId, target.ordinal, target.publicUrl, target.urlSha256, target.localPath,
          target.status ?? 'QUEUED', target.failureCode ?? null,
        )
        return `($1,$${offset},$${offset + 1},$${offset + 2},$${offset + 3},$${offset + 4},`
          + `$${offset + 5},now(),$${offset + 6},now(),`
          + `case when $${offset + 5}='CANCELLED' then now() else null end,now())`
      })
      const insertedResult = await client.query(`insert into site_reconstruction_pages (
          site_reconstruction_job_id,page_id,ordinal,public_url,url_sha256,local_path,
          status,available_at,failure_code,created_at,finished_at,updated_at
        ) values ${values.join(',')} on conflict do nothing`, parameters)
      const inserted = insertedResult.rowCount ?? 0
      const count = await client.query<{ count: string }>(
        'select count(*)::text as count from site_reconstruction_pages where site_reconstruction_job_id=$1',
        [job.id],
      )
      if (Number(count.rows[0]?.count ?? 0) > job.payload.maxPages) throw new Error('SITE_PAGE_LIMIT_EXCEEDED')
      await client.query('commit')
      return inserted
    } catch (error) {
      await client.query('rollback')
      throw error
    } finally {
      client.release()
    }
  }

  async finishIngestion(job: ClaimedSitePhase): Promise<void> {
    const client = await this.pool.connect()
    try {
      await client.query('begin')
      const count = await client.query<{ count: string }>(`select count(*)::text as count
        from site_reconstruction_pages where site_reconstruction_job_id=$1`, [job.id])
      const discovered = Number(count.rows[0]?.count ?? 0)
      if (discovered === 0) {
        const failed = await client.query(`update site_reconstruction_jobs
          set status='FAILED',phase_lease_owner=null,phase_lease_expires_at=null,
              terminal_code='NO_CLONEABLE_PAGES',terminal_message='The scan produced no cloneable pages.',
              finished_at=now(),updated_at=now()
          where id=$1 and status='INGESTING' and phase_lease_owner=$2 and phase_lease_generation=$3`,
        [job.id, job.leaseOwner, job.leaseGeneration])
        if (!failed.rowCount) throw new Error('STALE_SITE_INGESTION_LEASE')
        await this.enqueueEvent(client, job.id, 'FAILED')
      } else {
        const updated = await client.query(`update site_reconstruction_jobs
          set status='RUNNING',phase_lease_owner=null,phase_lease_expires_at=null,
              phase_attempt_count=0,phase_available_at=now(),
              discovered_count=$4,ingestion_finished_at=now(),started_at=coalesce(started_at,now()),updated_at=now()
          where id=$1 and status='INGESTING' and phase_lease_owner=$2 and phase_lease_generation=$3`,
        [job.id, job.leaseOwner, job.leaseGeneration, discovered])
        if (!updated.rowCount) throw new Error('STALE_SITE_INGESTION_LEASE')
        await this.enqueueEvent(client, job.id, 'RUNNING')
      }
      await client.query('commit')
    } catch (error) {
      await client.query('rollback')
      throw error
    } finally {
      client.release()
    }
  }

  async claimPage(workerId: string): Promise<ClaimedSitePage | null> {
    const client = await this.pool.connect()
    try {
      await client.query('begin')
      const reclaimed = await client.query<{ site_reconstruction_job_id: string }>(`with expired as (
          select page.site_reconstruction_job_id,page.page_id,
            page.attempt_count < job.max_retries_per_page as retryable
          from site_reconstruction_pages page
          join site_reconstruction_jobs job on job.id=page.site_reconstruction_job_id
          where page.status='RENDERING' and page.lease_expires_at<=now()
          order by page.lease_expires_at,page.page_id
          for update of page skip locked limit 100
        ) update site_reconstruction_pages page set
          status=case when expired.retryable then 'QUEUED' else 'FAILED' end,
          available_at=case when expired.retryable then now() else page.available_at end,
          lease_owner=null,lease_expires_at=null,
          failure_code='PAGE_LEASE_EXPIRED',
          finished_at=case when expired.retryable then null else now() end,
          updated_at=now()
        from expired
        where page.site_reconstruction_job_id=expired.site_reconstruction_job_id
          and page.page_id=expired.page_id
        returning page.site_reconstruction_job_id`)
      for (const jobId of new Set(reclaimed.rows.map((row) => row.site_reconstruction_job_id))) {
        await this.refreshJobCounters(client, jobId)
      }
      const result = await client.query<{
        site_reconstruction_job_id: string; owner_id: string; scan_id: string; correlation_id: string; root_url: string
        page_id: string; public_url: string; local_path: string; lease_owner: string; lease_generation: string
        attempt_count: number; max_retries_per_page: number
      }>(`with candidate as (
          select page.site_reconstruction_job_id,page.page_id
          from site_reconstruction_pages page
          join site_reconstruction_jobs job on job.id=page.site_reconstruction_job_id
          where job.status='RUNNING' and page.status='QUEUED' and page.available_at<=now()
            and (select count(*) from site_reconstruction_pages active
              where active.site_reconstruction_job_id=job.id and active.status='RENDERING')
              < job.page_concurrency
          order by page.available_at,page.ordinal,page.page_id
          for update of page skip locked limit 1
        ) update site_reconstruction_pages page
        set status='RENDERING',lease_owner=$1,lease_generation=lease_generation+1,
            lease_expires_at=now()+interval '60 seconds',attempt_count=attempt_count+1,
            started_at=coalesce(page.started_at,now()),finished_at=null,failure_code=null,updated_at=now()
        from candidate,site_reconstruction_jobs job
        where page.site_reconstruction_job_id=candidate.site_reconstruction_job_id
          and page.page_id=candidate.page_id and job.id=page.site_reconstruction_job_id
        returning page.site_reconstruction_job_id,job.owner_id,job.scan_id,job.correlation_id,job.root_url,
          page.page_id,page.public_url,page.local_path,page.lease_owner,page.lease_generation,
          page.attempt_count,job.max_retries_per_page`, [workerId])
      await client.query('commit')
      const row = result.rows[0]
      return row ? {
        jobId: row.site_reconstruction_job_id, ownerId: row.owner_id, scanId: row.scan_id,
        correlationId: row.correlation_id, rootUrl: row.root_url,
        pageId: row.page_id, publicUrl: row.public_url, localPath: row.local_path,
        leaseOwner: row.lease_owner, leaseGeneration: Number(row.lease_generation),
        attemptCount: row.attempt_count, maxRetries: row.max_retries_per_page,
      } : null
    } catch (error) {
      await client.query('rollback')
      throw error
    } finally {
      client.release()
    }
  }

  async extendPageLease(page: ClaimedSitePage): Promise<boolean> {
    const result = await this.pool.query(`update site_reconstruction_pages
      set lease_expires_at=now()+interval '60 seconds',updated_at=now()
      where site_reconstruction_job_id=$1 and page_id=$2 and status='RENDERING'
        and lease_owner=$3 and lease_generation=$4`,
    [page.jobId, page.pageId, page.leaseOwner, page.leaseGeneration])
    return result.rowCount === 1
  }

  async completePage(
    page: ClaimedSitePage,
    bundle: StoredObject,
    inputBytes: number,
  ): Promise<boolean> {
    const client = await this.pool.connect()
    try {
      await client.query('begin')
      const locked = await client.query(`select page_id from site_reconstruction_pages
        where site_reconstruction_job_id=$1 and page_id=$2 and status='RENDERING'
          and lease_owner=$3 and lease_generation=$4 for update`,
      [page.jobId, page.pageId, page.leaseOwner, page.leaseGeneration])
      if (!locked.rowCount) throw new Error('STALE_SITE_PAGE_LEASE')
      const job = await client.query<{ status: string; input_bytes: string; max_input_bytes: string }>(
        'select status,input_bytes,max_input_bytes from site_reconstruction_jobs where id=$1 for update', [page.jobId],
      )
      const state = job.rows[0]
      if (!state) throw new Error('SITE_JOB_NOT_FOUND')
      if (state.status === 'CANCEL_REQUESTED') {
        await this.finishPageWithoutBundle(client, page, 'CANCELLED', 'CANCELLED')
        await client.query('commit')
        return false
      }
      if (Number(state.input_bytes) + inputBytes > Number(state.max_input_bytes)) {
        await this.finishPageWithoutBundle(client, page, 'FAILED', 'SITE_INPUT_BUDGET_EXCEEDED')
        await this.incrementJob(client, page.jobId, false, 0)
        await client.query('commit')
        return false
      }
      await client.query(`update site_reconstruction_pages set status='SUCCEEDED',
          lease_owner=null,lease_expires_at=null,bundle_bucket=$5,bundle_storage_key=$6,
          bundle_bytes=$7,bundle_sha256=$8,input_bytes=$9,failure_code=null,
          bundle_state='AVAILABLE',bundle_delete_after=now(),
          finished_at=now(),updated_at=now()
        where site_reconstruction_job_id=$1 and page_id=$2 and status='RENDERING'
          and lease_owner=$3 and lease_generation=$4`, [
        page.jobId, page.pageId, page.leaseOwner, page.leaseGeneration,
        bundle.bucket, bundle.key, bundle.bytes, bundle.sha256, inputBytes,
      ])
      await this.incrementJob(client, page.jobId, true, inputBytes)
      await client.query('commit')
      return true
    } catch (error) {
      await client.query('rollback')
      throw error
    } finally {
      client.release()
    }
  }

  async failPage(page: ClaimedSitePage, code: string): Promise<void> {
    const client = await this.pool.connect()
    try {
      await client.query('begin')
      const status = page.attemptCount < page.maxRetries ? 'QUEUED' : 'FAILED'
      const updated = await client.query(`update site_reconstruction_pages set status=$5,
          available_at=case when $5='QUEUED' then now()+($6::text||' seconds')::interval else available_at end,
          lease_owner=null,lease_expires_at=null,failure_code=$7,
          finished_at=case when $5='FAILED' then now() else null end,updated_at=now()
        where site_reconstruction_job_id=$1 and page_id=$2 and status='RENDERING'
          and lease_owner=$3 and lease_generation=$4`, [
        page.jobId, page.pageId, page.leaseOwner, page.leaseGeneration, status,
        Math.min(30, 2 ** page.attemptCount), boundedCode(code),
      ])
      if (updated.rowCount && status === 'FAILED') await this.incrementJob(client, page.jobId, false, 0)
      await client.query('commit')
    } catch (error) {
      await client.query('rollback')
      throw error
    } finally {
      client.release()
    }
  }

  async claimAssembly(workerId: string): Promise<ClaimedSitePhase | null> {
    const client = await this.pool.connect()
    try {
      await client.query('begin')
      await this.finalizeEmptyJobs(client)
      const result = await client.query<SitePhaseRow>(`with candidate as (
          select job.id from site_reconstruction_jobs job
          where job.status in ('RUNNING','ASSEMBLING') and job.ingestion_finished_at is not null
            and job.phase_available_at<=now()
            and job.succeeded_count>0
            and not exists (select 1 from site_reconstruction_pages page
              where page.site_reconstruction_job_id=job.id and page.status in ('QUEUED','RENDERING'))
            and (job.phase_lease_owner is null or job.phase_lease_expires_at<=now())
          order by job.updated_at,job.id for update skip locked limit 1
        ) update site_reconstruction_jobs job set status='ASSEMBLING',
          phase_lease_owner=$1,phase_lease_generation=phase_lease_generation+1,
          phase_lease_expires_at=now()+interval '5 minutes',updated_at=now()
        from candidate where job.id=candidate.id
        returning job.id,job.owner_id,job.scan_id,job.correlation_id,job.root_url,
          job.command_payload_sha256,job.phase_lease_owner,job.phase_lease_generation,
          job.phase_attempt_count+1 as phase_attempt_count,
          job.max_pages,job.max_input_bytes,job.max_archive_bytes,job.max_shard_bytes,
          job.page_concurrency,job.max_retries_per_page,job.archive_retention_days,
          job.metadata_retention_days,job.same_origin_only,job.max_duration_seconds`, [workerId])
      const row = result.rows[0]
      if (row) await this.enqueueEvent(client, row.id, 'ASSEMBLING')
      await client.query('commit')
      return row ? phaseFromRow(row) : null
    } catch (error) {
      await client.query('rollback')
      throw error
    } finally {
      client.release()
    }
  }

  async listBundles(job: ClaimedSitePhase): Promise<SitePageBundleReference[]> {
    const result = await this.pool.query<{
      page_id: string; ordinal: number; public_url: string; local_path: string
      bundle_bucket: string; bundle_storage_key: string; bundle_bytes: string; sha256_hex: string
    }>(`select page_id,ordinal,public_url,local_path,bundle_bucket,bundle_storage_key,
        bundle_bytes,encode(bundle_sha256,'hex') as sha256_hex
      from site_reconstruction_pages
      where site_reconstruction_job_id=$1 and status='SUCCEEDED'
      order by ordinal,page_id`, [job.id])
    return result.rows.map((row) => ({
      pageId: row.page_id, ordinal: row.ordinal, publicUrl: row.public_url,
      localPath: row.local_path, bucket: row.bundle_bucket, key: row.bundle_storage_key,
      bytes: Number(row.bundle_bytes), sha256Hex: row.sha256_hex,
    }))
  }

  async listRoutes(jobId: string): Promise<SiteRoute[]> {
    const result = await this.pool.query<{ url_sha256_hex: string; local_path: string }>(
      `select encode(url_sha256,'hex') as url_sha256_hex,local_path
       from site_reconstruction_pages
       where site_reconstruction_job_id=$1 and status='SUCCEEDED'`,
      [jobId],
    )
    return result.rows.map((row) => ({ urlSha256Hex: row.url_sha256_hex, localPath: row.local_path }))
  }

  async listPageOutcomes(jobId: string): Promise<SitePageOutcome[]> {
    const result = await this.pool.query<{
      page_id: string; public_url: string; local_path: string; status: string; failure_code: string | null
    }>(`select page_id,public_url,local_path,status,failure_code
      from site_reconstruction_pages where site_reconstruction_job_id=$1
      order by ordinal,page_id`, [jobId])
    return result.rows.map((row) => ({
      pageId: row.page_id, publicUrl: row.public_url, localPath: row.local_path,
      status: row.status, failureCode: row.failure_code,
    }))
  }

  async publishArtifacts(job: ClaimedSitePhase, artifacts: SiteArtifactInput[]): Promise<void> {
    if (artifacts.length === 0) throw new Error('SITE_ARTIFACTS_EMPTY')
    await this.stageArtifacts(job, artifacts)
    const client = await this.pool.connect()
    try {
      await client.query('begin')
      const locked = await client.query<{
        discovered_count: number; succeeded_count: number; failed_count: number; cancelled_count: number
      }>(`select job.discovered_count,job.succeeded_count,job.failed_count,
          (select count(*)::integer from site_reconstruction_pages page
            where page.site_reconstruction_job_id=job.id and page.status='CANCELLED'
              and page.failure_code='CANCELLED') as cancelled_count
        from site_reconstruction_jobs job where job.id=$1 and job.status='ASSEMBLING'
          and phase_lease_owner=$2 and phase_lease_generation=$3
          and phase_lease_expires_at>now() for update`, [job.id, job.leaseOwner, job.leaseGeneration])
      if (!locked.rowCount) throw new Error('STALE_SITE_ASSEMBLY_LEASE')
      const total = artifacts.reduce((sum, artifact) => sum + artifact.object.bytes, 0)
      if (total > job.payload.maxArchiveBytes) throw new Error('SITE_ARCHIVE_BUDGET_EXCEEDED')
      await client.query(`update site_reconstruction_artifacts set state='PUBLISHED',published_at=now(),
          delete_after=now()+($3::text||' days')::interval
        where site_reconstruction_job_id=$1 and generation=$2 and state='STAGED'`,
      [job.id, job.leaseGeneration, job.payload.archiveRetentionDays])
      const counts = locked.rows[0]!
      const terminal = counts.failed_count > 0 || counts.cancelled_count > 0
        ? 'PARTIAL' : 'PUBLISHED'
      await client.query(`update site_reconstruction_jobs set status=$4,
          phase_lease_owner=null,phase_lease_expires_at=null,archive_bytes=$5,
          artifact_count=$6,finished_at=now(),updated_at=now()
        where id=$1 and phase_lease_owner=$2 and phase_lease_generation=$3`, [
        job.id, job.leaseOwner, job.leaseGeneration, terminal, total, artifacts.length,
      ])
      await this.enqueueEvent(client, job.id, terminal)
      await client.query('commit')
    } catch (error) {
      await client.query('rollback')
      throw error
    } finally {
      client.release()
    }
  }

  async stageArtifacts(job: ClaimedSitePhase, artifacts: SiteArtifactInput[]): Promise<void> {
    if (artifacts.length === 0) throw new Error('SITE_ARTIFACTS_EMPTY')
    const client = await this.pool.connect()
    try {
      await client.query('begin')
      const lease = await client.query(`select id from site_reconstruction_jobs
        where id=$1 and status='ASSEMBLING' and phase_lease_owner=$2
          and phase_lease_generation=$3 and phase_lease_expires_at>now() for update`,
      [job.id, job.leaseOwner, job.leaseGeneration])
      if (!lease.rowCount) throw new Error('STALE_SITE_ASSEMBLY_LEASE')
      const total = artifacts.reduce((sum, artifact) => sum + artifact.object.bytes, 0)
      if (total > job.payload.maxArchiveBytes) throw new Error('SITE_ARCHIVE_BUDGET_EXCEEDED')
      for (const artifact of artifacts) {
        await client.query(`insert into site_reconstruction_artifacts (
            id,owner_id,site_reconstruction_job_id,kind,generation,shard_number,
            logical_filename,storage_bucket,storage_key,content_type,byte_size,sha256,
            state,created_at,published_at,delete_after
          ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'STAGED',now(),null,
            now()+interval '1 day')
          on conflict (site_reconstruction_job_id,generation,kind,shard_number) do nothing`, [
          randomUUID(), job.ownerId, job.id, artifact.kind, job.leaseGeneration,
          artifact.shardNumber, artifact.logicalFilename, artifact.object.bucket,
          artifact.object.key, artifact.object.contentType, artifact.object.bytes,
          artifact.object.sha256,
        ])
      }
      const staged = await client.query<{
        kind: string; shard_number: number; logical_filename: string; storage_bucket: string
        storage_key: string; content_type: string; byte_size: string; sha256: Buffer; state: string
      }>(`select kind,shard_number,logical_filename,storage_bucket,storage_key,
          content_type,byte_size,sha256,state
        from site_reconstruction_artifacts
        where site_reconstruction_job_id=$1 and generation=$2
        order by kind,shard_number`, [job.id, job.leaseGeneration])
      if (staged.rows.length !== artifacts.length) throw new Error('SITE_ARTIFACT_STAGE_MISMATCH')
      for (const artifact of artifacts) {
        const row = staged.rows.find((candidate) => (
          candidate.kind === artifact.kind && candidate.shard_number === artifact.shardNumber
        ))
        if (!row || row.state !== 'STAGED' || row.logical_filename !== artifact.logicalFilename
            || row.storage_bucket !== artifact.object.bucket || row.storage_key !== artifact.object.key
            || row.content_type !== artifact.object.contentType
            || Number(row.byte_size) !== artifact.object.bytes
            || row.sha256.length !== artifact.object.sha256.length
            || !timingSafeEqual(row.sha256, artifact.object.sha256)) {
          throw new Error('SITE_ARTIFACT_STAGE_MISMATCH')
        }
      }
      await client.query('commit')
    } catch (error) {
      await client.query('rollback')
      throw error
    } finally {
      client.release()
    }
  }

  async retryAssembly(job: ClaimedSitePhase, code: string): Promise<void> {
    await this.retryPhase(job, 'ASSEMBLING', code)
  }

  async retryIngestion(job: ClaimedSitePhase, code: string): Promise<void> {
    await this.retryPhase(job, 'INGESTING', code)
  }

  private async retryPhase(
    job: ClaimedSitePhase,
    phase: 'INGESTING' | 'ASSEMBLING',
    code: string,
  ): Promise<void> {
    const client = await this.pool.connect()
    try {
      await client.query('begin')
      const exhausted = job.attemptCount >= 3
      const updated = await client.query(`update site_reconstruction_jobs
        set status=case when $5 then 'FAILED' else $4 end,
            phase_lease_owner=null,phase_lease_expires_at=null,
            phase_attempt_count=case when $5 then phase_attempt_count
              else phase_attempt_count+1 end,
            phase_available_at=case when $5 then phase_available_at
              else now()+($6::text||' seconds')::interval end,
            terminal_code=$7,
            terminal_message=case when $5 then 'Site clone phase exhausted its retry budget.'
              else terminal_message end,
            finished_at=case when $5 then now() else null end,updated_at=now()
        where id=$1 and status=$4 and phase_lease_owner=$2 and phase_lease_generation=$3`,
      [job.id, job.leaseOwner, job.leaseGeneration, phase, exhausted,
        Math.min(30, 2 ** job.attemptCount), boundedCode(code)])
      if (updated.rowCount) {
        await client.query(`delete from site_reconstruction_artifacts
          where site_reconstruction_job_id=$1 and generation=$2 and state='STAGED'`,
        [job.id, job.leaseGeneration])
        if (exhausted) await this.enqueueEvent(client, job.id, 'FAILED')
      }
      await client.query('commit')
    } catch (error) {
      await client.query('rollback')
      throw error
    } finally {
      client.release()
    }
  }

  async reconcileCancellations(): Promise<Array<{ id: string; ownerId: string }>> {
    const client = await this.pool.connect()
    const reconciled: Array<{ id: string; ownerId: string }> = []
    try {
      await client.query('begin')
      await client.query(`update site_reconstruction_jobs
        set status='CANCEL_REQUESTED',phase_lease_owner=null,phase_lease_expires_at=null,
            cancellation_requested_at=coalesce(cancellation_requested_at,now()),
            terminal_code='SITE_CLONE_DEADLINE_EXCEEDED',
            terminal_message='Site clone exceeded its maximum execution time.',updated_at=now()
        where status in ('INGESTING','RUNNING','ASSEMBLING')
          and created_at+(max_duration_seconds::text||' seconds')::interval<=now()`)
      await client.query(`update site_reconstruction_pages page set status='CANCELLED',
          finished_at=now(),updated_at=now(),failure_code='CANCELLED'
        from site_reconstruction_jobs job
        where page.site_reconstruction_job_id=job.id and job.status='CANCEL_REQUESTED'
          and page.status='QUEUED'`)
      const jobs = await client.query<{ id: string; owner_id: string }>(`select job.id,job.owner_id
        from site_reconstruction_jobs job
        where job.status='CANCEL_REQUESTED'
          and not exists (select 1 from site_reconstruction_pages page
            where page.site_reconstruction_job_id=job.id and page.status='RENDERING')
        for update skip locked`)
      for (const row of jobs.rows) {
        await this.refreshJobCounters(client, row.id)
        const updated = await client.query<{ status: string }>(`update site_reconstruction_jobs
          set status=case when succeeded_count>0 then 'RUNNING'
                when terminal_code='SITE_CLONE_DEADLINE_EXCEEDED' then 'FAILED'
                else 'CANCELLED' end,
              phase_lease_owner=null,phase_lease_expires_at=null,phase_attempt_count=0,
              phase_available_at=now(),
              finished_at=case when succeeded_count>0 then null else now() end,updated_at=now(),
              terminal_code=case
                when terminal_code='SITE_CLONE_DEADLINE_EXCEEDED' then terminal_code
                when succeeded_count>0 then 'CANCELLED_PARTIAL' else 'CANCELLED' end,
              terminal_message=case when terminal_code='SITE_CLONE_DEADLINE_EXCEEDED'
                then terminal_message else 'Site clone cancelled by the owner.' end
          where id=$1 returning status`, [row.id])
        const status = updated.rows[0]?.status
        if (status === 'CANCELLED' || status === 'FAILED') await this.enqueueEvent(client, row.id, status)
        if (status) reconciled.push({ id: row.id, ownerId: row.owner_id })
      }
      await client.query('commit')
      return reconciled
    } catch (error) {
      await client.query('rollback')
      throw error
    } finally {
      client.release()
    }
  }

  async claimEvent(workerId: string): Promise<ClaimedSiteEvent | null> {
    const result = await this.pool.query<{
      message_id: string; payload: Record<string, unknown>; lease_owner: string
    }>(`with candidate as (
        select message_id from site_reconstruction_event_outbox
        where (status='PENDING' and available_at<=now())
          or (status='CLAIMED' and lease_expires_at<=now())
        order by available_at,created_at,message_id for update skip locked limit 1
      ) update site_reconstruction_event_outbox outbox set status='CLAIMED',lease_owner=$1,
        lease_expires_at=now()+interval '30 seconds',delivery_attempts=delivery_attempts+1
      from candidate where outbox.message_id=candidate.message_id
      returning outbox.message_id,outbox.payload,outbox.lease_owner`, [workerId])
    const row = result.rows[0]
    return row ? { messageId: row.message_id, payload: row.payload, leaseOwner: row.lease_owner } : null
  }

  async completeEvent(event: ClaimedSiteEvent): Promise<void> {
    await this.pool.query(`update site_reconstruction_event_outbox set status='DELIVERED',
      lease_owner=null,lease_expires_at=null,delivered_at=now(),last_error_code=null
      where message_id=$1 and status='CLAIMED' and lease_owner=$2`, [event.messageId, event.leaseOwner])
  }

  async retryEvent(event: ClaimedSiteEvent, code: string): Promise<void> {
    await this.pool.query(`update site_reconstruction_event_outbox set
      status=case when delivery_attempts>=20 then 'DEAD' else 'PENDING' end,
      available_at=now()+interval '2 seconds',lease_owner=null,lease_expires_at=null,last_error_code=$3
      where message_id=$1 and status='CLAIMED' and lease_owner=$2`,
    [event.messageId, event.leaseOwner, boundedCode(code)])
  }

  async getReport(ownerId: string, jobId: string): Promise<Record<string, unknown> | null> {
    const job = await this.pool.query(`select id,scan_id,root_url,status,discovered_count,
        processed_count,succeeded_count,failed_count,input_bytes,archive_bytes,artifact_count,
        terminal_code,terminal_message,created_at,started_at,finished_at
      from site_reconstruction_jobs where id=$1 and owner_id=$2`, [jobId, ownerId])
    if (!job.rows[0]) return null
    const artifacts = await this.pool.query(`select id,kind,shard_number,logical_filename,
        byte_size,encode(sha256,'hex') as sha256_hex,delete_after
      from site_reconstruction_artifacts
      where site_reconstruction_job_id=$1 and owner_id=$2 and state='PUBLISHED' and delete_after>now()
      order by kind,shard_number,id`, [jobId, ownerId])
    return { ...job.rows[0], artifacts: artifacts.rows }
  }

  async getProgress(ownerId: string, jobId: string, after: number, limit: number, status: string, q: string): Promise<SiteProgress | null> {
    if (!Number.isInteger(after) || after < -1 || after > 100_000
        || !Number.isInteger(limit) || limit < 1 || limit > 100 || q.length > 200
        || !['ALL', 'QUEUED', 'RENDERING', 'SUCCEEDED', 'FAILED', 'CANCELLED'].includes(status)) {
      throw new Error('INVALID_SITE_PROGRESS_FILTER')
    }
    const client = await this.pool.connect()
    try {
      // A short, read-only snapshot keeps counters and page rows consistent during completion/retry.
      await client.query('begin isolation level repeatable read read only')
      await client.query("set local statement_timeout='3s'")
      const job = await client.query(`select id,scan_id,correlation_id,status,ingestion_finished_at,
          started_at,finished_at,updated_at,phase_lease_expires_at,phase_attempt_count,
          phase_available_at,terminal_code,now() as observed_at
        from site_reconstruction_jobs where id=$1 and owner_id=$2`, [jobId, ownerId])
      const row = job.rows[0]
      if (!row) {
        await client.query('commit')
        return null
      }
      const counts = await client.query<{ status: string; count: number }>(`select status,count(*)::int as count
        from site_reconstruction_pages where site_reconstruction_job_id=$1 group by status`, [jobId])
      const summary = { QUEUED: 0, RENDERING: 0, SUCCEEDED: 0, FAILED: 0, CANCELLED: 0 }
      for (const count of counts.rows) summary[count.status as keyof typeof summary] = count.count
      const columns = `page_id as "pageId",ordinal,public_url as url,status,attempt_count as "attemptCount",
        failure_code as "failureCode",started_at as "startedAt",finished_at as "finishedAt",
        updated_at as "updatedAt",available_at as "retryAt",
        coalesce(status='RENDERING' and lease_expires_at<=now(),false) as "leaseExpired"`
      const active = await client.query<SiteProgressPage>(`select ${columns} from site_reconstruction_pages
        where site_reconstruction_job_id=$1 and status='RENDERING' order by ordinal limit 32`, [jobId])
      const pages = await client.query<SiteProgressPage>(`select ${columns} from site_reconstruction_pages
        where site_reconstruction_job_id=$1 and ordinal>$2
          and ($3='ALL' or status=$3) and position(lower($4) in lower(public_url))>0
        order by ordinal limit $5`, [jobId, after, status, q, limit + 1])
      const items = pages.rows.slice(0, limit).map(progressPage)
      await client.query('commit')
      return {
        available: true, jobId, scanId: row.scan_id, correlationId: row.correlation_id,
        phase: row.status, ingestionComplete: row.ingestion_finished_at !== null,
        observedAt: row.observed_at, updatedAt: row.updated_at, startedAt: row.started_at,
        finishedAt: row.finished_at, phaseAttemptCount: row.phase_attempt_count,
        phaseRetryAt: row.phase_available_at, terminalCode: row.terminal_code,
        phaseLeaseExpired: row.phase_lease_expires_at !== null && row.phase_lease_expires_at <= row.observed_at,
        counts: summary, activePages: active.rows.map(progressPage), items,
        nextAfter: pages.rows.length > limit ? items.at(-1)!.ordinal : null,
      }
    } catch (error) {
      await client.query('rollback')
      throw error
    } finally {
      client.release()
    }
  }

  async getArtifact(ownerId: string, jobId: string, artifactId: string): Promise<SiteArtifactReference | null> {
    const result = await this.pool.query<{
      id: string; created_at: Date; kind: SiteArtifactReference['kind']; shard_number: number; logical_filename: string
      storage_bucket: string; storage_key: string; content_type: string; byte_size: string
      sha256_hex: string; delete_after: Date; state: SiteArtifactReference['state']
    }>(`select id,created_at,kind,shard_number,logical_filename,storage_bucket,storage_key,content_type,
        byte_size,encode(sha256,'hex') as sha256_hex,delete_after,state
      from site_reconstruction_artifacts
      where id=$1 and site_reconstruction_job_id=$2 and owner_id=$3
        and kind in ('ARCHIVE_SHARD','MANIFEST') limit 1`, [artifactId, jobId, ownerId])
    const row = result.rows[0]
    return row ? {
      id: row.id, createdAt: row.created_at, kind: row.kind, shardNumber: row.shard_number,
      logicalFilename: row.logical_filename, bucket: row.storage_bucket, key: row.storage_key,
      contentType: row.content_type, bytes: Number(row.byte_size), sha256Hex: row.sha256_hex,
      expiresAt: row.delete_after, state: row.state,
    } : null
  }

  async claimObjectForDeletion(): Promise<ClaimedSiteObjectDeletion | null> {
    const artifact = await this.pool.query<{
      id: string; site_reconstruction_job_id: string; storage_bucket: string
      storage_key: string; content_type: string; byte_size: string; sha256: Buffer
    }>(`with candidate as (
        select id from site_reconstruction_artifacts
        where state in ('PUBLISHED','DELETE_PENDING') and delete_after<=now()
        order by delete_after,id for update skip locked limit 1
      ) update site_reconstruction_artifacts artifact
      set state='DELETE_PENDING',delete_after=now()+interval '30 seconds'
      from candidate where artifact.id=candidate.id
      returning artifact.id,artifact.site_reconstruction_job_id,artifact.storage_bucket,
        artifact.storage_key,artifact.content_type,artifact.byte_size,artifact.sha256`)
    const artifactRow = artifact.rows[0]
    if (artifactRow) {
      return {
        type: 'ARTIFACT', jobId: artifactRow.site_reconstruction_job_id, objectId: artifactRow.id,
        object: {
          bucket: artifactRow.storage_bucket, key: artifactRow.storage_key,
          contentType: artifactRow.content_type, bytes: Number(artifactRow.byte_size),
          sha256: artifactRow.sha256,
        },
      }
    }

    const bundle = await this.pool.query<{
      site_reconstruction_job_id: string; page_id: string; bundle_bucket: string
      bundle_storage_key: string; bundle_bytes: string; bundle_sha256: Buffer
    }>(`with candidate as (
        select page.site_reconstruction_job_id,page.page_id
        from site_reconstruction_pages page
        join site_reconstruction_jobs job on job.id=page.site_reconstruction_job_id
        where job.status in ('PUBLISHED','PARTIAL','FAILED','CANCELLED','EXPIRED')
          and page.status='SUCCEEDED'
          and page.bundle_state in ('AVAILABLE','DELETE_PENDING')
          and page.bundle_delete_after<=now()
        order by page.bundle_delete_after,page.site_reconstruction_job_id,page.page_id
        for update of page skip locked limit 1
      ) update site_reconstruction_pages page
      set bundle_state='DELETE_PENDING',bundle_delete_after=now()+interval '30 seconds'
      from candidate
      where page.site_reconstruction_job_id=candidate.site_reconstruction_job_id
        and page.page_id=candidate.page_id
      returning page.site_reconstruction_job_id,page.page_id,page.bundle_bucket,
        page.bundle_storage_key,page.bundle_bytes,page.bundle_sha256`)
    const bundleRow = bundle.rows[0]
    return bundleRow ? {
      type: 'PAGE_BUNDLE', jobId: bundleRow.site_reconstruction_job_id, objectId: bundleRow.page_id,
      object: {
        bucket: bundleRow.bundle_bucket, key: bundleRow.bundle_storage_key,
        contentType: 'application/json', bytes: Number(bundleRow.bundle_bytes),
        sha256: bundleRow.bundle_sha256,
      },
    } : null
  }

  async completeObjectDeletion(deletion: ClaimedSiteObjectDeletion): Promise<void> {
    const client = await this.pool.connect()
    try {
      await client.query('begin')
      if (deletion.type === 'ARTIFACT') {
        const deleted = await client.query(`update site_reconstruction_artifacts
          set state='DELETED',deleted_at=now()
          where id=$1 and site_reconstruction_job_id=$2 and state='DELETE_PENDING'`,
        [deletion.objectId, deletion.jobId])
        if (!deleted.rowCount) throw new Error('STALE_SITE_GC_CLAIM')
        const remaining = await client.query(`select 1 from site_reconstruction_artifacts
          where site_reconstruction_job_id=$1 and state in ('PUBLISHED','DELETE_PENDING') limit 1`,
        [deletion.jobId])
        if (!remaining.rowCount) {
          const expired = await client.query(`update site_reconstruction_jobs
            set status='EXPIRED',updated_at=now()
            where id=$1 and status in ('PUBLISHED','PARTIAL')`, [deletion.jobId])
          if (expired.rowCount) await this.enqueueEvent(client, deletion.jobId, 'EXPIRED')
        }
      } else {
        const deleted = await client.query(`update site_reconstruction_pages
          set bundle_state='DELETED',bundle_delete_after=now()
          where site_reconstruction_job_id=$1 and page_id=$2 and bundle_state='DELETE_PENDING'`,
        [deletion.jobId, deletion.objectId])
        if (!deleted.rowCount) throw new Error('STALE_SITE_GC_CLAIM')
      }
      await client.query('commit')
    } catch (error) {
      await client.query('rollback')
      throw error
    } finally {
      client.release()
    }
  }

  async retryObjectDeletion(deletion: ClaimedSiteObjectDeletion): Promise<void> {
    if (deletion.type === 'ARTIFACT') {
      await this.pool.query(`update site_reconstruction_artifacts
        set delete_after=now()+interval '1 minute'
        where id=$1 and site_reconstruction_job_id=$2 and state='DELETE_PENDING'`,
      [deletion.objectId, deletion.jobId])
      return
    }
    await this.pool.query(`update site_reconstruction_pages
      set bundle_delete_after=now()+interval '1 minute'
      where site_reconstruction_job_id=$1 and page_id=$2 and bundle_state='DELETE_PENDING'`,
    [deletion.jobId, deletion.objectId])
  }

  private async acceptRequested(envelope: SiteCloneRequestedEnvelope): Promise<boolean> {
    const encoded = Buffer.from(JSON.stringify(envelope), 'utf8')
    const hash = createHash('sha256').update(encoded).digest()
    const client = await this.pool.connect()
    try {
      await client.query('begin')
      await client.query('select pg_advisory_xact_lock(hashtextextended($1,0))', [envelope.messageId])
      const existing = await client.query<{ command_payload_sha256: Buffer }>(
        'select command_payload_sha256 from site_reconstruction_jobs where command_message_id=$1',
        [envelope.messageId],
      )
      if (existing.rowCount) {
        const stored = existing.rows[0]?.command_payload_sha256
        if (!stored || stored.length !== hash.length || !timingSafeEqual(stored, hash)) {
          throw new Error('MESSAGE_ID_COLLISION')
        }
        await client.query('commit')
        return true
      }
      const payload = envelope.payload
      await client.query(`insert into site_reconstruction_jobs (
          id,command_message_id,command_payload_sha256,owner_id,scan_id,correlation_id,
          command_version,root_url,status,max_pages,max_input_bytes,max_archive_bytes,
          max_shard_bytes,page_concurrency,max_retries_per_page,archive_retention_days,
          metadata_retention_days,same_origin_only,max_duration_seconds,created_at,updated_at
        ) values ($1,$2,$3,$4,$5,$6,$7,$8,'INGESTING',$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,now(),now())`, [
        payload.siteCloneRequestId, envelope.messageId, hash, payload.ownerId, payload.scanId,
        envelope.correlationId, envelope.aggregateVersion, payload.rootUrl, payload.maxPages,
        payload.maxInputBytes, payload.maxArchiveBytes, payload.maxShardBytes,
        payload.pageConcurrency, payload.maxRetriesPerPage, payload.archiveRetentionDays,
        payload.metadataRetentionDays, payload.sameOriginOnly, payload.maxDurationSeconds,
      ])
      await client.query('commit')
      return false
    } catch (error) {
      await client.query('rollback')
      throw error
    } finally {
      client.release()
    }
  }

  private async acceptCancellation(envelope: Extract<SiteCloneCommandEnvelope, { messageType: 'SITE_CLONE_CANCEL_REQUESTED' }>): Promise<boolean> {
    const encoded = Buffer.from(JSON.stringify(envelope), 'utf8')
    const hash = createHash('sha256').update(encoded).digest()
    const client = await this.pool.connect()
    try {
      await client.query('begin')
      await client.query('select pg_advisory_xact_lock(hashtextextended($1,0))', [envelope.messageId])
      const existing = await client.query<{ payload_sha256: Buffer }>(
        'select payload_sha256 from site_reconstruction_command_inbox where message_id=$1', [envelope.messageId],
      )
      if (existing.rowCount) {
        const stored = existing.rows[0]?.payload_sha256
        if (!stored || stored.length !== hash.length || !timingSafeEqual(stored, hash)) {
          throw new Error('MESSAGE_ID_COLLISION')
        }
        await client.query('commit')
        return true
      }
      const job = await client.query<{ status: string }>(`select status from site_reconstruction_jobs
        where id=$1 and owner_id=$2 for update`, [envelope.aggregateId, envelope.payload.ownerId])
      const status = job.rows[0]?.status
      if (!status) throw new Error('SITE_JOB_NOT_FOUND')
      const terminal = ['PUBLISHED', 'PARTIAL', 'FAILED', 'CANCELLED', 'EXPIRED'].includes(status)
      if (!terminal) {
        await client.query(`update site_reconstruction_jobs set status='CANCEL_REQUESTED',
          phase_lease_owner=null,phase_lease_expires_at=null,cancellation_requested_at=now(),updated_at=now()
          where id=$1`, [envelope.aggregateId])
      }
      await client.query(`insert into site_reconstruction_command_inbox
        (message_id,payload_sha256,outcome,processed_at) values ($1,$2,$3,now())`, [
        envelope.messageId, hash, terminal ? 'IGNORED_TERMINAL' : 'APPLIED',
      ])
      await client.query('commit')
      return false
    } catch (error) {
      await client.query('rollback')
      throw error
    } finally {
      client.release()
    }
  }

  private async incrementJob(client: PoolClient, jobId: string, succeeded: boolean, inputBytes: number): Promise<void> {
    const result = await client.query<{ processed_count: number }>(`update site_reconstruction_jobs set
        processed_count=processed_count+1,
        succeeded_count=succeeded_count+case when $2 then 1 else 0 end,
        failed_count=failed_count+case when $2 then 0 else 1 end,
        input_bytes=input_bytes+$3,updated_at=now()
      where id=$1 returning processed_count`, [jobId, succeeded, inputBytes])
    const processed = result.rows[0]?.processed_count ?? 0
    if (processed > 0 && processed % 100 === 0) await this.enqueueEvent(client, jobId, 'RUNNING')
  }

  private async finishPageWithoutBundle(
    client: PoolClient,
    page: ClaimedSitePage,
    status: 'FAILED' | 'CANCELLED',
    code: string,
  ): Promise<void> {
    await client.query(`update site_reconstruction_pages set status=$5,
        lease_owner=null,lease_expires_at=null,failure_code=$6,finished_at=now(),updated_at=now()
      where site_reconstruction_job_id=$1 and page_id=$2 and status='RENDERING'
        and lease_owner=$3 and lease_generation=$4`, [
      page.jobId, page.pageId, page.leaseOwner, page.leaseGeneration, status, code,
    ])
  }

  private async refreshJobCounters(client: PoolClient, jobId: string): Promise<void> {
    await client.query(`update site_reconstruction_jobs job set
        processed_count=counts.processed,succeeded_count=counts.succeeded,
        failed_count=counts.failed,input_bytes=counts.input_bytes,updated_at=now()
      from (select
          count(*) filter (where status in ('SUCCEEDED','FAILED'))::integer as processed,
          count(*) filter (where status='SUCCEEDED')::integer as succeeded,
          count(*) filter (where status='FAILED')::integer as failed,
          coalesce(sum(input_bytes) filter (where status='SUCCEEDED'),0)::bigint as input_bytes
        from site_reconstruction_pages where site_reconstruction_job_id=$1) counts
      where job.id=$1`, [jobId])
  }

  private async finalizeEmptyJobs(client: PoolClient): Promise<void> {
    const rows = await client.query<{ id: string }>(`select id from site_reconstruction_jobs job
      where status='RUNNING' and ingestion_finished_at is not null and succeeded_count=0
        and not exists (select 1 from site_reconstruction_pages page
          where page.site_reconstruction_job_id=job.id and page.status in ('QUEUED','RENDERING'))
      for update skip locked`)
    for (const row of rows.rows) {
      await client.query(`update site_reconstruction_jobs set status='FAILED',
        terminal_code='ALL_PAGES_FAILED',terminal_message='Every cloneable page failed.',
        finished_at=now(),updated_at=now() where id=$1`, [row.id])
      await this.enqueueEvent(client, row.id, 'FAILED')
    }
  }

  private async enqueueEvent(client: PoolClient, jobId: string, status: string): Promise<void> {
    const job = await client.query<{
      event_version: string; owner_id: string; correlation_id: string; discovered_count: number
      processed_count: number; succeeded_count: number; failed_count: number
      artifact_count: number; archive_bytes: string; terminal_code: string | null; terminal_message: string | null
    }>(`update site_reconstruction_jobs set event_version=event_version+1,updated_at=now()
      where id=$1 returning event_version,owner_id,correlation_id,discovered_count,
        processed_count,succeeded_count,failed_count,artifact_count,archive_bytes,
        terminal_code,terminal_message`, [jobId])
    const row = job.rows[0]
    if (!row) throw new Error('SITE_JOB_NOT_FOUND')
    const messageId = randomUUID()
    const occurredAt = new Date().toISOString()
    const payload = {
      messageId,
      aggregateType: 'SITE_CLONE',
      aggregateId: jobId,
      aggregateVersion: Number(row.event_version),
      messageType: 'SITE_CLONE_PROGRESS',
      contractVersion: 1,
      correlationId: row.correlation_id,
      occurredAt,
      payload: {
        siteCloneRequestId: jobId,
        ownerId: row.owner_id,
        status,
        discoveredCount: row.discovered_count,
        processedCount: row.processed_count,
        succeededCount: row.succeeded_count,
        failedCount: row.failed_count,
        artifactCount: row.artifact_count,
        totalArchiveBytes: Number(row.archive_bytes),
        terminalCode: row.terminal_code,
        terminalMessage: row.terminal_message,
      },
    }
    await client.query(`insert into site_reconstruction_event_outbox (
        message_id,site_reconstruction_job_id,event_version,correlation_id,payload,
        status,available_at,created_at
      ) values ($1,$2,$3,$4,$5::jsonb,'PENDING',now(),now())`, [
      messageId, jobId, Number(row.event_version), row.correlation_id, JSON.stringify(payload),
    ])
  }
}

interface SitePhaseRow {
  id: string
  owner_id: string
  scan_id: string
  correlation_id: string
  root_url: string
  command_payload_sha256: Buffer
  phase_lease_owner: string
  phase_lease_generation: string
  phase_attempt_count: number
  max_pages: number
  max_input_bytes: string
  max_archive_bytes: string
  max_shard_bytes: string
  page_concurrency: number
  max_retries_per_page: number
  archive_retention_days: number
  metadata_retention_days: number
  same_origin_only: boolean
  max_duration_seconds: number
}

function phaseFromRow(row: SitePhaseRow): ClaimedSitePhase {
  return {
    id: row.id,
    ownerId: row.owner_id,
    scanId: row.scan_id,
    correlationId: row.correlation_id,
    rootUrl: row.root_url,
    leaseOwner: row.phase_lease_owner,
    leaseGeneration: Number(row.phase_lease_generation),
    attemptCount: row.phase_attempt_count,
    payload: {
      siteCloneRequestId: row.id,
      ownerId: row.owner_id,
      scanId: row.scan_id,
      rootUrl: row.root_url,
      maxPages: row.max_pages,
      maxInputBytes: Number(row.max_input_bytes),
      maxArchiveBytes: Number(row.max_archive_bytes),
      maxShardBytes: Number(row.max_shard_bytes),
      pageConcurrency: row.page_concurrency,
      maxRetriesPerPage: row.max_retries_per_page,
      maxDurationSeconds: row.max_duration_seconds,
      archiveRetentionDays: row.archive_retention_days,
      metadataRetentionDays: row.metadata_retention_days,
      sameOriginOnly: true,
    },
  }
}

function boundedCode(value: string): string {
  return value.toUpperCase().replace(/[^A-Z0-9_]/gu, '_').slice(0, 64) || 'SITE_CLONE_FAILED'
}

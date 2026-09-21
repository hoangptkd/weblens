import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'
import type { Config } from './config.js'
import { ObjectStorage } from './storage.js'

const endpoint = process.env.CAPTURE_TEST_S3_ENDPOINT
const accessKey = process.env.CAPTURE_TEST_S3_ACCESS_KEY
const secretKey = process.env.CAPTURE_TEST_S3_SECRET_KEY
const bucket = process.env.CAPTURE_TEST_S3_BUCKET
const configured = endpoint && accessKey && secretKey && bucket

test('MinIO put, copy, integrity read và delete hoạt động với site-clone staging', {
  skip: configured ? false : 'CAPTURE_TEST_S3_* chưa được cấu hình',
}, async () => {
  const storage = new ObjectStorage(config())
  await storage.ensureBucket()
  const id = randomUUID()
  const body = Buffer.from('design-clone-minio-integration', 'utf8')
  const staging = await storage.put(`site-clone-staging/integration/${id}/manifest.json`, body, 'application/json')
  const published = await storage.copy(staging, `integration/${id}/manifest.json`)

  try {
    await storage.verify(staging)
    await storage.verify(published)
    assert.deepEqual(await storage.get(published.bucket, published.key), body)
    assert.deepEqual(published.sha256, staging.sha256)
    assert.equal(published.bytes, body.length)
  } finally {
    await Promise.allSettled([storage.delete(staging), storage.delete(published)])
  }
  await assert.rejects(storage.get(published.bucket, published.key), /ARTIFACT_OBJECT_MISSING/u)
})

function config(): Config {
  return {
    host: '127.0.0.1',
    port: 1,
    serviceToken: 'integration-token-at-least-32-bytes',
    databaseUrl: 'postgresql://unused',
    clickhouseUrl: 'http://unused',
    clickhouseDatabase: 'unused',
    clickhouseUsername: 'unused',
    clickhousePassword: 'unused',
    s3Endpoint: endpoint!,
    s3Region: 'us-east-1',
    s3AccessKey: accessKey!,
    s3SecretKey: secretKey!,
    s3Bucket: bucket!,
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

import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { loadConfig } from './config.js'

const originalEnvironment = { ...process.env }

afterEach(() => {
  process.env = { ...originalEnvironment }
})

test('can disable ClickHouse migrations for a restricted cloud runtime user', () => {
  Object.assign(process.env, {
    WEBLENS_SERVICE_TOKEN: 'x'.repeat(32),
    CAPTURE_DATABASE_URL: 'postgresql://capture:password@localhost/capture',
    CLICKHOUSE_URL: 'https://clickhouse.example:8443',
    CLICKHOUSE_USERNAME: 'capture',
    CLICKHOUSE_PASSWORD: 'password',
    S3_ENDPOINT: 'https://s3.example',
    S3_ACCESS_KEY: 'access',
    S3_SECRET_KEY: 'secret',
    WEBLENS_CONTROL_CAPTURE_EVENT_URL: 'http://127.0.0.1:8080/internal/v1/events/captures',
    WEBLENS_CONTROL_SITE_CLONE_EVENT_URL: 'http://127.0.0.1:8080/internal/v1/events/site-clones',
    WEBLENS_CRAWLER_REPORT_BASE_URL: 'http://127.0.0.1:8081',
    CAPTURE_MIGRATE_CLICKHOUSE_ON_START: 'false',
  })

  assert.equal(loadConfig().migrateClickHouseOnStart, false)
})

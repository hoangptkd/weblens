import assert from 'node:assert/strict'
import { once } from 'node:events'
import { createServer } from 'node:http'
import { test } from 'node:test'
import type { AddressInfo } from 'node:net'
import { CrawlerReportClient } from './crawler-client.js'

test('crawler client chuẩn hóa outcome contract viết hoa của Go service', async () => {
  const server = createServer((_request, response) => {
    response.setHeader('content-type', 'application/json')
    response.end(JSON.stringify({
      items: [{
        id: 'page-1', scanId: 'scan-1', url: 'https://example.com/', finalUrl: 'https://example.com/',
        outcome: 'SUCCESS', statusCode: 200, contentType: 'text/html',
      }],
    }))
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')

  try {
    const port = (server.address() as AddressInfo).port
    const client = new CrawlerReportClient({
      crawlerReportBaseUrl: `http://127.0.0.1:${port}`,
      serviceToken: 'test-token',
    })
    const result = await client.listPages('owner-1', 'scan-1')
    assert.equal(result.items[0]?.outcome, 'success')
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  }
})

import assert from 'node:assert/strict'
import test from 'node:test'
import { createServer, request } from 'node:http'
import { assertPublicHttpUrl, isPrivateAddress } from './security.js'
import { SafeProxy } from './safe-proxy.js'

test('chặn địa chỉ private, loopback, link-local và multicast', () => {
  for (const address of [
    '127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.1.2', '169.254.169.254',
    '::1', 'fd00::1', '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:169.254.169.254',
    '192.0.2.1', '198.18.0.1', '2001:db8::1',
  ]) {
    assert.equal(isPrivateAddress(address), true, address)
  }
  assert.equal(isPrivateAddress('8.8.8.8'), false)
  assert.equal(isPrivateAddress('2606:4700:4700::1111'), false)
})

test('chỉ chấp nhận HTTP(S) công khai không có userinfo', async () => {
  await assert.rejects(assertPublicHttpUrl('file:///etc/passwd'), /URL_POLICY_REJECTED/u)
  await assert.rejects(assertPublicHttpUrl('http://user:pass@example.com'), /URL_POLICY_REJECTED/u)
  await assert.rejects(assertPublicHttpUrl('http://localhost:8080'), /SSRF_BLOCKED/u)
  await assert.rejects(assertPublicHttpUrl('http://127.0.0.1'), /SSRF_BLOCKED/u)
  await assert.rejects(assertPublicHttpUrl('http://[::ffff:127.0.0.1]/'), /SSRF_BLOCKED/u)
  assert.equal((await assertPublicHttpUrl('https://[2606:4700:4700::1111]/')).hostname,
    '[2606:4700:4700::1111]')
})

test('SafeProxy không mở kết nối tới loopback qua IPv4-mapped IPv6', async () => {
  let privateHits = 0
  const privateServer = createServer((_request, response) => { privateHits++; response.end('private') })
  await new Promise<void>((resolve) => privateServer.listen(0, '127.0.0.1', resolve))
  const proxy = new SafeProxy()
  await proxy.start()
  try {
    const privateAddress = privateServer.address()
    assert.ok(privateAddress && typeof privateAddress !== 'string')
    const proxyPort = Number(new URL(proxy.url()).port)
    const status = await new Promise<number>((resolve, reject) => {
      const outgoing = request({
        hostname: '127.0.0.1', port: proxyPort,
        path: `http://[::ffff:127.0.0.1]:${privateAddress.port}/secret`,
      }, (response) => {
        response.resume()
        response.on('end', () => resolve(response.statusCode ?? 0))
      })
      outgoing.on('error', reject)
      outgoing.end()
    })
    assert.equal(status, 502)
    assert.equal(privateHits, 0)
  } finally {
    await proxy.close()
    await new Promise<void>((resolve) => privateServer.close(() => resolve()))
  }
})

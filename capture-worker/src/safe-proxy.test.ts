import assert from 'node:assert/strict'
import { Socket, connect } from 'node:net'
import { once } from 'node:events'
import { test } from 'node:test'
import { SafeProxy } from './safe-proxy.js'

test('proxy closes open connections during shutdown and enforces transport bytes', async () => {
  const proxy = new SafeProxy(1024)
  await proxy.start()
  const client = connect({ host: '127.0.0.1', port: Number(new URL(proxy.url()).port) })
  await once(client, 'connect')
  const upstream = new Socket()
  Reflect.get(proxy, 'track').call(proxy, upstream, true)
  upstream.emit('data', Buffer.alloc(1025))
  assert.throws(() => proxy.assertWithinBudget(), /CAPTURE_TRANSFER_BUDGET_EXCEEDED/u)
  assert.equal(upstream.destroyed, true)
  await proxy.close()
  client.destroy()
})

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { InteractiveBrowserSessionManager, validateBrowserSessionAction } from './browser-session.js'

test('browser session chỉ nhận thao tác hữu hạn trong viewport', () => {
  assert.deepEqual(validateBrowserSessionAction({ type: 'click', x: 1364, y: 767 }), {
    type: 'click', x: 1364, y: 767,
  })
  assert.throws(() => validateBrowserSessionAction({ type: 'click', x: 1365, y: 768 }), /INVALID_BROWSER_ACTION/u)
  assert.deepEqual(validateBrowserSessionAction({ type: 'key', key: 'Enter' }), {
    type: 'key', key: 'Enter',
  })
  assert.throws(() => validateBrowserSessionAction({ type: 'click', x: -1, y: 0 }), /INVALID_BROWSER_ACTION/u)
  assert.throws(() => validateBrowserSessionAction({ type: 'key', key: 'Control+L' }), /INVALID_BROWSER_ACTION/u)
  assert.throws(() => validateBrowserSessionAction({ type: 'type', text: 'x'.repeat(4_097) }), /INVALID_BROWSER_ACTION/u)
})

test('browser session dùng viewport thực tế của engine cho tọa độ click', () => {
  assert.deepEqual(validateBrowserSessionAction({ type: 'click', x: 1364, y: 711 }, { width: 1365, height: 712 }),
    { type: 'click', x: 1364, y: 711 })
  assert.throws(() => validateBrowserSessionAction({ type: 'click', x: 1364, y: 712 }, { width: 1365, height: 712 }),
    /INVALID_BROWSER_ACTION/)
})

test('browser session chết được xóa để chủ sở hữu mở lại, không lộ phiên cho owner khác', async () => {
  const manager = new InteractiveBrowserSessionManager()
  const sessions = Reflect.get(manager, 'sessions') as Map<string, unknown>
  const closed: string[] = []
  const timer = setTimeout(() => undefined, 60_000)
  timer.unref()
  sessions.set('clone-1', {
    ownerId: 'owner-1', siteCloneId: 'clone-1', expiresAt: Date.now() + 60_000, timer,
    browser: { isConnected: () => false, close: async () => { closed.push('browser') } },
    context: { close: async () => { closed.push('context') } },
    proxy: { close: async () => { closed.push('proxy') } },
    activePage: { isClosed: () => false }, waiters: new Set(),
  })

  assert.equal(manager.status('other-owner', 'clone-1'), null)
  assert.equal(sessions.size, 1)
  assert.equal(manager.status('owner-1', 'clone-1'), null)
  assert.equal(sessions.size, 0)
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.deepEqual(closed, ['context', 'browser', 'proxy'])
})

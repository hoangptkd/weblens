import assert from 'node:assert/strict'
import { test } from 'node:test'
import { validateBrowserSessionAction } from './browser-session.js'

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

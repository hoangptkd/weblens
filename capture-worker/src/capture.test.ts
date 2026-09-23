import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  collectResourceBodies,
  isSafeExpansionLabel,
  sanitizeUrl,
  type ResponseCandidate,
} from './capture.js'

test('redact toàn bộ query value và loại userinfo, fragment khỏi URL analytical', () => {
  const sanitized = sanitizeUrl(
    'https://user:password@example.com/app.js?token=secret&lang=vi&lang=en#private-fragment',
  )
  const url = new URL(sanitized)

  assert.equal(url.username, '')
  assert.equal(url.password, '')
  assert.equal(url.hash, '')
  assert.deepEqual(url.searchParams.getAll('token'), ['[REDACTED]'])
  assert.deepEqual(url.searchParams.getAll('lang'), ['[REDACTED]'])
})

test('chỉ tự động bấm điều khiển mở rộng rõ ràng và không phá hoại', () => {
  assert.equal(isSafeExpansionLabel('Xem thêm bài viết'), true)
  assert.equal(isSafeExpansionLabel('Load more'), true)
  assert.equal(isSafeExpansionLabel('Xóa và xem thêm'), false)
  assert.equal(isSafeExpansionLabel('Đăng xuất'), false)
  assert.equal(isSafeExpansionLabel('Gửi biểu mẫu'), false)
})

test('bỏ resource đã lỗi trước khi đọc body và không gọi Playwright wait', async () => {
  let finishedCalls = 0
  const value = candidate({
    skipReason: 'HTTP_FAILURE',
    finished: async () => { finishedCalls += 1; return null },
  })

  const result = await collectResourceBodies([value], 1_024, 1_024, Date.now() + 100)

  assert.equal(finishedCalls, 0)
  assert.equal(result.bodies.length, 0)
  assert.equal(result.cloneInputs[0]?.skipReason, 'HTTP_FAILURE')
})

test('requestfailed sau response giải phóng wait đang treo', async () => {
  const value = candidate({ finished: () => new Promise(() => undefined) })
  setTimeout(() => {
    value.skipReason = 'REQUEST_FAILED'
    value.markFailed()
  }, 5)

  const result = await collectResourceBodies([value], 1_024, 1_024, Date.now() + 200)

  assert.equal(result.bodies.length, 0)
  assert.equal(result.cloneInputs[0]?.skipReason, 'REQUEST_FAILED')
})

test('body không kết thúc bị giới hạn thời gian và candidate đến muộn không được nhập giữa vòng lặp', async () => {
  const candidates: ResponseCandidate[] = []
  const late = candidate()
  const first = candidate({
    finished: async () => {
      candidates.push(late)
      return null
    },
    body: () => new Promise(() => undefined),
  })
  candidates.push(first)

  const started = Date.now()
  const result = await collectResourceBodies(candidates, 1_024, 1_024, Date.now() + 30)

  assert.ok(Date.now() - started < 1_000)
  assert.equal(result.cloneInputs.length, 1)
  assert.equal(result.cloneInputs[0]?.skipReason, 'RESOURCE_TIMEOUT')
})

function candidate(overrides: {
  skipReason?: string | null
  finished?: () => Promise<Error | null>
  body?: () => Promise<Buffer>
} = {}): ResponseCandidate {
  let markFailed: () => void = () => undefined
  const failed = new Promise<void>((resolveFailure) => { markFailed = resolveFailure })
  return {
    response: {
      finished: overrides.finished ?? (async () => null),
      body: overrides.body ?? (async () => Buffer.from('body')),
    },
    sequence: 1,
    sourceUrl: 'https://example.com/image.webp',
    publicUrl: 'https://example.com/image.webp',
    resourceType: 'image',
    mimeType: 'image/webp',
    captureBody: true,
    skipReason: overrides.skipReason ?? null,
    failed,
    markFailed,
  }
}

import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { ManagedBrowserPanel } from './ManagedBrowserPanel'
import type { SiteCloneBrowserSession } from '../domain/types'

const api = vi.hoisted(() => ({ startSiteCloneBrowserSession: vi.fn(), getSiteCloneBrowserSession: vi.fn(),
  getSiteCloneBrowserScreenshot: vi.fn(), readySiteCloneBrowserSession: vi.fn(), closeSiteCloneBrowserSession: vi.fn() }))
vi.mock('../api/webLensApiService', () => ({ webLensService: api }))
const waiting = { status: 'AWAITING_USER', currentUrl: 'https://example.com', viewportWidth: 1280,
  viewportHeight: 720, expiresAt: '2030-01-01T00:00:00Z' } as SiteCloneBrowserSession

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.resetAllMocks(); vi.unstubAllGlobals() })

async function open() {
  class TestURL extends URL { }
  vi.stubGlobal('URL', Object.assign(TestURL, { createObjectURL: vi.fn(() => 'blob:test'), revokeObjectURL: vi.fn() }))
  api.startSiteCloneBrowserSession.mockResolvedValue(waiting)
  api.getSiteCloneBrowserSession.mockResolvedValue(waiting)
  api.getSiteCloneBrowserScreenshot.mockResolvedValue(new Blob(['image']))
  const view = render(<ManagedBrowserPanel siteCloneId="clone" autoStart={false} />)
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Mở phiên đăng nhập' })) })
  return view
}

it('keeps READY when an earlier poll returns after confirmation', async () => {
  vi.useFakeTimers()
  await open()
  let finish!: (value: SiteCloneBrowserSession) => void
  api.getSiteCloneBrowserSession.mockReturnValue(new Promise<SiteCloneBrowserSession>((resolve) => { finish = resolve }))
  await act(async () => { await vi.advanceTimersByTimeAsync(1500) })
  api.readySiteCloneBrowserSession.mockResolvedValue({ ...waiting, status: 'READY' })
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Tôi đã đăng nhập — tiếp tục clone' })) })
  await act(async () => { finish(waiting) })
  expect(screen.getByRole('status')).toHaveTextContent('Đã xác nhận')
  expect(api.getSiteCloneBrowserSession).toHaveBeenCalledTimes(2)
})

it('does not create a new object URL when a response arrives after unmount', async () => {
  vi.useFakeTimers()
  const view = await open()
  let finish!: (value: SiteCloneBrowserSession) => void
  api.getSiteCloneBrowserSession.mockReturnValue(new Promise<SiteCloneBrowserSession>((resolve) => { finish = resolve }))
  await act(async () => { await vi.advanceTimersByTimeAsync(1500) })
  view.unmount()
  await act(async () => { finish(waiting) })
  expect(URL.createObjectURL).toHaveBeenCalledTimes(1)
  expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:test')
})

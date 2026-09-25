import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from '../api/apiClient'
import { webLensService } from '../api/webLensApiService'
import type { SiteClone } from '../domain/types'
import { SiteClonePage } from './SiteClonePage'

describe('SiteClonePage', () => {
  afterEach(() => vi.restoreAllMocks())
  beforeEach(() => {
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: vi.fn(() => 'blob:browser-session') })
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: vi.fn() })
    vi.spyOn(webLensService, 'getSiteCloneProgress').mockResolvedValue({
      available: false, jobId: 'clone-1', scanId: 'scan-internal-1', correlationId: null,
      phase: 'WAITING_FOR_SCAN', ingestionComplete: false, observedAt: '2026-09-21T06:00:00Z',
      updatedAt: null, startedAt: null, finishedAt: null, phaseAttemptCount: 0, phaseRetryAt: null,
      phaseLeaseExpired: false, terminalCode: null, counts: {}, activePages: [], items: [], nextAfter: null,
    })
  })

  it('mở phiên trình duyệt tạm thời khi website yêu cầu đăng nhập', async () => {
    const clone = siteClone()
    const browserSession = {
      status: 'AWAITING_USER' as const,
      currentUrl: 'https://example.com/login',
      expiresAt: '2026-09-21T06:10:00Z',
      viewportWidth: 1365,
      viewportHeight: 768,
    }
    vi.spyOn(webLensService, 'listSiteClones').mockResolvedValue(siteClonePage([]))
    vi.spyOn(webLensService, 'getSiteClone').mockResolvedValue(clone)
    vi.spyOn(webLensService, 'startSiteClone').mockResolvedValue(clone)
    const startBrowser = vi.spyOn(webLensService, 'startSiteCloneBrowserSession').mockResolvedValue(browserSession)
    vi.spyOn(webLensService, 'getSiteCloneBrowserSession').mockResolvedValue(browserSession)
    vi.spyOn(webLensService, 'getSiteCloneBrowserScreenshot').mockResolvedValue(new Blob(['jpeg']))
    const user = userEvent.setup()
    renderSiteClonePage()

    await user.type(screen.getByLabelText('URL gốc'), 'https://example.com')
    await user.click(screen.getByLabelText('Website yêu cầu đăng nhập, cookie hoặc OTP'))
    await user.click(screen.getByRole('button', { name: /Scan và clone/i }))

    expect(startBrowser).toHaveBeenCalledWith(clone.id)
    expect(await screen.findByRole('heading', { name: 'Trình duyệt đăng nhập tạm thời' })).toBeInTheDocument()
  })

  it('cho mở lại phiên khi trình duyệt chết sau thao tác', async () => {
    const clone = siteClone()
    const browserSession = {
      status: 'AWAITING_USER' as const,
      currentUrl: 'https://example.com/login',
      expiresAt: '2026-09-25T04:10:00Z',
      viewportWidth: 1365,
      viewportHeight: 768,
    }
    vi.spyOn(webLensService, 'listSiteClones').mockResolvedValue(siteClonePage([]))
    vi.spyOn(webLensService, 'getSiteClone').mockResolvedValue(clone)
    const startBrowser = vi.spyOn(webLensService, 'startSiteCloneBrowserSession').mockResolvedValue(browserSession)
    vi.spyOn(webLensService, 'getSiteCloneBrowserSession').mockResolvedValue(browserSession)
    vi.spyOn(webLensService, 'getSiteCloneBrowserScreenshot').mockResolvedValue(new Blob(['jpeg']))
    vi.spyOn(webLensService, 'sendSiteCloneBrowserAction').mockRejectedValue(new ApiError({
      code: 'BROWSER_SESSION_UNAVAILABLE', status: 503,
      detail: 'The login browser is unavailable. Open a new session to continue.',
    }, 503))
    const user = userEvent.setup()
    renderSiteClonePage('/app/clone/clone-1')

    await user.click(await screen.findByRole('button', { name: 'Mở phiên đăng nhập' }))
    await screen.findByRole('heading', { name: 'Trình duyệt đăng nhập tạm thời' })
    await user.click(screen.getByRole('button', { name: 'Enter' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('Phiên trình duyệt đã đóng')
    expect(screen.queryByRole('heading', { name: 'Trình duyệt đăng nhập tạm thời' })).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Mở phiên đăng nhập' }))
    expect(startBrowser).toHaveBeenCalledTimes(2)
  })

  it('chỉ yêu cầu URL và tự tạo workflow scan nội bộ', async () => {
    const clone = siteClone()
    vi.spyOn(webLensService, 'listSiteClones').mockResolvedValue(siteClonePage([]))
    vi.spyOn(webLensService, 'getSiteClone').mockResolvedValue(clone)
    const start = vi.spyOn(webLensService, 'startSiteClone').mockResolvedValue(clone)
    const user = userEvent.setup()
    renderSiteClonePage()

    await user.type(screen.getByLabelText('URL gốc'), 'https://example.com')
    await user.click(screen.getByRole('button', { name: /Scan và clone/i }))

    expect(start).toHaveBeenCalledWith('https://example.com', expect.any(String))
    expect(await screen.findByText('https://example.com/')).toBeInTheDocument()
    expect(screen.getByText('scan-internal-1')).toBeInTheDocument()
    expect(screen.queryByLabelText(/scan id/i)).not.toBeInTheDocument()
  })

  it('không gửi request khi URL không hợp lệ', async () => {
    vi.spyOn(webLensService, 'listSiteClones').mockResolvedValue(siteClonePage([]))
    const start = vi.spyOn(webLensService, 'startSiteClone')
    const user = userEvent.setup()
    renderSiteClonePage()

    await user.type(screen.getByLabelText('URL gốc'), 'file:///etc/passwd')
    await user.click(screen.getByRole('button', { name: /Scan và clone/i }))

    expect(start).not.toHaveBeenCalled()
    expect(await screen.findByRole('alert')).toBeInTheDocument()
  })

  it('hiển thị lại workflow owner-scoped từ URL sau khi tải lại trang', async () => {
    const clone = { ...siteClone(), id: 'clone-vietnam-airlines', targetUrl: 'https://www.vietnamairlines.com/no/vi', status: 'RUNNING' as const, discoveredCount: 11935, processedCount: 993, succeededCount: 993 }
    vi.spyOn(webLensService, 'listSiteClones').mockResolvedValue(siteClonePage([clone]))
    const get = vi.spyOn(webLensService, 'getSiteClone').mockResolvedValue(clone)

    renderSiteClonePage('/app/clone/clone-vietnam-airlines')

    expect(await screen.findByRole('heading', { name: 'Clone của bạn' })).toBeInTheDocument()
    expect(await screen.findAllByText(clone.targetUrl)).not.toHaveLength(0)
    expect(screen.getByText(/11[,.]935 URL khám phá · 993 ứng viên đã render/)).toBeInTheDocument()
    expect(get).toHaveBeenCalledWith('clone-vietnam-airlines')
  })
})

function renderSiteClonePage(initialEntry = '/app/clone') {
  return render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <Routes>
        <Route path="/app/clone" element={<SiteClonePage />} />
        <Route path="/app/clone/:siteCloneId" element={<SiteClonePage />} />
      </Routes>
    </MemoryRouter>,
  )
}

function siteClonePage(items: SiteClone[]) {
  return { items, page: 0, size: 20, totalItems: items.length, totalPages: items.length === 0 ? 0 : 1 }
}

function siteClone(): SiteClone {
  return {
    id: 'clone-1',
    websiteId: 'website-1',
    scanId: 'scan-internal-1',
    targetUrl: 'https://example.com/',
    status: 'WAITING_FOR_SCAN',
    discoveredCount: 0,
    processedCount: 0,
    succeededCount: 0,
    failedCount: 0,
    artifactCount: 0,
    totalArchiveBytes: 0,
    createdAt: '18/09/2026, 07:00',
    artifacts: [],
  }
}

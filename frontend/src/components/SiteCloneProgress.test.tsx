import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { webLensService } from '../api/webLensApiService'
import type { SiteClone, SiteCloneProgress as Progress } from '../domain/types'
import { SiteCloneProgress } from './SiteCloneProgress'

const clone: SiteClone = { id: 'clone-1', scanId: 'scan-1', websiteId: 'site-1', targetUrl: 'https://example.com/',
  status: 'RUNNING', discoveredCount: 10, processedCount: 4, succeededCount: 3, failedCount: 1,
  artifactCount: 0, totalArchiveBytes: 0, artifacts: [], createdAt: '2026-09-21T06:00:00Z' }
const item = { pageId: 'page-1', ordinal: 0, url: 'https://example.com/active', status: 'RENDERING' as const,
  attemptCount: 2, failureCode: 'PAGE_LEASE_EXPIRED', startedAt: '2026-09-21T06:00:00Z', finishedAt: null,
  updatedAt: '2026-09-21T06:02:00Z', retryAt: '2026-09-21T06:00:00Z', leaseExpired: true }
const progress: Progress = { available: true, jobId: clone.id, scanId: clone.scanId, correlationId: 'trace-1',
  phase: 'RUNNING', ingestionComplete: true, observedAt: '2026-09-21T06:03:00Z', updatedAt: '2026-09-21T06:02:00Z',
  startedAt: '2026-09-21T06:00:00Z', finishedAt: null, phaseAttemptCount: 0, phaseRetryAt: null,
  phaseLeaseExpired: false, terminalCode: null,
  counts: { QUEUED: 3, RENDERING: 1, SUCCEEDED: 3, FAILED: 1, CANCELLED: 2 },
  activePages: [item], items: [item], nextAfter: 0 }

describe('SiteCloneProgress', () => {
  afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers() })

  it('uses candidate totals, exposes current pages, paginates and resets cursor on filtering', async () => {
    const get = vi.spyOn(webLensService, 'getSiteCloneProgress').mockResolvedValue(progress)
    const user = userEvent.setup()
    render(<MemoryRouter><SiteCloneProgress clone={clone} /></MemoryRouter>)
    expect(await screen.findByRole('progressbar')).toHaveAttribute('value', '50')
    expect(screen.getByText('4 / 8 ứng viên · 2 URL bị loại/hủy')).toBeInTheDocument()
    expect(screen.getByText(/100% render không có nghĩa/)).toBeInTheDocument()
    expect(screen.getByText(/Lease hết hạn, chờ tiếp quản/)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Trang tiếp' }))
    await waitFor(() => expect(get).toHaveBeenLastCalledWith('clone-1', { after: 0, status: 'ALL', q: '' }))
    await user.selectOptions(screen.getByLabelText('Trạng thái trang render'), 'FAILED')
    await waitFor(() => expect(get).toHaveBeenLastCalledWith('clone-1', { after: -1, status: 'FAILED', q: '' }))
    await user.click(screen.getByText('Tra log và thông tin chẩn đoán'))
    await user.click(screen.getByRole('button', { name: 'Sao chép chẩn đoán job' }))
    const copied = await navigator.clipboard.readText()
    expect(JSON.parse(copied)).toMatchObject({ siteCloneRequestId: 'clone-1', scanId: 'scan-1', correlationId: 'trace-1' })
    expect(copied).not.toContain('https://')
  })

  it('keeps a partial job explicit even after render reaches 100 percent', async () => {
    vi.spyOn(webLensService, 'getSiteCloneProgress').mockResolvedValue({ ...progress, phase: 'PARTIAL',
      counts: { SUCCEEDED: 3, FAILED: 1, CANCELLED: 6 }, activePages: [], items: [], nextAfter: null })
    render(<MemoryRouter><SiteCloneProgress clone={{ ...clone, status: 'PARTIAL' }} /></MemoryRouter>)
    expect(await screen.findByRole('progressbar')).toHaveAttribute('value', '100')
    expect(screen.getByRole('heading', { name: 'Đã xuất bản một phần' })).toBeInTheDocument()
    expect(screen.getByText(/không suy ra thành công từ phần trăm/)).toBeInTheDocument()
  })

  it('does not fabricate progress before ingestion or when the endpoint fails', async () => {
    vi.spyOn(webLensService, 'getSiteCloneProgress').mockRejectedValue(new Error('Worker unavailable'))
    render(<MemoryRouter><SiteCloneProgress clone={clone} /></MemoryRouter>)
    expect(await screen.findByRole('alert')).toHaveTextContent('Không cập nhật được tiến độ')
    expect(screen.getByRole('progressbar')).not.toHaveAttribute('value')
    expect(within(screen.getByRole('table')).queryAllByRole('row')).toHaveLength(1)
  })

  it('retains the last snapshot with an explicit stale warning when polling fails', async () => {
    vi.useFakeTimers()
    const get = vi.spyOn(webLensService, 'getSiteCloneProgress').mockResolvedValueOnce(progress)
      .mockRejectedValue(new Error('Connection lost'))
    await act(async () => { render(<MemoryRouter><SiteCloneProgress clone={clone} /></MemoryRouter>) })
    expect(screen.getByRole('progressbar')).toHaveAttribute('value', '50')
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000) })
    expect(get).toHaveBeenCalledTimes(2)
    expect(screen.getByRole('alert')).toHaveTextContent('Đang giữ bản chụp cũ')
    expect(screen.getByRole('progressbar')).toHaveAttribute('value', '50')
  })
})

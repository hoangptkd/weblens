import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { webLensService } from '../api/webLensApiService'
import { WebsiteDetailPage } from './WebsiteDetailPage'

describe('WebsiteDetailPage', () => {
  afterEach(() => vi.restoreAllMocks())

  it('phân trang lịch sử scan bằng backend', async () => {
    vi.spyOn(webLensService, 'getWebsite').mockResolvedValue({ id: 'site-1', name: 'Example', url: 'https://example.com/', hostname: 'example.com', updatedAt: '17/09/2026', pageCount: 100, failedPageCount: 4 })
    const scans = vi.spyOn(webLensService, 'listScans').mockImplementation(async (_websiteId, { page, size }) => ({
      items: [{ id: `scan-${page}`, websiteId: 'site-1', status: 'COMPLETED', createdAt: '17/09/2026', duration: '00:10', progress: { discovered: 10, queued: 0, processed: 10, succeeded: 9, failed: 1, limit: 100000 } }],
      page,
      size,
      totalItems: 21,
      totalPages: 2,
    }))

    render(<MemoryRouter initialEntries={['/app/websites/site-1']}><Routes><Route path="/app/websites/:websiteId" element={<WebsiteDetailPage />} /></Routes></MemoryRouter>)

    expect(await screen.findByText('#scan-0')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Trang tiếp theo' }))
    expect(await screen.findByText('#scan-1')).toBeInTheDocument()
    expect(scans).toHaveBeenLastCalledWith('site-1', {
      page: 1,
      size: 20,
      statuses: undefined,
      sort: 'createdAt,desc',
    })
  })
})

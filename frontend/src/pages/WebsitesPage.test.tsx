import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { webLensService } from '../api/webLensApiService'
import { WebsitesPage } from './WebsitesPage'

describe('WebsitesPage', () => {
  afterEach(() => vi.restoreAllMocks())

  it('hiển thị KPI thật và yêu cầu trang tiếp theo từ backend', async () => {
    vi.spyOn(webLensService, 'getDashboardSummary').mockResolvedValue({
      activeWebsites: 21,
      scansLast30Days: 42,
      activeScans: 3,
      processedPages: 100,
      succeededPages: 95,
      failedPages: 5,
    })
    const list = vi.spyOn(webLensService, 'listWebsites').mockImplementation(async ({ page, size }) => ({
      items: [{ id: `site-${page}`, name: `Website trang ${page + 1}`, url: `https://page-${page}.example/`, hostname: `page-${page}.example`, updatedAt: '17/09/2026', pageCount: 10, failedPageCount: 1 }],
      page,
      size,
      totalItems: 21,
      totalPages: 2,
    }))

    render(<MemoryRouter><WebsitesPage /></MemoryRouter>)

    expect(await screen.findByText('95%')).toBeInTheDocument()
    expect(screen.getByText('Website trang 1')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Trang tiếp theo' }))
    expect(await screen.findByText('Website trang 2')).toBeInTheDocument()
    expect(list).toHaveBeenLastCalledWith({
      page: 1,
      size: 20,
      q: undefined,
      statuses: ['ACTIVE'],
      sort: 'updatedAt,desc',
    })
  })
})

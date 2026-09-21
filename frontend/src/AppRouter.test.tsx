import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { authApi } from './api/authApi'
import { webLensService } from './api/webLensApiService'
import { AppRouter } from './AppRouter'

describe('AppRouter', () => {
  afterEach(() => vi.restoreAllMocks())

  it('renders the website dashboard route', async () => {
    vi.spyOn(authApi, 'restore').mockResolvedValue({ id: 'user-1', email: 'owner@example.com', displayName: 'Owner', status: 'ACTIVE' })
    vi.spyOn(webLensService, 'getDashboardSummary').mockResolvedValue({ activeWebsites: 1, scansLast30Days: 2, activeScans: 0, processedPages: 10, succeededPages: 9, failedPages: 1 })
    vi.spyOn(webLensService, 'listWebsites').mockResolvedValue({
      items: [{ id: 'site-1', name: 'Production Website', url: 'https://example.com/', hostname: 'example.com', latestStatus: 'COMPLETED', updatedAt: '17/09/2026', pageCount: 10, failedPageCount: 1 }],
      page: 0,
      size: 20,
      totalItems: 1,
      totalPages: 1,
    })
    render(<MemoryRouter initialEntries={['/app/websites']}><AppRouter /></MemoryRouter>)
    expect(await screen.findByRole('heading', { name: 'Websites' })).toBeInTheDocument()
    expect(await screen.findByText('Production Website')).toBeInTheDocument()
  })

  it('renders a branded not-found page', () => {
    render(<MemoryRouter initialEntries={['/not-real']}><AppRouter /></MemoryRouter>)
    expect(screen.getByRole('heading', { name: /ngoài frontier/i })).toBeInTheDocument()
  })
})

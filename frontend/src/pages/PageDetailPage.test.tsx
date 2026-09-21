import { render, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { webLensService } from '../api/webLensApiService'
import type { Capture } from '../domain/types'
import { scanPages } from '../test/fixtures'
import { PageDetailPage } from './PageDetailPage'

describe('PageDetailPage', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('liên kết tới capture hoàn tất mới nhất từ API', async () => {
    const page = scanPages[0]
    const latestCapture: Capture = {
      id: '6132a7d3-591e-481a-8131-628d5401068a',
      scanId: page.scanId,
      pageId: page.id,
      status: 'COMPLETED',
      targetUrl: page.url,
      measurementProfile: 'desktop-lab-v1',
      analyticsExpectedCount: 1,
      analyticsPublishedCount: 1,
      objectCount: 2,
      totalObjectBytes: 17_739,
      createdAt: 'Vừa xong',
    }
    vi.spyOn(webLensService, 'getScanPage').mockResolvedValue(page)
    vi.spyOn(webLensService, 'getLatestCapture').mockResolvedValue(latestCapture)

    render(
      <MemoryRouter initialEntries={[`/app/pages/${page.id}`]}>
        <Routes>
          <Route path="/app/pages/:scanPageId" element={<PageDetailPage />} />
        </Routes>
      </MemoryRouter>,
    )

    const link = await screen.findByRole('link', { name: /Xem snapshot gần nhất/i })
    expect(link).toHaveAttribute('href', `/app/snapshots/${latestCapture.id}`)
    expect(link).not.toHaveAttribute('href', '/app/snapshots/snapshot-1')
  })

  it('không cho tạo capture khi crawl trang thất bại', async () => {
    const page = { ...scanPages[0], outcome: 'failed' as const, statusCode: undefined }
    vi.spyOn(webLensService, 'getScanPage').mockResolvedValue(page)
    vi.spyOn(webLensService, 'getLatestCapture').mockResolvedValue(null)

    render(
      <MemoryRouter initialEntries={[`/app/pages/${page.id}`]}>
        <Routes>
          <Route path="/app/pages/:scanPageId" element={<PageDetailPage />} />
        </Routes>
      </MemoryRouter>,
    )

    expect(await screen.findByRole('button', { name: 'Trang không đủ điều kiện capture' })).toBeDisabled()
  })

  it('phân biệt kết quả cần chú ý với thông tin và nêu giới hạn HTML tĩnh', async () => {
    const page = {
      ...scanPages[0],
      findings: [
        { id: 'warning', severity: 'warning' as const, title: 'Cảnh báo', description: 'Cần kiểm tra', evidence: '{}' },
        { id: 'info', severity: 'info' as const, title: 'Thông tin', description: 'Tham khảo', evidence: '{}' },
      ],
    }
    vi.spyOn(webLensService, 'getScanPage').mockResolvedValue(page)
    vi.spyOn(webLensService, 'getLatestCapture').mockResolvedValue(null)

    render(
      <MemoryRouter initialEntries={[`/app/pages/${page.id}`]}>
        <Routes>
          <Route path="/app/pages/:scanPageId" element={<PageDetailPage />} />
        </Routes>
      </MemoryRouter>,
    )

    expect(await screen.findByText('1 cần chú ý · 1 thông tin')).toBeInTheDocument()
    expect(screen.getByText(/Rule nội dung dùng HTML tĩnh/)).toBeInTheDocument()
    expect(screen.getByText('Kích thước response đã thu thập')).toBeInTheDocument()
  })
})

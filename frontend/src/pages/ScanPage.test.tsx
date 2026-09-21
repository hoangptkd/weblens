import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { webLensService } from '../api/webLensApiService'
import { ScanPage } from './ScanPage'

describe('ScanPage', () => {
  afterEach(() => vi.restoreAllMocks())

  it('dùng cursor của backend khi duyệt page evidence', async () => {
    vi.spyOn(webLensService, 'getScan').mockResolvedValue({
      id: 'scan-1',
      websiteId: 'site-1',
      status: 'COMPLETED',
      createdAt: '17/09/2026',
      duration: '00:10',
      progress: { discovered: 2, queued: 0, processed: 2, succeeded: 2, failed: 0, limit: 100000 },
    })
    const pages = vi.spyOn(webLensService, 'listScanPages').mockImplementation(async (_scanId, cursor, _limit, filters) => ({
      items: [{
        id: cursor ? 'page-2' : 'page-1',
        scanId: 'scan-1',
        path: cursor ? '/second' : '/first',
        url: cursor ? 'https://example.com/second' : 'https://example.com/first',
        statusCode: 200,
        outcome: filters?.issuesOnly ? 'warning' : 'success',
        links: 0,
        images: 0,
        scripts: 0,
        stylesheets: 0,
        findings: filters?.issuesOnly ? [{ id: 'finding-1', severity: 'warning', title: 'Issue', description: 'Issue', evidence: '{}' }] : [],
      }],
      summary: {
        totalUrlCount: 245,
        issuePageCount: 17,
        findingCount: 23,
        status2xxCount: 220,
        status3xxCount: 5,
        status4xxCount: 10,
        status5xxCount: 3,
        noResponseCount: 7,
      },
      analyticsExpectedCount: 2,
      analyticsPublishedCount: 2,
      analyticsWatermark: '17/09/2026',
      fresh: true,
      nextCursor: cursor ? undefined : 'cursor-2',
    }))

    render(<MemoryRouter initialEntries={['/app/scans/scan-1']}><Routes><Route path="/app/scans/:scanId" element={<ScanPage />} /></Routes></MemoryRouter>)

    expect(await screen.findByText('245 URL')).toBeInTheDocument()
    await userEvent.click(await screen.findByRole('tab', { name: /Trang 245/i }))
    expect(await screen.findByText('/first')).toBeInTheDocument()
    expect(screen.getByText('Trang dữ liệu 1 · hiển thị 1 trong tổng số 245')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Trang tiếp theo' }))
    expect(await screen.findByText('/second')).toBeInTheDocument()
    expect(pages).toHaveBeenLastCalledWith('scan-1', 'cursor-2', 100, {
      issuesOnly: false,
      outcomes: undefined,
      q: undefined,
      indexable: undefined,
    })

    await userEvent.click(screen.getByRole('button', { name: 'Trang trước' }))
    expect(await screen.findByText('/first')).toBeInTheDocument()
    expect(pages).toHaveBeenLastCalledWith('scan-1', undefined, 100, {
      issuesOnly: false,
      outcomes: undefined,
      q: undefined,
      indexable: undefined,
    })

    await userEvent.click(screen.getByRole('tab', { name: /Trang cần chú ý 17/i }))
    expect(await screen.findByText('17 trang cần chú ý · 23 kết quả kiểm tra')).toBeInTheDocument()
    expect(screen.getByText('Trang dữ liệu 1 · hiển thị 1 trong tổng số 17')).toBeInTheDocument()
    expect(pages).toHaveBeenLastCalledWith('scan-1', undefined, 100, {
      issuesOnly: true,
      outcomes: undefined,
      q: undefined,
      indexable: undefined,
    })
  })
})

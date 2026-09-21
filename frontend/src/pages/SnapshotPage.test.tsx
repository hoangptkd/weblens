import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { webLensService } from '../api/webLensApiService'
import { snapshot } from '../test/fixtures'
import { SnapshotPage } from './SnapshotPage'

describe('SnapshotPage', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('tải screenshot qua API có xác thực và chỉ render dưới dạng ảnh tĩnh', async () => {
    vi.spyOn(webLensService, 'getSnapshot').mockResolvedValue({
      ...snapshot,
      artifacts: { renderedHtmlBytes: 1200, screenshotBytes: 4 },
    })
    vi.spyOn(webLensService, 'getCaptureScreenshot').mockResolvedValue(new Blob(
      [new Uint8Array([0xff, 0xd8, 0xff, 0xd9])],
      { type: 'image/jpeg' },
    ))
    const createObjectUrl = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:weblens-screenshot')
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined)

    render(
      <MemoryRouter initialEntries={['/app/snapshots/snapshot-1']}>
        <Routes>
          <Route path="/app/snapshots/:snapshotId" element={<SnapshotPage />} />
        </Routes>
      </MemoryRouter>,
    )

    const image = await screen.findByRole('img', { name: /Screenshot của https:\/\/evomi.com\//i })
    expect(image).toHaveAttribute('src', 'blob:weblens-screenshot')
    expect(createObjectUrl).toHaveBeenCalledOnce()
    expect(webLensService.getCaptureScreenshot).toHaveBeenCalledWith('snapshot-1')
    expect(screen.getByText(/không thực thi website/i)).toBeInTheDocument()
    expect(document.querySelector('iframe')).not.toBeInTheDocument()
  })

  it('hiển thị metadata body và tải resource dưới dạng file qua API có xác thực', async () => {
    const captured = snapshot.resources.find((resource) => resource.bodyCaptured)
    expect(captured?.capturedBodyId).toBeTruthy()
    vi.spyOn(webLensService, 'getSnapshot').mockResolvedValue({
      ...snapshot,
      artifacts: { renderedHtmlBytes: 1200, screenshotBytes: 0 },
      resources: captured ? [captured] : [],
    })
    vi.spyOn(webLensService, 'getCapturedResource').mockResolvedValue(new Blob(
      [new TextEncoder().encode('untrusted resource body')],
      { type: 'application/octet-stream' },
    ))
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:weblens-resource')
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined)
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined)

    render(
      <MemoryRouter initialEntries={['/app/snapshots/snapshot-1']}>
        <Routes>
          <Route path="/app/snapshots/:snapshotId" element={<SnapshotPage />} />
        </Routes>
      </MemoryRouter>,
    )

    expect(await screen.findByText('Đã lưu', { selector: 'strong' })).toBeInTheDocument()
    expect(screen.getByText(/SHA-256/i)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /Tải body/i }))

    await waitFor(() => {
      expect(webLensService.getCapturedResource).toHaveBeenCalledWith('snapshot-1', captured?.capturedBodyId)
      expect(click).toHaveBeenCalledOnce()
    })
    expect(document.querySelector('iframe')).not.toBeInTheDocument()
    expect(document.querySelector('script')).not.toBeInTheDocument()
  })

  it('hiển thị trạng thái reconstruction và chỉ tải clone dưới dạng ZIP', async () => {
    vi.spyOn(webLensService, 'getSnapshot').mockResolvedValue({
      ...snapshot,
      artifacts: { renderedHtmlBytes: 1200, screenshotBytes: 0 },
    })
    vi.spyOn(webLensService, 'getReconstructionArchive').mockResolvedValue(new Blob(
      [new TextEncoder().encode('PK-static-clone')],
      { type: 'application/zip' },
    ))
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:weblens-static-clone')
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined)
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined)

    render(
      <MemoryRouter initialEntries={['/app/snapshots/snapshot-1']}>
        <Routes>
          <Route path="/app/snapshots/:snapshotId" element={<SnapshotPage />} />
        </Routes>
      </MemoryRouter>,
    )

    expect(await screen.findByText(/Bản clone tĩnh một trang/i)).toBeInTheDocument()
    expect(screen.getByText(/Hoàn tất một phần · 5 file đã đóng gói/i)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /Tải bản clone/i }))

    await waitFor(() => {
      expect(webLensService.getReconstructionArchive).toHaveBeenCalledWith('reconstruction-1')
      expect(click).toHaveBeenCalledOnce()
    })
    expect(document.querySelector('iframe')).not.toBeInTheDocument()
  })
})

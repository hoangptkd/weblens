import {
  AlertTriangle,
  ArrowLeft,
  Braces,
  Camera,
  Check,
  ChevronDown,
  Clock3,
  Download,
  FileCode2,
  Filter,
  Image,
  LoaderCircle,
  Network,
  Search,
  ShieldCheck,
} from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { webLensService } from '../api/webLensApiService'
import { ErrorState, LoadingState } from '../components/StateView'
import type { CapturedResource } from '../domain/types'
import { useAsyncData } from '../hooks/useAsyncData'
import { formatBytes } from '../utils/validation'

export function SnapshotPage() {
  const { snapshotId = '' } = useParams()
  const { data: snapshot, error, loading } = useAsyncData(
    () => webLensService.getSnapshot(snapshotId),
    `snapshot:${snapshotId}`,
  )
  const [query, setQuery] = useState('')
  const [type, setType] = useState('all')
  const [screenshotResult, setScreenshotResult] = useState<{
    snapshotId: string
    url: string | null
    error: string | null
  } | null>(null)
  const [downloadingResourceId, setDownloadingResourceId] = useState<string | null>(null)
  const [resourceDownloadError, setResourceDownloadError] = useState<string | null>(null)
  const [cloneDownloading, setCloneDownloading] = useState(false)
  const [cloneDownloadError, setCloneDownloadError] = useState<string | null>(null)
  const filtered = useMemo(
    () => snapshot?.resources.filter((resource) => (
      (type === 'all' || resource.type === type)
      && resource.url.toLowerCase().includes(query.toLowerCase())
    )) ?? [],
    [query, snapshot, type],
  )
  const currentScreenshot = screenshotResult?.snapshotId === snapshotId ? screenshotResult : null
  const screenshotUrl = currentScreenshot?.url ?? null
  const screenshotError = currentScreenshot?.error ?? null
  const screenshotLoading = Boolean(snapshot?.artifacts?.screenshotBytes) && currentScreenshot === null

  useEffect(() => {
    if (!snapshot?.artifacts?.screenshotBytes) return undefined
    let active = true
    let objectUrl: string | null = null
    void webLensService.getCaptureScreenshot(snapshotId)
      .then((blob) => {
        if (!active) return
        if (blob.type && blob.type !== 'image/jpeg') {
          throw new Error('Screenshot không có định dạng JPEG hợp lệ.')
        }
        objectUrl = URL.createObjectURL(blob)
        setScreenshotResult({ snapshotId, url: objectUrl, error: null })
      })
      .catch((loadError: unknown) => {
        if (active) {
          setScreenshotResult({
            snapshotId,
            url: null,
            error: loadError instanceof Error ? loadError.message : 'Không thể tải screenshot.',
          })
        }
      })
    return () => {
      active = false
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    }
  }, [snapshot?.artifacts?.screenshotBytes, snapshotId])

  async function downloadResource(resource: CapturedResource) {
    if (!resource.capturedBodyId || downloadingResourceId) return
    setDownloadingResourceId(resource.capturedBodyId)
    setResourceDownloadError(null)
    try {
      const blob = await webLensService.getCapturedResource(snapshotId, resource.capturedBodyId)
      if (blob.type && blob.type !== 'application/octet-stream') {
        throw new Error('Resource body không có định dạng tải xuống an toàn.')
      }
      const objectUrl = URL.createObjectURL(blob)
      const anchor = document.createElement('a')
      anchor.href = objectUrl
      anchor.download = `weblens-resource-${resource.capturedBodyId}.bin`
      anchor.rel = 'noopener'
      document.body.append(anchor)
      anchor.click()
      anchor.remove()
      window.setTimeout(() => URL.revokeObjectURL(objectUrl), 0)
      setDownloadingResourceId(null)
    } catch (downloadError: unknown) {
      setDownloadingResourceId(null)
      setResourceDownloadError(
        downloadError instanceof Error ? downloadError.message : 'Không thể tải resource body.',
      )
    }
  }

  const metric = (name: 'lcp' | 'cls' | 'ttfb') => {
    const value = snapshot?.performance?.[name]
    if (!value || value.status === 'UNAVAILABLE' || value.value === null) {
      return value?.unavailableReason ?? 'Không đo được'
    }
    return `${name === 'cls' ? value.value.toFixed(3) : Math.round(value.value)} ${
      value.unit === 'score' ? '' : value.unit
    }`.trim()
  }

  const downloadClone = async () => {
    if (!snapshot?.reconstruction?.downloadAvailable || cloneDownloading) return
    setCloneDownloading(true)
    setCloneDownloadError(null)
    try {
      const blob = await webLensService.getReconstructionArchive(snapshot.reconstruction.id)
      if (blob.type && blob.type !== 'application/zip') throw new Error('Archive không có định dạng ZIP hợp lệ.')
      const objectUrl = URL.createObjectURL(blob)
      const anchor = document.createElement('a')
      anchor.href = objectUrl
      anchor.download = 'weblens-static-clone.zip'
      anchor.rel = 'noopener'
      document.body.append(anchor)
      anchor.click()
      anchor.remove()
      window.setTimeout(() => URL.revokeObjectURL(objectUrl), 0)
    } catch (downloadError) {
      setCloneDownloadError(downloadError instanceof Error ? downloadError.message : 'Không thể tải bản clone.')
    } finally {
      setCloneDownloading(false)
    }
  }

  if (loading) return <div className="app-page"><LoadingState label="Đang tải snapshot…" /></div>
  if (error || !snapshot) return <div className="app-page"><ErrorState title="Không tìm thấy snapshot" /></div>

  return (
    <div className="app-page">
      <Link className="back-link" to={`/app/pages/${snapshot.scanPageId}`}><ArrowLeft />Page evidence /</Link>
      <header className="page-header">
        <div>
          <span className="page-kicker">PAGE SNAPSHOT · V1.5</span>
          <h1>Rendered capture</h1>
          <p>{snapshot.finalUrl} · {snapshot.createdAt}</p>
        </div>
        <span className="capture-complete"><Check />{snapshot.status === 'PARTIAL_SUCCESS' ? 'Hoàn tất một phần' : 'Capture hoàn tất'}</span>
      </header>

      <section className="snapshot-stats">
        <div><Camera /><span><small>VIEWPORT</small><strong>{snapshot.viewport}</strong></span></div>
        <div><Network /><span><small>NETWORK REQUEST</small><strong>{snapshot.resourceCount}</strong></span></div>
        <div><FileCode2 /><span><small>BODY ĐƯỢC LƯU</small><strong>{snapshot.capturedResourceCount ?? 0}</strong></span></div>
        <div><ShieldCheck /><span><small>PROFILE</small><strong>{snapshot.measurementProfile ?? 'desktop-lab-v1'}</strong></span></div>
      </section>
      <section className="snapshot-stats">
        <div><Clock3 /><span><small>LCP LAB</small><strong>{metric('lcp')}</strong></span></div>
        <div><Clock3 /><span><small>CLS LAB</small><strong>{metric('cls')}</strong></span></div>
        <div><Clock3 /><span><small>TTFB LAB</small><strong>{metric('ttfb')}</strong></span></div>
        <div><Braces /><span><small>CHROMIUM</small><strong>{snapshot.browserVersion ?? 'Không xác định'}</strong></span></div>
      </section>

      <section className="content-card reconstruction-card" aria-labelledby="reconstruction-title">
        <div className="reconstruction-copy">
          <span className="page-kicker">PAGESOURCE STATIC CLONE</span>
          <h2 id="reconstruction-title">Bản clone tĩnh một trang</h2>
          {snapshot.reconstruction
            ? (
              <p>
                {cloneStatus(snapshot.reconstruction.status)} · {snapshot.reconstruction.packagedCount} file đã đóng gói
                · {snapshot.reconstruction.skippedCount} file bỏ qua
                {snapshot.reconstruction.archiveBytes ? ` · ${formatBytes(snapshot.reconstruction.archiveBytes)}` : ''}
              </p>
            )
            : <p>Capture này được tạo trước khi tính năng clone tĩnh được bật.</p>}
          {snapshot.reconstruction?.completenessCode
            ? <small>Mức đầy đủ: {snapshot.reconstruction.completenessCode}</small>
            : null}
          {snapshot.reconstruction?.failureCode
            ? <small className="reconstruction-error">Lỗi: {snapshot.reconstruction.failureCode}</small>
            : null}
          {cloneDownloadError ? <small className="reconstruction-error" role="alert">{cloneDownloadError}</small> : null}
        </div>
        <button
          className="primary-action reconstruction-download"
          type="button"
          disabled={!snapshot.reconstruction?.downloadAvailable || cloneDownloading}
          onClick={() => void downloadClone()}
        >
          {cloneDownloading ? <LoaderCircle className="spin" /> : <Download />}
          {cloneDownloading ? 'Đang tải…' : 'Tải bản clone'}
        </button>
        <p className="reconstruction-safety">ZIP chỉ để tải xuống; WebLens không preview hoặc chạy HTML/JavaScript bên trong.</p>
      </section>

      <div className="snapshot-layout">
        <section className="snapshot-preview">
          <div className="preview-toolbar">
            <span className="window-dots"><i /><i /><i /></span>
            <span>{snapshot.finalUrl}</span>
            <span>{snapshot.viewport}</span>
          </div>
          <div className="captured-site captured-site--artifact">
            {screenshotUrl
              ? <img className="capture-screenshot" src={screenshotUrl} alt={`Screenshot của ${snapshot.finalUrl}`} />
              : (
                <div className={`screenshot-state${screenshotError ? ' screenshot-state--error' : ''}`}>
                  {screenshotLoading ? <LoaderCircle className="spin" /> : <AlertTriangle />}
                  <strong>{screenshotLoading ? 'Đang tải screenshot…' : 'Không thể hiển thị screenshot'}</strong>
                  {screenshotError ? <small>{screenshotError}</small> : null}
                </div>
              )}
            <div className="snapshot-watermark"><Camera />Ảnh capture tĩnh · không thực thi website</div>
          </div>
        </section>
        <aside className="snapshot-inspector">
          <div className="inspector-tabs"><button className="active" type="button">Tóm tắt</button><button type="button" disabled>DOM</button></div>
          <div className="inspector-body">
            <span className="page-kicker">CAPTURE METADATA</span>
            <dl>
              <div><dt>Trạng thái</dt><dd><span className="ok-dot" />{snapshot.status}</dd></div>
              <div><dt>Final URL</dt><dd>{snapshot.finalUrl}</dd></div>
              <div><dt>Rendered title</dt><dd>{snapshot.rendered?.title || 'Không có'}</dd></div>
              <div><dt>Canonical</dt><dd>{snapshot.rendered?.canonicalUrl || 'Không có'}</dd></div>
              <div><dt>Schema.org</dt><dd>{snapshot.rendered?.schemaOrgTypes.join(', ') || 'Không phát hiện'}</dd></div>
              <div><dt>HTML sau render</dt><dd>{snapshot.artifacts ? formatBytes(snapshot.artifacts.renderedHtmlBytes) : 'Không có'}</dd></div>
              <div><dt>Screenshot</dt><dd>{snapshot.artifacts ? `${formatBytes(snapshot.artifacts.screenshotBytes)} · JPEG` : 'Không có'}</dd></div>
            </dl>
            <div className="inspector-note">
              <Braces />
              <p><strong>Không thực thi nội dung capture</strong>DOM, JavaScript và resource body chỉ được xem như dữ liệu không tin cậy.</p>
            </div>
          </div>
        </aside>
      </div>

      <section className="content-card evidence-details">
        <div className="card-toolbar"><div><h2>Khác biệt static / rendered</h2><span>Hai observation ở hai thời điểm riêng biệt</span></div></div>
        <dl>
          <div><dt>Title</dt><dd>{snapshot.diff?.titleChanged ? 'Đã thay đổi' : 'Không đổi'}</dd></div>
          <div><dt>Description</dt><dd>{snapshot.diff?.descriptionChanged ? 'Đã thay đổi' : 'Không đổi'}</dd></div>
          <div><dt>Canonical</dt><dd>{snapshot.diff?.canonicalChanged ? 'Đã thay đổi' : 'Không đổi'}</dd></div>
          <div><dt>H1</dt><dd>{snapshot.diff?.h1Changed ? 'Đã thay đổi' : 'Không đổi'}</dd></div>
          <div><dt>Liên kết / hình ảnh</dt><dd>{snapshot.diff ? `${signed(snapshot.diff.linkCountDelta)} link · ${signed(snapshot.diff.imageCountDelta)} image` : 'Không có diff'}</dd></div>
        </dl>
      </section>

      <section className="content-card resources-card">
        <div className="card-toolbar">
          <div><h2>Network resources</h2><span>{filtered.length} / {snapshot.resources.length} request đã quan sát</span></div>
          <div className="resource-filters">
            <label className="search-field">
              <span className="sr-only">Tìm tài nguyên</span><Search />
              <input placeholder="Tìm URL…" value={query} onChange={(event) => setQuery(event.target.value)} />
            </label>
            <label className="select-field">
              <Filter /><span className="sr-only">Loại tài nguyên</span>
              <select value={type} onChange={(event) => setType(event.target.value)}>
                <option value="all">Mọi loại</option>
                <option value="document">Document</option>
                <option value="stylesheet">CSS</option>
                <option value="script">Script</option>
                <option value="image">Image</option>
                <option value="font">Font</option>
                <option value="fetch">Fetch</option>
              </select>
              <ChevronDown />
            </label>
          </div>
        </div>
        {resourceDownloadError ? <div className="resource-download-error" role="alert">{resourceDownloadError}</div> : null}
        <div className="data-table-wrap">
          <table className="data-table resource-table">
            <thead><tr><th scope="col">Resource</th><th scope="col">Type</th><th scope="col">Status</th><th scope="col">Response</th><th scope="col">Body evidence</th><th scope="col">Duration</th><th scope="col">Tải</th></tr></thead>
            <tbody>
              {filtered.map((resource) => {
                const parsed = resourceLocation(resource.url)
                const downloading = downloadingResourceId === resource.capturedBodyId
                return (
                  <tr key={resource.id}>
                    <td>
                      <div className={`resource-type-icon ${resource.type}`}>
                        {resource.type === 'image' ? <Image /> : resource.type === 'script' ? <Braces /> : <FileCode2 />}
                      </div>
                      <span><strong>{parsed.path}</strong><small>{parsed.host}</small></span>
                    </td>
                    <td>{resource.type}</td>
                    <td><span className="http-ok">{resource.status || '—'}</span></td>
                    <td>{formatBytes(resource.sizeBytes)}</td>
                    <td>
                      {resource.bodyCaptured
                        ? (
                          <span className="body-evidence">
                            <strong>{resource.bodyTruncated ? 'Đã lưu một phần' : 'Đã lưu'}</strong>
                            <small>{formatBytes(resource.capturedBodyBytes)} · SHA-256 {shortHash(resource.bodySha256)}</small>
                          </span>
                        )
                        : <span className="body-not-captured">Không lưu body</span>}
                    </td>
                    <td>{resource.durationMs} ms</td>
                    <td>
                      <button
                        className="resource-download"
                        type="button"
                        disabled={!resource.bodyCaptured || !resource.capturedBodyId || Boolean(downloadingResourceId)}
                        onClick={() => void downloadResource(resource)}
                        aria-label={`Tải body ${parsed.path}`}
                      >
                        {downloading ? <LoaderCircle className="spin" /> : <Download />}
                      </button>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  )
}

function resourceLocation(rawUrl: string): { path: string; host: string } {
  try {
    const url = new URL(rawUrl)
    return { path: `${url.pathname || '/'}${url.search}`, host: url.hostname }
  } catch {
    return { path: 'URL không hợp lệ', host: '' }
  }
}

function signed(value: number): string {
  return value > 0 ? `+${value}` : String(value)
}

function shortHash(value: string | null): string {
  return value ? `${value.slice(0, 12)}…` : 'không có'
}

function cloneStatus(status: NonNullable<import('../domain/types').PageSnapshot['reconstruction']>['status']): string {
  const labels = {
    QUEUED: 'Đang chờ',
    RUNNING: 'Đang tạo',
    PUBLISHED: 'Hoàn chỉnh',
    PARTIAL: 'Hoàn tất một phần',
    FAILED: 'Tạo clone thất bại',
    EXPIRED: 'Đã hết hạn',
  } satisfies Record<typeof status, string>
  return labels[status]
}

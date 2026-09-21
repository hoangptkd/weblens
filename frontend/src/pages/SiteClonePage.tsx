import { Archive, ArrowRight, CircleStop, CloudCog, Download, FileJson2, Globe2, LoaderCircle, Play, Search, ShieldCheck } from 'lucide-react'
import { useState } from 'react'
import type { FormEvent } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { webLensService } from '../api/webLensApiService'
import { NumberPagination } from '../components/Pagination'
import { SiteCloneProgress } from '../components/SiteCloneProgress'
import { EmptyState, ErrorState, LoadingState } from '../components/StateView'
import type { SiteClone } from '../domain/types'
import { useAsyncData } from '../hooks/useAsyncData'
import { validatePublicUrl } from '../utils/validation'

const terminal = new Set(['PUBLISHED', 'PARTIAL', 'FAILED', 'CANCELLED', 'EXPIRED'])

export function SiteClonePage() {
  const { siteCloneId } = useParams()
  const navigate = useNavigate()
  const [url, setUrl] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [downloading, setDownloading] = useState<string | null>(null)
  const [historyPage, setHistoryPage] = useState(0)
  const [historyPageSize, setHistoryPageSize] = useState(20)
  const [historyQuery, setHistoryQuery] = useState('')
  const [historyStatus, setHistoryStatus] = useState<SiteClone['status'] | 'ALL'>('ALL')
  const [historySort, setHistorySort] = useState('createdAt,desc')
  const [historyReloadKey, setHistoryReloadKey] = useState(0)
  const [detailReloadKey, setDetailReloadKey] = useState(0)
  const [cancellingId, setCancellingId] = useState<string | null>(null)
  const historyState = useAsyncData(
    () => webLensService.listSiteClones({
      page: historyPage,
      size: historyPageSize,
      q: historyQuery || undefined,
      statuses: historyStatus === 'ALL' ? undefined : [historyStatus],
      sort: historySort,
    }),
    `site-clones:${historyPage}:${historyPageSize}:${historyQuery}:${historyStatus}:${historySort}:${historyReloadKey}`,
    {
      pollIntervalMs: 5_000,
      shouldPoll: (history) => history.items.some((clone) => !terminal.has(clone.status)),
    },
  )
  const detailState = useAsyncData(
    () => siteCloneId ? webLensService.getSiteClone(siteCloneId) : Promise.resolve(null),
    `site-clone:${siteCloneId ?? 'none'}:${detailReloadKey}`,
    {
      pollIntervalMs: 2_000,
      shouldPoll: (clone) => clone !== null && !terminal.has(clone.status),
    },
  )
  const siteClone = detailState.data
  const history = historyState.data
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const validation = validatePublicUrl(url)
    setError(validation)
    if (validation) return
    setSubmitting(true)
    try {
      const clone = await webLensService.startSiteClone(url, crypto.randomUUID())
      setHistoryPage(0)
      setHistoryReloadKey((value) => value + 1)
      navigate(`/app/clone/${clone.id}`)
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Không thể bắt đầu clone website.')
    } finally {
      setSubmitting(false)
    }
  }

  async function cancel(siteCloneToCancel: SiteClone) {
    setCancellingId(siteCloneToCancel.id)
    setError(null)
    try {
      await webLensService.cancelSiteClone(siteCloneToCancel.id)
      setHistoryReloadKey((value) => value + 1)
      if (siteCloneToCancel.id === siteCloneId) setDetailReloadKey((value) => value + 1)
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Không thể hủy tác vụ clone.')
    } finally {
      setCancellingId(null)
    }
  }

  async function download(artifactId: string, filename: string) {
    if (!siteClone) return
    setDownloading(artifactId)
    try {
      const blob = await webLensService.getSiteCloneArtifact(siteClone.id, artifactId)
      const objectUrl = URL.createObjectURL(blob)
      const anchor = document.createElement('a')
      anchor.href = objectUrl
      anchor.download = filename
      anchor.click()
      URL.revokeObjectURL(objectUrl)
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Không thể tải artifact.')
    } finally {
      setDownloading(null)
    }
  }

  function applyHistoryFilters(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setHistoryQuery(String(new FormData(event.currentTarget).get('q') ?? '').trim())
    setHistoryPage(0)
  }

  return (
    <div className="app-page clone-page">
      <header className="page-header">
        <div><span className="page-kicker">PAGESOURCE · PLAYWRIGHT</span><h1>Design Clone website</h1><p>Nhập một URL. WebLens tự scan, chọn giao diện đại diện và đóng gói bản clone tĩnh có thể tiếp tục sau restart.</p></div>
      </header>

      <section className="clone-command-card" aria-labelledby="clone-command-title">
        <div className="clone-command-copy"><span><CloudCog aria-hidden="true" /></span><div><small>URL → DISCOVER → SELECT → ARCHIVE</small><h2 id="clone-command-title">Tạo Design Clone</h2><p>Crawler khám phá URL; WebLens giữ giao diện đại diện theo chức năng và layout, rồi đóng gói asset same-origin thành archive tải về.</p></div></div>
        <form onSubmit={submit} noValidate>
          <label htmlFor="site-clone-url">URL gốc</label>
          <div className="clone-url-field"><Globe2 aria-hidden="true" /><input id="site-clone-url" value={url} onChange={(event) => setUrl(event.target.value)} placeholder="https://example.com" aria-invalid={Boolean(error)} aria-describedby={error ? 'site-clone-error' : 'site-clone-help'} /><button className="button button--primary" type="submit" disabled={submitting}>{submitting ? <LoaderCircle className="spin" aria-hidden="true" /> : <Play aria-hidden="true" />}Scan và clone</button></div>
          <small id="site-clone-help">Không cần chọn scan. Mỗi yêu cầu mới tự tạo một scan fresh.</small>
        </form>
      </section>

      {error ? <p className="clone-alert" id="site-clone-error" role="alert">{error}</p> : null}

      {detailState.error ? <p className="clone-alert" role="alert">{detailState.error.message}</p> : null}

      {siteClone ? <section className="clone-console">
        <header><div><span className={`clone-status clone-status--${siteClone.status.toLowerCase()}`}>{siteClone.status.replaceAll('_', ' ')}</span><h2>{siteClone.targetUrl}</h2><p>Operation <code>{siteClone.id}</code> · scan nội bộ <code>{siteClone.scanId}</code></p></div>{!terminal.has(siteClone.status) && siteClone.status !== 'CANCEL_REQUESTED' ? <button className="button button--danger-ghost button--small" type="button" onClick={() => void cancel(siteClone)} disabled={cancellingId === siteClone.id} aria-label={`Hủy clone ${siteClone.targetUrl}`}>{cancellingId === siteClone.id ? <LoaderCircle className="spin" aria-hidden="true" /> : <CircleStop aria-hidden="true" />}Hủy</button> : null}</header>
        <div className="clone-kpis">
          <article><small>URL KHÁM PHÁ</small><strong>{siteClone.discoveredCount.toLocaleString('vi-VN')}</strong><span>trang trong frontier</span></article>
          <article><small>ỨNG VIÊN RENDER</small><strong>{siteClone.processedCount.toLocaleString('vi-VN')}</strong><span>trang đại diện, không phải mọi URL</span></article>
          <article><small>BUNDLE ỨNG VIÊN</small><strong>{siteClone.succeededCount.toLocaleString('vi-VN')}</strong><span>manifest ghi số representative đóng gói cuối</span></article>
          <article><small>RENDER LỖI</small><strong>{siteClone.failedCount.toLocaleString('vi-VN')}</strong><span>không bao gồm URL chủ động loại</span></article>
        </div>
        <SiteCloneProgress key={siteClone.id} clone={siteClone} />
        {siteClone.terminalCode ? <div className="clone-terminal"><strong>{siteClone.terminalCode}</strong><span>{siteClone.terminalMessage ?? 'Workflow đã kết thúc với thông tin bổ sung.'}</span></div> : null}
        {siteClone.artifacts.length > 0 ? <div className="clone-artifacts"><div><ShieldCheck aria-hidden="true" /><span><strong>Artifact đã kiểm tra SHA-256</strong><small>Giải nén tất cả shard ZIP vào cùng một thư mục. Manifest mô tả trang thiếu và lỗi.</small></span></div><ul>{siteClone.artifacts.map((artifact) => <li key={artifact.id}><span className="clone-artifact-icon">{artifact.kind === 'MANIFEST' ? <FileJson2 /> : <Archive />}</span><span><strong>{artifact.filename}</strong><small>{formatBytes(artifact.byteSize)} · hết hạn {artifact.expiresAt}</small></span><button className="button button--secondary button--small" type="button" disabled={downloading === artifact.id} onClick={() => download(artifact.id, artifact.filename)}>{downloading === artifact.id ? <LoaderCircle className="spin" /> : <Download />}Tải</button></li>)}</ul></div> : null}
      </section> : detailState.loading && siteCloneId ? <section className="clone-empty" aria-busy="true"><LoaderCircle className="spin" aria-hidden="true" /><h2>Đang mở clone</h2><p>Đang nạp tiến độ, kết quả render và artifact mới nhất.</p></section> : <section className="clone-empty"><Archive aria-hidden="true" /><h2>Chọn một clone để kiểm tra</h2><p>Danh sách bên dưới giữ lại các workflow bền vững sau khi tải lại trang hoặc mở phiên làm việc mới.</p></section>}

      <section className="clone-history" aria-labelledby="clone-history-title" aria-busy={historyState.refreshing}>
        <div className="clone-history__toolbar"><div><span className="page-kicker">WORKFLOW HISTORY</span><h2 id="clone-history-title">Clone của bạn</h2><p>{history?.totalItems ?? 0} workflow phù hợp</p></div><form className="list-filters" onSubmit={applyHistoryFilters}><label className="search-field"><Search aria-hidden="true" /><span className="sr-only">Tìm clone</span><input name="q" defaultValue={historyQuery} placeholder="Tìm URL…" maxLength={200} /></label><label className="select-field"><span className="sr-only">Trạng thái clone</span><select value={historyStatus} onChange={(event) => { setHistoryStatus(event.target.value as SiteClone['status'] | 'ALL'); setHistoryPage(0) }}><option value="ALL">Mọi trạng thái</option><option value="WAITING_FOR_SCAN">Chờ scan</option><option value="QUEUED">Đang chờ</option><option value="RUNNING">Đang chạy</option><option value="ASSEMBLING">Đóng gói</option><option value="PUBLISHED">Đã xuất bản</option><option value="PARTIAL">Một phần</option><option value="FAILED">Thất bại</option><option value="CANCELLED">Đã hủy</option><option value="EXPIRED">Hết hạn</option></select></label><label className="select-field"><span className="sr-only">Sắp xếp clone</span><select value={historySort} onChange={(event) => { setHistorySort(event.target.value); setHistoryPage(0) }}><option value="createdAt,desc">Mới nhất</option><option value="createdAt,asc">Cũ nhất</option><option value="processedPages,desc">Ứng viên render nhiều</option><option value="targetUrl,asc">URL A–Z</option></select></label><button className="button button--secondary button--small" type="submit">Lọc</button></form></div>
        {historyState.loading ? <LoadingState label="Đang tải lịch sử clone…" /> : historyState.error ? <ErrorState /> : history?.items.length === 0 ? <EmptyState title="Chưa có workflow clone">Clone đầu tiên sẽ xuất hiện tại đây và vẫn theo dõi được sau khi tải lại trang.</EmptyState> : history ? <div className="clone-history__list">{history.items.map((clone) => <article className={`clone-history__item${clone.id === siteCloneId ? ' is-selected' : ''}`} key={clone.id}><Link to={`/app/clone/${clone.id}`} aria-current={clone.id === siteCloneId ? 'page' : undefined}><span className={`clone-status clone-status--${clone.status.toLowerCase()}`}>{clone.status.replaceAll('_', ' ')}</span><strong>{clone.targetUrl}</strong><small>{clone.discoveredCount.toLocaleString('vi-VN')} URL khám phá · {clone.processedCount.toLocaleString('vi-VN')} ứng viên đã render · tạo {clone.createdAt}</small></Link><div><span>{progressLabel(clone)}</span>{!terminal.has(clone.status) && clone.status !== 'CANCEL_REQUESTED' ? <button className="button button--danger-ghost button--small" type="button" disabled={cancellingId === clone.id} onClick={() => void cancel(clone)} aria-label={`Hủy clone ${clone.targetUrl}`}>{cancellingId === clone.id ? <LoaderCircle className="spin" aria-hidden="true" /> : <CircleStop aria-hidden="true" />}Hủy</button> : <ArrowRight aria-hidden="true" />}</div></article>)}</div> : null}
        {history ? <NumberPagination page={history.page} pageSize={history.size} totalItems={history.totalItems} totalPages={history.totalPages} disabled={historyState.refreshing} onPageChange={setHistoryPage} onPageSizeChange={(size) => { setHistoryPageSize(size); setHistoryPage(0) }} /> : null}
      </section>
    </div>
  )
}

function progressLabel(siteClone: SiteClone): string {
  if (['PUBLISHED', 'PARTIAL'].includes(siteClone.status)) return 'Đã đóng gói'
  if (siteClone.status === 'ASSEMBLING') return 'Đang đóng gói'
  if (siteClone.status === 'RUNNING') return 'Đang chọn'
  return siteClone.status.replaceAll('_', ' ')
}

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`
  if (value < 1024 ** 2) return `${(value / 1024).toFixed(1)} KiB`
  if (value < 1024 ** 3) return `${(value / 1024 ** 2).toFixed(1)} MiB`
  return `${(value / 1024 ** 3).toFixed(2)} GiB`
}

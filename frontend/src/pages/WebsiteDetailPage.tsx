import { ArrowLeft, ArrowRight, ExternalLink, LoaderCircle, Play } from 'lucide-react'
import { useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { ApiError } from '../api/apiClient'
import { webLensService } from '../api/webLensApiService'
import { NumberPagination } from '../components/Pagination'
import { ErrorState, LoadingState } from '../components/StateView'
import { StatusBadge } from '../components/StatusBadge'
import { useAsyncData } from '../hooks/useAsyncData'
import type { ScanStatus } from '../domain/types'

export function WebsiteDetailPage() {
  const { websiteId = '' } = useParams()
  const navigate = useNavigate()
  const [page, setPage] = useState(0)
  const [pageSize, setPageSize] = useState(20)
  const [status, setStatus] = useState<ScanStatus | 'ALL'>('ALL')
  const [sort, setSort] = useState('createdAt,desc')
  const websiteState = useAsyncData(() => webLensService.getWebsite(websiteId), `website:${websiteId}`)
  const scansState = useAsyncData(
    () => webLensService.listScans(websiteId, {
      page,
      size: pageSize,
      statuses: status === 'ALL' ? undefined : [status],
      sort,
    }),
    `website-scans:${websiteId}:${page}:${pageSize}:${status}:${sort}`,
  )
  const [startingScan, setStartingScan] = useState(false)
  const [startError, setStartError] = useState<string | null>(null)

  async function startScan() {
    if (startingScan) return
    setStartingScan(true)
    setStartError(null)
    try {
      const scan = await webLensService.startScan(websiteId, crypto.randomUUID())
      navigate(`/app/scans/${scan.id}`)
    } catch (error: unknown) {
      const requestId = error instanceof ApiError ? ` · Mã theo dõi ${error.requestId}` : ''
      setStartError(`${error instanceof Error ? error.message : 'Không thể bắt đầu lần quét.'}${requestId}`)
    } finally {
      setStartingScan(false)
    }
  }

  if (websiteState.loading) return <div className="app-page"><LoadingState label="Đang tải website…" /></div>
  if (websiteState.error || !websiteState.data) return <div className="app-page"><ErrorState title="Không tìm thấy website" /></div>
  const website = websiteState.data
  const scansPage = scansState.data

  return (
    <div className="app-page">
      <Link className="back-link" to="/app/websites"><ArrowLeft />Tất cả websites</Link>
      <header className="detail-header"><div className="detail-identity"><span className="site-favicon site-favicon--large">{website.hostname.slice(0, 1).toUpperCase()}</span><div><span className="page-kicker">CHI TIẾT WEBSITE</span><h1>{website.name}</h1><a href={website.url} target="_blank" rel="noreferrer">{website.url}<ExternalLink size={14} /></a></div></div><div className="header-actions"><button className="button button--primary" type="button" onClick={startScan} disabled={startingScan}>{startingScan ? <LoaderCircle className="spin" /> : <Play />}{startingScan ? 'Đang tạo lần quét…' : 'Bắt đầu quét'}</button></div></header>
      {startError ? <div className="scan-alert scan-alert--error" role="alert">{startError}</div> : null}
      <section className="site-summary"><div><small>TRẠNG THÁI GẦN NHẤT</small>{website.latestStatus ? <StatusBadge status={website.latestStatus} /> : <strong>Chưa quét</strong>}</div><div><small>TRANG ĐƯỢC XỬ LÝ</small><strong>{website.pageCount}</strong></div><div><small>TRANG THẤT BẠI</small><strong>{website.failedPageCount}</strong></div><div><small>CẬP NHẬT</small><strong>{website.updatedAt}</strong></div></section>
      <section className="content-card"><div className="card-toolbar"><div><h2>Lịch sử quét</h2><span>{scansPage?.totalItems ?? 0} lần quét</span></div><div className="list-filters"><label className="select-field"><span className="sr-only">Trạng thái scan</span><select value={status} onChange={(event) => { setStatus(event.target.value as ScanStatus | 'ALL'); setPage(0) }}><option value="ALL">Mọi trạng thái</option><option value="QUEUED">Đang chờ</option><option value="RUNNING">Đang chạy</option><option value="CANCEL_REQUESTED">Đang hủy</option><option value="COMPLETED">Hoàn tất</option><option value="PARTIAL_SUCCESS">Một phần</option><option value="FAILED">Thất bại</option><option value="CANCELLED">Đã hủy</option></select></label><label className="select-field"><span className="sr-only">Sắp xếp scan</span><select value={sort} onChange={(event) => { setSort(event.target.value); setPage(0) }}><option value="createdAt,desc">Mới nhất</option><option value="createdAt,asc">Cũ nhất</option><option value="failedPages,desc">Lỗi nhiều nhất</option><option value="status,asc">Theo trạng thái</option></select></label></div></div>{scansState.loading ? <LoadingState /> : scansState.error ? <ErrorState /> : <div className="data-table-wrap"><table className="data-table"><thead><tr><th scope="col">Lần quét</th><th scope="col">Trạng thái</th><th scope="col">Trang</th><th scope="col">Thất bại</th><th scope="col">Thời lượng</th><th scope="col"><span className="sr-only">Mở</span></th></tr></thead><tbody>{scansPage?.items.map((scan) => <tr key={scan.id}><td><Link to={`/app/scans/${scan.id}`}><strong>#{scan.id.slice(0, 8)}</strong><small>{scan.createdAt}</small></Link></td><td><StatusBadge status={scan.status} /></td><td>{scan.progress.processed} / {scan.progress.discovered}</td><td>{scan.progress.failed}</td><td>{scan.duration}</td><td><Link className="icon-link" to={`/app/scans/${scan.id}`} aria-label={`Mở lần quét ${scan.id}`}><ArrowRight /></Link></td></tr>)}</tbody></table></div>}{scansPage ? <NumberPagination page={scansPage.page} pageSize={scansPage.size} totalItems={scansPage.totalItems} totalPages={scansPage.totalPages} disabled={scansState.refreshing} onPageChange={setPage} onPageSizeChange={(size) => { setPageSize(size); setPage(0) }} /> : null}</section>
    </div>
  )
}

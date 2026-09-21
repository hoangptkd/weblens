import { Activity, ArrowRight, CheckCircle2, CircleAlert, Globe2, Plus, Search, Sparkles } from 'lucide-react'
import { useState } from 'react'
import type { FormEvent } from 'react'
import { Link } from 'react-router-dom'
import { webLensService } from '../api/webLensApiService'
import { NumberPagination } from '../components/Pagination'
import { EmptyState, ErrorState, LoadingState } from '../components/StateView'
import { StatusBadge } from '../components/StatusBadge'
import { useAsyncData } from '../hooks/useAsyncData'
import { validatePublicUrl } from '../utils/validation'

export function WebsitesPage() {
  const [reloadKey, setReloadKey] = useState(0)
  const [page, setPage] = useState(0)
  const [pageSize, setPageSize] = useState(20)
  const [query, setQuery] = useState('')
  const [status, setStatus] = useState<'ACTIVE' | 'ARCHIVED' | 'ALL'>('ACTIVE')
  const [sort, setSort] = useState('updatedAt,desc')
  const websitesState = useAsyncData(
    () => webLensService.listWebsites({
      page,
      size: pageSize,
      q: query || undefined,
      statuses: status === 'ALL' ? ['ACTIVE', 'ARCHIVED'] : [status],
      sort,
    }),
    `websites:${page}:${pageSize}:${query}:${status}:${sort}:${reloadKey}`,
  )
  const summaryState = useAsyncData(
    () => webLensService.getDashboardSummary(),
    `dashboard-summary:${reloadKey}`,
  )
  const [adding, setAdding] = useState(false)
  const [urlError, setUrlError] = useState<string | null>(null)
  const pageData = websitesState.data
  const websites = pageData?.items ?? []
  const summary = summaryState.data
  const successRate = summary && summary.processedPages > 0
    ? Math.round((summary.succeededPages / summary.processedPages) * 100)
    : null

  async function addWebsite(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const value = String(new FormData(event.currentTarget).get('url') ?? '')
    const validationError = validatePublicUrl(value)
    setUrlError(validationError)
    if (validationError) return
    try {
      const hostname = new URL(value).hostname
      await webLensService.createWebsite(hostname, value)
      setAdding(false)
      setPage(0)
      setReloadKey((current) => current + 1)
    } catch (requestError) {
      setUrlError(requestError instanceof Error ? requestError.message : 'Không thể thêm website.')
    }
  }

  function applyFilters(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setQuery(String(new FormData(event.currentTarget).get('q') ?? '').trim())
    setPage(0)
  }

  return (
    <div className="app-page">
      <header className="page-header"><div><span className="page-kicker">TỔNG QUAN</span><h1>Websites</h1><p>Quan sát tất cả target và lần quét gần nhất trong một nơi.</p></div><button className="button button--primary" type="button" aria-expanded={adding} aria-controls="add-website-panel" onClick={() => setAdding((value) => !value)}><Plus size={17} />Thêm website</button></header>

      <section className="metric-grid" aria-label="Tóm tắt workspace" aria-busy={summaryState.loading}>
        <article><span className="metric-icon mint"><Globe2 /></span><div><small>WEBSITE ĐANG HOẠT ĐỘNG</small><strong>{summary?.activeWebsites ?? '—'}</strong><p>Dữ liệu owner-scoped từ PostgreSQL</p></div></article>
        <article><span className="metric-icon blue"><Activity /></span><div><small>LẦN QUÉT 30 NGÀY</small><strong>{summary?.scansLast30Days ?? '—'}</strong><p>{summary ? `${summary.activeScans} lần quét đang hoạt động` : 'Đang tải dữ liệu'}</p></div></article>
        <article><span className="metric-icon green"><CheckCircle2 /></span><div><small>TỶ LỆ TRANG THÀNH CÔNG</small><strong>{successRate === null ? '—' : `${successRate}%`}</strong><p>{summary ? `${summary.succeededPages} / ${summary.processedPages} trang đã xử lý` : 'Đang tải dữ liệu'}</p></div></article>
        <article><span className="metric-icon orange"><CircleAlert /></span><div><small>TRANG THẤT BẠI</small><strong>{summary?.failedPages ?? '—'}</strong><p>Trên toàn bộ lịch sử scan hiện có</p></div></article>
      </section>

      {adding ? <section className="inline-panel" id="add-website-panel" aria-labelledby="add-website-title"><div><Sparkles /><h2 id="add-website-title">Thêm website production</h2><p>Frontend kiểm tra cú pháp; backend tiếp tục áp dụng ownership và chính sách an toàn trước khi scan.</p></div><form onSubmit={addWebsite} noValidate><label htmlFor="new-site-url">URL website</label><div className="compact-form"><input id="new-site-url" name="url" placeholder="https://example.com" aria-invalid={Boolean(urlError)} aria-describedby={urlError ? 'new-site-error' : 'new-site-help'} /><button className="button button--dark" type="submit">Thêm website</button></div>{urlError ? <p className="field-error" id="new-site-error" role="alert">{urlError}</p> : <small id="new-site-help">Chỉ chấp nhận HTTP hoặc HTTPS.</small>}</form></section> : null}

      <section className="content-card">
        <div className="card-toolbar"><div><h2>Website đã đăng ký</h2><span>{pageData?.totalItems ?? 0} target</span></div><form className="list-filters" onSubmit={applyFilters}><label className="search-field"><Search aria-hidden="true" /><span className="sr-only">Tìm website</span><input name="q" defaultValue={query} placeholder="Tên, host hoặc URL…" maxLength={200} /></label><label className="select-field"><span className="sr-only">Trạng thái website</span><select value={status} onChange={(event) => { setStatus(event.target.value as typeof status); setPage(0) }}><option value="ACTIVE">Đang hoạt động</option><option value="ARCHIVED">Đã lưu trữ</option><option value="ALL">Tất cả</option></select></label><label className="select-field"><span className="sr-only">Sắp xếp website</span><select value={sort} onChange={(event) => { setSort(event.target.value); setPage(0) }}><option value="updatedAt,desc">Cập nhật mới nhất</option><option value="createdAt,desc">Tạo mới nhất</option><option value="name,asc">Tên A–Z</option></select></label><button className="button button--secondary button--small" type="submit">Lọc</button></form></div>
        {websitesState.loading ? <LoadingState label="Đang tải danh sách website…" /> : websitesState.error ? <ErrorState /> : websites.length === 0 ? <EmptyState title="Chưa có website">Thêm website đầu tiên để bắt đầu scan.</EmptyState> : <div className="website-list">{websites.map((website) => <Link className="website-row" to={`/app/websites/${website.id}`} key={website.id}><span className="site-favicon">{website.hostname.slice(0, 1).toUpperCase()}</span><span className="site-identity"><strong>{website.name}</strong><small>{website.url}</small></span><span className="site-stat"><small>TRANG ĐƯỢC XỬ LÝ</small><strong>{website.pageCount}</strong></span><span className="site-stat"><small>TRANG THẤT BẠI</small><strong>{website.failedPageCount}</strong></span><span className="site-status">{website.latestStatus ? <StatusBadge status={website.latestStatus} /> : <strong>Chưa quét</strong>}<small>{website.updatedAt}</small></span><ArrowRight className="row-arrow" aria-hidden="true" /></Link>)}</div>}
        {pageData ? <NumberPagination page={pageData.page} pageSize={pageData.size} totalItems={pageData.totalItems} totalPages={pageData.totalPages} disabled={websitesState.refreshing} onPageChange={setPage} onPageSizeChange={(size) => { setPageSize(size); setPage(0) }} /> : null}
      </section>
    </div>
  )
}

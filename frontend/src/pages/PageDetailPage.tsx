import { ArrowLeft, ArrowRight, Braces, Camera, Check, Clock3, Code2, ExternalLink, FileCode2, Image, Link2, LoaderCircle, Type } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { webLensService } from '../api/webLensApiService'
import { ErrorState, LoadingState } from '../components/StateView'
import { SeverityBadge } from '../components/StatusBadge'
import { useAsyncData } from '../hooks/useAsyncData'
import { formatBytes } from '../utils/validation'
import type { Capture } from '../domain/types'

const terminalCaptureStatuses = new Set(['COMPLETED', 'PARTIAL_SUCCESS', 'FAILED', 'CANCELLED'])

export function PageDetailPage() {
  const { scanPageId = '' } = useParams()
  const { data: page, error, loading } = useAsyncData(() => webLensService.getScanPage(scanPageId), `scan-page:${scanPageId}`)
  const { data: latestCapture, loading: latestCaptureLoading } = useAsyncData(
    () => page ? webLensService.getLatestCapture(page.scanId, page.id) : Promise.resolve(null),
    `latest-capture:${page?.scanId ?? 'pending'}:${scanPageId}`,
  )
  const [capture, setCapture] = useState<Capture | null>(null)
  const [captureError, setCaptureError] = useState<string | null>(null)
  const [submittingCapture, setSubmittingCapture] = useState(false)
  const navigate = useNavigate()

  useEffect(() => {
    if (!capture || terminalCaptureStatuses.has(capture.status)) {
      if (capture?.status === 'COMPLETED' || capture?.status === 'PARTIAL_SUCCESS') {
        navigate(`/app/snapshots/${capture.id}`)
      }
      return
    }
    const timer = window.setTimeout(() => {
      void webLensService.getCapture(capture.id)
        .then(setCapture)
        .catch((pollError: unknown) => setCaptureError(pollError instanceof Error ? pollError.message : 'Không thể cập nhật capture.'))
    }, 1500)
    return () => window.clearTimeout(timer)
  }, [capture, navigate])

  async function startCapture() {
    if (!page || page.outcome !== 'success' || submittingCapture) return
    setSubmittingCapture(true)
    setCaptureError(null)
    try {
      setCapture(await webLensService.startCapture(page.id, crypto.randomUUID()))
    } catch (createError: unknown) {
      setCaptureError(createError instanceof Error ? createError.message : 'Không thể tạo browser capture.')
    } finally {
      setSubmittingCapture(false)
    }
  }

  if (loading) return <div className="app-page"><LoadingState label="Đang tải bằng chứng trang…" /></div>
  if (error || !page) return <div className="app-page"><ErrorState title="Không tìm thấy trang đã quét" /></div>

  const issueCount = page.findings.filter((finding) => finding.severity !== 'info').length
  const informationCount = page.findings.length - issueCount

  return (
    <div className="app-page">
      <Link className="back-link" to={`/app/scans/${page.scanId}`}><ArrowLeft />Quay lại lần quét</Link>
      <header className="detail-header"><div><span className="page-kicker">SCAN PAGE EVIDENCE</span><h1>{page.path}</h1><a href={page.url} target="_blank" rel="noreferrer">{page.url}<ExternalLink size={14} /></a></div><button className="button button--primary" type="button" disabled={page.outcome !== 'success' || submittingCapture || Boolean(capture && !terminalCaptureStatuses.has(capture.status))} onClick={startCapture}>{submittingCapture || (capture && !terminalCaptureStatuses.has(capture.status)) ? <LoaderCircle className="spin" /> : <Camera />}{page.outcome !== 'success' ? 'Trang không đủ điều kiện capture' : submittingCapture ? 'Đang tạo…' : capture?.status === 'RUNNING' ? 'Chromium đang render…' : capture?.status === 'INDEXING' ? 'Đang lập chỉ mục…' : 'Tạo browser capture'}</button></header>
      {capture && !terminalCaptureStatuses.has(capture.status) ? <div className="capture-progress" role="status" aria-live="polite"><span className="pulse" /><div><strong>{capture.status === 'QUEUED' || capture.status === 'DISPATCHED' ? 'Capture job đã được lưu bền vững' : capture.status === 'INDEXING' ? 'Đang ghi analytical evidence' : 'Playwright Worker đang render trang'}</strong><small>{capture.status} · profile {capture.measurementProfile}</small></div></div> : null}
      {captureError ? <div className="scan-alert scan-alert--error" role="alert">{captureError}</div> : null}

      <section className="evidence-metrics"><article><span><Code2 /></span><small>HTTP STATUS</small><strong>{page.statusCode ?? '—'}</strong><p>{page.outcome === 'failed' ? 'Không thành công' : page.outcome === 'warning' ? 'Bỏ qua theo chính sách quét' : 'Phản hồi nhận được'}</p></article><article><span><Clock3 /></span><small>RESPONSE TIME</small><strong>{page.responseTimeMs !== undefined ? `${page.responseTimeMs} ms` : '—'}</strong><p>TTFB {page.timing?.ttfbMillis !== undefined ? `${page.timing.ttfbMillis} ms` : 'không phát sinh phép đo'}</p></article><article><span><FileCode2 /></span><small>HTML SIZE</small><strong>{page.responseBytes !== undefined ? formatBytes(page.responseBytes) : '—'}</strong><p>Kích thước response đã thu thập</p></article></section>

      <div className="page-detail-grid"><section className="content-card evidence-details"><div className="card-toolbar"><div><h2>Nội dung đã trích xuất</h2><span>Text được escape, không render HTML</span></div></div><dl><div><dt><Type />Title</dt><dd>{page.title ?? <span className="missing">Không thu thập được</span>}</dd></div><div><dt><Type />Description</dt><dd>{page.description ?? <span className="missing">Không thu thập được</span>}</dd></div><div><dt><Type />H1</dt><dd>{page.h1 ?? <span className="missing">Không thu thập được</span>}</dd></div><div><dt><Link2 />Canonical</dt><dd>{page.canonicalUrl ?? <span className="missing">Không khai báo</span>} {page.canonicalRelation ? <small>· {page.canonicalRelation}</small> : null}</dd></div><div><dt><Code2 />Indexability</dt><dd>{page.indexable ? 'Có thể lập chỉ mục' : 'Không thể lập chỉ mục'} {page.indexabilityReason ? <small>· {page.indexabilityReason}</small> : null}</dd></div><div><dt><Code2 />Robots</dt><dd>{page.metaRobots || page.xRobotsTag ? `${page.metaRobots ?? '—'} · X-Robots: ${page.xRobotsTag ?? '—'}` : <span className="missing">Không khai báo</span>}</dd></div></dl><div className="resource-counts"><div><Link2 /><span><strong>{page.links}</strong><small>Liên kết</small></span></div><div><Image /><span><strong>{page.images}</strong><small>Hình ảnh</small></span></div><div><Braces /><span><strong>{page.scripts}</strong><small>Scripts</small></span></div><div><FileCode2 /><span><strong>{page.stylesheets}</strong><small>Stylesheets</small></span></div></div></section>
        <section className="content-card evidence-details"><div className="card-toolbar"><div><h2>Social &amp; structured SEO</h2><span>HTML tĩnh · {(page.structuredData?.types.length ?? 0)} Schema.org type</span></div></div><dl><div><dt><Type />Meta keywords</dt><dd>{page.metaKeywords ?? <span className="missing">Không khai báo</span>}</dd></div><div><dt><Braces />Open Graph</dt><dd>{page.openGraph?.title ?? <span className="missing">Thiếu og:title</span>}<br /><small>{page.openGraph?.description ?? 'Thiếu og:description'}</small><br /><small>{page.openGraph?.imageUrl ?? 'Thiếu og:image'}</small></dd></div><div><dt><Braces />Schema.org</dt><dd>{page.structuredData?.types.length ? page.structuredData.types.join(', ') : <span className="missing">Không phát hiện type</span>}<br /><small>{page.structuredData ? `${page.structuredData.itemCount} item · ${page.structuredData.errorCount} lỗi · ${page.structuredData.warningCount} cảnh báo` : 'Không có summary'}</small></dd></div><div><dt><Link2 />Hreflang</dt><dd>{page.hreflang?.length ? page.hreflang.map((entry) => `${entry.language}: ${entry.url}`).join(' · ') : <span className="missing">Không khai báo</span>}</dd></div><div><dt><Type />Heading H2–H6</dt><dd>{[page.h2, page.h3, page.h4, page.h5, page.h6].map((values, index) => `H${index + 2}: ${values?.length ?? 0}`).join(' · ')}</dd></div><div><dt><Clock3 />Network phases</dt><dd>DNS {page.timing?.dnsMillis ?? '—'} ms · Connect {page.timing?.connectMillis ?? '—'} ms · TLS {page.timing?.tlsMillis ?? '—'} ms · TTFB {page.timing?.ttfbMillis ?? '—'} ms</dd></div></dl></section>
        <section className="content-card findings-card"><div className="card-toolbar"><div><h2>Kết quả kiểm tra deterministic</h2><span>{issueCount} cần chú ý · {informationCount} thông tin</span></div></div>{page.findings.length === 0 ? <div className="clean-state"><Check /><strong>Không có kết quả từ các rule hiện tại</strong><p>Điều này không phải chứng nhận SEO hoặc accessibility; các rule chỉ đọc bằng chứng đã thu thập.</p></div> : <div className="finding-list">{page.findings.map((finding) => <article key={finding.id}><div><SeverityBadge severity={finding.severity} /><small>RULE · {finding.id.toUpperCase()}</small></div><h3>{finding.title}</h3><p>{finding.description}</p><code>{finding.evidence}</code></article>)}</div>}<p className="pipeline-note">Rule nội dung dùng HTML tĩnh. Hãy tạo browser capture khi cần đối chiếu DOM sau JavaScript.</p></section></div>
      <div className="security-note"><strong>Ranh giới bảo mật</strong><p>Frontend chỉ kiểm tra cú pháp URL và hiển thị text đã escape. DNS, redirect, private IP, response-size limit và DNS rebinding phải được kiểm soát ở backend trước mọi kết nối.</p>{latestCaptureLoading ? <span className="security-note__empty">Đang tìm snapshot…</span> : latestCapture ? <Link to={`/app/snapshots/${latestCapture.id}`}>Xem snapshot gần nhất <ArrowRight /></Link> : <span className="security-note__empty">Chưa có snapshot</span>}</div>
    </div>
  )
}

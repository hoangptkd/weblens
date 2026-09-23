import { Check, Copy, RefreshCw, Search } from 'lucide-react'
import { useState } from 'react'
import { webLensService } from '../api/webLensApiService'
import type { SiteClone, SiteClonePageStatus, SiteCloneProgressPage } from '../domain/types'
import { useAsyncData } from '../hooks/useAsyncData'

const terminal = new Set(['PUBLISHED', 'PARTIAL', 'FAILED', 'CANCELLED', 'EXPIRED'])
const labels: Record<SiteClonePageStatus, string> = {
  QUEUED: 'Chờ render / thử lại', RENDERING: 'Đang render', SUCCEEDED: 'Đã render',
  FAILED: 'Render lỗi', CANCELLED: 'Bị loại / đã hủy',
}
const phases: Record<string, string> = {
  WAITING_FOR_SCAN: 'Khám phá URL', QUEUED: 'Chờ Capture Worker', INGESTING: 'Chọn ứng viên render',
  RUNNING: 'Render và thu tài nguyên', ASSEMBLING: 'Ghép trang, đóng gói và xác minh artifact',
  CANCEL_REQUESTED: 'Đang dừng an toàn', PUBLISHED: 'Đã xuất bản', PARTIAL: 'Đã xuất bản một phần',
  FAILED: 'Thất bại', CANCELLED: 'Đã hủy', EXPIRED: 'Artifact đã hết hạn',
}

export function SiteCloneProgress({ clone }: { clone: SiteClone }) {
  const [filter, setFilter] = useState({ status: 'ALL', q: '' })
  const [cursors, setCursors] = useState([-1])
  const [reload, setReload] = useState(0)
  const [copyMessage, setCopyMessage] = useState('')
  const after = cursors.at(-1) ?? -1
  const state = useAsyncData(
    () => webLensService.getSiteCloneProgress(clone.id, { after, ...filter }),
    `clone-progress:${clone.id}:${clone.status}:${after}:${JSON.stringify(filter)}:${reload}`,
    { pollIntervalMs: 5_000, shouldPoll: (value) => !terminal.has(value.phase),
      shouldPollOnError: () => !terminal.has(clone.status) },
  )
  const data = state.data
  const phase = data?.phase ?? clone.status
  const counts = data?.counts ?? {}
  const done = (counts.SUCCEEDED ?? 0) + (counts.FAILED ?? 0)
  const candidates = done + (counts.QUEUED ?? 0) + (counts.RENDERING ?? 0)
  const percent = data?.ingestionComplete && candidates > 0 ? Math.floor(done * 100 / candidates) : undefined
  const published = ['PUBLISHED', 'PARTIAL', 'EXPIRED'].includes(phase)
  const stopped = terminal.has(phase) || phase === 'CANCEL_REQUESTED'
  const steps = [
    { title: 'Khám phá', detail: 'Crawler tìm URL', done: Boolean(data?.available), active: phase === 'WAITING_FOR_SCAN' },
    { title: 'Chọn trang', detail: 'Loại trùng và ngoài policy', done: Boolean(data?.ingestionComplete), active: phase === 'INGESTING' },
    { title: 'Render', detail: 'Chromium + bundle ứng viên', done: published || phase === 'ASSEMBLING', active: phase === 'RUNNING' },
    { title: 'Đóng gói & xuất bản', detail: 'ZIP, manifest, SHA-256', done: published, active: phase === 'ASSEMBLING' },
  ]

  function diagnostic(page?: SiteCloneProgressPage) {
    // Opaque identifiers only: no URLs, query values, tokens or captured HTML.
    return JSON.stringify({ service: 'capture-worker', siteCloneRequestId: clone.id, scanId: clone.scanId,
      correlationId: data?.correlationId ?? null, phase, observedAt: data?.observedAt ?? null,
      ...(page ? { pageId: page.pageId, attempt: page.attemptCount, status: page.status,
        errorCode: page.failureCode, updatedAt: page.updatedAt } : { terminalCode: data?.terminalCode ?? clone.terminalCode ?? null }),
    }, null, 2)
  }

  async function copy(text: string) {
    try { await navigator.clipboard.writeText(text); setCopyMessage('Đã sao chép thông tin tra log.') }
    catch { setCopyMessage('Không thể sao chép tự động. Hãy chọn nội dung trong mục Tra log bên dưới.') }
  }

  function changeFilter(next: typeof filter) { setFilter(next); setCursors([-1]) }

  return <section className="render-monitor" aria-labelledby="render-monitor-title">
    <header className="render-monitor__header">
      <div><span className="page-kicker">RENDER MONITOR</span><h3 id="render-monitor-title">{phases[phase] ?? phase}</h3>
        <p>Trạng thái lưu bền vững · tự cập nhật mỗi 5 giây khi còn chạy</p></div>
      <button type="button" className="button button--secondary button--small" disabled={state.refreshing || state.loading}
        onClick={() => setReload((value) => value + 1)}><RefreshCw aria-hidden="true" />Làm mới tiến độ</button>
    </header>
    {state.error ? <p className="clone-alert" role="alert">Không cập nhật được tiến độ. {data ? 'Đang giữ bản chụp cũ; không phải trạng thái hiện tại.' : state.error.message}</p> : null}
    <div className="render-monitor__meter">
      <div><strong>{percent === undefined ? 'Chưa có tổng số ứng viên render ổn định' : `${percent}% ứng viên đã xử lý`}</strong>
        <span>{data?.available ? `${done} / ${candidates} ứng viên · ${counts.CANCELLED ?? 0} URL bị loại/hủy` : 'Chờ dữ liệu từ Capture Worker'}</span></div>
      {percent !== undefined ? <progress aria-label="Tiến độ xử lý ứng viên render" max={100} value={percent} />
        : !stopped ? <progress aria-label="Đang chuẩn bị danh sách render" /> : null}
      <p>{stopped ? 'Workflow đã dừng hoặc kết thúc; xem trạng thái và mã lỗi, không suy ra thành công từ phần trăm.'
        : '100% render không có nghĩa archive đã sẵn sàng. Đóng gói và xuất bản là bước riêng.'}</p>
    </div>
    <ol className="render-monitor__steps" aria-label="Các giai đoạn render">
      {steps.map((step) => <li key={step.title} className={step.done ? 'is-done' : step.active ? 'is-active' : ''} aria-current={step.active ? 'step' : undefined}>
        {step.done ? <Check aria-hidden="true" /> : <span className="render-step-dot" aria-hidden="true" />}
        <div><strong>{step.title}</strong><small>{step.detail}</small></div>
      </li>)}
    </ol>
    {data?.phaseLeaseExpired ? <p className="clone-alert" role="status">Lease giai đoạn đã hết hạn. Worker có thể đang gián đoạn hoặc chờ tiếp quản; chưa kết luận job thất bại.</p> : null}
    {data?.phaseAttemptCount ? <p>Giai đoạn đã có {data.phaseAttemptCount} lần lỗi được ghi nhận. Lịch thử lại: {date(data.phaseRetryAt)}.</p> : null}
    <div className="render-monitor__active">
      <h4>Đang render ({counts.RENDERING ?? 0})</h4>
      {data?.activePages.length ? <ul>{data.activePages.map((page) => <li key={page.pageId}>
        <span><strong>{page.url}</strong><small>Lần thử {page.attemptCount} · cập nhật {date(page.updatedAt)}{page.leaseExpired ? ' · Lease hết hạn, chờ tiếp quản' : ''}</small></span>
        <button type="button" className="button button--secondary button--small" onClick={() => void copy(diagnostic(page))} aria-label={`Sao chép chẩn đoán trang ${page.ordinal + 1}`}><Copy aria-hidden="true" />Tra log</button>
      </li>)}</ul> : <p>{state.loading ? 'Đang đọc trạng thái…' : 'Không có trang đang giữ lease render trong bản chụp này.'}</p>}
      {(counts.RENDERING ?? 0) > 32 ? <p>Hiển thị tối đa 32 trang đang render; dùng bộ lọc bên dưới để xem tiếp.</p> : null}
    </div>
    <form className="list-filters" onSubmit={(event) => {
      event.preventDefault(); changeFilter({ ...filter, q: String(new FormData(event.currentTarget).get('pageQuery') ?? '').trim() })
    }}>
      <label className="search-field"><Search aria-hidden="true" /><span className="sr-only">Tìm URL render</span><input name="pageQuery" defaultValue={filter.q} maxLength={200} placeholder="Tìm đường dẫn trang…" /></label>
      <label className="select-field"><span className="sr-only">Trạng thái trang render</span><select value={filter.status} onChange={(event) => changeFilter({ ...filter, status: event.target.value })}>
        <option value="ALL">Mọi trạng thái trang</option>{Object.entries(labels).map(([key, label]) => <option key={key} value={key}>{label} ({counts[key as SiteClonePageStatus] ?? 0})</option>)}
      </select></label><button type="submit" className="button button--secondary button--small">Lọc trang</button>
    </form>
    <div className="render-monitor__table">
      <table><caption>Tiến trình từng trang · đã render chưa đồng nghĩa được giữ trong ZIP cuối</caption>
        <thead><tr><th scope="col">Trang / mã tra cứu</th><th scope="col">Trạng thái</th><th scope="col">Lần thử</th><th scope="col">Thời gian</th><th scope="col">Mã lỗi / lý do</th><th scope="col">Log</th></tr></thead>
        <tbody>{data?.items.map((page) => <tr key={page.pageId}>
          <td><strong>{page.url}</strong><code>{page.pageId}</code></td>
          <td>{labels[page.status]}{page.leaseExpired ? <small>Lease hết hạn</small> : null}</td><td>{page.attemptCount}</td>
          <td><small>Bắt đầu: {date(page.startedAt)}</small><small>Kết thúc: {date(page.finishedAt)}</small>
            {page.status === 'QUEUED' && page.attemptCount > 0 ? <small>Thử lại sau: {date(page.retryAt)}</small> : null}</td>
          <td><code>{page.failureCode ?? '—'}</code></td>
          <td><button type="button" className="button button--secondary button--small" onClick={() => void copy(diagnostic(page))} aria-label={`Sao chép mã log ${page.pageId}`}><Copy aria-hidden="true" /></button></td>
        </tr>)}</tbody>
      </table>
      {!data?.items.length ? <p>{state.loading ? 'Đang tải danh sách trang…' : 'Chưa có trang phù hợp với bộ lọc.'}</p> : null}
    </div>
    <nav className="render-monitor__pagination" aria-label="Phân trang render">
      <button type="button" className="button button--secondary button--small" disabled={cursors.length === 1 || state.loading} onClick={() => setCursors((values) => values.slice(0, -1))}>Trang trước</button>
      <span>Trang {cursors.length} · tối đa 50 dòng</span>
      <button type="button" className="button button--secondary button--small" disabled={data?.nextAfter == null || state.loading} onClick={() => { if (data?.nextAfter != null) setCursors((values) => [...values, data.nextAfter!]) }}>Trang tiếp</button>
      <button type="button" className="button button--secondary button--small" onClick={() => { setCursors([-1]); setReload((value) => value + 1) }}>Về đầu / cập nhật</button>
    </nav>
    <p className="render-monitor__freshness">Bản chụp: {date(data?.observedAt)} · cập nhật job: {date(data?.updatedAt)}. Bộ lọc đang chạy có thể thay đổi; về đầu để xem trang vừa hoàn tất.</p>
    <p role="status" className="render-monitor__copy-status">{copyMessage}</p>
  </section>
}

function date(value: string | null | undefined) {
  return value ? new Date(value).toLocaleString('vi-VN') : '—'
}

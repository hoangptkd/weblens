import { ArrowRight, Box, Braces, Camera, Check, ChevronRight, Clock3, Database, FileSearch, Gauge, History, Layers3, Menu, Radar, ScanLine, ShieldCheck, Sparkles, X, Zap } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { FormEvent } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { authApi } from '../api/authApi'
import { Brand } from '../components/Brand'
import { ScanVisual } from '../components/ScanVisual'
import { validatePublicUrl } from '../utils/validation'

const features = [
  { icon: ShieldCheck, eyebrow: 'CRAWLER AN TOÀN', title: 'Quét trong giới hạn. Không biến thành crawler vô tận.', text: 'Mỗi lần quét có giới hạn trang, độ sâu, thời gian, chuyển hướng và kích thước phản hồi rõ ràng.', accent: 'mint' },
  { icon: Radar, eyebrow: 'BẰNG CHỨNG KỸ THUẬT', title: 'Nhìn thấy từng trang, không chỉ một con số.', text: 'Theo dõi status code, thời gian phản hồi, title, H1, liên kết và tài nguyên trên từng URL.', accent: 'blue' },
  { icon: Camera, eyebrow: 'BROWSER CAPTURE · V1.5', title: 'Giữ lại trạng thái trang sau khi JavaScript chạy.', text: 'Chromium cô lập ghi lại ảnh chụp, DOM cuối cùng và metadata của CSS, JS, ảnh, font.', accent: 'orange' },
]

const roadmap = [
  ['V2', 'Biết website thay đổi gì', 'So sánh scan và phát hiện regression'],
  ['V3', 'Giải thích vì sao bị lỗi', 'AI phân tích nguyên nhân từ bằng chứng'],
  ['V4', 'Tự động theo dõi website', 'Lịch quét, cảnh báo và monitoring'],
  ['V5', 'Mở rộng nhiều lần quét', 'Queue và distributed workers'],
  ['V6', 'Hỏi đáp trên dữ liệu WebLens', 'RAG và Ask WebLens'],
  ['V7', 'Phát hiện bất thường', 'ML anomaly detection'],
  ['V8', 'Vận hành production', 'Cloud, observability và scaling'],
]

export function LandingPage() {
  const [menuOpen, setMenuOpen] = useState(false)
  const [authenticated, setAuthenticated] = useState<boolean | null>(null)
  const [url, setUrl] = useState('https://')
  const [error, setError] = useState<string | null>(null)
  const navigate = useNavigate()

  useEffect(() => {
    let active = true
    authApi.restore()
      .then(() => { if (active) setAuthenticated(true) })
      .catch(() => { if (active) setAuthenticated(false) })
    return () => { active = false }
  }, [])

  function submitTarget(event: FormEvent) {
    event.preventDefault()
    const validationError = validatePublicUrl(url)
    setError(validationError)
    if (!validationError) navigate('/register', { state: { targetUrl: url } })
  }

  return (
    <div className="marketing-page">
      <a className="skip-link" href="#main-content">Đi đến nội dung chính</a>
      <header className="marketing-header">
        <div className="container nav-wrap">
          <Brand />
          <nav className={`marketing-nav${menuOpen ? ' is-open' : ''}`} id="marketing-menu" aria-label="Điều hướng chính">
            <a href="#platform">Nền tảng</a><a href="#capture">Browser Capture</a><a href="#roadmap">Lộ trình</a><a href="#security">An toàn</a>
          </nav>
          <div className="nav-actions" aria-busy={authenticated === null}>{authenticated === null ? null : authenticated
            ? <Link className="button button--dark button--small" to="/app/websites">Vào dashboard <ArrowRight size={15} /></Link>
            : <><Link className="text-link" to="/login">Đăng nhập</Link><Link className="button button--dark button--small" to="/register">Bắt đầu sử dụng <ArrowRight size={15} /></Link></>}</div>
          <button className="nav-toggle" type="button" aria-expanded={menuOpen} aria-controls="marketing-menu" aria-label={menuOpen ? 'Đóng menu' : 'Mở menu'} onClick={() => setMenuOpen((value) => !value)}>{menuOpen ? <X /> : <Menu />}</button>
        </div>
      </header>

      <main id="main-content">
        <section className="hero-section">
          <div className="hero-grid-bg" aria-hidden="true" />
          <div className="container hero-grid">
            <div className="hero-copy reveal">
              <div className="eyebrow-pill"><span />WEB INTELLIGENCE CHO DEVELOPER</div>
              <h1>Thấy rõ website.<br /><em>Hiểu từng dấu vết.</em></h1>
              <p className="hero-lead">WebLens biến mỗi lần quét thành một hồ sơ kỹ thuật có thể kiểm chứng — từ URL, phản hồi HTTP đến tài nguyên sau khi render.</p>
              <form className="url-form" onSubmit={submitTarget} noValidate>
                <label htmlFor="hero-url">Website bạn muốn quan sát</label>
                <div className="url-input-wrap"><ScanLine aria-hidden="true" /><input id="hero-url" value={url} onChange={(event) => { setUrl(event.target.value); if (error) setError(null) }} aria-invalid={Boolean(error)} aria-describedby={error ? 'hero-url-error' : 'hero-url-help'} /><button type="submit">Đăng ký để quét <ArrowRight size={17} /></button></div>
                {error ? <p className="field-error" id="hero-url-error" role="alert">{error}</p> : <p className="form-help" id="hero-url-help"><Check size={14} aria-hidden="true" /> URL sẽ được giữ cho bước đăng ký và chỉ được quét sau khi bạn xác nhận.</p>}
              </form>
            </div>
            <div className="hero-visual reveal reveal--delay"><div className="orbit orbit--one" aria-hidden="true" /><div className="orbit orbit--two" aria-hidden="true" /><ScanVisual /><div className="floating-note floating-note--top"><Zap size={15} /> Tiến độ tự động</div><div className="floating-note floating-note--bottom"><ShieldCheck size={15} /> Giới hạn an toàn</div></div>
          </div>
          <div className="container trust-strip"><span>Được thiết kế cho</span><strong>SOLO DEVELOPERS</strong><i /><strong>FREELANCERS</strong><i /><strong>SMALL TEAMS</strong><i /><strong>PRODUCTION WEBSITES</strong></div>
        </section>

        <section className="section section--ink" id="platform">
          <div className="container">
            <div className="section-heading section-heading--light"><span className="section-index">01 / NỀN TẢNG</span><h2>Một luồng rõ ràng từ URL<br />đến <em>bằng chứng.</em></h2><p>Không chạy theo điểm số phù phiếm. WebLens lưu lại điều đã quan sát, giới hạn của lần quét và lý do của từng finding.</p></div>
            <div className="feature-grid">{features.map(({ icon: Icon, eyebrow, title, text, accent }) => <article className={`feature-card feature-card--${accent}`} key={title}><div className="feature-icon"><Icon aria-hidden="true" /></div><small>{eyebrow}</small><h3>{title}</h3><p>{text}</p><Link to="/register">Bắt đầu sử dụng <ChevronRight size={16} /></Link></article>)}</div>
          </div>
        </section>

        <section className="section evidence-section">
          <div className="container split-layout">
            <div className="evidence-board">
              <div className="board-header"><span><i className="pulse" /> MINH HỌA LẦN QUÉT</span><strong>12 / 18 trang</strong></div>
              <div className="board-line"><div><small>URL HIỆN TẠI</small><strong>evomi.com/locations</strong></div><span className="code red">503</span></div>
              <div className="metric-row"><div><Gauge /><span><small>Response time</small><strong>684 ms</strong></span></div><div><Database /><span><small>HTML size</small><strong>341.6 KB</strong></span></div></div>
              <div className="finding-card"><span className="warning-mark">!</span><div><small>FINDING · RULE HTML_SIZE_V1</small><strong>HTML có kích thước lớn</strong><p>Bằng chứng: 341.600 bytes vượt ngưỡng 300.000 bytes.</p></div></div>
              <div className="event-log"><span><i className="ok-dot" />11 trang thành công</span><span><i className="warn-dot" />1 trang thất bại</span><span><Clock3 />00:18</span></div>
            </div>
            <div className="section-copy"><span className="section-index">02 / QUAN SÁT</span><h2>Tiến độ không phải<br />một spinner bí ẩn.</h2><p>Mỗi trạng thái đều có ý nghĩa: đang chờ, đang chạy, hoàn tất một phần, thất bại hay đã hủy. Kết quả thiếu không bao giờ được trình bày như một lần quét hoàn chỉnh.</p><ul className="check-list"><li><Check />Counters nhất quán theo giới hạn cấu hình</li><li><Check />Cập nhật định kỳ từ Control Plane</li><li><Check />Hủy hợp tác, vẫn đọc được kết quả đã thu thập</li></ul><Link className="arrow-link" to="/register">Tạo lần quét đầu tiên <ArrowRight /></Link></div>
          </div>
        </section>

        <section className="section capture-section" id="capture">
          <div className="container">
            <div className="section-heading"><span className="section-index">03 / WEBLENS V1.5</span><h2>Không chỉ tải HTML.<br /><em>Chụp lại trang đã sống.</em></h2><p>Browser Worker tách biệt mở trang bằng Chromium và ghi nhận những gì thực sự xuất hiện sau khi JavaScript chạy.</p></div>
            <div className="capture-layout">
              <div className="browser-frame"><div className="browser-bar"><span className="window-dots"><i /><i /><i /></span><span>evomi.com</span><Camera size={15} /></div><div className="site-preview"><div className="site-preview-nav"><span /><span /><span /></div><div className="site-preview-title"><i /><i /></div><div className="site-preview-cards"><span /><span /><span /></div><div className="scan-overlay"><small>MINH HỌA CAPTURE</small><strong>DOM, screenshot và network evidence</strong><div><span>DOM cuối</span><span>Ảnh chụp</span><span>Network</span></div></div></div></div>
              <div className="capture-list"><article><span>01</span><div><Braces /><h3>DOM sau render</h3><p>Giữ lại cấu trúc cuối cùng để điều tra khác biệt giữa HTML ban đầu và UI thực tế.</p></div></article><article><span>02</span><div><Camera /><h3>Ảnh chụp có ngữ cảnh</h3><p>Biết trang trông như thế nào tại đúng thời điểm capture, không phải phỏng đoán.</p></div></article><article><span>03</span><div><Layers3 /><h3>CSS, JS, ảnh và font</h3><p>Metadata tài nguyên được lọc, phân loại và giới hạn trước khi lưu trữ.</p></div></article></div>
            </div>
          </div>
        </section>

        <section className="section workflow-section">
          <div className="container"><div className="section-heading section-heading--center"><span className="section-index">04 / LUỒNG SẢN PHẨM</span><h2>Từ đăng ký đến snapshot<br />trong một đường thẳng.</h2></div><ol className="workflow"><li><span>01</span><div className="workflow-icon"><Box /></div><h3>Thêm website</h3><p>Chuẩn hóa target HTTP(S) và xác định phạm vi.</p></li><li><span>02</span><div className="workflow-icon"><ScanLine /></div><h3>Chạy scan</h3><p>Crawl có giới hạn, trạng thái và tiến độ rõ ràng.</p></li><li><span>03</span><div className="workflow-icon"><FileSearch /></div><h3>Đọc report</h3><p>Đi từ summary xuống bằng chứng của từng page.</p></li><li><span>04</span><div className="workflow-icon"><Camera /></div><h3>Tạo capture</h3><p>Render bằng browser worker và xem tài nguyên.</p></li></ol></div>
        </section>

        <section className="section roadmap-section" id="roadmap">
          <div className="container roadmap-layout"><div className="roadmap-intro"><span className="section-index">05 / ROADMAP</span><h2>Xây độ phức tạp<br />khi có lý do.</h2><p>WebLens bắt đầu bằng bằng chứng deterministic. Mỗi lớp AI, distributed system hay cloud chỉ xuất hiện khi phiên bản trước đã tạo đủ dữ liệu và nhu cầu.</p><span className="future-label">Các tính năng dưới đây chưa hoạt động</span></div><div className="roadmap-list">{roadmap.map(([version, title, detail]) => <div className="roadmap-item" key={version}><span>{version}</span><div><strong>{title}</strong><small>{detail}</small></div><History aria-hidden="true" /></div>)}</div></div>
        </section>

        <section className="section security-section" id="security"><div className="container security-card"><div><ShieldCheck /><span className="section-index">AN TOÀN LÀ HÀNH VI SẢN PHẨM</span><h2>Internet là dữ liệu không tin cậy.</h2><p>WebLens thiết kế crawler quanh SSRF defense, giới hạn tài nguyên và worker cô lập — không phải thêm chúng vào phút cuối.</p></div><ul><li><Check />Chỉ HTTP và HTTPS</li><li><Check />Kiểm tra lại mọi redirect</li><li><Check />Chặn private và metadata IP</li><li><Check />Không thực thi script trong API</li></ul></div></section>

        <section className="cta-section"><div className="cta-grid" aria-hidden="true" /><div className="container cta-content"><Sparkles aria-hidden="true" /><h2>Bắt đầu với một URL.<br />Kết thúc bằng bằng chứng.</h2><p>Tạo tài khoản và chạy luồng WebLens trên dữ liệu thật của website bạn quản lý.</p><Link className="button button--light" to="/register">Tạo tài khoản <ArrowRight /></Link></div></section>
      </main>

      <footer className="marketing-footer"><div className="container footer-top"><Brand inverse /><p>Nền tảng website intelligence dựa trên bằng chứng, dành cho developer.</p><div><Link to="/app/websites">Dashboard</Link><a href="#platform">Nền tảng</a><a href="#roadmap">Roadmap</a></div></div><div className="container footer-bottom"><span>© 2026 WebLens</span><span>Control Plane · Crawler · Browser Capture</span></div></footer>
    </div>
  )
}

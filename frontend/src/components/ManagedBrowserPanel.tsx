import { useEffect, useRef, useState } from 'react'
import type { FormEvent, MouseEvent } from 'react'
import { ApiError } from '../api/apiClient'
import { webLensService } from '../api/webLensApiService'
import type { SiteCloneBrowserAction, SiteCloneBrowserSession } from '../domain/types'

interface Props {
  siteCloneId: string
  autoStart: boolean
}

export function ManagedBrowserPanel({ siteCloneId, autoStart }: Props) {
  const [session, setSession] = useState<SiteCloneBrowserSession | null>(null)
  const [screenshotUrl, setScreenshotUrl] = useState<string | null>(null)
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const screenshotRef = useRef<string | null>(null)

  useEffect(() => () => {
    if (screenshotRef.current) URL.revokeObjectURL(screenshotRef.current)
  }, [])

  useEffect(() => {
    if (!autoStart) return
    void start()
    // The clone id is the idempotency boundary for the worker session.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoStart, siteCloneId])

  useEffect(() => {
    if (!session || session.status === 'READY') return
    const timer = window.setInterval(() => { void refresh() }, 1_500)
    return () => window.clearInterval(timer)
    // Polling follows the session lifecycle, not every screenshot URL change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.status, siteCloneId])

  function clearSession() {
    if (screenshotRef.current) URL.revokeObjectURL(screenshotRef.current)
    screenshotRef.current = null
    setScreenshotUrl(null)
    setSession(null)
    setText('')
  }

  async function start() {
    setBusy(true)
    setError(null)
    try {
      setSession(await webLensService.startSiteCloneBrowserSession(siteCloneId))
      await refresh()
    } catch (requestError) {
      setError(message(requestError, 'Không thể mở phiên trình duyệt đăng nhập.'))
    } finally {
      setBusy(false)
    }
  }

  async function refresh() {
    try {
      const [nextSession, screenshot] = await Promise.all([
        webLensService.getSiteCloneBrowserSession(siteCloneId),
        webLensService.getSiteCloneBrowserScreenshot(siteCloneId),
      ])
      const nextUrl = URL.createObjectURL(screenshot)
      if (screenshotRef.current) URL.revokeObjectURL(screenshotRef.current)
      screenshotRef.current = nextUrl
      setScreenshotUrl(nextUrl)
      setSession(nextSession)
      setError(null)
    } catch (requestError) {
      if (sessionUnavailable(requestError)) clearSession()
      setError(message(requestError, 'Không cập nhật được phiên trình duyệt.'))
    }
  }

  async function send(action: SiteCloneBrowserAction) {
    setBusy(true)
    setError(null)
    try {
      setSession(await webLensService.sendSiteCloneBrowserAction(siteCloneId, action))
      await refresh()
    } catch (requestError) {
      if (sessionUnavailable(requestError)) clearSession()
      setError(message(requestError, 'Không gửi được thao tác tới trình duyệt.'))
    } finally {
      setBusy(false)
    }
  }

  function submitText(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!text) return
    const value = text
    setText('')
    void send({ type: 'type', text: value })
  }

  function clickScreenshot(event: MouseEvent<HTMLButtonElement>) {
    if (!session) return
    const rectangle = event.currentTarget.getBoundingClientRect()
    const x = Math.round((event.clientX - rectangle.left) * session.viewportWidth / rectangle.width)
    const y = Math.round((event.clientY - rectangle.top) * session.viewportHeight / rectangle.height)
    void send({ type: 'click', x: Math.max(0, Math.min(session.viewportWidth - 1, x)), y: Math.max(0, Math.min(session.viewportHeight - 1, y)) })
  }

  async function ready() {
    setBusy(true)
    setError(null)
    try {
      setSession(await webLensService.readySiteCloneBrowserSession(siteCloneId))
    } catch (requestError) {
      if (sessionUnavailable(requestError)) clearSession()
      setError(message(requestError, 'Không thể xác nhận đăng nhập.'))
    } finally {
      setBusy(false)
    }
  }

  async function close() {
    setBusy(true)
    try {
      await webLensService.closeSiteCloneBrowserSession(siteCloneId)
      clearSession()
      setError(null)
    } catch (requestError) {
      setError(message(requestError, 'Không thể đóng phiên trình duyệt.'))
    } finally {
      setBusy(false)
    }
  }

  if (!session) {
    return <section className="managed-browser" aria-busy={busy}><h3>Website cần đăng nhập?</h3><p>Mở trình duyệt tạm thời để tự nhập tài khoản hoặc OTP. Phiên tự xóa sau 10 phút.</p><button className="button button--secondary" type="button" onClick={() => void start()} disabled={busy}>{busy ? 'Đang mở…' : 'Mở phiên đăng nhập'}</button>{error ? <p role="alert" className="clone-alert">{error}</p> : null}</section>
  }

  return <section className="managed-browser" aria-busy={busy}>
    <header><div><h3>Trình duyệt đăng nhập tạm thời</h3><p>{session.currentUrl || 'Đang tải trang…'} · hết hạn {new Date(session.expiresAt).toLocaleTimeString('vi-VN')}</p></div><button className="button button--danger-ghost button--small" type="button" onClick={() => void close()} disabled={busy}>Đóng phiên</button></header>
    {session.status === 'READY' ? <p className="managed-browser__ready" role="status">Đã xác nhận. Renderer đang dùng cookie trong bộ nhớ của phiên này.</p> : <>
      {screenshotUrl ? <button className="managed-browser__screen" type="button" onClick={clickScreenshot} disabled={busy} aria-label="Nhấp vào vị trí tương ứng trong trang web"><img src={screenshotUrl} alt="" /></button> : <p role="status">Đang lấy ảnh trình duyệt…</p>}
      <p className="managed-browser__help">Nhấp vào ô trên ảnh, nhập nội dung bên dưới rồi gửi. WebLens không ghi nội dung phím vào log.</p>
      <form className="managed-browser__input" onSubmit={submitText}>
        <label htmlFor={`browser-text-${siteCloneId}`}>Email, mật khẩu hoặc OTP</label>
        <div><input id={`browser-text-${siteCloneId}`} type="password" value={text} onChange={(event) => setText(event.target.value)} autoComplete="off" maxLength={4096} /><button className="button button--secondary button--small" type="submit" disabled={busy || !text}>Gửi nội dung</button></div>
      </form>
      <div className="managed-browser__actions" aria-label="Phím và cuộn trang">
        {(['Tab', 'Enter', 'Backspace', 'Escape'] as const).map((key) => <button key={key} className="button button--secondary button--small" type="button" disabled={busy} onClick={() => void send({ type: 'key', key })}>{key}</button>)}
        <button className="button button--secondary button--small" type="button" disabled={busy} onClick={() => void send({ type: 'scroll', deltaY: 700 })}>Cuộn xuống</button>
        <button className="button button--secondary button--small" type="button" disabled={busy} onClick={() => void send({ type: 'scroll', deltaY: -700 })}>Cuộn lên</button>
        <button className="button button--primary button--small" type="button" disabled={busy} onClick={() => void ready()}>Tôi đã đăng nhập — tiếp tục clone</button>
      </div>
    </>}
    {error ? <p role="alert" className="clone-alert">{error}</p> : null}
  </section>
}

function message(error: unknown, fallback: string): string {
  if (sessionUnavailable(error)) return 'Phiên trình duyệt đã đóng. Mở lại phiên đăng nhập để tiếp tục.'
  return error instanceof Error ? error.message : fallback
}

function sessionUnavailable(error: unknown): boolean {
  return error instanceof ApiError
    && (error.code === 'BROWSER_SESSION_NOT_FOUND' || error.code === 'BROWSER_SESSION_UNAVAILABLE')
}

import type { Browser, BrowserContext, Page } from 'playwright'
import {
  browserContextSizeOptions,
  launchCaptureBrowser,
  closeCaptureBrowser,
  observeTurnstileErrors,
  readBrowserSettings,
} from './browser.js'
import { SafeProxy } from './safe-proxy.js'
import { assertPublicHttpUrl } from './security.js'

const SESSION_TTL_MS = 10 * 60 * 1_000
const MAX_SESSIONS = 1
const VIEWPORT = { width: 1365, height: 768 }
const allowedKeys = new Set([
  'Enter', 'Tab', 'Escape', 'Backspace', 'Delete',
  'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown',
])

export type BrowserSessionAction =
  | { type: 'click'; x: number; y: number }
  | { type: 'type'; text: string }
  | { type: 'key'; key: string }
  | { type: 'scroll'; deltaY: number }

export interface BrowserSessionStatus {
  status: 'AWAITING_USER' | 'READY'
  currentUrl: string
  expiresAt: string
  viewportWidth: number
  viewportHeight: number
}

export interface BrowserSessionHandle {
  context: BrowserContext
  browserVersion: string
}

interface BrowserSession {
  ownerId: string
  siteCloneId: string
  browser: Browser
  context: BrowserContext
  proxy: SafeProxy
  activePage: Page
  viewportWidth: number
  viewportHeight: number
  status: BrowserSessionStatus['status']
  expiresAt: number
  timer: NodeJS.Timeout
  waiters: Set<(handle: BrowserSessionHandle | null) => void>
}

export class InteractiveBrowserSessionManager {
  private readonly sessions = new Map<string, BrowserSession>()
  private starting = 0

  async start(ownerId: string, siteCloneId: string, targetUrl: string): Promise<BrowserSessionStatus> {
    const existing = this.owned(ownerId, siteCloneId)
    if (existing) return this.toStatus(existing)
    if (this.sessions.has(siteCloneId)) throw new Error('BROWSER_SESSION_NOT_FOUND')
    if (this.sessions.size + this.starting >= MAX_SESSIONS) throw new Error('BROWSER_SESSION_CAPACITY_REACHED')
    await assertPublicHttpUrl(targetUrl)

    this.starting += 1
    const proxy = new SafeProxy()
    let browser: Browser | null = null
    let context: BrowserContext | null = null
    try {
      await proxy.start()
      const browserSettings = readBrowserSettings()
      browser = await launchCaptureBrowser(proxy.url(), { ...browserSettings, viewport: VIEWPORT })
      context = await browser.newContext({
        ...browserContextSizeOptions(browserSettings.engine, VIEWPORT),
        acceptDownloads: false,
        javaScriptEnabled: true,
        serviceWorkers: 'block',
      })
      await protectContext(context)
      const page = await context.newPage()
      observeTurnstileErrors(page, siteCloneId)
      const expiresAt = Date.now() + SESSION_TTL_MS
      const session: BrowserSession = {
        ownerId,
        siteCloneId,
        browser,
        context,
        proxy,
        activePage: page,
        viewportWidth: VIEWPORT.width,
        viewportHeight: VIEWPORT.height,
        status: 'AWAITING_USER',
        expiresAt,
        timer: setTimeout(() => { void this.closeById(siteCloneId) }, SESSION_TTL_MS),
        waiters: new Set(),
      }
      session.timer.unref()
      context.on('page', (openedPage) => {
        observeTurnstileErrors(openedPage, siteCloneId)
        session.activePage = openedPage
      })
      this.sessions.set(siteCloneId, session)
      browser.on('disconnected', () => {
        if (this.sessions.get(siteCloneId) === session) void this.closeById(siteCloneId)
      })
      try {
        await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 })
      } catch {
        if (page.url() === 'about:blank') throw new Error('BROWSER_SESSION_NAVIGATION_FAILED')
      }
      const measured = await measuredViewport(page)
      session.viewportWidth = measured.width
      session.viewportHeight = measured.height
      return this.toStatus(session)
    } catch (error) {
      await context?.close().catch(() => undefined)
      if (browser) await closeCaptureBrowser(browser).catch(() => undefined)
      await proxy.close().catch(() => undefined)
      this.sessions.delete(siteCloneId)
      throw error
    } finally {
      this.starting -= 1
    }
  }

  status(ownerId: string, siteCloneId: string): BrowserSessionStatus | null {
    const session = this.owned(ownerId, siteCloneId)
    return session ? this.toStatus(session) : null
  }

  async screenshot(ownerId: string, siteCloneId: string): Promise<Buffer | null> {
    const session = this.owned(ownerId, siteCloneId)
    if (!session) return null
    return Buffer.from(await this.page(session).screenshot({ type: 'jpeg', quality: 75, fullPage: false }))
  }

  async act(ownerId: string, siteCloneId: string, rawAction: unknown): Promise<BrowserSessionStatus | null> {
    const session = this.owned(ownerId, siteCloneId)
    if (!session) return null
    if (session.status !== 'AWAITING_USER') throw new Error('BROWSER_SESSION_ALREADY_READY')
    const action = validateBrowserSessionAction(rawAction, {
      width: session.viewportWidth,
      height: session.viewportHeight,
    })
    const page = this.page(session)
    if (action.type === 'click') await page.mouse.click(action.x, action.y)
    else if (action.type === 'type') await page.keyboard.insertText(action.text)
    else if (action.type === 'key') await page.keyboard.press(action.key)
    else await page.mouse.wheel(0, action.deltaY)
    return this.toStatus(session)
  }

  ready(ownerId: string, siteCloneId: string): BrowserSessionStatus | null {
    const session = this.owned(ownerId, siteCloneId)
    if (!session) return null
    session.status = 'READY'
    const handle = this.handle(session)
    for (const waiter of session.waiters) waiter(handle)
    session.waiters.clear()
    return this.toStatus(session)
  }

  async waitForReady(ownerId: string, siteCloneId: string, timeoutMillis: number): Promise<BrowserSessionHandle | null> {
    const session = this.owned(ownerId, siteCloneId)
    if (!session) return null
    if (session.status === 'READY') return this.handle(session)
    return new Promise((resolve) => {
      const finish = (handle: BrowserSessionHandle | null) => {
        clearTimeout(timer)
        session.waiters.delete(finish)
        resolve(handle)
      }
      const timer = setTimeout(() => finish(null), Math.max(1, Math.min(timeoutMillis, session.expiresAt - Date.now())))
      timer.unref()
      session.waiters.add(finish)
    })
  }

  async close(ownerId: string, siteCloneId: string): Promise<boolean> {
    if (!this.owned(ownerId, siteCloneId)) return false
    await this.closeById(siteCloneId)
    return true
  }

  async closeAll(): Promise<void> {
    await Promise.allSettled([...this.sessions.keys()].map((siteCloneId) => this.closeById(siteCloneId)))
  }

  private owned(ownerId: string, siteCloneId: string): BrowserSession | null {
    const session = this.sessions.get(siteCloneId)
    if (!session || session.ownerId !== ownerId) return null
    if (session.expiresAt <= Date.now() || !session.browser.isConnected()
        || (session.activePage.isClosed() && session.context.pages().every((page) => page.isClosed()))) {
      void this.closeById(siteCloneId)
      return null
    }
    return session
  }

  private page(session: BrowserSession): Page {
    if (!session.activePage.isClosed()) return session.activePage
    const open = session.context.pages().filter((page) => !page.isClosed()).at(-1)
    if (!open) throw new Error('BROWSER_SESSION_PAGE_CLOSED')
    session.activePage = open
    return open
  }

  private toStatus(session: BrowserSession): BrowserSessionStatus {
    return {
      status: session.status,
      currentUrl: publicUrl(this.page(session).url()),
      expiresAt: new Date(session.expiresAt).toISOString(),
      viewportWidth: session.viewportWidth,
      viewportHeight: session.viewportHeight,
    }
  }

  private handle(session: BrowserSession): BrowserSessionHandle {
    return { context: session.context, browserVersion: session.browser.version() }
  }

  private async closeById(siteCloneId: string): Promise<void> {
    const session = this.sessions.get(siteCloneId)
    if (!session) return
    this.sessions.delete(siteCloneId)
    clearTimeout(session.timer)
    for (const waiter of session.waiters) waiter(null)
    session.waiters.clear()
    await session.context.close().catch(() => undefined)
    await closeCaptureBrowser(session.browser).catch(() => undefined)
    await session.proxy.close().catch(() => undefined)
  }
}

export function validateBrowserSessionAction(
  value: unknown,
  viewport: { width: number; height: number } = VIEWPORT,
): BrowserSessionAction {
  if (!value || typeof value !== 'object') throw new Error('INVALID_BROWSER_ACTION')
  const action = value as Record<string, unknown>
  if (action['type'] === 'click' && validInteger(action['x'], 0, viewport.width - 1)
      && validInteger(action['y'], 0, viewport.height - 1)) {
    return { type: 'click', x: Number(action['x']), y: Number(action['y']) }
  }
  if (action['type'] === 'type' && typeof action['text'] === 'string'
      && action['text'].length > 0 && action['text'].length <= 4_096) {
    return { type: 'type', text: action['text'] }
  }
  if (action['type'] === 'key' && typeof action['key'] === 'string' && allowedKeys.has(action['key'])) {
    return { type: 'key', key: action['key'] }
  }
  if (action['type'] === 'scroll' && validInteger(action['deltaY'], -2_000, 2_000)
      && action['deltaY'] !== 0) {
    return { type: 'scroll', deltaY: Number(action['deltaY']) }
  }
  throw new Error('INVALID_BROWSER_ACTION')
}

async function measuredViewport(page: Page): Promise<{ width: number; height: number }> {
  const value = await page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight })).catch(() => VIEWPORT)
  return validInteger(value.width, 320, 4_096) && validInteger(value.height, 200, 4_096) ? value : VIEWPORT
}

async function protectContext(context: BrowserContext): Promise<void> {
  await context.route('**/*', async (route) => {
    try {
      const target = route.request().url()
      if (!target.startsWith('data:') && !target.startsWith('blob:')) await assertPublicHttpUrl(target)
      await route.continue()
    } catch {
      await route.abort('blockedbyclient')
    }
  })
}

function validInteger(value: unknown, minimum: number, maximum: number): boolean {
  return Number.isInteger(value) && Number(value) >= minimum && Number(value) <= maximum
}

function publicUrl(raw: string): string {
  try {
    const url = new URL(raw)
    url.username = ''
    url.password = ''
    url.search = ''
    url.hash = ''
    return url.toString().slice(0, 8_192)
  } catch {
    return ''
  }
}

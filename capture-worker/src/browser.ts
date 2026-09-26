import { chromium, type Browser, type BrowserContextOptions, type LaunchOptions, type Page } from 'playwright'
import { Camoufox } from 'camoufox-js'
import { addExtra } from 'playwright-extra'
import StealthPlugin from 'puppeteer-extra-plugin-stealth'
import { log } from './log.js'
export async function closeCaptureBrowser(browser: Browser): Promise<void> { await browser.close() }
const observedPages = new WeakSet<Page>()
const browserEnvironmentNames = ['DISPLAY', 'HOME', 'LANG', 'LD_LIBRARY_PATH', 'PATH', 'XAUTHORITY'] as const
const windowsBrowserEnvironmentNames = ['SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA'] as const

export type BrowserEngine = 'playwright' | 'camoufox'

interface BrowserLaunchSettings {
  engine?: BrowserEngine
  headless: boolean
  stealth: boolean
  viewport?: { width: number; height: number }
}

export function turnstileConsoleCode(sourceUrl: string, message: string): string | null {
  try {
    if (new URL(sourceUrl).origin !== 'https://challenges.cloudflare.com') return null
  } catch { return null }
  // Extract an allowlisted field only. Never persist the raw console text or source URL.
  return /^\[Cloudflare Turnstile\]\s+Error:\s*(\d{6})(?:\.|\s|$)/u.exec(message.slice(0, 128))?.[1] ?? null
}

export function observeTurnstileErrors(page: Page, operationId: string): void {
  if (observedPages.has(page)) return
  observedPages.add(page)
  const seen = new Set<string>()
  page.on('console', (message) => {
    if (seen.size >= 5) return
    const code = turnstileConsoleCode(message.location().url, message.text())
    if (!code || seen.has(code)) return
    seen.add(code)
    log('warn', 'browser verification failed', { operationId, provider: 'turnstile', errorCode: code })
  })
}

export function readBrowserSettings(env: NodeJS.ProcessEnv = process.env) {
  function flag(name: string, fallback: boolean): boolean {
    const value = env[name]?.trim()
    if (!value) return fallback
    if (value === 'true') return true
    if (value === 'false') return false
    throw new Error(`${name} must be true or false`)
  }
  const rawEngine = env.CAPTURE_BROWSER_ENGINE?.trim() || 'camoufox'
  if (rawEngine !== 'playwright' && rawEngine !== 'camoufox') {
    throw new Error('INVALID_CAPTURE_BROWSER_ENGINE')
  }
  const engine: BrowserEngine = rawEngine
  return {
    engine,
    headless: flag('CAPTURE_BROWSER_HEADLESS', true),
    stealth: flag('CAPTURE_BROWSER_STEALTH', false),
  }
}

// Both ordinary captures and managed login sessions must keep the same egress policy.
export async function launchCaptureBrowser(
  proxyUrl: string,
  settings: BrowserLaunchSettings = readBrowserSettings(),
): Promise<Browser> {
  const proxy = new URL(proxyUrl)
  if (proxy.protocol !== 'http:' || proxy.hostname !== '127.0.0.1' || !proxy.port
      || proxy.username || proxy.password || proxy.pathname !== '/' || proxy.search || proxy.hash) {
    throw new Error('INVALID_CAPTURE_PROXY')
  }
  if (settings.engine === 'camoufox') {
    if (process.platform !== 'linux' && process.platform !== 'win32') throw new Error('CAMOUFOX_PLATFORM_UNSUPPORTED')
    return await Camoufox({
      headless: settings.headless,
      os: process.platform === 'win32' ? 'windows' : 'linux',
      humanize: true,
      block_webrtc: true,
      exclude_addons: ['UBO'],
      proxy: { server: proxyUrl },
      firefox_user_prefs: {
        // Windows Session 0 can fail-fast in native gamepad discovery. Capture/login
        // needs mouse and keyboard, not physical controllers; disable before startup.
        ...(process.platform === 'win32' && settings.headless ? { 'dom.gamepad.enabled': false } : {}),
        // Firefox normally bypasses proxies for loopback. WebLens requires every
        // HTTP(S) request to reach SafeProxy so DNS rebinding/private egress stays blocked.
        'network.proxy.allow_hijacking_localhost': true,
        'network.proxy.testing_localhost_is_secure_when_hijacked': true,
      },
      env: camoufoxEnvironment(),
      ...(settings.viewport ? { window: [settings.viewport.width, settings.viewport.height] } : {}),
      handleSIGHUP: false,
      handleSIGINT: false,
      handleSIGTERM: false,
    }) as Browser
  }
  if (settings.engine && settings.engine !== 'playwright') throw new Error('INVALID_CAPTURE_BROWSER_ENGINE')
  const options: LaunchOptions = { headless: settings.headless, proxy: { server: proxyUrl } }
  if (!settings.stealth) return chromium.launch(options)

  // Independent plugin state per browser: concurrent launches must not share mutable hooks.
  const launcher = addExtra(chromium)
  const stealth = StealthPlugin()
  // Preserve extension restrictions and avoid the plugin's disk profile preferences/OS spoofing.
  // Headed Chromium supplies its own current-version UA; do not hard-code an unrelated platform.
  stealth.enabledEvasions.delete('defaultArgs')
  stealth.enabledEvasions.delete('user-agent-override')
  launcher.use(stealth)
  return launcher.launch(options)
}

export function camoufoxEnvironment(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): Record<string, string> {
  const names: readonly string[] = platform === 'win32'
    ? [...browserEnvironmentNames, ...windowsBrowserEnvironmentNames]
    : browserEnvironmentNames
  return Object.fromEntries(names.flatMap((name) => env[name] === undefined ? [] : [[name, env[name]!]]))
}

export function browserContextSizeOptions(
  engine: BrowserEngine,
  viewport: { width: number; height: number },
): Pick<BrowserContextOptions, 'viewport' | 'deviceScaleFactor'> {
  // Camoufox pins window dimensions in the engine. An explicit Playwright viewport
  // sends a Firefox protocol field unsupported by the current pinned browser.
  return engine === 'camoufox' ? { viewport: null } : { viewport, deviceScaleFactor: 1 }
}

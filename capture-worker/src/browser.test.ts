import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createServer } from 'node:net'
import { readdir, readFile } from 'node:fs/promises'
import {
  browserContextSizeOptions,
  camoufoxEnvironment,
  launchCaptureBrowser,
  closeCaptureBrowser,
  readBrowserSettings,
  turnstileConsoleCode,
  observeTurnstileErrors,
  type BrowserEngine,
} from './browser.js'
import { EventEmitter } from 'node:events'
import type { Page } from 'playwright'
import { SafeProxy } from './safe-proxy.js'

test('Turnstile diagnostics extract only numeric codes from the expected script origin', () => {
  const source = 'https://challenges.cloudflare.com/turnstile/v0/api.js?secret=not-for-logs'
  assert.equal(turnstileConsoleCode(source, '[Cloudflare Turnstile] Error: 600010. token=private'), '600010')
  assert.equal(turnstileConsoleCode('https://example.com/api.js', '[Cloudflare Turnstile] Error: 600010.'), null)
  assert.equal(turnstileConsoleCode('https://challenges.cloudflare.com.evil.test/', '[Cloudflare Turnstile] Error: 600010.'), null)
  assert.equal(turnstileConsoleCode('not a URL', '[Cloudflare Turnstile] Error: 600010.'), null)
  assert.equal(turnstileConsoleCode(source, 'token 123456'), null)
  assert.equal(turnstileConsoleCode(source, '[Cloudflare Turnstile] Error: 6000101.'), null)
})

test('browser diagnostics deduplicate, cap volume and never log console bodies or source URLs', (t) => {
  const output: string[] = []
  t.mock.method(process.stdout, 'write', (value: string) => { output.push(value); return true })
  const page = new EventEmitter()
  observeTurnstileErrors(page as unknown as Page, 'operation-1')
  observeTurnstileErrors(page as unknown as Page, 'operation-1')
  for (const code of ['600010', '600010', '300010', '200500', '110600', '110620', '400020']) {
    page.emit('console', {
      location: () => ({url:'https://challenges.cloudflare.com/api.js?token=private'}),
      text: () => `[Cloudflare Turnstile] Error: ${code}. credential=private`,
    })
  }
  assert.equal(output.length, 5)
  assert.equal(JSON.parse(output[0]!).errorCode, '600010')
  assert.ok(output.every(line => !line.includes('private') && !line.includes('https://')))
})

test('browser settings default to Camoufox and reject removed engines', () => {
  assert.deepEqual(readBrowserSettings({}), { engine: 'camoufox', headless: true, stealth: false })
  assert.deepEqual(readBrowserSettings({ CAPTURE_BROWSER_HEADLESS: 'false', CAPTURE_BROWSER_STEALTH: 'true' }),
    { engine: 'camoufox', headless: false, stealth: true })
  assert.equal(readBrowserSettings({ CAPTURE_BROWSER_ENGINE: 'playwright' }).engine, 'playwright')
  assert.equal(readBrowserSettings({ CAPTURE_BROWSER_ENGINE: 'camoufox' }).engine, 'camoufox')
  assert.throws(() => readBrowserSettings({ CAPTURE_BROWSER_ENGINE: 'seleniumbase' }), /INVALID_CAPTURE_BROWSER_ENGINE/)
  assert.throws(() => readBrowserSettings({ CAPTURE_BROWSER_ENGINE: 'unknown' }), /INVALID_CAPTURE_BROWSER_ENGINE/)
  assert.throws(() => readBrowserSettings({ CAPTURE_BROWSER_HEADLESS: 'FALSE' }), /CAPTURE_BROWSER_HEADLESS/)
  assert.throws(() => readBrowserSettings({ CAPTURE_BROWSER_STEALTH: '1' }), /CAPTURE_BROWSER_STEALTH/)
})

test('Camoufox receives only allowlisted process environment and a compatible context size', () => {
  assert.deepEqual(camoufoxEnvironment({ PATH: '/bin', DISPLAY: ':99', DATABASE_URL: 'secret' }), {
    DISPLAY: ':99', PATH: '/bin',
  })
  assert.deepEqual(camoufoxEnvironment({ PATH: 'C:\\Windows', SystemRoot: 'C:\\Windows', TEMP: 'C:\\Temp',
    DATABASE_URL: 'secret' }, 'win32'), { PATH: 'C:\\Windows', SystemRoot: 'C:\\Windows', TEMP: 'C:\\Temp' })
  assert.deepEqual(browserContextSizeOptions('camoufox', { width: 1365, height: 768 }), { viewport: null })
  assert.deepEqual(browserContextSizeOptions('playwright', { width: 1365, height: 768 }), {
    viewport: { width: 1365, height: 768 }, deviceScaleFactor: 1,
  })
})

test('browser launcher accepts only its local SafeProxy', async () => {
  for (const stealth of [false, true]) {
    for (const url of ['http://proxy.example:1234', 'http://user:pass@127.0.0.1:1234', 'http://127.0.0.1:1234/?token=x']) {
      await assert.rejects(launchCaptureBrowser(url, { headless: true, stealth }), /INVALID_CAPTURE_PROXY/)
    }
  }
})

// Opt-in browser smoke, no third-party requests or application data required.
for (const engine of ['playwright', 'camoufox'] satisfies BrowserEngine[]) {
 for (const headless of [true, false]) {
  for (const stealth of (engine === 'playwright' ? [false, true] : [false])) {
    test(`browser smoke: engine=${engine}, headless=${headless}, stealth=${stealth}`, {
      skip: process.env.WEBLENS_BROWSER_SMOKE !== 'true', timeout: 60_000,
    }, async () => {
      const proxy = new SafeProxy()
      await proxy.start()
      let privateConnections = 0
      const privateServer = createServer((socket) => {
        privateConnections += 1
        socket.destroy()
      })
      await new Promise<void>((resolve) => privateServer.listen(0, '127.0.0.1', resolve))
      let browser: Awaited<ReturnType<typeof launchCaptureBrowser>> | undefined
      try {
        const viewport = { width: 1365, height: 768 }
        browser = await launchCaptureBrowser(proxy.url(), { engine, headless, stealth, viewport })
        const context = await browser.newContext({
          ...browserContextSizeOptions(engine, viewport),
          acceptDownloads: false, javaScriptEnabled: true, serviceWorkers: 'block',
        })
        await context.route('https://example.com/**', (route) => route.fulfill({
          contentType: 'text/html', body: '<title>Local browser fixture</title><main>Fixture</main>',
        }))
        const page = await context.newPage()
        await context.route('https://challenges.cloudflare.com/fixture.js', (route) => route.fulfill({
          contentType: 'application/javascript', body: 'console.warn("[Cloudflare Turnstile] Error: 600010.")',
        }))
        const observedCodes: string[] = []
        page.on('console', message => {
          const code = turnstileConsoleCode(message.location().url, message.text())
          if (code) observedCodes.push(code)
        })
        await page.goto('https://example.com/fixture')
        if (engine === 'camoufox' && process.platform === 'win32' && headless) {
          // Regression: either API polling or registering a listener must not start
          // Windows.Gaming.Input in a noninteractive service and kill the browser.
          assert.equal(await page.evaluate(() => {
            window.addEventListener('gamepadconnected', () => undefined)
            navigator.getGamepads?.()
            return typeof navigator.getGamepads
          }), 'undefined')
          await new Promise<void>((resolve) => setTimeout(resolve, 5_000))
          assert.ok(browser.isConnected())
          await page.setContent('<input aria-label="Login"><button>Continue</button>')
          await page.getByRole('textbox', { name: 'Login' }).click()
          await page.keyboard.insertText('fixture-user')
          assert.equal(await page.getByRole('textbox', { name: 'Login' }).inputValue(), 'fixture-user')
          await page.getByRole('button', { name: 'Continue' }).click()
          await page.goto('https://example.com/fixture')
        }
        await page.addScriptTag({url:'https://challenges.cloudflare.com/fixture.js'})
        assert.deepEqual(observedCodes, ['600010'])
        assert.equal(await page.title(), 'Local browser fixture')
        await page.bringToFront()
        await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
        assert.ok((await page.screenshot({ type: 'jpeg' })).length > 0)
        const resource = await page.evaluate(async () => (await fetch('/resource')).text())
        assert.match(resource, /Local browser fixture/)
        const swResult = await page.evaluate(async () => {
          try { return await navigator.serviceWorker.register('/sw.js') ? 'registered' : 'blocked' }
          catch { return 'blocked' }
        })
        assert.equal(swResult, 'blocked')
        assert.deepEqual(context.serviceWorkers(), [])
        const signals = await page.evaluate(() => ({ webdriver: navigator.webdriver, ua: navigator.userAgent }))
        if (stealth) assert.notEqual(signals.webdriver, true)
        else if (engine === 'playwright') assert.equal(signals.webdriver, true)
        if (!headless) assert.doesNotMatch(signals.ua, /HeadlessChrome/)
        await context.addCookies([{ name: 'fixture', value: 'test', url: 'https://example.com' }])
        const secondPage = await context.newPage()
        await secondPage.goto('https://example.com/second')
        assert.match(await secondPage.evaluate(() => document.cookie), /fixture=test/)
        const isolatedContext = await browser.newContext()
        assert.deepEqual(await isolatedContext.cookies(), [])
        await isolatedContext.close()
        // This request is NOT intercepted: the real SafeProxy must reject private egress.
        const address = privateServer.address()
        assert.ok(address && typeof address !== 'string')
        await assert.rejects(page.goto(`https://127.0.0.1:${address.port}/private`, { timeout: 5_000 }))
        assert.equal(privateConnections, 0, 'browser must not connect directly to a private listener')
        await context.close()
      } finally {
        if (browser) await closeCaptureBrowser(browser)
        await new Promise<void>((resolve) => privateServer.close(() => resolve()))
        await proxy.close()
      }
      if (engine === 'camoufox' && process.platform === 'linux') {
        const profiles = (await readdir('/run/weblens-browser')).filter((name) => name.startsWith('session-'))
        assert.deepEqual(profiles, [], 'launcher must remove its temporary profile after close')
        for (const pid of (await readdir('/proc')).filter((name) => /^\d+$/.test(name))) {
          const cmdline = await readFile(`/proc/${pid}/cmdline`, 'utf8').catch(() => '')
          assert.ok(!cmdline.includes('/opt/camoufox/camoufox-bin'), 'no browser orphan')
        }
      }
    })
  }
}
}

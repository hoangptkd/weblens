import { afterEach, describe, expect, it, vi } from 'vitest'
import { apiRequest, resolveApiBaseUrl, restoreAccessToken, setAccessToken } from './apiClient'

describe('apiClient session restore', () => {
  afterEach(() => {
    setAccessToken(null)
    document.cookie = 'XSRF-TOKEN=; Max-Age=0; Path=/'
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('restores the in-memory access token from the refresh session', async () => {
    document.cookie = 'XSRF-TOKEN=test-csrf; Path=/'
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      accessToken: 'restored-access',
      tokenType: 'Bearer',
      expiresAt: '2026-09-19T12:00:00Z',
      user: { id: 'user-1', email: 'owner@example.com', displayName: 'Owner', status: 'ACTIVE' },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(restoreAccessToken()).resolves.toBe(true)
    expect(fetchMock).toHaveBeenCalledOnce()
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/v1/auth/token-refreshes')
    expect(new Headers(fetchMock.mock.calls[0]?.[1]?.headers).get('X-XSRF-TOKEN')).toBe('test-csrf')
  })

  it('keeps local frontend and API cookies on the same loopback host', () => {
    expect(resolveApiBaseUrl('http://localhost:8080', '127.0.0.1')).toBe('http://127.0.0.1:8080')
    expect(resolveApiBaseUrl('https://api.example.com', 'app.example.com')).toBe('https://api.example.com')
  })

  it('bounds requests, preserves caller cancellation and allows bounded browser startup', async () => {
    const deadlines = vi.spyOn(AbortSignal, 'timeout')
    const fetchMock = vi.fn().mockImplementation(async () => new Response(null, { status: 204 }))
    vi.stubGlobal('fetch', fetchMock)
    const caller = new AbortController()
    await apiRequest('/api/v1/scans', { signal: caller.signal })
    const signal = fetchMock.mock.calls[0]?.[1]?.signal as AbortSignal
    expect(deadlines).toHaveBeenLastCalledWith(30_000)
    expect(signal.aborted).toBe(false)
    caller.abort()
    expect(signal.aborted).toBe(true)
    await apiRequest('/api/v1/site-clones/test/browser-session', { method: 'POST' })
    expect(deadlines).toHaveBeenLastCalledWith(65_000)
    await apiRequest('/api/v1/site-clones/test/artifacts/archive')
    expect(deadlines).toHaveBeenLastCalledWith(120_000)
  })
})

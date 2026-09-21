import { afterEach, describe, expect, it, vi } from 'vitest'
import { resolveApiBaseUrl, restoreAccessToken, setAccessToken } from './apiClient'

describe('apiClient session restore', () => {
  afterEach(() => {
    setAccessToken(null)
    document.cookie = 'XSRF-TOKEN=; Max-Age=0; Path=/'
    vi.unstubAllGlobals()
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
})

import type { ApiAuthSession, ApiFieldError, ApiProblemDetail } from './contracts'

const configuredBaseUrl = import.meta.env.VITE_API_BASE_URL ?? ''
const apiBaseUrl = resolveApiBaseUrl(configuredBaseUrl)
const csrfCookieName = 'XSRF-TOKEN'
const csrfHeaderName = 'X-XSRF-TOKEN'

let accessToken: string | null = null
let refreshInFlight: Promise<boolean> | null = null

export function resolveApiBaseUrl(configured: string, pageHostname = window.location.hostname): string {
  const normalized = configured.replace(/\/$/, '')
  if (!normalized) return ''
  try {
    const url = new URL(normalized)
    if (isLoopback(url.hostname) && isLoopback(pageHostname)) url.hostname = pageHostname
    return url.toString().replace(/\/$/, '')
  } catch {
    return normalized
  }
}

function isLoopback(hostname: string) {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]'
}

export class ApiError extends Error {
  readonly code: string
  readonly requestId: string
  readonly fieldErrors: ApiFieldError[]
  readonly status: number

  constructor(problem: ApiProblemDetail, fallbackStatus: number) {
    super(problem.detail ?? problem.title ?? 'Không thể hoàn tất yêu cầu.')
    this.name = 'ApiError'
    this.code = problem.code ?? 'HTTP_ERROR'
    this.requestId = problem.correlationId ?? 'unavailable'
    this.fieldErrors = problem.fieldErrors ?? []
    this.status = problem.status ?? fallbackStatus
  }
}

export function setAccessToken(token: string | null) {
  accessToken = token
}

export function restoreAccessToken(): Promise<boolean> {
  return accessToken ? Promise.resolve(true) : refreshAccessToken()
}

export async function apiRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await authenticatedResponse(path, init)
  return decode<T>(response)
}

export async function apiBlobRequest(path: string, init: RequestInit = {}): Promise<Blob> {
  const response = await authenticatedResponse(path, init)
  if (response.ok) return response.blob()
  await decode<never>(response)
  throw new Error('Không thể tải artifact.')
}

async function authenticatedResponse(path: string, init: RequestInit): Promise<Response> {
  let response = await execute(path, init)
  if (response.status === 401 && canAttemptRefresh(path) && await refreshAccessToken()) {
    response = await execute(path, init)
  }
  return response
}

async function execute(path: string, init: RequestInit): Promise<Response> {
  const headers = new Headers(init.headers)
  if (init.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json')
  if (accessToken) headers.set('Authorization', `Bearer ${accessToken}`)
  if (requiresCsrf(path, init.method)) {
    const csrf = readCookie(csrfCookieName)
    if (csrf) headers.set(csrfHeaderName, csrf)
  }
  return fetch(`${apiBaseUrl}${path}`, { ...init, headers, credentials: 'include' })
}

async function refreshAccessToken(): Promise<boolean> {
  if (!refreshInFlight) {
    refreshInFlight = performRefresh().finally(() => { refreshInFlight = null })
  }
  return refreshInFlight
}

async function performRefresh(): Promise<boolean> {
  const csrf = readCookie(csrfCookieName)
  if (!csrf) {
    accessToken = null
    return false
  }
  const response = await fetch(`${apiBaseUrl}/api/v1/auth/token-refreshes`, {
    method: 'POST',
    credentials: 'include',
    headers: { [csrfHeaderName]: csrf },
  })
  if (!response.ok) {
    accessToken = null
    return false
  }
  const session = await response.json() as ApiAuthSession
  accessToken = session.accessToken
  return true
}

async function decode<T>(response: Response): Promise<T> {
  if (response.ok) {
    if (response.status === 204) return undefined as T
    return response.json() as Promise<T>
  }
  let problem: ApiProblemDetail = {}
  try {
    problem = await response.json() as ApiProblemDetail
  } catch {
    problem = { detail: 'Backend trả về phản hồi không hợp lệ.' }
  }
  throw new ApiError(problem, response.status)
}

function canAttemptRefresh(path: string): boolean {
  return path !== '/api/v1/auth/token-refreshes'
    && path !== '/api/v1/auth/sessions'
    && path !== '/api/v1/auth/registrations'
}

function requiresCsrf(path: string, method?: string): boolean {
  return method === 'DELETE' && path === '/api/v1/auth/session'
}

function readCookie(name: string): string | null {
  const prefix = `${encodeURIComponent(name)}=`
  const item = document.cookie.split('; ').find((cookie) => cookie.startsWith(prefix))
  return item ? decodeURIComponent(item.slice(prefix.length)) : null
}

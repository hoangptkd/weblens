import { apiRequest, restoreAccessToken, setAccessToken } from './apiClient'
import type { ApiAuthSession, ApiUser } from './contracts'

export const authApi = {
  async register(email: string, password: string, displayName: string): Promise<ApiAuthSession> {
    const session = await apiRequest<ApiAuthSession>('/api/v1/auth/registrations', {
      method: 'POST',
      body: JSON.stringify({ email, password, displayName }),
    })
    setAccessToken(session.accessToken)
    return session
  },

  async login(email: string, password: string): Promise<ApiAuthSession> {
    const session = await apiRequest<ApiAuthSession>('/api/v1/auth/sessions', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    })
    setAccessToken(session.accessToken)
    return session
  },

  me(): Promise<ApiUser> {
    return apiRequest<ApiUser>('/api/v1/me')
  },

  async restore(): Promise<ApiUser> {
    if (!await restoreAccessToken()) throw new Error('Phiên đăng nhập đã hết hạn.')
    return apiRequest<ApiUser>('/api/v1/me')
  },

  async logout(): Promise<void> {
    try {
      await apiRequest<void>('/api/v1/auth/session', { method: 'DELETE' })
    } finally {
      setAccessToken(null)
    }
  },
}

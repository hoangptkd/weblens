import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { authApi } from '../api/authApi'
import { AuthPage } from './AuthPage'

describe('AuthPage', () => {
  afterEach(() => vi.restoreAllMocks())

  it('yêu cầu mật khẩu đăng ký tối thiểu 12 ký tự và gọi backend thật', async () => {
    const register = vi.spyOn(authApi, 'register').mockResolvedValue({
      user: { id: 'user-1', email: 'owner@example.com', displayName: 'Owner', status: 'ACTIVE' },
      accessToken: 'test-token',
      tokenType: 'Bearer',
      expiresAt: '2026-09-17T12:00:00Z',
    })
    render(<MemoryRouter><AuthPage mode="register" /></MemoryRouter>)

    const user = userEvent.setup()
    await user.type(screen.getByLabelText('Tên hiển thị'), 'Owner')
    await user.type(screen.getByLabelText('Email công việc'), 'owner@example.com')
    await user.type(screen.getByLabelText('Mật khẩu'), 'short')
    await user.click(screen.getByRole('button', { name: 'Tạo tài khoản' }))
    expect(screen.getByRole('alert')).toHaveTextContent('tối thiểu 12 ký tự')
    expect(register).not.toHaveBeenCalled()

    await user.clear(screen.getByLabelText('Mật khẩu'))
    await user.type(screen.getByLabelText('Mật khẩu'), 'a-secure-password')
    await user.click(screen.getByRole('button', { name: 'Tạo tài khoản' }))
    expect(register).toHaveBeenCalledWith('owner@example.com', 'a-secure-password', 'Owner')
  })
})

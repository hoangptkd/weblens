import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { authApi } from '../api/authApi'
import { LandingPage } from './LandingPage'

describe('LandingPage', () => {
  afterEach(() => vi.restoreAllMocks())

  it('explains V1.5 and labels the future roadmap', () => {
    vi.spyOn(authApi, 'restore').mockRejectedValue(new Error('No session'))
    render(<MemoryRouter><LandingPage /></MemoryRouter>)
    expect(screen.getByRole('heading', { name: /Chụp lại trang đã sống/i })).toBeInTheDocument()
    expect(screen.getByText(/Các tính năng dưới đây chưa hoạt động/i)).toBeInTheDocument()
  })

  it('shows an accessible validation error for an unsafe protocol', async () => {
    vi.spyOn(authApi, 'restore').mockRejectedValue(new Error('No session'))
    const user = userEvent.setup()
    render(<MemoryRouter><LandingPage /></MemoryRouter>)
    const input = screen.getByLabelText(/Website bạn muốn quan sát/i)
    await user.clear(input)
    await user.type(input, 'file:///etc/passwd')
    await user.click(screen.getByRole('button', { name: /Đăng ký để quét/i }))
    expect(screen.getByRole('alert')).toHaveTextContent(/HTTP hoặc HTTPS/i)
    expect(input).toHaveAttribute('aria-invalid', 'true')
  })

  it('shows the dashboard action instead of login for an authenticated user', async () => {
    vi.spyOn(authApi, 'restore').mockResolvedValue({
      id: 'user-1',
      email: 'owner@example.com',
      displayName: 'Owner',
      status: 'ACTIVE',
    })
    render(<MemoryRouter><LandingPage /></MemoryRouter>)

    expect(await screen.findByRole('link', { name: /Vào dashboard/i })).toHaveAttribute('href', '/app/websites')
    expect(screen.queryByRole('link', { name: 'Đăng nhập' })).not.toBeInTheDocument()
  })
})

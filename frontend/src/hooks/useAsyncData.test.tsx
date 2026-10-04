import { act, render, screen } from '@testing-library/react'
import { useAsyncData } from './useAsyncData'
import { afterEach, describe, expect, it, vi } from 'vitest'

function PollingHarness({ loader }: { loader: () => Promise<number> }) {
  const state = useAsyncData(loader, 'polling-test', {
    pollIntervalMs: 100,
    shouldPoll: (value) => value < 2,
  })
  return (
    <div>
      <span data-testid="value">{state.data ?? 'empty'}</span>
      <span data-testid="error">{state.error?.message ?? 'none'}</span>
    </div>
  )
}

function AdaptiveHarness({ loader, enabled = true }: { loader: () => Promise<number>; enabled?: boolean }) {
  const state = useAsyncData(loader, 'adaptive', {
    enabled,
    pollIntervalMs: (value) => value === 1 ? 1000 : 100,
    shouldPoll: (value) => value < 2,
  })
  return <span data-testid="adaptive">{state.data ?? 'empty'}</span>
}

describe('useAsyncData polling', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('keeps stale data after a transient error and stops at the terminal value', async () => {
    vi.useFakeTimers()
    const loader = vi.fn()
      .mockResolvedValueOnce(1)
      .mockRejectedValueOnce(new Error('Mất kết nối tạm thời'))
      .mockResolvedValueOnce(2)

    render(<PollingHarness loader={loader} />)
    await act(async () => undefined)
    expect(screen.getByTestId('value')).toHaveTextContent('1')

    await act(async () => { await vi.advanceTimersByTimeAsync(100) })
    expect(screen.getByTestId('value')).toHaveTextContent('1')
    expect(screen.getByTestId('error')).toHaveTextContent('Mất kết nối tạm thời')

    await act(async () => { await vi.advanceTimersByTimeAsync(100) })
    expect(screen.getByTestId('value')).toHaveTextContent('2')
    expect(screen.getByTestId('error')).toHaveTextContent('none')

    await act(async () => { await vi.advanceTimersByTimeAsync(500) })
    expect(loader).toHaveBeenCalledTimes(3)
  })

  it('cleans up a pending poll after unmount', async () => {
    vi.useFakeTimers()
    const loader = vi.fn().mockResolvedValue(1)
    const view = render(<PollingHarness loader={loader} />)
    await act(async () => undefined)

    view.unmount()
    await act(async () => { await vi.advanceTimersByTimeAsync(500) })

    expect(loader).toHaveBeenCalledTimes(1)
  })

  it('waits for enablement, adapts to queue state, and stops at terminal', async () => {
    vi.useFakeTimers()
    const loader = vi.fn().mockResolvedValueOnce(1).mockResolvedValueOnce(2)
    const view = render(<AdaptiveHarness loader={loader} enabled={false} />)
    await act(async () => undefined)
    expect(loader).not.toHaveBeenCalled()
    view.rerender(<AdaptiveHarness loader={loader} />)
    await act(async () => undefined)
    await act(async () => { await vi.advanceTimersByTimeAsync(999) })
    expect(loader).toHaveBeenCalledTimes(1)
    await act(async () => { await vi.advanceTimersByTimeAsync(1) })
    expect(screen.getByTestId('adaptive')).toHaveTextContent('2')
    await act(async () => { await vi.advanceTimersByTimeAsync(2000) })
    expect(loader).toHaveBeenCalledTimes(2)
  })

  it('pauses network polling while the document is hidden', async () => {
    vi.useFakeTimers()
    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
    const loader = vi.fn().mockResolvedValue(2)
    render(<AdaptiveHarness loader={loader} />)
    await act(async () => { await vi.advanceTimersByTimeAsync(500) })
    expect(loader).not.toHaveBeenCalled()
    visibility.mockReturnValue('visible')
    await act(async () => { await vi.advanceTimersByTimeAsync(100) })
    expect(loader).toHaveBeenCalledTimes(1)
  })
})

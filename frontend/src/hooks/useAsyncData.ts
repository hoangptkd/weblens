import { useEffect, useEffectEvent, useState } from 'react'

interface AsyncState<T> {
  data: T | null
  error: Error | null
  loading: boolean
  refreshing: boolean
}

interface KeyedAsyncState<T> extends AsyncState<T> {
  key: string
}

interface AsyncDataOptions<T> {
  pollIntervalMs?: number | ((data: T | null) => number)
  enabled?: boolean
  shouldPoll?: (data: T) => boolean
  shouldPollOnError?: () => boolean
}

export function useAsyncData<T>(
  loader: () => Promise<T>,
  dependencyKey: string,
  options: AsyncDataOptions<T> = {},
): AsyncState<T> {
  const [state, setState] = useState<KeyedAsyncState<T>>({ key: dependencyKey, data: null, error: null, loading: true, refreshing: false })
  const load = useEffectEvent(loader)
  const shouldPoll = useEffectEvent((data: T) => options.shouldPoll?.(data) ?? false)
  const shouldPollOnError = useEffectEvent(() => options.shouldPollOnError?.() ?? true)
  const pollInterval = useEffectEvent((data: T | null) => typeof options.pollIntervalMs === 'function'
    ? options.pollIntervalMs(data)
    : options.pollIntervalMs)
  const enabled = options.enabled ?? true
  const pollingEnabled = options.pollIntervalMs !== undefined
  const fixedInterval = typeof options.pollIntervalMs === 'number' ? options.pollIntervalMs : undefined

  useEffect(() => {
    let active = true
    let timer: number | undefined
    let latestData: T | null = null

    function schedule() {
      const interval = pollInterval(latestData)
      if (active && interval && interval > 0) timer = window.setTimeout(run, interval)
    }

    async function run() {
      if (!active) return
      if (pollingEnabled && document.visibilityState === 'hidden') {
        schedule()
        return
      }
      if (latestData !== null) {
        setState((current) => ({ ...current, refreshing: current.key === dependencyKey && current.data !== null }))
      }
      try {
        const data = await load()
        if (!active) return
        latestData = data
        setState({ key: dependencyKey, data, error: null, loading: false, refreshing: false })
      } catch (error: unknown) {
        if (!active) return
        const normalized = error instanceof Error ? error : new Error('Đã có lỗi xảy ra.')
        setState((current) => current.key === dependencyKey
          ? { ...current, error: normalized, loading: false, refreshing: false }
          : { key: dependencyKey, data: null, error: normalized, loading: false, refreshing: false })
      }

      const keepPolling = latestData === null ? shouldPollOnError() : shouldPoll(latestData)
      if (keepPolling) schedule()
    }

    if (enabled) void run()
    return () => {
      active = false
      if (timer !== undefined) window.clearTimeout(timer)
    }
  }, [dependencyKey, fixedInterval, pollingEnabled, enabled])

  if (state.key !== dependencyKey) {
    return { data: null, error: null, loading: true, refreshing: false }
  }
  return state
}

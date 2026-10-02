import { computed, onScopeDispose, ref, shallowRef } from 'vue'
import { errorStatus } from '../../lib/errors.js'
import { useNow } from './useNow.js'

/** DESIGN.md §5.1 common state contract. */
export type DataState = 'loading' | 'ready' | 'empty' | 'error' | 'forbidden' | 'stale'

export type LiveOptions<T> = {
  /** Poll interval; 0 disables polling (fetch once + manual refresh). Default 15 s (DESIGN.md §3.5). */
  intervalMs?: number
  isEmpty?: (data: T) => boolean
  /** Return false to skip a tick (e.g. a filter is incomplete). */
  enabled?: () => boolean
  immediate?: boolean
}

/**
 * Resolve the §5.1 state from what a loader knows. Stale = data exists but the last refresh failed or the data
 * is older than 2× the interval.
 */
export function resolveDataState(input: {
  hasData: boolean
  loading: boolean
  error: unknown
  empty: boolean
  ageMs: number | null
  intervalMs: number
}): DataState {
  const forbidden = input.error !== null && input.error !== undefined && errorStatus(input.error) === 403
  if (!input.hasData) {
    if (forbidden) return 'forbidden'
    if (input.error !== null && input.error !== undefined && !input.loading) return 'error'
    return 'loading'
  }
  if (input.error !== null && input.error !== undefined) return forbidden ? 'forbidden' : 'stale'
  if (input.intervalMs > 0 && input.ageMs !== null && input.ageMs > input.intervalMs * 2) return 'stale'
  return input.empty ? 'empty' : 'ready'
}

/**
 * One polling loop per page: pauses while the tab is hidden, refreshes on return when overdue, drops responses
 * that arrive out of order, keeps the last good data when a refresh fails (state → 'stale').
 */
export function useLive<T>(fetcher: (signal: AbortSignal) => Promise<T>, options: LiveOptions<T> = {}) {
  const intervalMs = options.intervalMs ?? 15000
  const data = shallowRef<T>()
  const error = shallowRef<unknown>(null)
  const loading = ref(false)
  const lastAt = ref<number | null>(null)
  const now = useNow()
  let seq = 0
  let timer: ReturnType<typeof setTimeout> | null = null
  let controller: AbortController | null = null
  let disposed = false

  async function refresh() {
    if (disposed) return
    if (options.enabled && !options.enabled()) return
    const mine = ++seq
    controller?.abort()
    controller = new AbortController()
    loading.value = true
    try {
      const result = await fetcher(controller.signal)
      if (mine !== seq || disposed) return
      data.value = result
      error.value = null
      lastAt.value = Date.now()
    } catch (err) {
      if (mine !== seq || disposed) return
      if ((err as { name?: string })?.name === 'AbortError') return
      error.value = err
    } finally {
      if (mine === seq && !disposed) {
        loading.value = false
        arm()
      }
    }
  }

  function arm() {
    if (timer) clearTimeout(timer)
    timer = null
    if (intervalMs <= 0 || disposed || typeof document === 'undefined') return
    if (document.hidden) return
    timer = setTimeout(() => void refresh(), intervalMs)
  }

  function onVisibility() {
    if (document.hidden) {
      if (timer) clearTimeout(timer)
      timer = null
      return
    }
    const age = lastAt.value === null ? Infinity : Date.now() - lastAt.value
    if (age >= intervalMs) void refresh()
    else arm()
  }

  if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisibility)
  onScopeDispose(() => {
    disposed = true
    if (timer) clearTimeout(timer)
    controller?.abort()
    if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisibility)
  })

  if (options.immediate !== false) void refresh()

  const state = computed<DataState>(() =>
    resolveDataState({
      hasData: data.value !== undefined,
      loading: loading.value,
      error: error.value,
      empty: data.value !== undefined && Boolean(options.isEmpty?.(data.value)),
      ageMs: lastAt.value === null ? null : now.value - lastAt.value,
      intervalMs,
    }),
  )

  return { data, error, loading, lastAt, state, refresh, intervalMs }
}

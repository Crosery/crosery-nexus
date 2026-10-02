/**
 * 一次读取 / 一次写入的状态机。
 *
 * 对照参考实现 `geek_main/app/console/src/lib/resource.ts:1-58`（逐行移植，仅补充注释与 `refetch` 别名）：
 * - `useResource`：加载中、失败、数据三态；依赖变化自动重取；按序号丢弃过期响应，避免慢请求覆盖新结果；
 *   成功前不碰旧数据，所以刷新列表时页面不会闪空。
 * - `useAction`：写操作进行中 / 错误；成功返回结果，失败返回 undefined 并把错误留在 `error` 上。
 */
import { computed, onScopeDispose, ref, shallowRef, watch, type ComputedRef, type Ref, type WatchSource } from 'vue'

export type Resource<T> = {
  data: Ref<T | undefined>
  error: Ref<unknown>
  loading: Ref<boolean>
  /** 首次加载（还没有任何数据）时为 true，用于「首次骨架 / 刷新不闪空」的分支。 */
  initial: Ref<boolean>
  reload: () => Promise<void>
}

/**
 * 读取一次接口。`deps` 变化时重新读取，旧请求的结果按序号丢弃。
 * 刷新时保留旧数据（成功前 `data` 不被清空），所以列表不会闪空。
 */
export function useResource<T>(
  fetcher: () => Promise<T>,
  deps: WatchSource[] = [],
  options: { enabled?: () => boolean } = {},
): Resource<T> {
  const data = shallowRef<T>()
  const error = shallowRef<unknown>(null)
  const loading = ref(false)
  const initial = ref(true)
  let seq = 0
  let disposed = false

  async function reload() {
    if (options.enabled && !options.enabled()) return
    const mine = ++seq
    loading.value = true
    error.value = null
    try {
      const result = await fetcher()
      if (mine === seq && !disposed) {
        data.value = result
        initial.value = false
      }
    } catch (err) {
      if (mine === seq && !disposed) error.value = err
    } finally {
      if (mine === seq && !disposed) loading.value = false
    }
  }

  watch(deps, () => void reload(), { immediate: true })
  onScopeDispose(() => {
    disposed = true
  })
  return { data, error, loading, initial, reload }
}

/** 一次写操作的状态：进行中与错误；成功返回结果，失败返回 undefined 并记下错误。 */
export function useAction<A extends unknown[], R>(run: (...args: A) => Promise<R>) {
  const pending = ref(false)
  const error = shallowRef<unknown>(null)
  async function execute(...args: A): Promise<R | undefined> {
    pending.value = true
    error.value = null
    try {
      return await run(...args)
    } catch (err) {
      error.value = err
      return undefined
    } finally {
      pending.value = false
    }
  }
  return {
    pending,
    error,
    execute,
    reset: () => {
      error.value = null
    },
  }
}

/**
 * Resolves once `loading` reads false. A useLive `refresh()` that a background poll superseded returns at once while
 * the newer read is still in flight; a switch that stays locked until the acknowledged state is on screen awaits
 * this after its re-read (FF-18).
 */
export function whenIdle(loading: Ref<boolean>): Promise<void> {
  if (!loading.value) return Promise.resolve()
  return new Promise((resolve) => {
    const stop = watch(loading, (value) => {
      if (value) return
      stop()
      resolve()
    }, { flush: 'sync' })
  })
}

export type SheetWrite = {
  /** 这个面板发出的写入还在途（不论属于哪一次打开）：提交按钮与隐藏的回车提交都看它。 */
  busy: Ref<boolean>
  /** 在途的写入属于上一次打开：新打开的面板可以编辑，但要等它落地才能再提交。 */
  stale: ComputedRef<boolean>
  /** 面板每打开一次调用一次：之后旧写入的完成不再碰面板本地状态。 */
  renew: () => void
  /**
   * 发起一次写入；已有写入在途时直接返回 false（不发请求）。
   * `done` / `failed` 总会被调用，`current = false` 表示面板已被关掉重开：父级的刷新与提示照常，
   * 但不要关面板、不要清草稿、不要把失败写进新面板。
   */
  run: <R>(
    write: () => Promise<R>,
    handlers: { done?: (result: R, current: boolean) => void | Promise<void>; failed?: (error: unknown, current: boolean) => void },
  ) => Promise<boolean>
}

/**
 * 表单面板（sheet）的写入会话：同一时刻只允许一次写入在途——连按回车、请求未回时关掉再开，都不会发出
 * 第二次创建；每次打开换一代，旧一代写入的完成不会关掉或清空新打开的面板。
 */
export function useSheetWrite(): SheetWrite {
  const busy = ref(false)
  const generation = ref(0)
  const owner = ref(-1)
  const stale = computed(() => busy.value && owner.value !== generation.value)

  function renew() {
    generation.value += 1
  }

  async function run<R>(
    write: () => Promise<R>,
    handlers: { done?: (result: R, current: boolean) => void | Promise<void>; failed?: (error: unknown, current: boolean) => void },
  ): Promise<boolean> {
    if (busy.value) return false
    const mine = generation.value
    owner.value = mine
    busy.value = true
    try {
      let result: R
      try {
        result = await write()
      } catch (error) {
        handlers.failed?.(error, mine === generation.value)
        return false
      }
      await handlers.done?.(result, mine === generation.value)
      return true
    } finally {
      busy.value = false
    }
  }

  return { busy, stale, renew, run }
}

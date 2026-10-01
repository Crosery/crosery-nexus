/**
 * 一次读取 / 一次写入的状态机。
 *
 * 对照参考实现 `geek_main/app/console/src/lib/resource.ts:1-58`（逐行移植，仅补充注释与 `refetch` 别名）：
 * - `useResource`：加载中、失败、数据三态；依赖变化自动重取；按序号丢弃过期响应，避免慢请求覆盖新结果；
 *   成功前不碰旧数据，所以刷新列表时页面不会闪空。
 * - `useAction`：写操作进行中 / 错误；成功返回结果，失败返回 undefined 并把错误留在 `error` 上。
 */
import { onScopeDispose, ref, shallowRef, watch, type Ref, type WatchSource } from 'vue'

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

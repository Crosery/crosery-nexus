/**
 * 列表筛选 / 分页 / 搜索与 URL query 的双向同步。
 *
 * 对照参考实现 `geek_main/app/console/src/lib/nav.ts`（导航能力裁剪的纯数据思路）与
 * `geek_main/app/console/src/pages/github/Repos.vue`（列表筛选写进路由、刷新与分享链接保持同一视图）。
 *
 * 约定：
 * - state 里一律存字符串；默认值不写进 URL，所以干净链接不会拖一串 `?days=7&page=1`。
 * - 页面读 `state` 直接触发数据加载（即时），写 URL 走 250ms 防抖与 `router.replace`
 *   （不污染历史：后退键仍然回到上一页，而不是在每次输入之间跳）。
 * - 外部变化（粘贴深链、浏览器前进/后退）会回填到 `state`，页面因此保持同一视图。
 */
import { computed, onScopeDispose, reactive, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'

export type QueryValue = string | number | boolean | null | undefined
export type QueryDefaults = Record<string, QueryValue>

type Normalized<T extends QueryDefaults> = { [K in keyof T]: string }

const first = (value: unknown): string => {
  if (Array.isArray(value)) return value.length ? String(value[0]) : ''
  return value === null || value === undefined ? '' : String(value)
}

const asString = (value: QueryValue): string => (value === null || value === undefined ? '' : String(value))

/** 把 state 序列化成 query：默认值与空值不写进 URL。 */
function buildQuery(input: Record<string, string>, defaults: Record<string, string>): Record<string, string> {
  const query: Record<string, string> = {}
  for (const [key, value] of Object.entries(input)) {
    const fallback = defaults[key] ?? ''
    if (value === '' || value === fallback) continue
    query[key] = value
  }
  return query
}

function sameQuery(a: Record<string, string>, b: Record<string, string>): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)])
  for (const key of keys) if ((a[key] ?? '') !== (b[key] ?? '')) return false
  return true
}

/** 当前 URL 上真正带值的 schema 键（不含默认值），用于「已筛选 N 项」与「清除筛选」。 */
export function useQueryState<T extends QueryDefaults>(defaults: T) {
  const route = useRoute()
  const router = useRouter()
  const schema = Object.keys(defaults)
  const fallback: Record<string, string> = {}
  for (const key of schema) fallback[key] = asString(defaults[key])

  const read = (): Record<string, string> => {
    const out: Record<string, string> = {}
    for (const key of schema) {
      const raw = first(route.query[key])
      out[key] = raw === '' ? fallback[key] : raw
    }
    return out
  }

  // 内部按 Record<string, string> 处理；对外的 state 按 schema 键名收窄类型。
  const state: Record<string, string> = reactive(read()) as Record<string, string>

  // URL -> state：深链、前进/后退、外部跳转都能把视图还原。
  watch(
    () => route.query,
    () => {
      const next = read()
      for (const key of schema) {
        if (state[key] !== next[key]) state[key] = next[key]
      }
    },
  )

  let timer: ReturnType<typeof setTimeout> | null = null
  const flush = () => {
    timer = null
    // 保留 schema 之外的 query（例如详情抽屉的 ?request=），只增删自己管的键。
    const query: Record<string, string> = {}
    for (const [key, value] of Object.entries(route.query)) {
      const value2 = first(value)
      if (!schema.includes(key) && value2 !== '') query[key] = value2
    }
    Object.assign(query, buildQuery({ ...state }, fallback))
    if (sameQuery(query, Object.fromEntries(Object.entries(route.query).map(([k, v]) => [k, first(v)])))) return
    void router.replace({ query })
  }

  // state -> URL：防抖，避免每次按键都写一条历史/触发一次导航。
  watch(
    state,
    () => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(flush, 250)
    },
    { deep: true },
  )
  onScopeDispose(() => {
    if (timer) clearTimeout(timer)
    timer = null
  })

  const activeKeys = computed(() => schema.filter((key) => state[key] !== fallback[key]))

  return {
    state: state as unknown as Normalized<T>,
    /** 已偏离默认值的筛选键，用来渲染「已筛选 / 清除筛选」。 */
    activeKeys,
    /** 立刻把当前 state 写进 URL（清筛选、翻页这类离散操作不需要等防抖）。 */
    flush,
    patch(partial: Partial<Normalized<T>>) {
      Object.assign(state, partial)
    },
    reset() {
      Object.assign(state, fallback)
    },
  }
}

/** 前端分页：返回当前页数据与总页数，并把越界页码夹回范围内（数据变少时不会停在空页）。 */
export function paginate<T>(items: T[], page: number, pageSize: number) {
  const size = Math.max(1, Math.floor(pageSize) || 1)
  const total = items.length
  const totalPages = Math.max(1, Math.ceil(total / size))
  const current = Math.min(Math.max(1, Math.floor(page) || 1), totalPages)
  const start = (current - 1) * size
  return { rows: items.slice(start, start + size), total, totalPages, page: current, pageSize: size }
}

/** 防抖：文本搜索用，避免每敲一个字就打一次接口。 */
export function debounce<A extends unknown[]>(fn: (...args: A) => void, wait = 300) {
  let timer: ReturnType<typeof setTimeout> | null = null
  const wrapped = (...args: A) => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = null
      fn(...args)
    }, wait)
  }
  wrapped.cancel = () => {
    if (timer) clearTimeout(timer)
    timer = null
  }
  return wrapped
}

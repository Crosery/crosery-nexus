/**
 * 实验台只读闸门（红队第二轮 R1 收口）。
 *
 * ## 背景
 *
 * A 侧是 `281c30e` 的**冻结页面副本**，但它们 import 的是**活的 api 模块**，不是沙箱：
 * 红队实测在 `/ab?flow=keys-access&v=a` 点「重置今日用量」没有确认框，直接发出
 * `POST /api/keys/<id>/quota/reset` —— 本轮刚验收为「已修」的零确认重置被实验台自己绕过了。
 * 而 `/ab` 在侧栏一键可达、深链可分享，任何人都可能误触真实数据。
 *
 * ## 三层拦截面（fail-closed）
 *
 * 1. **函数层**：把活 `api` 模块上**不在只读白名单里的方法**全部换成拒绝 stub。
 *    这是最内层，覆盖所有走 api 的写调用，与用什么传输无关（以后有人改成 XHR 也一样拦住）；
 *    白名单是**穷举读接口**，新增的 api 方法默认被拦（fail-closed）。
 * 2. **fetch 层**：非 GET/HEAD 一律拒绝（覆盖页面自己直接 fetch 的探索代码、第三方组件）。
 * 3. **XHR 层**：非 GET/HEAD 的 `XMLHttpRequest.open` 直接抛错（覆盖手写/库内 XHR）。
 *
 * ## 唯一的例外
 *
 * 实验台**自己的投票** `POST /api/ab/preference` 必须放行 —— 那是「真实用户参与」通道的核心，
 * 不能被自己的闸门关掉（v1 就踩过这个坑：闸门把投票一起拦了）。例外按「同源 + 精确路径 + POST」匹配。
 *
 * ## 计数不能静默
 *
 * 每次拦截都回调 `onBlocked`，页面把它显示成「已拦截 N 次写请求」：否则用户点了没反应，
 * 会误以为页面坏了（红队 D2 的教训：失败必须留痕）。
 */

/** 只读白名单：**只允许列在这里的 api 方法**，其余（含未来新增的）一律拦截。 */
export const READ_ONLY_API_METHODS = [
  'session',
  'bootstrap',
  'dashboard',
  'analytics',
  'charts',
  'chartsLatency',
  'usagePage',
  'usageKeySummaries',
  'usageOverview',
  'monitor',
  'audit',
  'channels',
  'credentialProxy',
  'modelIndex',
  'usageBreakdown',
  'cacheAnalytics',
  'cacheTrend',
  'cacheLiveUrl',
  'version',
  'getRTKStatus',
  'getRTKPlanes',
  'getOAuthStatus',
] as const

/** 唯一允许穿透闸门的写请求：实验台自己的投票（真实用户通道）。 */
export const WRITE_ALLOWLIST: Array<{ method: string; path: string }> = [
  { method: 'POST', path: '/api/ab/preference' },
]

export const WRITE_BLOCKED_MESSAGE = '实验台为只读对照：写请求已被拦截，请到真实页面执行'

export interface ReadOnlyBlockInfo {
  /** `api` = 函数层拦截（写方法名）；`fetch` / `xhr` = 网络层拦截 */
  layer: 'api' | 'fetch' | 'xhr'
  detail: string
  method?: string
  url?: string
}

export type ReadOnlyOnBlocked = (info: ReadOnlyBlockInfo) => void

/** 非 GET/HEAD 即视为写方法。 */
export const isWriteMethod = (method: string | undefined | null): boolean => {
  const value = String(method || 'GET').toUpperCase()
  return value !== 'GET' && value !== 'HEAD'
}

/** 投票端点例外：同源 + 精确路径 + POST。 */
export function isAllowlistedWrite(rawUrl: string, method: string | undefined | null, origin = window.location.origin): boolean {
  if (!isWriteMethod(method)) return false
  let pathname: string
  try {
    pathname = new URL(rawUrl, origin).pathname
  } catch {
    return false
  }
  return WRITE_ALLOWLIST.some((entry) => entry.method === String(method).toUpperCase() && entry.path === pathname)
}

interface GateEnvironment {
  api: Record<string, unknown>
  onBlocked: ReadOnlyOnBlocked
  /** 默认 `window`；测试可传沙箱对象。 */
  target?: Window & typeof globalThis
}

/**
 * 安装只读闸门，返回 `release()` 用于卸载时**精确还原**（只还原自己改过的方法，
 * 不整体替换 window.fetch，避免把别人的补丁也一起冲掉）。
 */
export function installReadOnlyGate({ api, onBlocked, target = window }: GateEnvironment): () => void {
  const restores: Array<() => void> = []

  /* ── 1. 函数层：不在白名单里的 api 方法一律拒绝 ─────────────────────────── */
  const allowed = new Set<string>(READ_ONLY_API_METHODS)
  const stubbed: Array<{ key: string; original: unknown }> = []
  for (const key of Object.keys(api)) {
    if (allowed.has(key)) continue
    const original = api[key]
    if (typeof original !== 'function') continue
    stubbed.push({ key, original })
    api[key] = (...args: unknown[]) => {
      void args
      onBlocked({ layer: 'api', detail: key })
      return Promise.reject(new Error(WRITE_BLOCKED_MESSAGE))
    }
  }
  restores.push(() => {
    for (const { key, original } of stubbed) api[key] = original
  })

  /* ── 2. fetch 层：非 GET/HEAD 一律拒绝（投票除外） ──────────────────────── */
  const rawFetch = target.fetch
  target.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const fromRequest = typeof input === 'object' && input !== null && 'method' in input ? (input as Request).method : undefined
    const method = String(init?.method || fromRequest || 'GET').toUpperCase()
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : String((input as Request)?.url ?? '')
    if (isWriteMethod(method) && !isAllowlistedWrite(url, method, target.location.origin)) {
      onBlocked({ layer: 'fetch', detail: `${method} ${url}`, method, url })
      return Promise.reject(new Error(WRITE_BLOCKED_MESSAGE))
    }
    return rawFetch.call(target, input as RequestInfo, init)
  }) as typeof target.fetch
  restores.push(() => {
    target.fetch = rawFetch
  })

  /* ── 3. XHR 层：非 GET/HEAD 的 open 直接抛错 ────────────────────────────── */
  const rawOpen = target.XMLHttpRequest.prototype.open
  target.XMLHttpRequest.prototype.open = function patchedOpen(this: XMLHttpRequest, method: string, url: string | URL, ...rest: unknown[]) {
    if (isWriteMethod(method) && !isAllowlistedWrite(String(url), method, target.location.origin)) {
      onBlocked({ layer: 'xhr', detail: `${String(method).toUpperCase()} ${String(url)}`, method: String(method), url: String(url) })
      throw new Error(WRITE_BLOCKED_MESSAGE)
    }
    return (rawOpen as unknown as (...args: unknown[]) => void).call(this, method, url, ...rest)
  } as typeof target.XMLHttpRequest.prototype.open
  restores.push(() => {
    target.XMLHttpRequest.prototype.open = rawOpen
  })

  return () => {
    for (const restore of restores.reverse()) restore()
  }
}

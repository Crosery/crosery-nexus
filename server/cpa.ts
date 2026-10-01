import { createHash, randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { config } from './config.js'

export type UsageRecord = {
  timestamp?: string
  provider?: string
  model?: string
  alias?: string
  endpoint?: string
  api_key?: string
  request_id?: string
  latency_ms?: number
  ttft_ms?: number
  failed?: boolean
  fail?: { status_code?: number; body?: string }
  source?: string
  auth_index?: string
  reasoning_effort?: string
  service_tier?: string
  response_headers?: Record<string, string | string[]>
  /** 调用方 UA，用于区分 Pi / Claude Code / Codex CLI 等客户端。 */
  user_agent?: string
  /** 直连对端地址；经 nginx 时恒为回环，真实来源看 x_forwarded_for。 */
  client_ip?: string
  x_forwarded_for?: string
  tokens?: {
    input_tokens?: number
    output_tokens?: number
    reasoning_tokens?: number
    cached_tokens?: number
    total_tokens?: number
    /**
     * Anthropic 独有的第四段：写入缓存的 token，按 1.25x 输入价单独计费。
     * CPA 一直在下发，早期落库时漏接，导致命中率恒 100%、成本系统性低估。
     */
    cache_creation_tokens?: number
    cache_read_tokens?: number
    cache_read_tokens_present?: boolean
  }
}

export class CPARequestError extends Error {
  constructor(readonly status: number, readonly path: string, body: string) {
    super(`CPA ${status}: ${body.slice(0, 240)}`)
    this.name = 'CPARequestError'
  }
}

/** 旧版 CPA 缺少部分管理 API；调用方可在不影响已成功的账号开关时安全降级。 */
export const isUnsupportedManagementEndpoint = (error: unknown) =>
  error instanceof CPARequestError && error.status === 404

/**
 * 远端管理面 → 本地 Magpie shim 的**方言适配**（单点，task-66）。
 *
 * 背景（红队第十八轮副作用发现）：本文件按**远端 CPA** 的管理面写调用，而本地 shim 是另一套方法/路径：
 *   - `PATCH /auth-files/status`（远端）↔ `PUT /auth-files/status`（本地 shim）
 *   - `PATCH /auth-files/fields`（远端）↔ `PUT /auth-files/proxy`（本地 shim）
 * 以前 local 分支**原样透传**，于是本机（local 控制面）的「凭据启用/禁用」「凭据级代理」100% 失败，
 * 报 `This CPA management operation is not supported by the Magpie kernel`（路由层再把它变成 400）。
 *
 * 修法：在**唯一的分支点**做翻译，而不是去改两个调用点（那会漏掉第三个调用点）。
 * 远端 cpa 模式完全不经过这里 → 行为不变。
 */
const LOCAL_MANAGEMENT_ALIASES: Record<string, { method: string; path: string }> = {
  'PATCH /auth-files/status': { method: 'PUT', path: '/auth-files/status' },
  'PATCH /auth-files/fields': { method: 'PUT', path: '/auth-files/proxy' },
}

/**
 * 本地 shim **确实没有**对应能力的远端字段：明确报错，而不是让它落到含糊的
 * 「not supported by the Magpie kernel」再被路由层变成 400。
 * 目前只有「冷却开关」——Magpie 的凭据文件没有这个概念（远端 CPA 有）。
 */
const LOCAL_UNSUPPORTED_REQUEST_FIELDS: Record<string, string[]> = {
  '/auth-files/fields': ['disable_cooling'],
}

/**
 * 本地 shim **确实没有**的远端操作（实测能力矩阵见 `docs/qa/blue/local-control-plane-methods.md`）。
 * 明确报出「哪个操作、为什么、替代路径」，而不是让它落到含糊的
 * `This CPA management operation is not supported by the Magpie kernel` 再被路由层压成 400。
 */
const LOCAL_UNSUPPORTED_OPERATIONS: Record<string, string> = {
  'POST /api-call': '本机 Magpie 内核不代理任意上游 API 调用（远端 CPA 的 /api-call 才有）——'
    + '受影响的用量/额度/资料类功能需要远端控制面，或走网关自身端口',
  'GET /latest-version': '本机没有独立的 CPA 版本接口（远端 CPA 才有）；控制台版本请看 /api/version',
}

/** 适配一次本地管理面调用；未命中翻译表就原样放行（保持既有行为）。 */
export function adaptLocalManagementRequest(path: string, init: RequestInit = {}): { path: string; init: RequestInit } {
  const method = String(init.method || 'GET').toUpperCase()
  const [pathname, query] = path.split('?')
  let body: Record<string, unknown> = {}
  if (typeof init.body === 'string' && init.body.trim()) {
    try { body = JSON.parse(init.body) as Record<string, unknown> } catch { body = {} }
  }
  const unsupportedOperation = LOCAL_UNSUPPORTED_OPERATIONS[`${method} ${pathname}`]
  if (unsupportedOperation) {
    throw new Error(`本地控制面不支持该操作：${method} ${pathname} —— ${unsupportedOperation}`)
  }
  const unsupported = (LOCAL_UNSUPPORTED_REQUEST_FIELDS[pathname] || []).filter(field => field in body)
  if (unsupported.length) {
    throw new Error(`本地控制面不支持该操作：${method} ${pathname} 的 ${unsupported.join(' / ')} 字段`
      + '（Magpie 内核没有对应能力，远端 cpa 控制面才有）。请在 Magpie 渠道配置里表达同样的语义。')
  }
  const alias = LOCAL_MANAGEMENT_ALIASES[`${method} ${pathname}`]
  if (!alias) return { path, init }
  return { path: query ? `${alias.path}?${query}` : alias.path, init: { ...init, method: alias.method } }
}

/**
 * 「目标不存在」错误（task-68）：带 `status = 404`，路由层据此原样返回 404，
 * `message` 就是机器可读的 reason（`credential_not_found`）。
 */
export class ManagementNotFoundError extends Error {
  readonly status = 404
  constructor(readonly code: string) { super(code) }
}

async function cpaRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
  if (config.gatewayEngine === 'magpie' && config.magpieControlPlane === 'local') {
    const { magpieManagementRequest } = await import('./magpieControl.js')
    const local = adaptLocalManagementRequest(path, init)
    return magpieManagementRequest<T>(local.path, local.init)
  }
  if (!config.cpaManagementKey) throw new Error('CPA_MANAGEMENT_KEY 未配置')
  const response = await fetch(`${config.cpaBaseUrl}/v0/management${path}`, {
    ...init,
    signal: init.signal || AbortSignal.timeout(config.cpaRequestTimeoutMs),
    headers: {
      Authorization: `Bearer ${config.cpaManagementKey}`,
      'Content-Type': 'application/json',
      ...(init.headers || {}),
    },
  })
  if (!response.ok) {
    const text = await response.text()
    throw new CPARequestError(response.status, path, text)
  }
  return response.json() as Promise<T>
}

export const hashKey = (key: string) => createHash('sha256').update(key).digest('hex')
export const maskKey = (key: string) => `${key.slice(0, 7)}••••••••${key.slice(-5)}`

export async function getCPAKeys(): Promise<string[]> {
  const result = await cpaRequest<{ 'api-keys': string[] }>('/api-keys')
  return result['api-keys'] || []
}

export async function replaceCPAKeys(keys: string[]) {
  return cpaRequest('/api-keys', { method: 'PUT', body: JSON.stringify(keys) })
}

export async function getModelAccess(): Promise<Record<string, string[]>> {
  const result = await cpaRequest<Record<string, string[]> | { 'api-key-model-access': Record<string, string[]> }>('/api-key-model-access')
  const wrapped = result['api-key-model-access']
  return wrapped && !Array.isArray(wrapped) ? wrapped : result as Record<string, string[]>
}

export async function putModelAccess(access: Record<string, string[]>) {
  await cpaRequest('/api-key-model-access', { method: 'PUT', body: JSON.stringify(access) })
  return true
}

export async function getChannelAccess(): Promise<Record<string, string[]>> {
  const result = await cpaRequest<Record<string, string[]> | { 'api-key-channel-access': Record<string, string[]> }>('/api-key-channel-access')
  const wrapped = result['api-key-channel-access']
  return wrapped && !Array.isArray(wrapped) ? wrapped : result as Record<string, string[]>
}

export async function putChannelAccess(access: Record<string, string[]>) {
  await cpaRequest('/api-key-channel-access', { method: 'PUT', body: JSON.stringify(access) })
  return true
}

/**
 * 管理态模型目录不受任何用户 Key 白名单影响。不能再拿「第一把 Key」访问 /v1/models，
 * 否则第一把 Key 受限后，console 会误以为其他渠道和模型都不存在。
 */
export async function listModels(): Promise<string[]> {
  const result = await cpaRequest<{ models?: Array<{ id?: string }> }>('/available-models')
  return [...new Set((result.models || []).map((item) => String(item.id || '')).filter(Boolean))].sort()
}

export async function popUsage(count = 200): Promise<UsageRecord[]> {
  return cpaRequest<UsageRecord[]>(`/usage-queue?count=${count}`)
}

export async function listAuthFiles() {
  return cpaRequest<{ files: Array<Record<string, unknown>> }>('/auth-files')
}

/** Read credential metadata server-side only; never return or log the raw credential object. */
export async function downloadAuthFile(name: string): Promise<Record<string, unknown>> {
  const raw = await cpaRequest<unknown>(`/auth-files/download?name=${encodeURIComponent(name)}`)
  // 本地 shim 对不存在的凭据返回 null；远端管理面返回 404（由 cpaRequest 抛出）。
  // 这里把 null 翻译成同一个语义，读/写两侧才对得上（task-68）。
  if (raw === null || raw === undefined) throw new ManagementNotFoundError('credential_not_found')
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new Error('CPA 凭据文件格式无效')
  return raw as Record<string, unknown>
}

export async function uploadAuthFile(name: string, raw: Buffer) {
  if (config.gatewayEngine === 'magpie' && config.magpieControlPlane === 'local') {
    const { saveLocalAuthFile } = await import('./magpieControl.js')
    saveLocalAuthFile(name, raw)
    return
  }
  if (!config.cpaManagementKey) throw new Error('CPA_MANAGEMENT_KEY 未配置')
  const form = new FormData()
  form.set('file', new Blob([Uint8Array.from(raw)]), name)
  const response = await fetch(`${config.cpaBaseUrl}/v0/management/auth-files`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${config.cpaManagementKey}` },
    body: form,
    signal: AbortSignal.timeout(config.cpaRequestTimeoutMs),
  })
  if (!response.ok) {
    await response.arrayBuffer().catch(() => undefined)
    throw new Error(`CPA auth-file upload failed with HTTP ${response.status}`)
  }
}

export type CompatModel = { name?: string; alias?: string }
export type CompatChannel = {
  name?: string
  'base-url'?: string
  'api-key-entries'?: Array<{ 'api-key'?: string; 'proxy-url'?: string }>
  models?: CompatModel[]
  [key: string]: unknown
}

export async function getCompatChannels(): Promise<CompatChannel[]> {
  const result = await cpaRequest<{ 'openai-compatibility': CompatChannel[] }>('/openai-compatibility')
  return result['openai-compatibility'] || []
}

export async function putCompatChannels(channels: CompatChannel[]) {
  return cpaRequest('/openai-compatibility', { method: 'PUT', body: JSON.stringify(channels) })
}

/**
 * 除了 openai-compatibility，CPA 还允许把第三方上游挂在 claude-api-key /
 * codex-api-key 等原生协议条目下（例如 Kimi 挂在 claude-api-key）。这些条目
 * 同样对外提供模型，必须一并纳入渠道视图，否则面板里禁用的根本不是它们。
 */
export const PROVIDER_KEY_ENDPOINTS = ['claude-api-key', 'codex-api-key', 'gemini-api-key', 'vertex-api-key'] as const
export type ProviderKeyEndpoint = (typeof PROVIDER_KEY_ENDPOINTS)[number]

export type ProviderKeyEntry = {
  'api-key'?: string
  prefix?: string
  'base-url'?: string
  models?: CompatModel[]
  [key: string]: unknown
}

export async function getProviderKeyEntries(endpoint: ProviderKeyEndpoint): Promise<ProviderKeyEntry[]> {
  const result = await cpaRequest<Record<string, ProviderKeyEntry[]>>(`/${endpoint}`)
  return result[endpoint] || []
}

export async function putProviderKeyEntries(endpoint: ProviderKeyEndpoint, entries: ProviderKeyEntry[]) {
  return cpaRequest(`/${endpoint}`, { method: 'PUT', body: JSON.stringify(entries) })
}

/** 用 base-url 的主机名给这类渠道命名，比 `claude-api-key[0]` 可读得多。 */
export function providerChannelName(entry: ProviderKeyEntry, endpoint: ProviderKeyEndpoint, index: number): string {
  const prefix = String(entry.prefix || '').trim()
  if (prefix) return prefix

  const baseUrl = String(entry['base-url'] || '')
  try {
    const host = new URL(baseUrl).hostname.replace(/^www\./, '')
    const label = host.split('.').filter((part) => !['com', 'cn', 'io', 'ai', 'net', 'org', 'api'].includes(part))[0]
    if (label) return label
  } catch {
    // base-url 缺失或非法时退回端点名
  }
  return `${endpoint}-${index + 1}`
}

export async function deleteCompatChannel(name: string) {
  return cpaRequest(`/openai-compatibility?name=${encodeURIComponent(name)}`, { method: 'DELETE' })
}

export async function deleteAuthFile(name: string) {
  return cpaRequest(`/auth-files?name=${encodeURIComponent(name)}`, { method: 'DELETE' })
}

export async function setAuthFileDisabled(name: string, disabled: boolean) {
  return cpaRequest('/auth-files/status', { method: 'PATCH', body: JSON.stringify({ name, disabled }) })
}

export async function setAuthFileProxy(name: string, proxyUrl: string) {
  return cpaRequest('/auth-files/fields', { method: 'PATCH', body: JSON.stringify({ name, proxy_url: proxyUrl }) })
}

export async function setAuthFileCoolingDisabled(name: string, disabled: boolean) {
  return cpaRequest('/auth-files/fields', { method: 'PATCH', body: JSON.stringify({ name, disable_cooling: disabled }) })
}

/**
 * 立刻清除某个凭据的失败冷却窗口。
 * CPA 没有专门的清冷却端点，但 disable_cooling 置 true 会当场清空该凭据的全部既有冷却
 * （2026-09-28 实测 codex 11→0、antigravity 1→0、claude 2→0），随后置回 false 恢复正常
 * 失败保护，已清掉的冷却不会回灌。用于上游额度重置成功后让凭据毫秒级重新参与池选，
 * 而不是继续等 429 里旧 resets_at 排的冷却（2026-09-27「重置了但用不了」事故）。
 */
export async function clearAuthFileCooldown(name: string) {
  await setAuthFileCoolingDisabled(name, true)
  await setAuthFileCoolingDisabled(name, false)
}

/**
 * 读取某个凭据当前的 proxy_url。
 * GET /auth-files 的条目不含该字段（buildAuthFileEntry 不返回），只能下载凭据原文再取。
 * 原文含 access_token/refresh_token，因此只在后端解析并且只把 proxy_url 交出去。
 */
export async function getAuthFileProxy(name: string): Promise<string> {
  const raw = await cpaRequest<{ proxy_url?: unknown } | null>(`/auth-files/download?name=${encodeURIComponent(name)}`)
  // 与写侧同语义：凭据不存在 → 404（本地 null / 远端 404），不再回一个"空代理"骗客户端
  if (raw === null || raw === undefined) throw new ManagementNotFoundError('credential_not_found')
  return typeof raw.proxy_url === 'string' ? raw.proxy_url.trim() : ''
}

export async function getGlobalProxy(options: { required?: boolean } = {}): Promise<string> {
  try {
    const result = await cpaRequest<{ 'proxy-url'?: string }>('/proxy-url')
    return String(result['proxy-url'] || '').trim()
  } catch (error) {
    if (options.required) throw error
    return ''
  }
}

export async function getAuthFileModels(name: string): Promise<string[]> {
  try {
    const result = await cpaRequest<{ models?: Array<{ id?: string }> }>(`/auth-files/models?name=${encodeURIComponent(name)}`)
    return (result.models || []).map((model) => String(model.id || '')).filter(Boolean)
  } catch {
    return []
  }
}

export async function getExcludedModels(): Promise<Record<string, string[]>> {
  try {
    const result = await cpaRequest<{ 'oauth-excluded-models': Record<string, string[]> }>('/oauth-excluded-models')
    return result['oauth-excluded-models'] || {}
  } catch {
    return {}
  }
}

export async function putExcludedModels(excluded: Record<string, string[]>) {
  return cpaRequest('/oauth-excluded-models', { method: 'PUT', body: JSON.stringify(excluded) })
}

export const modelId = (model: CompatModel) => String(model.alias || model.name || '').trim()

export type ApiCallResult = { status_code?: number; statusCode?: number; body?: unknown; body_text?: string }

/** CPA 代为转发上游请求，`$TOKEN$` 由 CPA 替换成该凭据的 OAuth token。 */
export async function apiCall(
  authIndex: string | undefined,
  url: string,
  options: { method?: string; header?: Record<string, string>; data?: string } = {},
) {
  return cpaRequest<ApiCallResult>('/api-call', {
    method: 'POST',
    body: JSON.stringify({
      ...(authIndex ? { auth_index: authIndex } : {}),
      method: options.method || 'GET',
      url,
      header: options.header || {
        Authorization: 'Bearer $TOKEN$',
        'Content-Type': 'application/json',
        'anthropic-beta': 'oauth-2025-04-20',
      },
      ...(options.data === undefined ? {} : { data: options.data }),
    }),
  })
}

const CODEX_HEADERS = {
  Authorization: 'Bearer $TOKEN$',
  'Content-Type': 'application/json',
  'User-Agent': 'codex_cli_rs/0.76.0 (Debian 13.0.0; x86_64) WindowsTerminal',
}

export const CODEX_RESET_CREDITS_URL = 'https://chatgpt.com/backend-api/wham/rate-limit-reset-credits'

export function codexHeaders(accountId?: string) {
  return accountId ? { ...CODEX_HEADERS, 'Chatgpt-Account-Id': accountId } : { ...CODEX_HEADERS }
}

export async function getCodexResetCredits(authIndex: string, accountId?: string) {
  return apiCall(authIndex, CODEX_RESET_CREDITS_URL, { header: codexHeaders(accountId) })
}

/** 消耗一次主动重置额度。redeem_request_id 用于上游幂等，每次必须新生成。 */
export async function consumeCodexResetCredit(authIndex: string, accountId?: string) {
  return apiCall(authIndex, `${CODEX_RESET_CREDITS_URL}/consume`, {
    method: 'POST',
    header: codexHeaders(accountId),
    data: JSON.stringify({ redeem_request_id: randomUUID() }),
  })
}

const CLAUDE_HEADERS = {
  Authorization: 'Bearer $TOKEN$',
  'Content-Type': 'application/json',
  'anthropic-version': '2023-06-01',
  'anthropic-beta': 'oauth-2025-04-20',
  // 上游按 UA 判定「surface」：不是 claude-cli 的 UA 只会拿回 ineligible_reason=surface
  'User-Agent': 'claude-cli/2.1.280 (external, cli)',
}

/**
 * `cedar_ember=1` 让同一个额度响应带上 banked reset 的 grant 列表（Claude Code CLI 2.1.280 的取法），
 * `skip_spend=1` 只是省掉用不到的 spend 段。**不额外发请求**：额度卡片本来就要打这一个 URL。
 */
export const CLAUDE_USAGE_URL = 'https://api.anthropic.com/api/oauth/usage?cedar_ember=1&skip_spend=1'
export const CLAUDE_PROFILE_URL = 'https://api.anthropic.com/api/oauth/profile'

export function claudeHeaders() {
  return { ...CLAUDE_HEADERS }
}

/** 兑现一次 banked reset。request_id 是上游幂等键：同一次点击重试要复用，新的点击必须新生成。 */
export async function claimClaudeResetCredit(authIndex: string, orgUuid: string, grantId: string) {
  return apiCall(authIndex, `https://api.anthropic.com/api/organizations/${encodeURIComponent(orgUuid)}/reset_rate_limits`, {
    method: 'POST',
    header: claudeHeaders(),
    data: JSON.stringify({ program: 'cedar_ember', grant_id: grantId, request_id: randomUUID() }),
  })
}

export async function getClaudeAccountMonitor(authIndex: string) {
  const [usage, profile] = await Promise.all([
    apiCall(authIndex, 'https://api.anthropic.com/api/oauth/usage'),
    apiCall(authIndex, 'https://api.anthropic.com/api/oauth/profile'),
  ])
  return { usage, profile }
}

export type CpaVersionInfo = {
  engine?: 'cpa' | 'magpie'
  version: string
  commit: string
  buildDate: string
  latestVersion?: string
  hasUpdate?: boolean
  upstream?: import('../packages/contracts/magpie-upstream.js').MagpieUpstreamStatus
  rtk?: import('./rtkService.js').RTKView
}

export type ConsoleVersionInfo = {
  version: string
  releaseId?: string
  releaseDate?: string
}

export type VersionsPayload = {
  cpa: CpaVersionInfo
  console: ConsoleVersionInfo
}

let cachedCpaVersion: { info: CpaVersionInfo; time: number } | null = null

/**
 * 本机是否真的持有 OAuth 凭据（供 upstream 状态里的 `oauthConnected` 用）。
 *
 * 2026-10-01（task-8）：这个字段以前是硬编码 `true`，会把「一个凭据都没有」也报成「已接通」。
 * 取证口径：只在本机控制面（`MAGPIE_CONTROL_PLANE=local`）下读本机凭据库——
 * 存在未禁用的凭据才算接通；目录不存在或读取失败一律 false。
 * 远程控制面（`cpa`）下无法在不额外发请求的前提下取证，如实回落 false，绝不假装；
 * 真实连通性看 `/api/cpa/oauth/status`。本函数只做本机目录读，无网络成本。
 */
async function localOAuthConnected(): Promise<boolean> {
  if (config.magpieControlPlane !== 'local') return false
  try {
    const { listLocalAuthFiles } = await import('./magpieControl.js')
    return listLocalAuthFiles().some((file) => !file.disabled)
  } catch {
    return false
  }
}

export async function getCpaVersion(force = false): Promise<CpaVersionInfo> {
  const { readRTKStatus } = await import('./rtkService.js')
  const rtk = await readRTKStatus().catch(() => undefined)
  if (config.gatewayEngine === 'magpie') {
    try {
      const { kernelJSON } = await import('./magpieEngine.js')
      const health = await kernelJSON(config.magpieKernelSocket, '/internal/health') as { revision?: unknown }
      if (typeof health.revision !== 'string' || !/^[a-f0-9]{40}$/.test(health.revision)) throw new Error('Invalid kernel revision')
      const { readMagpieUpstreamStatus } = await import('./magpieUpstream.js')
      /**
       * 「已接通」只能来自真正的平面探测（2026-10-01 task-8 修正，blue-rtk 上报）：
       * - `rtkConnected` 只表达「中转站（relay）平面真的可用」。本机装了 rtk 二进制、
       *   或内核有缝，都不等于接上中转站；探测结果直接复用 `readRTKStatus()` 已经拿到的
       *   `planes[]`（其内部 `resolveRtkPlane()` 有 30s 缓存，不额外增加每请求成本）。
       * - `oauthConnected` 见 `localOAuthConnected()`。
       */
      const relayPlane = rtk?.planes?.find((probe) => probe.id === 'relay')
      const upstream = readMagpieUpstreamStatus(health.revision, undefined, {
        oauthConnected: await localOAuthConnected(),
        rtkConnected: Boolean(relayPlane?.available),
      })
      return { engine: 'magpie', version: health.revision.slice(0, 7), commit: health.revision, buildDate: '',
        upstream, rtk, latestVersion: upstream.latestRelease || upstream.candidateRevision?.slice(0, 7),
        hasUpdate: upstream.status === 'review_required' && upstream.candidateRevision !== health.revision }
    } catch {
      return { engine: 'magpie', version: 'offline', commit: '', buildDate: '', rtk }
    }
  }
  if (!force && cachedCpaVersion && Date.now() - cachedCpaVersion.time < 60_000) {
    return { ...cachedCpaVersion.info, rtk }
  }
  if (!config.cpaManagementKey) {
    return { version: 'unknown', commit: '', buildDate: '', rtk }
  }
  try {
    const response = await fetch(`${config.cpaBaseUrl}/v0/management/get-auth-status`, {
      signal: AbortSignal.timeout(config.cpaRequestTimeoutMs),
      headers: {
        Authorization: `Bearer ${config.cpaManagementKey}`,
        'Content-Type': 'application/json',
      },
    })
    const cpaVersion = response.headers.get('x-cpa-version') || 'unknown'
    const commit = response.headers.get('x-cpa-commit') || ''
    const buildDate = response.headers.get('x-cpa-build-date') || ''

    let latestVersion: string | undefined
    try {
      const latestResp = await cpaRequest<{ 'latest-version'?: string }>('/latest-version')
      latestVersion = latestResp['latest-version']
    } catch {
      // latest-version 接口获取失败时不中断主版本
    }

    const hasUpdate = Boolean(
      latestVersion &&
      cpaVersion !== 'unknown' &&
      !cpaVersion.includes(latestVersion.replace(/^v/, '')) &&
      latestVersion !== cpaVersion
    )

    const info: CpaVersionInfo = {
      version: cpaVersion,
      commit,
      buildDate,
      latestVersion,
      hasUpdate,
    }
    cachedCpaVersion = { info, time: Date.now() }
    return info
  } catch {
    return {
      version: 'offline',
      commit: '',
      buildDate: '',
    }
  }
}

let cachedConsoleVersion: ConsoleVersionInfo | null = null

export function getConsoleVersion(): ConsoleVersionInfo {
  if (cachedConsoleVersion) return cachedConsoleVersion
  let version = '0.1.0'
  let releaseId: string | undefined
  let releaseDate: string | undefined

  try {
    const pkgPath = join(process.cwd(), 'package.json')
    if (existsSync(pkgPath)) {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'))
      if (pkg.version) version = pkg.version
    }
  } catch {}

  try {
    const relPath = join(process.cwd(), 'RELEASE.json')
    if (existsSync(relPath)) {
      const rel = JSON.parse(readFileSync(relPath, 'utf-8'))
      releaseId = rel.releaseId
      releaseDate = rel.createdAt
    }
  } catch {}

  cachedConsoleVersion = { version, releaseId, releaseDate }
  return cachedConsoleVersion
}

export const OAUTH_PROVIDER_ENDPOINTS: Record<string, string> = {
  antigravity: '/antigravity-auth-url?is_webui=true',
  google: '/antigravity-auth-url?is_webui=true',
  codex: '/codex-auth-url?is_webui=true',
  openai: '/codex-auth-url?is_webui=true',
  claude: '/anthropic-auth-url?is_webui=true',
  anthropic: '/anthropic-auth-url?is_webui=true',
  kimi: '/kimi-auth-url',
  'kimi-ai': '/kimi-ai-auth-url',
  devin: '/devin-auth-url?is_webui=true',
  meta: '/meta-auth-url',
  muse: '/meta-auth-url',
  xai: '/xai-auth-url?is_webui=true',
  grok: '/xai-auth-url?is_webui=true',
}

/**
 * 入口白名单（task-61 F2/F4）：`provider` 只允许注册表里的值，**未知值不再原样返回**。
 *
 * 以前 `submitOAuthCallback` 直接 `canonicalCPAProvider(provider)`，而它对未知值原样返回，
 * 于是 `provider="../../../../tmp/canary"` 会一路拼进凭据文件名（越界写）与 `authUrl`（反射）。
 * 启动路径 `startOAuthLogin` 早就有这张表，这里把回调路径也纳入同一份注册表。
 */
export function isSupportedOAuthProvider(provider: unknown): boolean {
  const norm = String(provider ?? '').toLowerCase().trim()
  return Boolean(norm) && Object.prototype.hasOwnProperty.call(OAUTH_PROVIDER_ENDPOINTS, norm)
}

/** 取支持列表（错误文案与「可选值」提示共用）。 */
export const supportedOAuthProviders = (): string[] => Object.keys(OAUTH_PROVIDER_ENDPOINTS)

export function canonicalCPAProvider(provider: string): string {
  const norm = provider.toLowerCase().trim()
  if (norm === 'claude' || norm === 'anthropic') return 'anthropic'
  if (norm === 'codex' || norm === 'openai') return 'codex'
  if (norm === 'antigravity' || norm === 'google' || norm === 'anti-gravity') return 'antigravity'
  if (norm === 'xai' || norm === 'x-ai' || norm === 'grok') return 'xai'
  if (norm === 'devin' || norm === 'cognition') return 'devin'
  if (norm === 'meta' || norm === 'muse') return 'meta'
  return norm
}

export type OAuthStartResponse = {
  status: string
  url: string
  state: string
  user_code?: string
  flow?: string
  expires_in?: number
  provider: string
}

export async function startOAuthLogin(provider: string): Promise<OAuthStartResponse> {
  const norm = provider.toLowerCase().trim()
  const endpoint = OAUTH_PROVIDER_ENDPOINTS[norm]
  if (!endpoint) {
    throw new Error(`不支持的 OAuth 提供商: ${provider}。可选: ${Object.keys(OAUTH_PROVIDER_ENDPOINTS).join(', ')}`)
  }
  const result = await cpaRequest<any>(endpoint)
  return {
    ...result,
    provider: norm,
  }
}

export type OAuthStatusResponse = {
  status: 'ok' | 'wait' | 'error' | string
  error?: string
}

export async function getOAuthStatus(state: string): Promise<OAuthStatusResponse> {
  if (!state) throw new Error('缺少 state 参数')
  return cpaRequest<OAuthStatusResponse>(`/get-auth-status?state=${encodeURIComponent(state)}`)
}

export async function submitOAuthCallback(provider: string, redirectUrl: string, sessionState?: string): Promise<{ ok: boolean }> {
  const raw = redirectUrl.trim()
  if (!raw) throw new Error('缺少回调 URL 或授权码')
  if (!isSupportedOAuthProvider(provider)) {
    throw new Error(`不支持的 OAuth 提供商: ${provider}。可选: ${supportedOAuthProviders().join(', ')}`)
  }
  const canonical = canonicalCPAProvider(provider)

  let code = ''
  let state = (sessionState || '').trim()
  let errorMsg = ''
  let effectiveRedirectUrl = raw

  // 1. 如果是完整 URL
  try {
    const parsed = new URL(raw)
    code = parsed.searchParams.get('code') || ''
    const qState = parsed.searchParams.get('state')
    if (qState) state = qState
    errorMsg = parsed.searchParams.get('error') || parsed.searchParams.get('error_description') || ''

    // 部分平台如 Claude 可能在 hash 中携带
    if (parsed.hash) {
      const hashParams = new URLSearchParams(parsed.hash.replace(/^[#?]/, ''))
      if (!code && hashParams.get('code')) code = hashParams.get('code')!
      if (!state && hashParams.get('state')) state = hashParams.get('state')!
      if (!errorMsg) errorMsg = hashParams.get('error') || hashParams.get('error_description') || ''
    }
  } catch {
    // 2. 如果不是完整 URL，尝试按 query 格式解析或当作纯 code
    if (raw.includes('code=') || raw.includes('state=')) {
      const params = new URLSearchParams(raw.replace(/^[?#]/, ''))
      code = params.get('code') || ''
      const pState = params.get('state')
      if (pState) state = pState
      errorMsg = params.get('error') || params.get('error_description') || ''
    } else {
      // 用户直接粘贴了纯 authorization code
      code = raw
    }
  }

  if (!state) {
    throw new Error('缺少 state 会话标识，请确认当前授权会话未过期并重新开始')
  }

  // 如果不是完整 http(s) URL，构造符合提供商约定的标准 callback 地址
  if (!effectiveRedirectUrl.startsWith('http://') && !effectiveRedirectUrl.startsWith('https://')) {
    let baseCallback = 'http://localhost:8317/v0/management/oauth-callback'
    if (canonical === 'anthropic') baseCallback = 'http://localhost:54545/callback'
    else if (canonical === 'codex') baseCallback = 'http://localhost:1455/auth/callback'
    else if (canonical === 'antigravity') baseCallback = 'http://localhost:51121/oauth-callback'

    effectiveRedirectUrl = `${baseCallback}?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`
  }

  await cpaRequest<any>('/oauth-callback', {
    method: 'POST',
    body: JSON.stringify({
      provider: canonical,
      redirect_url: effectiveRedirectUrl,
      code: code || undefined,
      state,
      error: errorMsg || undefined,
    }),
  })
  return { ok: true }
}

export async function cancelOAuthSession(state: string): Promise<{ ok: boolean }> {
  if (!state) return { ok: true }
  try {
    await cpaRequest<any>(`/oauth-session?state=${encodeURIComponent(state)}`, {
      method: 'DELETE',
    })
  } catch {
    // 忽略取消会话失败
  }
  return { ok: true }
}

export async function addProviderApiKey(provider: string, apiKey: string): Promise<{ ok: boolean }> {
  const norm = provider.toLowerCase().trim()
  const key = apiKey.trim()
  if (!key) throw new Error('API Key 不能为空')

  let endpoint = ''
  if (norm === 'claude' || norm === 'anthropic') {
    endpoint = '/claude-api-key'
  } else if (norm === 'codex' || norm === 'openai') {
    endpoint = '/codex-api-key'
  } else if (norm === 'gemini' || norm === 'google') {
    endpoint = '/gemini-api-key'
  } else if (norm === 'xai' || norm === 'grok') {
    endpoint = '/xai-api-key'
  } else {
    throw new Error(`提供商 ${provider} 不支持直接录入 API Key`)
  }

  const listKey = endpoint.slice(1)
  const existing = await cpaRequest<Record<string, Array<{ 'api-key': string }>>>(endpoint).catch(() => ({ [listKey]: [] }))
  const currentList = Array.isArray(existing[listKey]) ? existing[listKey] : []
  if (!currentList.some((item) => item['api-key'] === key)) {
    const updated = [...currentList, { 'api-key': key }]
    await cpaRequest<any>(endpoint, {
      method: 'PUT',
      body: JSON.stringify(updated),
    })
  }
  return { ok: true }
}

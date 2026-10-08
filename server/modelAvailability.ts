import fs from 'node:fs'
import path from 'node:path'
import { config } from './config.js'
import { maskSystemKeys } from './systemKeys.js'
import type { ConsoleGroup } from './groups.js'
import { modelKind as defaultModelKind, type ModelKind } from './modelKind.js'
import { mapWithConcurrency, sanitizeSyncError, upstreamLimiter, type SyncOutcome, type SyncRunContext } from './syncRegistry.js'

/**
 * 模型可用性探测：每个服务（OAuth provider / 兼容渠道）的每个对话模型，经本机网关发一次最小请求。
 *
 * 保护规则（单测见 modelAvailability.test.ts）：
 * - 连续 3 次「可计数失败」才下线；一次成功立即上线；
 * - 中性结果（限流/额度/余额、上游 401/403、账号冷却、超时与网络错误、502/503/504）既不计数也不清零；
 * - 一轮之内不允许把一个服务的对话模型全部下线：本轮这个服务的下线一律不生效，保持原状态并记告警；
 * - 网关整轮不可达或读不到渠道目录：本轮作废，状态文件原样保留。
 */

export type AvailabilityState = 'online' | 'offline' | 'unprobed'
export type ModelAvailability = { state: AvailabilityState; failures: number; lastOkAt: string | null; lastError: string | null; since: string }
export type AvailabilityAlarm = { at: string; service: string; models: string[]; message: string }
export type AvailabilityFile = {
  version: 1
  updatedAt: string
  services: Record<string, Record<string, ModelAvailability>>
  alarms: AvailabilityAlarm[]
}

export const OFFLINE_AFTER_FAILURES = 3
export const PROBE_INTERVAL_MS = 30 * 60_000
export const PROBE_TIMEOUT_MS = 30_000
export const PROBE_CONCURRENCY = 2
const PROBE_JITTER_MS = 1_500
const MAX_ALARMS = 50
const MAX_REASON_LENGTH = 200
const MAX_BODY_BYTES = 64 * 1024

/** 探测只在 CPA 网关下进行（渠道白名单与探测 Key 都是 CPA 的能力）；MODEL_AVAILABILITY_PROBE=false 整体关闭。 */
export const modelAvailabilityEnabled = () =>
  config.modelAvailabilityProbe && config.gatewayEngine === 'cpa' && Boolean(config.cpaManagementKey)

/* ────────────────────────── 单次探测的判定 ────────────────────────── */

export type ProbeResponse =
  | { kind: 'http'; status: number; body: string }
  | { kind: 'timeout' }
  | { kind: 'network'; message: string }

export type ProbeVerdict = { outcome: 'ok' | 'countable' | 'neutral'; reason: string }

/** 限流 / 额度 / 余额 / 过载：上游账号的状况，不代表模型下架。 */
const QUOTA_TEXT = /rate[ _-]?limit|too many requests|quota|insufficient[ _-]?(?:balance|quota|credit|funds)|credit|billing|balance|usage limit|resource[ _-]?exhausted|overloaded|capacity/i
/** 网关挑不到账号、账号冷却、鉴权失败：账号的问题，不是模型的问题。 */
const ACCOUNT_TEXT = /auth_not_found|no auth available|cooling down|cooldown|unauthori[sz]ed|forbidden|permission|invalid[ _-]?api[ _-]?key|authentication/i
/** 探测请求本身的参数被拒（个别上游对 max_tokens 有下限、思考预算要小于输出上限）：换成下线就是把探测的毛病算到模型头上。 */
const PROBE_SHAPE_TEXT = /max[\s_-]?(?:output[\s_-]?|completion[\s_-]?)?tokens|thinking[\s_.-]?budget|budget[\s_]tokens/i
const COUNTABLE_STATUS = new Set([400, 404, 422, 500, 501])

const object = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null

function errorText(body: string): string {
  try {
    const parsed = object(JSON.parse(body))
    const error = parsed?.error
    const message = object(error)?.message ?? (typeof error === 'string' ? error : null) ?? parsed?.message
    const code = object(error)?.code ?? object(error)?.type
    if (typeof message === 'string' && message) return typeof code === 'string' && code && !message.includes(code) ? `${code}: ${message}` : message
  } catch {
    // 非 JSON 错误体按原文处理
  }
  return body.replace(/\s+/g, ' ').trim()
}

const reasonOf = (prefix: string, detail: string) =>
  sanitizeSyncError(maskSystemKeys(detail ? `${prefix}: ${detail}` : prefix)).slice(0, MAX_REASON_LENGTH)

function hasUsableChoice(body: string): boolean {
  try {
    const choices = object(JSON.parse(body))?.choices
    const first = Array.isArray(choices) ? object(choices[0]) : null
    return Boolean(first && (object(first.message) || typeof first.finish_reason === 'string'))
  } catch {
    return false
  }
}

export function classifyProbe(response: ProbeResponse): ProbeVerdict {
  if (response.kind === 'timeout') return { outcome: 'neutral', reason: `超时（>${PROBE_TIMEOUT_MS / 1000}s）` }
  if (response.kind === 'network') return { outcome: 'neutral', reason: reasonOf('网络错误', response.message) }
  const { status, body } = response
  if (status >= 200 && status < 300 && hasUsableChoice(body)) return { outcome: 'ok', reason: `HTTP ${status}` }
  const text = errorText(body)
  const reason = reasonOf(`HTTP ${status}`, text)
  if (QUOTA_TEXT.test(text) || ACCOUNT_TEXT.test(text) || PROBE_SHAPE_TEXT.test(text)) return { outcome: 'neutral', reason }
  if (status >= 200 && status < 300) return { outcome: 'countable', reason: reasonOf(`HTTP ${status} 没有可用的回复`, text) }
  return { outcome: COUNTABLE_STATUS.has(status) ? 'countable' : 'neutral', reason }
}

/* ────────────────────────── 一轮结果落到状态上 ────────────────────────── */

export type ServiceRound = { service: string; models: Array<{ model: string; chat: boolean; verdict?: ProbeVerdict }> }
export type AvailabilityTransition = { service: string; model: string; from: AvailabilityState; to: AvailabilityState; reason: string }
export type RoundApplication = {
  file: AvailabilityFile
  transitions: AvailabilityTransition[]
  alarms: AvailabilityAlarm[]
  /** 上一轮没有告警的服务：只有这些才写审计，持续故障不会每 30 分钟刷一条。 */
  freshAlarms: AvailabilityAlarm[]
}

/**
 * `probed`：本轮探测过的服务（目录里的全部模型，含非对话模型）；
 * `kept`：目录里有、本轮没探测的服务（OAuth 账号暂时归零），原状态照搬；其余服务从状态里移除。
 */
export function applyProbeRound(previous: AvailabilityFile | null, round: { probed: ServiceRound[]; kept: string[] }, now: number): RoundApplication {
  const at = new Date(now).toISOString()
  const services: AvailabilityFile['services'] = {}
  const transitions: AvailabilityTransition[] = []
  const alarms: AvailabilityAlarm[] = []
  const freshAlarms: AvailabilityAlarm[] = []

  for (const service of round.kept) {
    if (previous?.services[service]) services[service] = previous.services[service]
  }

  for (const { service, models } of round.probed) {
    const before = previous?.services[service] || {}
    const next: Record<string, ModelAvailability> = {}
    const goingOffline: AvailabilityTransition[] = []
    const changes: AvailabilityTransition[] = []

    for (const { model, chat, verdict } of models) {
      const prior = before[model]
      if (!chat) {
        next[model] = { state: 'unprobed', failures: 0, lastOkAt: prior?.lastOkAt ?? null, lastError: null, since: prior?.state === 'unprobed' ? prior.since : at }
        if (prior && prior.state !== 'unprobed') changes.push({ service, model, from: prior.state, to: 'unprobed', reason: '非对话模型，不再探测' })
        continue
      }
      // 新模型和刚改判为对话的模型从「在线」起步：目录里有它，就先不拦，靠探测证明它坏了
      const base: ModelAvailability = prior && prior.state !== 'unprobed'
        ? prior
        : { state: 'online', failures: 0, lastOkAt: prior?.lastOkAt ?? null, lastError: null, since: at }
      let entry = base
      if (verdict?.outcome === 'ok') {
        entry = { state: 'online', failures: 0, lastOkAt: at, lastError: null, since: base.state === 'online' ? base.since : at }
      } else if (verdict?.outcome === 'countable') {
        const failures = base.failures + 1
        const state: AvailabilityState = base.state === 'offline' || failures >= OFFLINE_AFTER_FAILURES ? 'offline' : 'online'
        entry = { state, failures, lastOkAt: base.lastOkAt, lastError: verdict.reason, since: state === base.state ? base.since : at }
      } else if (verdict) {
        entry = { ...base, lastError: verdict.reason }
      }
      next[model] = entry
      const from = prior?.state
      if (!from || from === entry.state) continue
      if (entry.state === 'offline') {
        goingOffline.push({ service, model, from, to: 'offline', reason: `连续 ${entry.failures} 次失败：${entry.lastError ?? ''}`.slice(0, MAX_REASON_LENGTH) })
      } else {
        changes.push({ service, model, from, to: entry.state, reason: from === 'unprobed' ? '改判为对话模型，开始探测' : `探测成功（${verdict?.reason ?? ''}）` })
      }
    }

    const chatModels = models.filter((item) => item.chat).length
    const online = Object.values(next).filter((entry) => entry.state === 'online').length
    if (goingOffline.length && chatModels > 0 && online === 0) {
      // 一轮之内全线下线更可能是账号或出口故障：这个服务本轮的下线全部不生效（失败计数照记，留作证据）
      for (const { model } of goingOffline) {
        const prior = before[model]
        if (prior) next[model] = { ...next[model], state: prior.state, since: prior.since }
      }
      const alarm: AvailabilityAlarm = {
        at,
        service,
        models: goingOffline.map((item) => item.model),
        message: `本轮将使全部 ${chatModels} 个对话模型下线，已保持原状态（疑似账号或出口故障）`,
      }
      alarms.push(alarm)
      if (!previous?.alarms.some((item) => item.service === service && item.at === previous.updatedAt)) freshAlarms.push(alarm)
    } else {
      transitions.push(...goingOffline)
    }
    transitions.push(...changes)
    services[service] = next
  }

  return {
    file: { version: 1, updatedAt: at, services, alarms: [...(previous?.alarms || []), ...alarms].slice(-MAX_ALARMS) },
    transitions,
    alarms,
    freshAlarms,
  }
}

/* ────────────────────────── 状态文件 ────────────────────────── */

export const availabilityFilePath = () => path.join(config.dataDir, 'model-availability.json')

const STATES: readonly AvailabilityState[] = ['online', 'offline', 'unprobed']
const isoText = (value: unknown): value is string => typeof value === 'string' && Number.isFinite(Date.parse(value))
const textOrNull = (value: unknown, max: number) => (typeof value === 'string' ? value.slice(0, max) : null)

/** 磁盘内容不可信（手改、旧版本）：坏条目丢掉，顶层不认识就当没有。 */
export function parseAvailabilityFile(raw: unknown): AvailabilityFile | null {
  const input = object(raw)
  if (!input || input.version !== 1 || !isoText(input.updatedAt)) return null
  const services: AvailabilityFile['services'] = {}
  for (const [service, models] of Object.entries(object(input.services) || {})) {
    const entries: Record<string, ModelAvailability> = {}
    for (const [model, value] of Object.entries(object(models) || {})) {
      const entry = object(value)
      if (!entry || !STATES.includes(entry.state as AvailabilityState) || !isoText(entry.since)) continue
      const failures = Number(entry.failures)
      entries[model] = {
        state: entry.state as AvailabilityState,
        failures: Number.isSafeInteger(failures) && failures >= 0 ? failures : 0,
        lastOkAt: isoText(entry.lastOkAt) ? entry.lastOkAt : null,
        lastError: textOrNull(entry.lastError, MAX_REASON_LENGTH),
        since: entry.since,
      }
    }
    services[service] = entries
  }
  const alarms = (Array.isArray(input.alarms) ? input.alarms : [])
    .map(object)
    .filter((alarm): alarm is Record<string, unknown> => Boolean(alarm && isoText(alarm.at) && typeof alarm.service === 'string'))
    .map((alarm) => ({
      at: String(alarm.at),
      service: String(alarm.service),
      models: Array.isArray(alarm.models) ? alarm.models.filter((model): model is string => typeof model === 'string') : [],
      message: textOrNull(alarm.message, MAX_REASON_LENGTH) ?? '',
    }))
    .slice(-MAX_ALARMS)
  return { version: 1, updatedAt: input.updatedAt, services, alarms }
}

export function readAvailabilityFile(file = availabilityFilePath()): AvailabilityFile | null {
  try {
    return parseAvailabilityFile(JSON.parse(fs.readFileSync(file, 'utf8')))
  } catch {
    return null
  }
}

/** 先写临时文件再改名：中途崩溃或写满磁盘都不会留下半个文件，上一份有效结果原样保留。 */
export function writeAvailabilityFile(data: AvailabilityFile, file = availabilityFilePath()) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const temporary = `${file}.${process.pid}.tmp`
  fs.writeFileSync(temporary, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 })
  fs.renameSync(temporary, file)
}

let cached: { stamp: string; data: AvailabilityFile | null } | null = null

/** 对账每 15 秒读一次：按 mtime + size 缓存，文件没变就不重新解析。 */
export function currentAvailability(file = availabilityFilePath()): AvailabilityFile | null {
  let stamp: string
  try {
    const stat = fs.statSync(file)
    stamp = `${file}:${stat.mtimeMs}:${stat.size}`
  } catch {
    stamp = `${file}:none`
  }
  if (!cached || cached.stamp !== stamp) cached = { stamp, data: stamp.endsWith(':none') ? null : readAvailabilityFile(file) }
  return cached.data
}

/** 分组跟随可用性：去掉被判下线的模型（重新上线后自动回来）；未探测与未知的模型照留。 */
export function withModelAvailability(groups: ConsoleGroup[], data: AvailabilityFile | null): ConsoleGroup[] {
  if (!data) return groups
  return groups.map((group) => {
    const states = data.services[group.id]
    if (!states) return group
    const models = group.models.filter((model) => states[model]?.state !== 'offline')
    return models.length === group.models.length ? group : { ...group, models }
  })
}

/* ────────────────────────── 一轮探测 ────────────────────────── */

/** 经本机网关发一次最小对话请求；Key 只放在请求头里，不进任何返回值。 */
export async function probeChatModel(baseUrl: string, key: string, model: string, timeoutMs = PROBE_TIMEOUT_MS): Promise<ProbeResponse> {
  try {
    const response = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, messages: [{ role: 'user', content: 'ping' }], max_tokens: 1, stream: false }),
      signal: AbortSignal.timeout(timeoutMs),
      redirect: 'error',
    })
    const body = await response.text()
    return { kind: 'http', status: response.status, body: body.slice(0, MAX_BODY_BYTES) }
  } catch (error) {
    if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) return { kind: 'timeout' }
    return { kind: 'network', message: error instanceof Error ? error.message : String(error) }
  }
}

export type ModelAvailabilityDeps = {
  /** 未经可用性过滤的渠道目录（含 available:false 的分组）。 */
  listCatalog: () => Promise<ConsoleGroup[]>
  /** 注册并钉住每个服务的探测 Key，返回服务 → Key。 */
  ensureProbeKeys: (services: string[]) => Promise<Record<string, string>>
  probe: (key: string, model: string) => Promise<ProbeResponse>
  audit: (action: string, target: string, details: string) => void
  /** 有状态变化时调用（清缓存 + 立即对账）；失败只记日志，下一轮 15 秒对账会补上。 */
  onTransitions?: () => Promise<unknown>
  modelKind?: (model: string) => ModelKind
  read?: () => AvailabilityFile | null
  write?: (data: AvailabilityFile) => void
  limiter?: { run<T>(task: () => Promise<T>): Promise<T> }
  sleep?: (ms: number) => Promise<void>
  random?: () => number
  log?: (line: string) => void
}

export type RoundReport = { services: number; probes: number; transitions: AvailabilityTransition[]; alarms: AvailabilityAlarm[] }

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

export async function runModelAvailabilityRound(
  deps: ModelAvailabilityDeps,
  context: Pick<SyncRunContext, 'now' | 'countRequests'>,
): Promise<SyncOutcome & { value?: RoundReport }> {
  const kindOf = deps.modelKind ?? defaultModelKind
  const read = deps.read ?? (() => readAvailabilityFile())
  const write = deps.write ?? ((data: AvailabilityFile) => writeAvailabilityFile(data))
  const limiter = deps.limiter ?? upstreamLimiter
  const sleep = deps.sleep ?? defaultSleep
  const random = deps.random ?? Math.random

  // 读不到目录或注册不了探测 Key 都直接抛出：本轮作废，状态文件不动
  const catalog = await deps.listCatalog()
  // 目录暂时为空的服务和账号归零的一样原样保留：不能因为一次空目录把已下线的模型忘掉、重新放行
  const live = catalog.filter((group) => group.available !== false && group.models.length > 0)
  const keys = live.length ? await deps.ensureProbeKeys(live.map((group) => group.id)) : {}

  const tasks = live.flatMap((group) => group.models.filter((model) => kindOf(model) === 'chat').map((model) => ({ service: group.id, model })))
  const responses = await mapWithConcurrency(tasks, PROBE_CONCURRENCY, async ({ service, model }) => {
    await sleep(Math.floor(random() * PROBE_JITTER_MS))
    const response = await limiter.run(() => deps.probe(keys[service], model))
    context.countRequests(1)
    return response
  })
  if (tasks.length && responses.every((response) => response.kind === 'network')) {
    const sample = responses[0].kind === 'network' ? responses[0].message : ''
    return { result: 'error', error: sanitizeSyncError(maskSystemKeys(`网关不可达，本轮作废、保留上次结果：${sample}`)) }
  }

  const verdicts = new Map(tasks.map((task, index) => [`${task.service}\n${task.model}`, classifyProbe(responses[index])]))
  const probed: ServiceRound[] = live.map((group) => ({
    service: group.id,
    models: group.models.map((model) => {
      const verdict = verdicts.get(`${group.id}\n${model}`)
      return { model, chat: Boolean(verdict), verdict }
    }),
  }))
  const liveIds = new Set(live.map((group) => group.id))
  const kept = catalog.filter((group) => !liveIds.has(group.id)).map((group) => group.id)
  const applied = applyProbeRound(read(), { probed, kept }, context.now())
  write(applied.file)

  for (const item of applied.transitions) {
    deps.audit('model_availability', `${item.service}/${item.model}`, JSON.stringify({ from: item.from, to: item.to, reason: item.reason }))
  }
  for (const alarm of applied.freshAlarms) {
    deps.audit('model_availability_alarm', alarm.service, JSON.stringify({ models: alarm.models, message: alarm.message }))
  }
  if (applied.transitions.length && deps.onTransitions) {
    await deps.onTransitions().catch((error: unknown) => {
      (deps.log ?? console.error)(JSON.stringify({ category: '[ERROR]', event: 'model_availability.reconcile_failed', cause: sanitizeSyncError(error instanceof Error ? error.message : error) }))
    })
  }

  const counts = { online: 0, offline: 0, unprobed: 0 }
  for (const group of live) for (const entry of Object.values(applied.file.services[group.id] || {})) counts[entry.state] += 1
  const down = applied.transitions.filter((item) => item.to === 'offline').length
  const up = applied.transitions.filter((item) => item.from === 'offline' && item.to === 'online').length
  const summary = [
    `${live.length} 服务`,
    `在线 ${counts.online}`,
    counts.offline ? `下线 ${counts.offline}` : '',
    counts.unprobed ? `未探测 ${counts.unprobed}` : '',
    down ? `本轮 −${down}` : '',
    up ? `本轮 +${up}` : '',
    kept.length ? `${kept.length} 服务暂不探测` : '',
    applied.alarms.length ? `告警 ${applied.alarms.length}` : '',
  ].filter(Boolean).join(' · ')
  const value: RoundReport = { services: live.length, probes: tasks.length, transitions: applied.transitions, alarms: applied.alarms }
  if (applied.alarms.length) {
    return {
      result: 'partial',
      summary,
      error: applied.alarms.map((alarm) => `${alarm.service}：${alarm.message}`).join('；'),
      value,
    }
  }
  return { result: 'ok', summary, value }
}

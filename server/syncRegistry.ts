import fs from 'node:fs'
import path from 'node:path'
import { config } from './config.js'

/**
 * 同步中心：所有后台/上游同步任务的单一登记处（CONTRACTS C3）。
 *
 * - in-process 任务由这里排程（setTimeout 链 + 抖动 + 出错指数退避），同一任务单飞；
 * - 请求驱动的任务（账号额度）用 `observe()` 记录每次真实刷新；
 * - external 任务（launchd）只读它们自己的状态文件，**绝不在这里运行或 kickstart**；
 * - 运行记录落 `DATA_DIR/sync-state.json`（小 JSON，原子替换；坏文件直接按空状态重建，不阻塞启动）。
 */

export type SyncResult = 'ok' | 'partial' | 'error' | 'skipped'
export type SyncJobState = 'idle' | 'running' | 'backoff' | 'disabled' | 'error' | 'unknown'
export type SyncTrigger = 'boot' | 'timer' | 'watch' | 'manual' | 'request'
export type SyncJobKind = 'in-process' | 'external'

export type SyncHistoryEntry = { at: string; result: SyncResult; durationMs: number | null }

export type SyncJobView = {
  id: string
  label: string
  kind: SyncJobKind
  intervalMs: number | null
  lastRunAt: string | null
  lastFinishedAt: string | null
  nextRunAt: string | null
  state: SyncJobState
  lastResult: SyncResult | null
  lastError: string | null
  summary: string | null
  backoffUntil: string | null
  backoffLevel: number
  requests24h: number | null
  history: SyncHistoryEntry[]
  canRunNow: boolean
  runCooldownUntil: string | null
}

export type SyncPolicy = {
  globalUpstreamConcurrency: number
  minIntervalPerHostMs: number
  backoff: { factor: 2; baseMs: number; maxMs: number }
  jitterPct: number
}

export const SYNC_POLICY: SyncPolicy = {
  globalUpstreamConcurrency: 4,
  minIntervalPerHostMs: 60_000,
  backoff: { factor: 2, baseMs: 60_000, maxMs: 6 * 60 * 60_000 },
  jitterPct: 10,
}

export type SyncStatusPayload = { policy: SyncPolicy; jobs: SyncJobView[]; generatedAt: string }

export type SyncOutcome = {
  result: SyncResult
  summary?: string | null
  error?: string | null
  /** 上游给出的最短等待（Retry-After 等），出错退避至少等这么久。 */
  retryAfterMs?: number | null
  /** 本轮没有任何到期工作：不记历史、不改 lastRun，只更新私有状态与下次时间。 */
  silent?: boolean
  /** 任务自己按主机/账号做了更细的退避时，不再叠加任务级退避（否则一个坏主机会拖住其它主机）。 */
  skipBackoff?: boolean
}

export type SyncRunContext = {
  trigger: SyncTrigger
  now: () => number
  countRequests: (n?: number) => void
  /** 任务私有的持久化状态（可原地修改，运行结束后随状态文件落盘）。 */
  data: Record<string, unknown>
}

export type InProcessJobDef = {
  id: string
  label: string
  kind: 'in-process'
  /** 对外展示的周期（例如每渠道探测间隔）；null = 按需触发。 */
  intervalMs: number | null
  /** 实际排程节拍（默认 = intervalMs）；只有 scheduled 时生效。 */
  tickMs?: number
  initialDelayMs?: number
  scheduled?: boolean
  runnable?: boolean
  manualCooldownMs?: number
  enabled?: () => boolean
  /**
   * 手动触发是否绕过任务级退避。默认不绕过（退避期内 run-now 返回 429 code:"backoff"）；
   * 只有自带更细粒度上游节流（按主机/账号退避）或根本不打第三方上游的任务才应声明 true。
   */
  manualBypassesBackoff?: boolean
  /** 启动时校验/修剪状态文件里的任务私有数据（原地修改）；坏条目直接丢弃。 */
  sanitizeData?: (data: Record<string, unknown>, now: number) => void
  run?: (context: SyncRunContext) => Promise<SyncOutcome & { value?: unknown }>
  /** 由任务私有状态推算的下次真实工作时间（展示用）。 */
  nextRunAt?: (data: Record<string, unknown>, now: number) => number | null
  /** 实时字段覆盖（例如数据桥 outbox 的状态由它自己的循环维护）。 */
  overlay?: (now: number) => Partial<Omit<SyncJobView, 'id' | 'label' | 'kind'>>
}

export type ExternalSnapshot = {
  intervalMs: number | null
  lastRunAt: number | null
  lastFinishedAt?: number | null
  nextRunAt?: number | null
  state: SyncJobState
  lastResult: SyncResult | null
  lastError?: string | null
  summary?: string | null
  /** 外部任务自己的日志能给出时间线时直接用；否则由登记处按观察到的 lastRunAt 逐次补记。 */
  history?: Array<{ at: number; result: SyncResult; durationMs?: number | null }>
  /** 外部任务自己持久化的退避（例如上游检查的 nextAttemptAt）；未到期时状态显示 backoff。 */
  backoffUntil?: number | null
  backoffLevel?: number
}

export type ExternalJobDef = {
  id: string
  label: string
  kind: 'external'
  read: () => ExternalSnapshot | Promise<ExternalSnapshot>
}

export type SyncJobDef = InProcessJobDef | ExternalJobDef

type HistoryRecord = { at: number; result: SyncResult; durationMs: number | null }

type JobRecord = {
  lastRunAt?: number
  lastFinishedAt?: number
  lastResult?: SyncResult
  lastError?: string | null
  summary?: string | null
  backoffUntil?: number
  backoffLevel?: number
  nextRunAt?: number
  manualAt?: number
  history: HistoryRecord[]
  /** 桶起点（ms）→ 该桶内的上游请求数；桶宽见 requestBucketMs。 */
  requests: Record<string, number>
  /**
   * requests 的桶宽。旧文件没有这个字段，存的是整点小时桶；载入时把它们挪到该小时最后一个 5 分钟桶，
   * 这样旧计数按原来的「整小时」寿命自然过期，不会因为被当成 5 分钟桶而提前丢掉。
   */
  requestBucketMs: number
  data: Record<string, unknown>
}

type StateFile = { version: 1; jobs: Record<string, JobRecord> }

type Timer = ReturnType<typeof setTimeout>

export type SyncRegistryOptions = {
  file?: string | null
  now?: () => number
  random?: () => number
  setTimer?: (callback: () => void, ms: number) => Timer
  clearTimer?: (timer: Timer) => void
  policy?: SyncPolicy
  log?: (line: string) => void
}

const HISTORY_WINDOW_MS = 24 * 60 * 60_000
const HISTORY_MAX = 96
/** requests24h 的计数桶：5 分钟一桶，窗口边界最多多算一个桶（≤5 分钟），而不是旧的整点桶（最多多算 1 小时）。 */
const REQUEST_BUCKET_MS = 5 * 60_000
const DEFAULT_MANUAL_COOLDOWN_MS = 5 * 60_000
const RESULTS: readonly SyncResult[] = ['ok', 'partial', 'error', 'skipped']
/** Date 能表示的最大毫秒数；超过它 toISOString() 会抛 RangeError。 */
const MAX_DATE_MS = 8.64e15

const finite = (value: unknown): number | undefined => (typeof value === 'number' && Number.isFinite(value) ? value : undefined)
export const isoOrNull = (value: number | null | undefined): string | null =>
  (typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= MAX_DATE_MS ? new Date(value).toISOString() : null)
const iso = isoOrNull

/** 错误文案进状态文件和响应体前统一截断并去掉可能夹带的凭据。 */
export function sanitizeSyncError(message: unknown): string {
  const text = String(message ?? '')
  // undici 的裸 TypeError：请求没拿到任何答复（拒绝连接、DNS、断开）。同步中心与概览直接显示这一行，换成一句话
  if (/^\s*fetch failed\s*$/i.test(text)) return '网络没连上（fetch failed）'
  return text
    .replace(/(bearer\s+)[^\s"',}]+/gi, '$1***')
    .replace(/((?:api[-_]?key|token|secret|password|authorization)["']?\s*[:=]\s*["']?)[^\s"',}]+/gi, '$1***')
    .replace(/\b(sk|rk|pk)-[A-Za-z0-9_-]{8,}/g, '$1-***')
    .slice(0, 300)
}

function emptyRecord(): JobRecord {
  return { history: [], requests: {}, requestBucketMs: REQUEST_BUCKET_MS, data: {} }
}

const HOUR_MS = 60 * 60_000

/**
 * 状态文件来自磁盘（手改、旧版本、时钟回拨都可能带来离谱的时间）。除了 Date 能表示的范围，还按时钟和策略夹住：
 * 「已经发生」的时间（上次运行、手动触发）不能在未来——否则一个未来的 manualAt 会让手动运行冷却几个月；
 * 任务级退避最长 backoff.maxMs。nextRunAt 由 firstDelay 按节拍 + 最大退避夹住。
 */
function sanitizeRecord(raw: unknown, now: number, maxBackoffMs: number): JobRecord {
  const value = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {}
  const record = emptyRecord()
  const ceilings = { lastRunAt: now, lastFinishedAt: now, manualAt: now, backoffUntil: now + maxBackoffMs, backoffLevel: MAX_DATE_MS, nextRunAt: MAX_DATE_MS }
  for (const key of ['lastRunAt', 'lastFinishedAt', 'backoffUntil', 'backoffLevel', 'nextRunAt', 'manualAt'] as const) {
    const number = finite(value[key])
    if (number !== undefined && number >= 0 && number <= MAX_DATE_MS) record[key] = Math.min(number, ceilings[key])
  }
  if (RESULTS.includes(value.lastResult as SyncResult)) record.lastResult = value.lastResult as SyncResult
  if (typeof value.lastError === 'string') record.lastError = value.lastError.slice(0, 300)
  if (typeof value.summary === 'string') record.summary = value.summary.slice(0, 200)
  if (Array.isArray(value.history)) {
    record.history = value.history
      .filter((entry): entry is HistoryRecord => Boolean(entry) && typeof entry === 'object'
        && (finite((entry as HistoryRecord).at) ?? -1) >= 0 && (entry as HistoryRecord).at <= now && RESULTS.includes((entry as HistoryRecord).result))
      .map(entry => ({ at: entry.at, result: entry.result, durationMs: finite(entry.durationMs) ?? null }))
      .slice(-HISTORY_MAX)
  }
  if (value.requests && typeof value.requests === 'object') {
    const legacyHourly = value.requestBucketMs !== REQUEST_BUCKET_MS
    for (const [key, count] of Object.entries(value.requests as Record<string, unknown>)) {
      if (!/^\d+$/.test(key) || (finite(count) ?? -1) < 0) continue
      let bucket = Number(key)
      // 旧文件的整点桶装的是整小时的计数：放进该小时最后一个 5 分钟桶，寿命与旧语义一致（整小时滑出窗口才过期）。
      if (legacyHourly && bucket % HOUR_MS === 0) bucket += HOUR_MS - REQUEST_BUCKET_MS
      record.requests[String(bucket)] = (record.requests[String(bucket)] ?? 0) + Number(count)
    }
  }
  if (value.data && typeof value.data === 'object' && !Array.isArray(value.data)) record.data = value.data as Record<string, unknown>
  return record
}

export class SyncRegistry {
  readonly policy: SyncPolicy
  private readonly defs = new Map<string, SyncJobDef>()
  private readonly records = new Map<string, JobRecord>()
  private readonly inflight = new Map<string, Promise<{ outcome: SyncOutcome; value?: unknown }>>()
  private readonly observing = new Map<string, number>()
  private readonly timers = new Map<string, Timer>()
  private readonly file: string | null
  private readonly now: () => number
  private readonly random: () => number
  private readonly setTimer: (callback: () => void, ms: number) => Timer
  private readonly clearTimer: (timer: Timer) => void
  private readonly log: (line: string) => void
  private started = false
  private saveTimer: Timer | null = null

  constructor(options: SyncRegistryOptions = {}) {
    this.file = options.file ?? null
    this.now = options.now ?? Date.now
    this.random = options.random ?? Math.random
    this.setTimer = options.setTimer ?? ((callback, ms) => {
      const timer = setTimeout(callback, ms)
      timer.unref?.()
      return timer
    })
    this.clearTimer = options.clearTimer ?? ((timer) => clearTimeout(timer))
    this.policy = options.policy ?? SYNC_POLICY
    this.log = options.log ?? ((line) => console.log(line))
    this.load()
  }

  private load(): void {
    if (!this.file) return
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8')) as Partial<StateFile>
      if (parsed?.version !== 1 || !parsed.jobs || typeof parsed.jobs !== 'object') return
      for (const [id, raw] of Object.entries(parsed.jobs)) this.records.set(id, sanitizeRecord(raw, this.now(), this.policy.backoff.maxMs))
    } catch {
      // 缺文件或坏文件都按空状态起步：运行记录只是观测数据，不能挡住服务启动。
    }
  }

  flush(): void {
    if (this.saveTimer) {
      this.clearTimer(this.saveTimer)
      this.saveTimer = null
    }
    if (!this.file) return
    const jobs: Record<string, JobRecord> = {}
    for (const [id, record] of this.records) jobs[id] = record
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true })
      const temporary = `${this.file}.${process.pid}.tmp`
      fs.writeFileSync(temporary, `${JSON.stringify({ version: 1, jobs } satisfies StateFile)}\n`, { mode: 0o600 })
      fs.renameSync(temporary, this.file)
    } catch {
      // 落盘失败不影响任务本身；下次运行再写。
    }
  }

  /** 任务私有数据在运行之外被改动（例如账号冷却）时调用：5s 内防抖落盘。 */
  saveSoon(): void {
    this.scheduleSave()
  }

  private scheduleSave(): void {
    if (!this.file || this.saveTimer) return
    this.saveTimer = this.setTimer(() => {
      this.saveTimer = null
      this.flush()
    }, 5_000)
  }

  private record(id: string): JobRecord {
    let record = this.records.get(id)
    if (!record) {
      record = emptyRecord()
      this.records.set(id, record)
    }
    return record
  }

  register(def: SyncJobDef): void {
    if (this.defs.has(def.id)) throw new Error(`sync job already registered: ${def.id}`)
    this.defs.set(def.id, def)
    const record = this.record(def.id)
    if (def.kind === 'in-process' && def.sanitizeData) {
      try {
        def.sanitizeData(record.data, this.now())
      } catch {
        // 校验器自己出错时宁可丢掉这份私有状态，也不能让一个坏文件挡住任务或状态接口。
        for (const key of Object.keys(record.data)) delete record.data[key]
      }
    }
    if (this.started && def.kind === 'in-process' && this.isScheduled(def)) this.arm(def, this.firstDelay(def))
  }

  has(id: string): boolean {
    return this.defs.has(id)
  }

  /** 任务私有持久状态（与运行上下文里的 data 是同一个对象）。 */
  jobData(id: string): Record<string, unknown> {
    return this.record(id).data
  }

  private isScheduled(def: InProcessJobDef): boolean {
    return Boolean(def.run) && def.scheduled !== false && Boolean(def.tickMs ?? def.intervalMs)
  }

  private jitter(ms: number): number {
    const spread = ms * (this.policy.jitterPct / 100)
    return Math.max(1_000, Math.round(ms + spread * (this.random() * 2 - 1)))
  }

  /** 重启不重置节拍：上次计划时间还没到就按它来，避免每次重启都把上游打一遍。 */
  private firstDelay(def: InProcessJobDef): number {
    const record = this.record(def.id)
    const now = this.now()
    const initial = def.initialDelayMs ?? 0
    const planned = Math.max(record.nextRunAt ?? 0, record.backoffUntil ?? 0)
    // 时钟回拨或旧文件里的离谱时间不能把任务冻住：最多等一个节拍加最大退避。
    const ceiling = (def.tickMs ?? def.intervalMs ?? 0) + this.policy.backoff.maxMs
    return Math.max(initial, planned > now ? Math.min(planned - now, ceiling) : 0)
  }

  private arm(def: InProcessJobDef, delayMs: number): void {
    const existing = this.timers.get(def.id)
    if (existing) this.clearTimer(existing)
    const record = this.record(def.id)
    record.nextRunAt = this.now() + delayMs
    this.timers.set(def.id, this.setTimer(() => {
      this.timers.delete(def.id)
      void this.run(def.id, 'timer').catch(() => undefined)
    }, delayMs))
  }

  start(): void {
    if (this.started) return
    this.started = true
    for (const def of this.defs.values()) {
      if (def.kind === 'in-process' && this.isScheduled(def)) this.arm(def, this.firstDelay(def))
    }
  }

  stop(): void {
    this.started = false
    for (const timer of this.timers.values()) this.clearTimer(timer)
    this.timers.clear()
    this.flush()
  }

  countRequests(id: string, n = 1): void {
    if (!(n > 0)) return
    const record = this.record(id)
    const bucket = String(Math.floor(this.now() / REQUEST_BUCKET_MS) * REQUEST_BUCKET_MS)
    record.requests[bucket] = (record.requests[bucket] ?? 0) + n
    this.scheduleSave()
  }

  isRunning(id: string): boolean {
    return this.inflight.has(id) || (this.observing.get(id) ?? 0) > 0
  }

  private finish(id: string, startedAt: number, outcome: SyncOutcome): void {
    const record = this.record(id)
    const now = this.now()
    if (!outcome.silent) {
      record.lastRunAt = startedAt
      record.lastFinishedAt = now
      record.lastResult = outcome.result
      record.lastError = outcome.error ? sanitizeSyncError(outcome.error) : null
      record.summary = outcome.summary ? String(outcome.summary).slice(0, 200) : null
      record.history.push({ at: startedAt, result: outcome.result, durationMs: Math.max(0, now - startedAt) })
      record.history = record.history.filter(entry => entry.at >= now - HISTORY_WINDOW_MS).slice(-HISTORY_MAX)
      if (outcome.result === 'error' && !outcome.skipBackoff) {
        const level = (record.backoffLevel ?? 0) + 1
        const { baseMs, factor, maxMs } = this.policy.backoff
        const delay = Math.min(maxMs, Math.max(outcome.retryAfterMs ?? 0, baseMs * factor ** (level - 1)))
        record.backoffLevel = level
        record.backoffUntil = now + delay
      } else {
        record.backoffLevel = 0
        record.backoffUntil = 0
      }
    }
    for (const bucket of Object.keys(record.requests)) {
      if (Number(bucket) + REQUEST_BUCKET_MS <= now - HISTORY_WINDOW_MS) delete record.requests[bucket]
    }
  }

  /** 单飞：同一任务正在跑时，后来的调用直接拿到同一个结果。 */
  run(id: string, trigger: SyncTrigger): Promise<{ outcome: SyncOutcome; value?: unknown }> {
    const pending = this.inflight.get(id)
    if (pending) return pending
    const def = this.defs.get(id)
    if (!def || def.kind !== 'in-process' || !def.run) return Promise.reject(new Error(`sync job not runnable: ${id}`))
    const execute = async () => {
      const startedAt = this.now()
      let outcome: SyncOutcome
      let value: unknown
      if (def.enabled && !def.enabled()) {
        outcome = { result: 'skipped', summary: '未启用', silent: true }
      } else {
        const context: SyncRunContext = {
          trigger,
          now: this.now,
          countRequests: (n = 1) => this.countRequests(id, n),
          data: this.record(id).data,
        }
        try {
          const result = await def.run!(context)
          value = result.value
          outcome = {
            result: result.result,
            summary: result.summary ?? null,
            error: result.error ?? null,
            retryAfterMs: result.retryAfterMs ?? null,
            silent: result.silent === true && trigger !== 'manual',
            skipBackoff: result.skipBackoff === true,
          }
        } catch (error) {
          outcome = { result: 'error', error: error instanceof Error ? error.message : String(error) }
        }
      }
      this.finish(id, startedAt, outcome)
      if (!outcome.silent) {
        this.log(JSON.stringify({ category: '[SYNC]', event: 'sync.run', job: id, trigger, result: outcome.result, durationMs: this.now() - startedAt, ...(outcome.error ? { error: sanitizeSyncError(outcome.error) } : {}) }))
      }
      if (this.started && this.isScheduled(def)) {
        const record = this.record(id)
        const tick = this.jitter(def.tickMs ?? def.intervalMs ?? 60_000)
        const backoffDelay = (record.backoffUntil ?? 0) - this.now()
        this.arm(def, Math.max(tick, backoffDelay))
      }
      this.flush()
      return { outcome, value }
    }
    const promise = execute().finally(() => this.inflight.delete(id))
    this.inflight.set(id, promise)
    return promise
  }

  /** 请求驱动的刷新（例如账号额度页加载）：照常执行，只在旁边记一笔运行记录。 */
  async observe<T>(id: string, task: () => Promise<T>, summarize: (value: T) => SyncOutcome): Promise<T> {
    const startedAt = this.now()
    this.observing.set(id, (this.observing.get(id) ?? 0) + 1)
    try {
      const value = await task()
      let outcome: SyncOutcome
      try { outcome = summarize(value) } catch { outcome = { result: 'ok' } }
      this.finish(id, startedAt, outcome)
      this.scheduleSave()
      return value
    } catch (error) {
      this.finish(id, startedAt, { result: 'error', error: error instanceof Error ? error.message : String(error) })
      this.scheduleSave()
      throw error
    } finally {
      const left = (this.observing.get(id) ?? 1) - 1
      if (left > 0) this.observing.set(id, left)
      else this.observing.delete(id)
    }
  }

  /**
   * 手动触发的统一准入（`POST /api/sync/:id/run` 与兼容入口 `POST /api/models/sync` 共用）：
   * 存在、可运行、已启用、不在运行、不在手动冷却、不在任务级退避（声明 manualBypassesBackoff 的除外）。
   * 放行时记下 manualAt（冷却从这里起算）并返回 null；不放行返回响应体。
   */
  admitManual(id: string): { status: number; body: Record<string, unknown> } | null {
    const def = this.defs.get(id)
    if (!def) return { status: 404, body: { accepted: false, code: 'not_found', error: '同步任务不存在' } }
    if (def.kind !== 'in-process' || !def.run || def.runnable === false) {
      return { status: 400, body: { accepted: false, code: 'not_runnable', error: '该任务不能从控制台触发' } }
    }
    if (def.enabled && !def.enabled()) return { status: 400, body: { accepted: false, code: 'disabled', error: '该任务未启用' } }
    if (this.isRunning(id)) return { status: 409, body: { accepted: false, code: 'running', error: '正在运行' } }
    const now = this.now()
    // 冷却与退避同时生效时按更晚的那个回 Retry-After：否则客户端按 300s 重试，仍会被 1h 的退避挡住。
    const cooldownUntil = this.cooldownUntil(def)
    const backoffUntil = this.manualBackoffUntil(def)
    const until = Math.max(cooldownUntil, backoffUntil)
    if (until > now) {
      const backoff = backoffUntil > cooldownUntil
      return { status: 429, body: { accepted: false, code: backoff ? 'backoff' : 'cooldown', error: backoff ? '任务退避中' : '手动运行冷却中', retryAfterSec: Math.ceil((until - now) / 1000) } }
    }
    this.record(id).manualAt = now
    return null
  }

  /** `POST /api/sync/:id/run`：服务端冷却，防止手动按钮变成刷上游的入口。 */
  requestRun(id: string): { status: number; body: Record<string, unknown> } {
    const rejected = this.admitManual(id)
    if (rejected) return rejected
    void this.run(id, 'manual').catch(() => undefined)
    return { status: 202, body: { accepted: true, jobId: id } }
  }

  private cooldownUntil(def: InProcessJobDef): number {
    const manualAt = this.record(def.id).manualAt ?? 0
    return manualAt ? manualAt + (def.manualCooldownMs ?? DEFAULT_MANUAL_COOLDOWN_MS) : 0
  }

  private manualBackoffUntil(def: InProcessJobDef): number {
    return def.manualBypassesBackoff ? 0 : this.record(def.id).backoffUntil ?? 0
  }

  private requests24h(record: JobRecord, now: number): number {
    let total = 0
    for (const [bucket, count] of Object.entries(record.requests)) {
      if (Number(bucket) + REQUEST_BUCKET_MS > now - HISTORY_WINDOW_MS) total += count
    }
    return total
  }

  private history(record: JobRecord, now: number): SyncHistoryEntry[] {
    return record.history
      .filter(entry => entry.at >= now - HISTORY_WINDOW_MS)
      .slice(-HISTORY_MAX)
      .map(entry => ({ at: new Date(entry.at).toISOString(), result: entry.result, durationMs: entry.durationMs }))
  }

  private viewInProcess(def: InProcessJobDef, now: number): SyncJobView {
    const record = this.record(def.id)
    const running = this.isRunning(def.id)
    const enabled = def.enabled ? def.enabled() : true
    const backoffActive = (record.backoffUntil ?? 0) > now
    const state: SyncJobState = !enabled ? 'disabled'
      : running ? 'running'
        : backoffActive ? 'backoff'
          : record.lastResult === 'error' ? 'error'
            : record.lastRunAt || this.isScheduled(def) ? 'idle' : 'unknown'
    const runnable = Boolean(def.run) && def.runnable !== false
    const cooldownUntil = runnable ? Math.max(this.cooldownUntil(def), this.manualBackoffUntil(def)) : 0
    const derived = def.nextRunAt?.(record.data, now) ?? null
    const timerAt = this.timers.has(def.id) ? record.nextRunAt ?? null : null
    const nextRunAt = enabled ? (derived !== null && timerAt !== null ? Math.max(derived, timerAt) : derived ?? timerAt) : null
    const view: SyncJobView = {
      id: def.id,
      label: def.label,
      kind: 'in-process',
      intervalMs: def.intervalMs,
      lastRunAt: iso(record.lastRunAt),
      lastFinishedAt: iso(record.lastFinishedAt),
      nextRunAt: iso(nextRunAt),
      state,
      lastResult: record.lastResult ?? null,
      lastError: record.lastError ?? null,
      summary: record.summary ?? null,
      backoffUntil: backoffActive ? iso(record.backoffUntil) : null,
      backoffLevel: backoffActive ? record.backoffLevel ?? 0 : 0,
      requests24h: this.requests24h(record, now),
      history: this.history(record, now),
      canRunNow: runnable && enabled && !running && cooldownUntil <= now,
      runCooldownUntil: cooldownUntil > now ? iso(cooldownUntil) : null,
    }
    return def.overlay ? { ...view, ...def.overlay(now) } : view
  }

  private async viewExternal(def: ExternalJobDef, now: number): Promise<SyncJobView> {
    const record = this.record(def.id)
    let snapshot: ExternalSnapshot
    try {
      snapshot = await def.read()
    } catch (error) {
      snapshot = { intervalMs: null, lastRunAt: null, state: 'unknown', lastResult: null, lastError: sanitizeSyncError(error instanceof Error ? error.message : error) }
    }
    // 外部任务没有自己的历史：每看到一次新的 lastRunAt 就补记一笔，服务运行期间自然攒出时间线。
    if (!snapshot.history && snapshot.lastRunAt && snapshot.lastResult && snapshot.lastRunAt !== record.lastRunAt) {
      record.lastRunAt = snapshot.lastRunAt
      record.history.push({ at: snapshot.lastRunAt, result: snapshot.lastResult, durationMs: null })
      record.history = record.history.filter(entry => entry.at >= now - HISTORY_WINDOW_MS).slice(-HISTORY_MAX)
      this.scheduleSave()
    }
    const backoffActive = typeof snapshot.backoffUntil === 'number' && snapshot.backoffUntil > now && snapshot.backoffUntil <= MAX_DATE_MS
    // 过了「预定下次运行 + 一个周期」还没有新结果：外部调度器多半停了（锁残留、plist 被卸载……），不能继续显示 idle/ok。
    const expectedAt = snapshot.nextRunAt ?? null
    const stale = !backoffActive && typeof expectedAt === 'number' && typeof snapshot.intervalMs === 'number' && snapshot.intervalMs > 0
      && now > expectedAt + snapshot.intervalMs
    const state: SyncJobState = backoffActive ? 'backoff' : stale ? 'unknown' : snapshot.state
    const summary = stale ? [snapshot.summary, '逾期未运行'].filter(Boolean).join(' · ') : snapshot.summary ?? null
    return {
      id: def.id,
      label: def.label,
      kind: 'external',
      intervalMs: snapshot.intervalMs,
      lastRunAt: iso(snapshot.lastRunAt),
      lastFinishedAt: iso(snapshot.lastFinishedAt ?? snapshot.lastRunAt),
      nextRunAt: iso(snapshot.nextRunAt ?? null),
      state,
      lastResult: snapshot.lastResult,
      lastError: snapshot.lastError ? sanitizeSyncError(snapshot.lastError) : null,
      summary,
      backoffUntil: backoffActive ? iso(snapshot.backoffUntil) : null,
      backoffLevel: backoffActive ? Math.max(0, Math.floor(snapshot.backoffLevel ?? 0)) : 0,
      requests24h: null,
      history: snapshot.history
        ? snapshot.history
          .filter(entry => entry.at >= now - HISTORY_WINDOW_MS)
          .slice(-HISTORY_MAX)
          .map(entry => ({ at: new Date(entry.at).toISOString(), result: entry.result, durationMs: entry.durationMs ?? null }))
        : this.history(record, now),
      canRunNow: false,
      runCooldownUntil: null,
    }
  }

  async status(): Promise<SyncStatusPayload> {
    const now = this.now()
    const jobs = await Promise.all([...this.defs.values()].map(def => (def.kind === 'external' ? this.viewExternal(def, now) : this.viewInProcess(def, now))))
    return { policy: this.policy, jobs, generatedAt: new Date(now).toISOString() }
  }
}

/** 进程内只有一个登记处；状态文件和数据库同目录，跟着 DATA_DIR 走。 */
export const syncRegistry = new SyncRegistry({ file: path.join(config.dataDir, 'sync-state.json') })

const freshMarks = new Map<string, number>()

/**
 * `?fresh=1` 这类「丢缓存」开关的服务端限流：同一个 key 在 minIntervalMs 内只放行一次，
 * 其余请求照常走缓存（页面每次加载都带 fresh 也不会把上游打穿）。
 */
export function allowFreshInvalidation(key: string, minIntervalMs = 60_000, now = Date.now()): boolean {
  const last = freshMarks.get(key) ?? 0
  if (now - last < minIntervalMs) return false
  freshMarks.set(key, now)
  return true
}

export function resetFreshInvalidation(): void {
  freshMarks.clear()
}

/**
 * 计数信号量。`upstreamLimiter` 是 `policy.globalUpstreamConcurrency` 的真正执行点：
 * 账号额度的每一次 /api-call 转发和模型发现的每一次 /models 探测都在这里排队，
 * 所以「同时在途的第三方上游请求 ≤ 4」对所有进程内任务合计成立，而不只是「同时在处理的账号 ≤ 4」。
 */
export function createLimiter(limit: number) {
  const max = Math.max(1, Math.floor(limit))
  let active = 0
  const waiting: Array<() => void> = []
  const release = () => {
    active -= 1
    const next = waiting.shift()
    if (next) {
      active += 1
      next()
    }
  }
  return {
    get active() { return active },
    get pending() { return waiting.length },
    async run<T>(task: () => Promise<T>): Promise<T> {
      if (active < max) active += 1
      else await new Promise<void>(resolve => waiting.push(resolve))
      try {
        return await task()
      } finally {
        release()
      }
    },
  }
}

export const upstreamLimiter = createLimiter(SYNC_POLICY.globalUpstreamConcurrency)

/** 有界并发的 map（账号额度扇出等）：保持输入顺序，单项失败由调用方自己兜住。 */
export async function mapWithConcurrency<T, R>(items: readonly T[], limit: number, task: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length)
  let next = 0
  const worker = async () => {
    while (next < items.length) {
      const index = next++
      results[index] = await task(items[index], index)
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker))
  return results
}

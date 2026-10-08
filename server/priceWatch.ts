import fs from 'node:fs'
import path from 'node:path'
import { config } from './config.js'
import {
  RATE_COMPONENTS, applyObservedPrice, cacheWritePrice, entryFor, normalizeModelForPricing, pricedIdFor, restoreObservedPrices,
  type ObservedPriceHistory, type PriceEntry, type RateComponent,
} from './pricing.js'
import type { SyncOutcome } from './syncRegistry.js'

/**
 * 价格巡检：每 6h 读三个价源，把真实改价变成带生效时刻的新价段。
 *
 * - 「改价」= 同一来源这次的价和它上次的价不同（基线按来源分开记）。来源之间、来源与静态表之间本来就不一致不算改价。
 * - 只改账单正在跟随的分项：账单价等于该来源上次的价才跟；人工核定的价（例如转售渠道刊例价）不被覆盖，只记一笔 skipped。
 * - 新价从观测时刻起生效；入库时已结算的用量从不重算。
 * - 任一分项变化超过 50% 要同一来源连续两次读取得到同一组价才生效；第二次不同就从第二次重新等。
 * - 读取失败或为空时什么都不改；来源 12h 没有成功读取标为过期。
 * - 每个事件追加到 DATA_DIR/pricing/price-changes.jsonl，生效的改价另记审计；状态（基线、待确认、已生效改价）
 *   原子写入 DATA_DIR/pricing/price-watch.json，进程启动时据此重放已生效的改价。
 */

export type WatchSource = 'official' | 'models.dev' | 'openrouter'
/** 处理顺序即优先级：同一轮里先让官方价生效，后面的来源看到账单价已经到位就只更新基线。 */
export const WATCH_SOURCES: readonly WatchSource[] = ['official', 'models.dev', 'openrouter']
const LABEL: Record<WatchSource, string> = { official: '官方', 'models.dev': 'models.dev', openrouter: 'OpenRouter' }

export const PRICE_WATCH_INTERVAL_MS = 6 * 60 * 60_000
export const SOURCE_STALE_MS = 12 * 60 * 60_000
const CONFIRM_ABOVE = 0.5

export type Rates = Partial<Record<RateComponent, number>>

/** fetchedAt = 这份价真正从上游取回的时刻：共享产物里各来源自己的时间戳；官方价是本次读取时刻。 */
export type SourceRead = { ok: true; fetchedAt: number; prices: Map<string, Rates>; note?: string } | { ok: false; error: string }

type Pending = { observed: Rates; firstObservedAt: string }
type SourceState = { lastOkAt?: number; lastAttemptAt?: number; lastFetchedAt?: number; lastError?: string | null }

export type PriceWatchState = {
  version: 1
  baselines: Partial<Record<WatchSource, Record<string, Rates>>>
  pending: Partial<Record<WatchSource, Record<string, Pending>>>
  sources: Partial<Record<WatchSource, SourceState>>
  applied: Record<string, ObservedPriceHistory>
}

export type PriceComponentChange = { component: RateComponent; before: number; after: number; changePct: number | null }

export type PriceWatchEvent = {
  at: string
  type: 'applied' | 'pending' | 'discarded' | 'skipped'
  model: string
  source: WatchSource
  components: PriceComponentChange[]
  /** applied：经两次读取确认时第一次看到的时刻；pending：false = 首次观测，true = 第二次读到不同的价、重新等 */
  firstObservedAt?: string
  restarted?: boolean
  reason?: string
}

/* ────────────────────────── 价源读数 ────────────────────────── */

/** 浮点噪声（0.7999999999999999）不算改价。 */
const round = (value: number) => Number(value.toPrecision(12))
const same = (a: number, b: number) => Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b))

/**
 * 只收正数：网关把缺失的分项写成 0（CPA 的 omitempty），OpenRouter 的免费变体也是 0。
 * 缺失就是缺失，不能当成「降到 0」去改账单价。
 */
export function normalizeRates(raw: Partial<Record<RateComponent, unknown>>): Rates {
  const rates: Rates = {}
  for (const component of RATE_COMPONENTS) {
    const value = raw[component]
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) rates[component] = round(value)
  }
  return rates
}

/** 网关 model-definitions 的价（`gatewayPricingMap` 的结果）。部分渠道失败时其余照常，并在 note 里列出。 */
export function gatewayPriceRead(map: Map<string, Partial<Record<RateComponent, unknown>>>, failures: string[], now: number): SourceRead {
  const prices = new Map<string, Rates>()
  for (const [id, pricing] of map) {
    const rates = normalizeRates(pricing)
    if (Object.keys(rates).length) prices.set(id, rates)
  }
  if (!prices.size) return { ok: false, error: failures.length ? `网关价格来源全部失败：${failures.join('、')}` : '网关未返回任何价格' }
  return { ok: true, fetchedAt: now, prices, ...(failures.length ? { note: `缺 ${failures.join('、')}` } : {}) }
}

type SharedPricing = {
  sources?: Record<string, { ok?: boolean; fetchedAt?: number; error?: string } | undefined>
  rows?: Array<{ id?: unknown; source?: unknown; prices?: Record<string, (Partial<Record<RateComponent, unknown>> & { unit?: unknown }) | undefined> }>
}

/** 共享产物的 `pricing` 段（models.dev / OpenRouter 双源，由共享同步实现联网抓取）。 */
export function sharedPriceReads(pricing: SharedPricing | null | undefined): Partial<Record<WatchSource, SourceRead>> {
  const reads: Partial<Record<WatchSource, SourceRead>> = {}
  for (const source of ['models.dev', 'openrouter'] as const) {
    if (!pricing || !Array.isArray(pricing.rows)) {
      reads[source] = { ok: false, error: '共享目录没有价格段' }
      continue
    }
    const status = pricing.sources?.[source]
    if (status?.ok === false) {
      reads[source] = { ok: false, error: status.error ? `上游失败：${status.error}` : '上游失败' }
      continue
    }
    const fetchedAt = status?.fetchedAt
    if (typeof fetchedAt !== 'number' || !Number.isFinite(fetchedAt) || fetchedAt <= 0) {
      reads[source] = { ok: false, error: '共享目录缺少抓取时间' }
      continue
    }
    const prices = new Map<string, Rates>()
    for (const row of pricing.rows) {
      const price = row?.source === source ? row.prices?.[source] : undefined
      if (!price || typeof row.id !== 'string' || (price.unit !== undefined && price.unit !== 'usd-per-million-tokens')) continue
      const rates = normalizeRates(price)
      if (Object.keys(rates).length) prices.set(row.id, rates)
    }
    reads[source] = prices.size ? { ok: true, fetchedAt, prices } : { ok: false, error: '没有任何价格' }
  }
  return reads
}

/** 价源 id → 价格表里精确收录的 id；多个别名落到同一模型时，名字完全一致的那条优先。 */
function resolvePriced(prices: Map<string, Rates>): Map<string, Rates> {
  const resolved = new Map<string, Rates>()
  const exact = new Set<string>()
  for (const [raw, rates] of prices) {
    const id = pricedIdFor(raw)
    if (!id || exact.has(id)) continue
    if (normalizeModelForPricing(raw) === id) exact.add(id)
    else if (resolved.has(id)) continue
    resolved.set(id, rates)
  }
  return resolved
}

/* ────────────────────────── 状态 ────────────────────────── */

const emptyState = (): PriceWatchState => ({ version: 1, baselines: {}, pending: {}, sources: {}, applied: {} })
const isObject = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value)
const isTime = (value: unknown): value is string => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(value) && Number.isFinite(Date.parse(value))
const isStamp = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value > 0
const rate = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value >= 0

function sanitizeRates(value: unknown): Rates | null {
  if (!isObject(value)) return null
  const rates = normalizeRates(value)
  return Object.keys(rates).length ? rates : null
}

function sanitizeApplied(value: unknown): ObservedPriceHistory | null {
  if (!isObject(value) || !isObject(value.base) || !Array.isArray(value.changes)) return null
  const base = value.base
  if (!rate(base.input) || !rate(base.output) || !rate(base.cacheRead) || (base.cacheWrite !== undefined && !rate(base.cacheWrite))) return null
  const tiers = Array.isArray(base.tiers) && base.tiers.every(tier => isObject(tier) && rate(tier.above) && rate(tier.input) && rate(tier.output) && rate(tier.cacheRead))
    ? base.tiers as PriceEntry['tiers'] : undefined
  const changes = value.changes.flatMap((change) => {
    const rates = isObject(change) ? sanitizeRates(change.changes) : null
    return rates && isObject(change) && isTime(change.at) ? [{ at: change.at, changes: rates, note: typeof change.note === 'string' ? change.note.slice(0, 80) : '观测改价' }] : []
  })
  if (!changes.length) return null
  return {
    base: { input: base.input as number, output: base.output as number, cacheRead: base.cacheRead as number, ...(base.cacheWrite !== undefined ? { cacheWrite: base.cacheWrite as number } : {}), ...(tiers?.length ? { tiers } : {}) },
    changes,
  }
}

/** 磁盘状态逐项校验，坏条目丢弃；顶层不是本格式时抛错（由调用方报告，不覆盖）。 */
export function sanitizePriceWatchState(raw: unknown): PriceWatchState {
  if (!isObject(raw) || raw.version !== 1) throw new Error('unsupported price-watch state')
  const state = emptyState()
  for (const source of WATCH_SOURCES) {
    const baselines = isObject(raw.baselines) ? raw.baselines[source] : undefined
    if (isObject(baselines)) {
      for (const [id, value] of Object.entries(baselines)) {
        const rates = sanitizeRates(value)
        if (rates) (state.baselines[source] ??= {})[id] = rates
      }
    }
    const pending = isObject(raw.pending) ? raw.pending[source] : undefined
    if (isObject(pending)) {
      for (const [id, value] of Object.entries(pending)) {
        const observed = isObject(value) ? sanitizeRates(value.observed) : null
        if (observed && isObject(value) && isTime(value.firstObservedAt)) (state.pending[source] ??= {})[id] = { observed, firstObservedAt: value.firstObservedAt }
      }
    }
    const status = isObject(raw.sources) ? raw.sources[source] : undefined
    if (isObject(status)) {
      const kept: SourceState = {}
      for (const key of ['lastOkAt', 'lastAttemptAt', 'lastFetchedAt'] as const) if (isStamp(status[key])) kept[key] = status[key] as number
      if (typeof status.lastError === 'string') kept.lastError = status.lastError.slice(0, 300)
      state.sources[source] = kept
    }
  }
  if (isObject(raw.applied)) {
    for (const [id, value] of Object.entries(raw.applied)) {
      const history = sanitizeApplied(value)
      if (history) state.applied[id] = history
    }
  }
  return state
}

/* ────────────────────────── 巡检 ────────────────────────── */

function billed(entry: PriceEntry, component: RateComponent): number {
  return component === 'cacheWrite' ? cacheWritePrice(entry) : entry[component]
}

const changePct = (before: number, after: number) => (before > 0 ? Math.round(((after - before) / before) * 1000) / 10 : null)
const sameRates = (left: Rates, right: Rates) =>
  RATE_COMPONENTS.every(component => (left[component] === undefined ? right[component] === undefined : right[component] !== undefined && same(left[component]!, right[component]!)))
const ratesOf = ({ from: _from, until: _until, note: _note, ...rates }: PriceEntry) => rates

function componentWords(components: PriceComponentChange[]): string {
  return components.map(({ component, before, after, changePct: pct }) => `${component} ${before}→${after}${pct === null ? '' : ` (${pct > 0 ? '+' : ''}${pct}%)`}`).join('，')
}

export type PriceWatchRunOptions = {
  readOfficial: () => Promise<SourceRead>
  readShared: () => Partial<Record<WatchSource, SourceRead>>
  now?: number
  audit?: (action: string, target: string, detail: string) => void
}

export class PriceWatcher {
  private state: PriceWatchState | null = null
  private loaded = false
  private loadError: string | null = null

  constructor(private readonly files: { state: string; log: string }) {}

  /** 启动时调用（幂等）：读状态，把已生效的改价重放进价格表。返回重放的模型数。 */
  restore(): number {
    if (this.loaded) return 0
    this.loaded = true
    let text: string
    try {
      text = fs.readFileSync(this.files.state, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') this.state = emptyState()
      else this.loadError = `价格巡检状态读取失败（${path.basename(this.files.state)}）`
      return 0
    }
    try {
      this.state = sanitizePriceWatchState(JSON.parse(text))
    } catch {
      // 不覆盖坏文件：里面是已生效改价的唯一来源，交给人处理
      this.loadError = `价格巡检状态文件损坏（${path.basename(this.files.state)}），已生效的改价未重放；修复或移走后重启`
      return 0
    }
    return restoreObservedPrices(this.state.applied)
  }

  /** 一轮读数落到状态与价格表上（就地修改 state）。 */
  private applyReads(state: PriceWatchState, reads: Partial<Record<WatchSource, SourceRead>>, now: number): PriceWatchEvent[] {
    const at = new Date(now).toISOString()
    const events: PriceWatchEvent[] = []
    for (const source of WATCH_SOURCES) {
      const read = reads[source]
      if (!read) continue
      const status = (state.sources[source] ??= {})
      status.lastAttemptAt = now
      if (!read.ok) {
        status.lastError = read.error.slice(0, 300)
        continue
      }
      status.lastError = null
      // 共享产物没刷新时读到的是同一份数据：不算一次新读取，否则一份快照就能「连续两次一致」
      if (status.lastFetchedAt !== undefined && read.fetchedAt <= status.lastFetchedAt) continue
      status.lastFetchedAt = read.fetchedAt
      status.lastOkAt = read.fetchedAt
      const baselines = (state.baselines[source] ??= {})
      const pending = (state.pending[source] ??= {})
      for (const [model, observed] of resolvePriced(read.prices)) {
        const base = baselines[model]
        if (!base) {
          baselines[model] = observed
          continue
        }
        const merged = { ...base, ...observed }
        const waiting = pending[model]
        const changed = RATE_COMPONENTS.filter(component => observed[component] !== undefined && base[component] !== undefined && !same(observed[component]!, base[component]!))
        const finish = () => {
          baselines[model] = merged
          delete pending[model]
        }
        if (!changed.length) {
          if (waiting) {
            const components = RATE_COMPONENTS.filter(component => waiting.observed[component] !== undefined && base[component] !== undefined && !same(waiting.observed[component]!, base[component]!))
              .map(component => ({ component, before: base[component]!, after: waiting.observed[component]!, changePct: changePct(base[component]!, waiting.observed[component]!) }))
            events.push({ at, type: 'discarded', model, source, components, firstObservedAt: waiting.firstObservedAt, reason: '再次读取回到原价' })
          }
          finish()
          continue
        }
        // 价格表还没有这个模型：由「价格元数据」任务按网关价补，这里只记基线
        const entry = entryFor(model, now)
        if (!entry) {
          finish()
          continue
        }
        const describe = (components: RateComponent[]) => components.map(component => ({ component, before: base[component]!, after: observed[component]!, changePct: changePct(base[component]!, observed[component]!) }))
        const followed = changed.filter(component => same(billed(entry, component), base[component]!))
        const curated = changed.filter(component => !followed.includes(component) && !same(billed(entry, component), observed[component]!))
        if (curated.length) events.push({ at, type: 'skipped', model, source, components: describe(curated), reason: '账单价与该来源上次的价不同（人工核定或跟随别的来源），不跟随' })
        if (!followed.length) {
          finish()
          continue
        }
        const components = describe(followed)
        const confirmed = Boolean(waiting && sameRates(waiting.observed, observed))
        if (!confirmed && components.some(({ before, after }) => before <= 0 || Math.abs(after - before) / before > CONFIRM_ABOVE)) {
          pending[model] = { observed, firstObservedAt: at }
          events.push({ at, type: 'pending', model, source, components, restarted: Boolean(waiting) })
          continue
        }
        const changes = Object.fromEntries(followed.map(component => [component, observed[component]!])) as Rates
        const note = `${LABEL[source]} 改价`
        const result = applyObservedPrice(model, { at, changes, note })
        if (result) {
          const history = (state.applied[model] ??= { base: ratesOf(result.before), changes: [] })
          history.changes.push({ at, changes, note })
          events.push({ at, type: 'applied', model, source, components, ...(confirmed ? { firstObservedAt: waiting!.firstObservedAt } : {}) })
        }
        finish()
      }
    }
    return events
  }

  private persist(state: PriceWatchState): string | null {
    try {
      fs.mkdirSync(path.dirname(this.files.state), { recursive: true, mode: 0o700 })
      const temporary = `${this.files.state}.${process.pid}.tmp`
      const handle = fs.openSync(temporary, 'w', 0o600)
      try {
        fs.writeFileSync(handle, `${JSON.stringify(state)}\n`)
        fs.fsyncSync(handle)
      } finally {
        fs.closeSync(handle)
      }
      fs.renameSync(temporary, this.files.state)
      return null
    } catch (error) {
      // 内存里的状态仍完整，下一轮会把它整份写出
      return `状态写入失败：${error instanceof Error ? error.message : String(error)}`
    }
  }

  private appendLog(events: PriceWatchEvent[]): string | null {
    if (!events.length) return null
    try {
      fs.mkdirSync(path.dirname(this.files.log), { recursive: true, mode: 0o700 })
      fs.appendFileSync(this.files.log, events.map(event => `${JSON.stringify(event)}\n`).join(''), { mode: 0o600 })
      return null
    } catch (error) {
      return `改价记录写入失败：${error instanceof Error ? error.message : String(error)}`
    }
  }

  async run(options: PriceWatchRunOptions): Promise<SyncOutcome & { events?: PriceWatchEvent[] }> {
    this.restore()
    const state = this.state
    if (!state) return { result: 'error', error: this.loadError ?? '价格巡检状态不可用', summary: '未读取价源，未改动任何价格' }
    const now = options.now ?? Date.now()
    const official = await options.readOfficial().catch((error: unknown): SourceRead => ({ ok: false, error: error instanceof Error ? error.message : String(error) }))
    let shared: Partial<Record<WatchSource, SourceRead>>
    try {
      shared = options.readShared()
    } catch (error) {
      const failed: SourceRead = { ok: false, error: error instanceof Error ? error.message : String(error) }
      shared = { 'models.dev': failed, openrouter: failed }
    }
    const reads: Partial<Record<WatchSource, SourceRead>> = { ...shared, official }
    const events = this.applyReads(state, reads, now)
    const writeErrors = [this.persist(state), this.appendLog(events)].filter((error): error is string => Boolean(error))
    for (const event of events) {
      if (event.type !== 'applied') continue
      const confirmedNote = event.firstObservedAt ? ` · 首次观测 ${event.firstObservedAt}` : ''
      options.audit?.('price_change', event.model, `${LABEL[event.source]} · ${componentWords(event.components)} · 生效 ${event.at}${confirmedNote}`)
    }

    const failed = WATCH_SOURCES.filter(source => reads[source] && !reads[source]!.ok)
    const stale = WATCH_SOURCES.filter((source) => {
      const last = state.sources[source]?.lastOkAt
      return !last || now - last > SOURCE_STALE_MS
    })
    const problems = [
      ...failed.map(source => `${LABEL[source]} 读取失败：${(reads[source] as { error: string }).error}`),
      ...WATCH_SOURCES.flatMap((source) => {
        const read = reads[source]
        return read?.ok && read.note ? [`${LABEL[source]} ${read.note}`] : []
      }),
      ...stale.filter(source => !failed.includes(source)).map((source) => {
        const last = state.sources[source]?.lastOkAt
        return last ? `${LABEL[source]} 超过 ${Math.floor((now - last) / 3_600_000)} 小时没有新价格（过期）` : `${LABEL[source]} 从未成功读取（过期）`
      }),
      ...writeErrors,
    ]
    const applied = events.filter(event => event.type === 'applied').length
    const pending = WATCH_SOURCES.reduce((total, source) => total + Object.keys(state.pending[source] ?? {}).length, 0)
    const summary = [applied ? `改价生效 ${applied}` : '无改价生效', pending ? `待确认 ${pending}` : '', `价格源 ${WATCH_SOURCES.length - stale.length}/${WATCH_SOURCES.length}`].filter(Boolean).join(' · ')
    return {
      result: failed.length === WATCH_SOURCES.length ? 'error' : problems.length ? 'partial' : 'ok',
      summary,
      error: problems.length ? problems.join('；') : null,
      events,
    }
  }
}

export const priceWatcher = new PriceWatcher({
  state: path.join(config.dataDir, 'pricing', 'price-watch.json'),
  log: path.join(config.dataDir, 'pricing', 'price-changes.jsonl'),
})

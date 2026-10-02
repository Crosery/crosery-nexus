/**
 * /accounts view model (DESIGN.md §6.5). Pure: no Vue, no DOM, so `server/accountsPageModel.test.ts` runs it
 * under node. Two existing endpoints feed it:
 *   /api/channels  `credentials`  every credential file of every type (disabled, status, proxy)
 *   /api/monitor   `accounts`     the monitored types (codex / claude / antigravity) with the gateway's raw
 *                                 auth-file fields (status_message, next_retry_after, recent_requests,
 *                                 priority …) plus `normalizedQuota` and the per-provider `quotaShare`.
 */
import type { EgressData, EgressRead } from '../../types.js'
import { EGRESS_CUSTOM, EGRESS_UNKNOWN, egressChoice } from './egressModel.js'

/**
 * The account states this page shows: a subset of the kit's StatusKind (src/ui/types.ts), declared here so the
 * model stays importable from node tests without pulling the kit's Vue composables into the server program.
 */
export type AccountState = 'run' | 'busy' | 'pause' | 'cool' | 'warn' | 'bad'

/* ── provider catalog ─────────────────────────────────────────────────────────────────────────── */

export type ProviderInfo = {
  /** OAuth provider id for /api/cpa/oauth/start */
  id: string
  /** credential `type` values that belong to this group */
  types: string[]
  name: string
  vendor: string
  /** browser = open the sign-in page and wait for the callback; device = enter / confirm a code */
  flow: 'browser' | 'device'
  /** the remote-server fallback: paste the localhost callback URL from the address bar */
  paste: boolean
  pastePlaceholder?: string
  /** Magpie marks these: sharing the subscription through a gateway can get the account banned */
  risk: boolean
  /** the console has a reset endpoint for this type */
  resettable: boolean
  /** /api/monitor reads its quota windows */
  monitored: boolean
  /** ProviderMark key */
  mark: string
}

export const PROVIDERS: ProviderInfo[] = [
  { id: 'codex', types: ['codex', 'openai'], name: 'Codex', vendor: 'OpenAI · ChatGPT 订阅', flow: 'browser', paste: true, pastePlaceholder: 'http://localhost:1455/auth/callback?code=…&state=…', risk: false, resettable: true, monitored: true, mark: 'codex' },
  { id: 'claude', types: ['claude', 'anthropic'], name: 'Claude', vendor: 'Anthropic · Claude 订阅', flow: 'browser', paste: true, pastePlaceholder: 'http://localhost:54545/callback?code=…&state=…', risk: true, resettable: true, monitored: true, mark: 'claude' },
  { id: 'antigravity', types: ['antigravity', 'google'], name: 'Antigravity', vendor: 'Google · 按模型家族计额', flow: 'browser', paste: true, pastePlaceholder: 'http://localhost:51121/oauth-callback?code=…&state=…', risk: true, resettable: false, monitored: true, mark: 'antigravity' },
  { id: 'kimi', types: ['kimi'], name: 'Kimi', vendor: 'Moonshot · kimi.com 国内站', flow: 'device', paste: false, risk: false, resettable: false, monitored: false, mark: 'kimi' },
  { id: 'kimi-ai', types: ['kimi-ai'], name: 'Kimi 国际站', vendor: 'Moonshot · kimi.ai', flow: 'device', paste: false, risk: false, resettable: false, monitored: false, mark: 'kimi' },
  { id: 'xai', types: ['xai', 'grok'], name: 'Grok', vendor: 'xAI · SuperGrok', flow: 'browser', paste: true, pastePlaceholder: 'http://localhost:…/callback?code=…', risk: false, resettable: false, monitored: false, mark: 'xai' },
  { id: 'devin', types: ['devin'], name: 'Devin', vendor: 'Cognition', flow: 'browser', paste: true, pastePlaceholder: 'http://127.0.0.1:8317/callback?code=…&state=…', risk: false, resettable: false, monitored: false, mark: 'devin' },
  { id: 'meta', types: ['meta', 'muse'], name: 'Meta AI', vendor: 'Meta · Muse', flow: 'device', paste: false, risk: false, resettable: false, monitored: false, mark: 'meta' },
]

export function providerForType(type: string): ProviderInfo | null {
  const t = String(type || '').trim().toLowerCase()
  return PROVIDERS.find((p) => p.types.includes(t)) ?? null
}

export function providerById(id: string | null | undefined): ProviderInfo | null {
  return PROVIDERS.find((p) => p.id === id) ?? null
}

export function flowLabel(p: ProviderInfo): string {
  if (p.flow === 'device') return '设备码'
  return p.paste ? '浏览器登录 · 可粘贴回调' : '浏览器登录'
}

/* ── input shapes (only the fields read here) ─────────────────────────────────────────────────── */

export type CredentialLike = {
  name: string
  type: string
  disabled: boolean
  status?: string
  label?: string
  modelCount?: number
  proxyUrl?: string
}

export type NormalizedWindow = {
  id: string
  label: string
  usedPercent: number
  resetsAt: string | null
  windowSeconds: number | null
  severity?: string
  scope: string | null
}

export type NormalizedQuota = {
  plan: string
  tier: string
  resetCredits: { available: number; applicable: number; entries: Array<{ id: string; expiresAt: string }> } | null
  windows: NormalizedWindow[]
  error: string | null
}

export type MonitorAccount = Record<string, unknown> & { name?: string; normalizedQuota?: NormalizedQuota | null }

export type QuotaShareKey = { keyId: string; keyName: string; requests: number; promptTokens: number; outputTokens: number; share: number }
export type ShareWindow = { windowStart: number; keys: QuotaShareKey[] }
export type QuotaShare = Record<string, ShareWindow | undefined>

/* ── view shapes ──────────────────────────────────────────────────────────────────────────────── */

export type WindowView = {
  id: string
  /** full label from the server (`5 小时额度`, `Gemini 模型 · 7 天额度`) */
  label: string
  /** micro label for the meter: 5H · 7D · G·5H */
  short: string
  /** used ratio 0..1 */
  used: number
  resetsAt: string | null
  /** duration class used to pick the row's two windows */
  span: 'short' | 'long' | 'other'
  /** a per-model window (Claude Fable, Codex Spark) — never the row's headline unless nothing else exists */
  scoped: boolean
}

export type Credits = { count: number; entries: Array<{ id: string; expiresAt: string }> }

export type RecentActivity = { ticks: number[]; bad: boolean[]; ok: number; failed: number }

export type Attention = 'bad' | 'warn' | null

export type AccountView = {
  key: string
  /** credential file name (the PATCH/DELETE id) */
  name: string
  authIndex: string | null
  type: string
  provider: ProviderInfo | null
  email: string
  plan: string
  disabled: boolean
  state: AccountState
  stateLabel: string
  /** gateway cooldown end (epoch ms), future only */
  coolUntil: number | null
  /** cooldown length estimate for the draining pie (null = pie stays full) */
  coolTotal: number | null
  lapsed: boolean
  /** the └ leader under the row: why it is cooling / lapsed / erroring */
  leader: string | null
  windows: WindowView[]
  a: WindowView | null
  b: WindowView | null
  /** windows not shown in the row */
  extra: WindowView[]
  credits: Credits | null
  /** ok = windows to show · error = read failed · empty = read fine, no windows · missing = monitor did not
   *  answer for it · none = the console reads no quota for this type */
  quotaState: 'ok' | 'error' | 'empty' | 'missing' | 'none'
  /** upstream / cache error text (also set with ok when the windows are the last good read) */
  quotaError: string | null
  recent: RecentActivity | null
  proxyUrl: string
  priority: number | null
  first: boolean
  routable: boolean
  attention: Attention
  modelCount: number | null
}

export type ProviderGroup = {
  key: string
  provider: ProviderInfo | null
  type: string
  name: string
  vendor: string
  accounts: AccountView[]
  routable: number
  /** priorities differ → the gateway picks the highest first */
  tiered: boolean
}

/* ── helpers ──────────────────────────────────────────────────────────────────────────────────── */

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '')
const num = (v: unknown): number | null => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v) : NaN
  return Number.isFinite(n) ? n : null
}
const ms = (v: unknown): number | null => {
  if (typeof v === 'number') return Number.isFinite(v) && v > 0 ? v : null
  const s = str(v)
  if (!s) return null
  const t = Date.parse(s)
  return Number.isFinite(t) ? t : null
}

const HOUR = 3_600_000
const DAY = 24 * HOUR

/** window duration in seconds: explicit, else read from the label / id the server gave it */
function spanSeconds(w: NormalizedWindow): number | null {
  if (w.windowSeconds && w.windowSeconds > 0) return w.windowSeconds
  const text = `${w.label} ${w.id}`.toLowerCase()
  if (/5\s*小时|five_hour|five-hour|session|\b5h\b/.test(text)) return 5 * 3600
  if (/7\s*天|seven_day|weekly|week|\b7d\b/.test(text)) return 7 * 86400
  if (/30\s*天|month/.test(text)) return 30 * 86400
  if (/每日|1\s*天|daily|\b1d\b/.test(text)) return 86400
  return null
}

function durLabel(seconds: number | null): string {
  if (!seconds) return '—'
  if (seconds <= 5.5 * 3600) return `${Math.max(1, Math.round(seconds / 3600))}H`
  if (seconds <= 26 * 3600) return '1D'
  return `${Math.round(seconds / 86400)}D`
}

/** antigravity family scopes become a one-letter prefix (G·5H / C·7D); per-model scopes are flagged instead */
const FAMILY_PREFIX: Record<string, string> = { 'gemini 模型': 'G', 'claude / gpt 模型': 'C' }

export function windowView(w: NormalizedWindow): WindowView {
  const seconds = spanSeconds(w)
  const scope = str(w.scope)
  const family = scope ? FAMILY_PREFIX[scope.toLowerCase()] : undefined
  const dur = durLabel(seconds)
  const short = family ? `${family}·${dur}` : scope ? `${dur}*` : dur === '—' ? (str(w.label).slice(0, 3) || '—') : dur
  return {
    id: String(w.id),
    label: str(w.label) || dur,
    short,
    used: Math.max(0, Number(w.usedPercent) || 0) / 100,
    resetsAt: w.resetsAt || null,
    span: seconds === null ? 'other' : seconds <= DAY / 1000 ? 'short' : 'long',
    scoped: Boolean(scope) && !family,
  }
}

const tightest = (list: WindowView[]) => list.reduce<WindowView | null>((best, w) => (!best || w.used > best.used ? w : best), null)

/**
 * The row shows two windows (Magpie: at most two, tightest per family): A = tightest short window (≤1 day),
 * B = tightest long one. Per-model windows only stand in when no general window exists in that class.
 */
export function pickWindows(windows: WindowView[]): { a: WindowView | null; b: WindowView | null; extra: WindowView[] } {
  const general = windows.filter((w) => !w.scoped)
  const pool = (span: WindowView['span']) => {
    const g = general.filter((w) => w.span === span)
    return g.length ? g : windows.filter((w) => w.span === span)
  }
  let a = tightest(pool('short'))
  let b = tightest(pool('long'))
  if (!a && !b) {
    const sorted = [...(general.length ? general : windows)].sort((x, y) => y.used - x.used)
    a = sorted[0] ?? null
    b = sorted[1] ?? null
  } else if (!a || !b) {
    const rest = (general.length ? general : windows).filter((w) => w !== a && w !== b && w.span === 'other')
    if (!a) a = tightest(rest)
    else if (!b) b = tightest(rest)
  }
  const extra = windows.filter((w) => w !== a && w !== b)
  return { a, b, extra }
}

/** `401 · 授权失效` vs a cooldown reason vs anything else, from the gateway's status_message */
const LAPSED_RE = /\b401\b|unauthori[sz]ed|invalid[_ ]grant|token[^a-z]*(has )?expired|refresh[_ ]token|revoked|signed[_ ]out|re-?auth|登录失效|授权失效|重新登录/i

export function lapsedFrom(message: string): boolean {
  return Boolean(message) && LAPSED_RE.test(message)
}

export function reasonWords(message: string): string {
  const m = message.toLowerCase()
  if (!m) return '上游暂时不可用'
  if (/\b429\b|rate.?limit|too many/.test(m)) return '429 限流 · Retry-After'
  if (/quota|usage.?limit|exceeded|exhausted|用尽|超额/.test(m)) return '额度用尽 · 到重置时刻恢复'
  if (/\b5\d\d\b|overload|unavailable|timeout|timed out|超时/.test(m)) return '上游不可用 · 自动重试'
  if (/\b403\b|forbidden/.test(m)) return '403 · 上游拒绝'
  const flat = message.replace(/\s+/g, ' ').trim()
  return flat.length > 48 ? `${flat.slice(0, 47)}…` : flat
}

function recentFrom(raw: unknown): RecentActivity | null {
  if (!Array.isArray(raw) || !raw.length) return null
  const ticks: number[] = []
  const bad: boolean[] = []
  let ok = 0
  let failed = 0
  for (const bucket of raw as Array<Record<string, unknown>>) {
    const s = num(bucket?.success) ?? 0
    const f = num(bucket?.failed) ?? 0
    ticks.push(s + f)
    bad.push(f > 0)
    ok += s
    failed += f
  }
  return { ticks, bad, ok, failed }
}

function creditsFrom(q: NormalizedQuota | null | undefined): Credits | null {
  const rc = q?.resetCredits
  if (!rc) return null
  const count = Math.max(0, Math.round(Number(rc.available) || 0))
  const entries = [...(rc.entries ?? [])]
    .filter((e) => e && typeof e.expiresAt === 'string')
    .sort((x, y) => (ms(x.expiresAt) ?? Infinity) - (ms(y.expiresAt) ?? Infinity))
  return { count, entries }
}

/** plan tag: the tier when the server has one (Max 20× · Pro), else the plan without the vendor prefix */
function planFrom(q: NormalizedQuota | null | undefined, raw: Record<string, unknown>): string {
  const tier = str(q?.tier)
  if (tier) return tier
  const plan = str(q?.plan).replace(/^(Codex|Claude|AntiGravity)\s*/i, '')
  if (plan) return plan
  return str(raw.account_type) && str(raw.account_type) !== 'oauth' ? str(raw.account_type) : ''
}

/** what the add sheet learns after a finished authorization: the new row, a renewal, or nothing yet */
export type VerifyResult = { name: string; email: string } | { renewed: true } | null

/**
 * After the gateway reports the authorization done: a credential that was not there when the sheet opened is the
 * new account. A renewal is only claimed when the sheet was opened to re-authorize a specific account and that
 * account is listed; a plain add whose file is not listed yet is `null`, so the sheet retries and then warns.
 * `baseline` null = the list was never read before the flow started (a deep link landing before the first
 * answer): nothing can be told apart, so no account is claimed as the new one.
 */
export function verifyOutcome(
  mine: Array<{ key: string; email: string }>,
  baseline: ReadonlySet<string> | null,
  reauthEmail: string | null,
  readOk: boolean,
): VerifyResult {
  const added = baseline ? mine.find((row) => !baseline.has(row.key)) : undefined
  if (added) return { name: added.key, email: added.email }
  if (!readOk || !reauthEmail) return null
  const want = reauthEmail.trim().toLowerCase()
  return mine.some((row) => row.email.trim().toLowerCase() === want) ? { renewed: true } : null
}

/* ── per-account exit (read: GET /api/proxies/egress/account · write: POST /api/proxies/assign, or PATCH …/proxy for an address) ── */

/**
 * The authoritative per-account exit. The list endpoints cannot be trusted for it: CPA's /auth-files carries no
 * proxy_url, so /api/channels reports '' for every account; only the per-credential read knows. The server answers
 * with the pool entry it points at and a masked value — never the URL.
 */
export type ProxyRead = { state: 'loading' } | { state: 'ready'; value: EgressRead } | { state: 'error' }

export const PROXY_CUSTOM = EGRESS_CUSTOM
export const PROXY_UNKNOWN = EGRESS_UNKNOWN

/** The picker's value: '' 继承 · 'direct' 直连 · a pool entry id · `preset:N` · custom; unknown until the read answers. */
export function proxyChoice(read: ProxyRead, egress: EgressData | null | undefined): string {
  if (read.state !== 'ready') return PROXY_UNKNOWN
  return egressChoice(read.value, egress)
}

/** A pick is skipped only when the current value is known and equal; an unknown current value is never assumed. */
export function proxyNeedsWrite(read: ProxyRead, next: string, egress: EgressData | null | undefined): boolean {
  if (next === PROXY_CUSTOM || next === PROXY_UNKNOWN) return false
  return read.state !== 'ready' || proxyChoice(read, egress) !== next
}

/**
 * Whether a settling read must leave the picker alone: an address still being typed in 自定义 survives a read that
 * lands meanwhile (a slow first GET, a 重读). The address just sent (`sent`) does not: the answer replaces it.
 */
export function proxyKeepsDraft(choice: string, draft: string, sent: string | null): boolean {
  const typed = draft.trim()
  return choice === PROXY_CUSTOM && typed !== '' && typed !== sent
}

/**
 * The custom address counts as `sent` (its answer replaces the field) only while its write is in flight. A
 * successful PATCH lands its answer (knowProxy) before the write ends, so a write that ends with the address still
 * outstanding failed: it is a draft again, and the re-read that follows leaves it in the field for a retry (FF-24).
 */
export function proxySentAfterWrite(busyBefore: string | undefined, busyNow: string | undefined, sent: string | null): string | null {
  return busyBefore === 'proxy' && busyNow !== 'proxy' ? null : sent
}

/* ── the page's two reads, merged per endpoint ────────────────────────────────────────────────── */

export type SplitPayload<C, M> = {
  channels: C | null
  monitor: M | null
  /** the endpoint that failed on this refresh while the other one answered */
  channelsError: unknown
  monitorError: unknown
  at: number
  /** when each side was last read successfully (null = never) */
  channelsAt: number | null
  monitorAt: number | null
}

/**
 * One refresh where only one endpoint fails must not wipe that endpoint's last good data (quota windows, reset
 * credits, authIndex, the unmonitored accounts, proxy presets): keep the previous value with its own read time and
 * keep the error, so the page can say "showing data from hh:mm".
 */
export function mergeAccountsPayload<C, M>(prev: SplitPayload<C, M> | null | undefined, next: SplitPayload<C, M>): SplitPayload<C, M> {
  const out = { ...next }
  if (next.channels === null && next.channelsError && prev?.channels != null) {
    out.channels = prev.channels
    out.channelsAt = prev.channelsAt
  }
  if (next.monitor === null && next.monitorError && prev?.monitor != null) {
    out.monitor = prev.monitor
    out.monitorAt = prev.monitorAt
  }
  return out
}

/* ── merge ────────────────────────────────────────────────────────────────────────────────────── */

const STATE_ORDER: Record<string, number> = { bad: 0, warn: 1, cool: 2, busy: 3, run: 4, pause: 5, off: 6, idle: 6, stale: 6 }

/**
 * Credentials (every type) ⋈ monitor accounts (monitored types, with quota). Either side may be missing when its
 * endpoint failed; the other still renders. `disabled` prefers the credential list (it is refreshed on writes).
 */
export function buildAccounts(credentials: CredentialLike[] | null, monitor: MonitorAccount[] | null, now = Date.now()): AccountView[] {
  const byName = new Map<string, MonitorAccount>()
  for (const m of monitor ?? []) {
    const name = str(m.name) || str(m.filename)
    if (name) byName.set(name, m)
  }
  const seen = new Set<string>()
  const rows: AccountView[] = []
  const add = (cred: CredentialLike | null, raw: MonitorAccount | null) => {
    const name = cred?.name || str(raw?.name) || str(raw?.filename)
    if (!name || seen.has(name)) return
    seen.add(name)
    rows.push(viewOf(name, cred, raw ?? {}, now))
  }
  for (const cred of credentials ?? []) add(cred, byName.get(cred.name) ?? null)
  for (const m of monitor ?? []) add(null, m)
  markRouting(rows)
  return rows
}

function viewOf(name: string, cred: CredentialLike | null, raw: MonitorAccount, now: number): AccountView {
  const type = (cred?.type || str(raw.type) || str(raw.provider) || 'oauth').toLowerCase()
  const provider = providerForType(type)
  const q = (raw.normalizedQuota ?? null) as NormalizedQuota | null
  const disabled = cred ? Boolean(cred.disabled) : Boolean(raw.disabled)
  const status = (cred?.status || str(raw.status)).toLowerCase()
  const message = str(raw.status_message)
  const until = ms(raw.next_retry_after)
  const coolUntil = until !== null && until > now ? until : null
  const lapsed = !disabled && (lapsedFrom(message) || (status === 'error' && /\b401\b/.test(message)))
  const changed = ms(raw.updated_at)
  // the gateway does not report when a cooldown started; the last state change is the best start estimate
  const coolTotal = coolUntil && changed && changed < now && coolUntil - changed < 2 * DAY ? coolUntil - changed : null

  let state: AccountState = 'run'
  let stateLabel = '运行'
  let leader: string | null = null
  if (disabled) {
    state = 'pause'
    stateLabel = '暂停'
  } else if (lapsed) {
    state = 'bad'
    stateLabel = '失效'
    leader = /\b401\b/.test(message) || !message ? '401 · 授权失效 · 重新授权后恢复' : `授权失效 · ${reasonWords(message)}`
  } else if (coolUntil) {
    state = 'cool'
    stateLabel = '冷却'
    leader = `网关休息中：${reasonWords(message)} · 唯一可用时仍会被尝试`
  } else if (status === 'error') {
    state = 'warn'
    stateLabel = '异常'
    leader = message ? reasonWords(message) : '网关标记为异常 · 原因未上报'
  } else if (status === 'refreshing') {
    state = 'busy'
    stateLabel = '刷新中'
  } else if (status === 'pending') {
    state = 'warn'
    stateLabel = '待验证'
    leader = '等待外部验证'
  }

  const monitored = Boolean(provider?.monitored)
  const windows = (q?.windows ?? []).map(windowView)
  const { a, b, extra } = pickWindows(windows)
  const email = str(raw.email) || str(raw.account) || str(cred?.label) || str(raw.label) || name.replace(/\.json$/i, '')
  return {
    key: name,
    name,
    authIndex: raw.auth_index === undefined || raw.auth_index === null ? null : String(raw.auth_index),
    type,
    provider,
    email,
    plan: planFrom(q, raw),
    disabled,
    state,
    stateLabel,
    coolUntil,
    coolTotal,
    lapsed,
    leader,
    windows,
    a,
    b,
    extra,
    credits: creditsFrom(q),
    quotaState: windows.length ? 'ok' : !monitored ? 'none' : !q ? 'missing' : q.error ? 'error' : 'empty',
    quotaError: monitored && q?.error ? q.error : null,
    recent: recentFrom(raw.recent_requests),
    proxyUrl: cred?.proxyUrl ?? str(raw.proxy_url),
    priority: num(raw.priority),
    first: false,
    routable: false,
    attention: null,
    modelCount: cred?.modelCount ?? null,
  }
}

function groupKey(row: AccountView): string {
  return row.provider?.id ?? row.type
}

/** routable / 首选 / escalation need the whole provider group */
function markRouting(rows: AccountView[]) {
  const groups = new Map<string, AccountView[]>()
  for (const row of rows) {
    const k = groupKey(row)
    groups.set(k, [...(groups.get(k) ?? []), row])
  }
  for (const list of groups.values()) {
    for (const row of list) row.routable = !row.disabled && !row.lapsed && row.state !== 'cool'
    const routable = list.filter((r) => r.routable)
    // CPA picks the highest-priority bucket first; 首选 only means something when exactly one account leads
    const prios = routable.map((r) => r.priority ?? 0)
    const top = Math.max(...prios)
    const leaders = routable.filter((r) => (r.priority ?? 0) === top)
    if (routable.length > 1 && leaders.length === 1 && new Set(prios).size > 1) leaders[0].first = true
    for (const row of list) {
      if (row.state === 'bad') row.attention = 'bad'
      else if (row.state === 'warn') row.attention = 'warn'
      else if (row.state === 'cool' && routable.length === 0) {
        // DESIGN §2.2: a cooldown escalates only when it took the provider's last routable account
        row.attention = 'warn'
        row.leader = `${row.leader ?? '网关休息中'} · ${row.provider?.name ?? row.type} 已无可用账号`
      }
    }
  }
}

export function groupAccounts(rows: AccountView[]): ProviderGroup[] {
  const map = new Map<string, ProviderGroup>()
  for (const row of rows) {
    const k = groupKey(row)
    let g = map.get(k)
    if (!g) {
      g = {
        key: k,
        provider: row.provider,
        type: row.type,
        name: row.provider?.name ?? (row.type ? row.type.charAt(0).toUpperCase() + row.type.slice(1) : '其它'),
        vendor: row.provider?.vendor ?? '其它凭据',
        accounts: [],
        routable: 0,
        tiered: false,
      }
      map.set(k, g)
    }
    g.accounts.push(row)
  }
  const order = (g: ProviderGroup) => {
    const i = PROVIDERS.findIndex((p) => p.id === g.provider?.id)
    return i === -1 ? PROVIDERS.length : i
  }
  const groups = [...map.values()].sort((x, y) => order(x) - order(y) || x.name.localeCompare(y.name))
  for (const g of groups) {
    g.accounts.sort((x, y) => (STATE_ORDER[x.state] ?? 9) - (STATE_ORDER[y.state] ?? 9) || x.email.localeCompare(y.email))
    g.routable = g.accounts.filter((a) => a.routable).length
    g.tiered = new Set(g.accounts.map((a) => a.priority ?? 0)).size > 1
  }
  return groups
}

/**
 * The groups as a filter shows them: only matching accounts, empty groups dropped, and the head facts (参与路由,
 * 按优先级选号) recounted over what is shown. Guards that need the whole provider (pause-last-account) keep using
 * the unfiltered `groupAccounts` result.
 */
export function filterGroups(groups: ProviderGroup[], show: string, q: string): ProviderGroup[] {
  return groups
    .map((g) => {
      const accounts = g.accounts.filter((r) => matches(r, show, q))
      return { ...g, accounts, routable: accounts.filter((a) => a.routable).length, tiered: new Set(accounts.map((a) => a.priority ?? 0)).size > 1 }
    })
    .filter((g) => g.accounts.length > 0)
}

/* ── filters, counts ──────────────────────────────────────────────────────────────────────────── */

export type ShowFilter = 'all' | 'run' | 'cool' | 'pause' | 'bad' | 'warn' | 'hot' | 'reset'

export const HOT_RATIO = 0.9

export function isHot(row: AccountView): boolean {
  return row.windows.some((w) => w.used >= HOT_RATIO)
}

export function matches(row: AccountView, show: string, q: string): boolean {
  if (show === 'run' && !(row.state === 'run' || row.state === 'busy')) return false
  if (show === 'cool' && row.state !== 'cool') return false
  if (show === 'pause' && row.state !== 'pause') return false
  if (show === 'bad' && row.state !== 'bad') return false
  if (show === 'warn' && row.state !== 'warn') return false
  if (show === 'hot' && !isHot(row)) return false
  if (show === 'reset' && !((row.credits?.count ?? 0) > 0)) return false
  const needle = q.trim().toLowerCase()
  if (!needle) return true
  return [row.email, row.plan, row.name, row.provider?.name ?? '', row.type].some((v) => v.toLowerCase().includes(needle))
}

export function countBy(rows: AccountView[]) {
  return {
    all: rows.length,
    run: rows.filter((r) => r.state === 'run' || r.state === 'busy').length,
    cool: rows.filter((r) => r.state === 'cool').length,
    pause: rows.filter((r) => r.state === 'pause').length,
    /** 失效 = authorization lapsed; 异常 = the gateway marks it failing for another reason (words mean one thing) */
    bad: rows.filter((r) => r.state === 'bad').length,
    warn: rows.filter((r) => r.state === 'warn').length,
    hot: rows.filter(isHot).length,
    reset: rows.filter((r) => (r.credits?.count ?? 0) > 0).length,
    attention: rows.filter((r) => r.attention !== null).length,
    providers: new Set(rows.map(groupKey)).size,
  }
}

/* ── time words ───────────────────────────────────────────────────────────────────────────────── */

const SHANGHAI = 'Asia/Shanghai'
const WEEKDAY = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']
const partsFmt = new Intl.DateTimeFormat('en-US', { timeZone: SHANGHAI, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', weekday: 'short' })
const WD: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }

function wall(t: number) {
  const p: Record<string, string> = {}
  for (const part of partsFmt.formatToParts(new Date(t))) p[part.type] = part.value
  const hour = p.hour === '24' ? '00' : p.hour
  return { y: Number(p.year), m: p.month, d: p.day, hm: `${hour}:${p.minute}`, wd: WD[p.weekday] ?? 0, day: Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day)) }
}

/** Magpie's resetClock: today `15:10` · tomorrow `明天 09:00` · this week `周四 09:00` · else `10/04 22:30`. */
export function fmtReset(value: string | number | null | undefined, now = Date.now()): string {
  const t = ms(value)
  if (t === null) return '—'
  const w = wall(t)
  const n = wall(now)
  const days = Math.round((w.day - n.day) / DAY)
  if (days === 0) return w.hm
  if (days === 1) return `明天 ${w.hm}`
  if (days > 1 && days < 7) return `${WEEKDAY[w.wd]} ${w.hm}`
  return `${w.m}/${w.d} ${w.hm}`
}

/** `10/04 22:30` (Shanghai), for credit expiry lines. */
export function fmtStamp(value: string | number | null | undefined): string {
  const t = ms(value)
  if (t === null) return '—'
  const w = wall(t)
  return `${w.m}/${w.d} ${w.hm}`
}

/** Strip userinfo from a proxy URL before it is ever shown (it may carry credentials). */
export function proxyLabel(url: string): string {
  const v = url.trim()
  if (!v) return '继承网关'
  if (v === 'direct') return '直连'
  try {
    const u = new URL(v)
    return `${u.protocol}//${u.hostname}${u.port ? `:${u.port}` : ''}`
  } catch {
    return v.replace(/\/\/[^@/]*@/, '//')
  }
}

/* ── reset outcomes (server response → resetOutcome.ts outcome) ───────────────────────────────── */

export type ResetOutcomeCode = 'ok' | 'partial' | 'no_window' | 'no_credit' | 'redeemed' | 'cooldown' | 'unsupported' | 'unavailable' | 'unknown'
export type ResetClassified = { outcome: ResetOutcomeCode; remaining?: number | null; recoverAt?: number | null; retryInMs?: number | null }

/** 200 bodies of POST /api/accounts/:i/reset-{codex,claude}-quota */
export function classifyResetSuccess(
  body: Record<string, unknown> | null | undefined,
  ctx: { creditsBefore: number; coolUntil: number | null },
): ResetClassified {
  const b = body ?? {}
  if (b.ok !== true) return { outcome: 'unknown' }
  if (b.result === 'already_used') return { outcome: 'redeemed' }
  const rc = (b.resetCredits ?? null) as { availableCount?: unknown } | null
  // only what the server reported: an unparsed or absent count is not guessed (the no-cache refresh shows it)
  const remaining = rc ? num(rc.availableCount) : null
  if (b.cooldownCleared === false) return { outcome: 'partial', remaining, recoverAt: ctx.coolUntil }
  return { outcome: 'ok', remaining }
}

/**
 * Error responses. The routes answer 404 (credential gone), 400 (type has no reset), 409 (Claude: no grant /
 * upstream declined with a code), 502 (upstream HTTP status in `error`, its body in `detail`). No status at all
 * (network drop, timeout) is `unknown`: the reset may or may not have happened, so it is never retried.
 */
export function classifyResetError(status: number | null, body: Record<string, unknown> | null | undefined, now = Date.now()): ResetClassified {
  if (status === null || status === 0) return { outcome: 'unknown' }
  const b = body ?? {}
  const text = `${str(b.error)} ${str(b.detail)} ${str(b.code)}`.toLowerCase()
  if (status === 400) return { outcome: 'unsupported' }
  if (status === 404) return { outcome: 'unavailable' }
  // a 5xx is a proven refusal only when it carries the upstream status (`上游返回 HTTP n`, sent before anything
  // was consumed). Any other 5xx is the route's catch-all, which also fires after the credit was used (e.g. the
  // follow-up credit read failing with `CPA 429: …`) or a proxy timeout: it may have reset, so its words are not
  // read as cooldown / no credit
  const proven = /^上游返回 HTTP \d+/.test(str(b.error))
  if (status >= 500 && !proven) return { outcome: 'unknown' }
  if (/not_limited|nothing_to_reset|no window|没有可重置/.test(text)) return { outcome: 'no_window' }
  if (/already_(used|redeemed)|redeemed/.test(text)) return { outcome: 'redeemed' }
  if (/cooldown|\b429\b|too many/.test(text)) {
    const until = ms(b.detail)
    return { outcome: 'cooldown', retryInMs: until && until > now ? until - now : null }
  }
  if (/no_credit|no_grant|ineligible|没有可用的主动重置|no reset/.test(text)) return { outcome: 'no_credit' }
  if (status === 409) return { outcome: 'unavailable' }
  if (status >= 500) return { outcome: 'unavailable' }
  return { outcome: 'unknown' }
}

/** zhang.wei@company.example → zhang.wei@…  (the confirm sheet shows the domain truncated) */
export function shortEmail(email: string): string {
  const at = email.lastIndexOf('@')
  return at > 0 ? `${email.slice(0, at)}@…` : email
}

/**
 * /accounts in the magpie backend (ACCOUNTS-ALIGN §3): a pure mapping from GET /api/accounts and
 * GET /api/accounts/catalog to what the page draws. No Vue, no DOM: `server/accountsMagpieModel.test.ts` runs it
 * under node. The CPA backend keeps `model.ts` and its own page.
 */
import type {
  AccountsCatalog,
  AccountsData,
  MagpieAccount,
  MagpieAccountProvider,
  MagpieCatalogItem,
  QuotaWindow,
} from '../../types.js'

/** The kit's StatusKind subset this page uses (declared here so node tests never load the kit). */
export type RowStatusKind = 'run' | 'pause' | 'off' | 'warn' | 'bad'

export type RowStatus = { kind: RowStatusKind; word: string; attention: boolean }

/** a window at or above this share shows when it resets */
export const RESET_HINT_AT = 80
/** the kernel reports no allowance for these agents at the pinned revision */
export const NO_USAGE_AGENTS: ReadonlySet<string> = new Set(['devin'])
/** forgetting the account these agents are signed in to is refused by Magpie ("switch to another account first") */
const ACTIVE_FORGET_LOCKED: ReadonlySet<string> = new Set(['claude', 'codex'])

export function isMagpieCatalogItem(item: unknown): item is MagpieCatalogItem {
  return Boolean(item && typeof item === 'object' && 'shortName' in item && 'completion' in item)
}

/* ── one account row ─────────────────────────────────────────────────────────────────────────── */

export function exhausted(account: MagpieAccount): boolean {
  return (account.quota?.windows ?? []).slice(0, 2).some((w) => w.usedPercent >= 100)
}

/** Magpie's words: 使用中 / 首选 for the active account, 已启用 for the others ticked, 已停用, 需重新登录, 已用尽. */
export function rowStatus(account: MagpieAccount): RowStatus {
  if (account.needsRelogin || account.quota?.errorCode === 'signed_out') return { kind: 'bad', word: '需重新登录', attention: true }
  if ((account.active || account.on) && exhausted(account)) return { kind: 'warn', word: '已用尽', attention: false }
  if (account.active) return { kind: 'run', word: account.first ? '首选' : '使用中', attention: false }
  if (account.on) return { kind: 'pause', word: '已启用', attention: false }
  return { kind: 'off', word: '已停用', attention: false }
}

const WORDS: Record<string, string> = {
  weekly: '周', monthly: '月', daily: '日', credits: '额度', 'add-on credits': '加购额度', 'shared credits': '共享额度',
  total: '总计', allowance: '配额', 'on-demand': '按需', 'premium requests': '高级请求', 'chat requests': '对话',
  completions: '补全', 'free trial': '试用', 'extra usage': '额外用量',
}

/** `5 hours` → 5h, `7 days · Opus` → 7d Opus, `Weekly` → 周; anything else is kept (the full name is the title). */
export function shortWindowLabel(name: string): string {
  const raw = String(name ?? '').trim()
  const span = /^(\d+)\s*(hours?|days?)(?:\s*·\s*(.+))?$/i.exec(raw)
  if (span) {
    const unit = span[2].toLowerCase().startsWith('h') ? 'h' : 'd'
    return span[3] ? `${span[1]}${unit} ${span[3]}` : `${span[1]}${unit}`
  }
  return WORDS[raw.toLowerCase()] ?? raw
}

/** `3h 后重置` (minutes under an hour, days past two). */
export function resetIn(resetsAt: string | null | undefined, now: number): string | null {
  const at = resetsAt ? Date.parse(resetsAt) : NaN
  if (!Number.isFinite(at)) return null
  const ms = at - now
  if (ms <= 60_000) return '即将重置'
  if (ms < 3_600_000) return `${Math.ceil(ms / 60_000)}m 后重置`
  if (ms < 48 * 3_600_000) return `${Math.round(ms / 3_600_000)}h 后重置`
  return `${Math.round(ms / 86_400_000)}d 后重置`
}

export type QuotaBar = {
  id: string
  /** Magpie's window name */
  label: string
  short: string
  /** 0–1 used */
  used: number
  pct: number
  hot: boolean
  /** shown once the window is ≥ 80 % used */
  reset: string | null
}

export function quotaBar(window: QuotaWindow, now: number): QuotaBar {
  const pct = Math.max(0, Math.min(100, Math.round(window.usedPercent)))
  return {
    id: window.id,
    label: window.label,
    short: shortWindowLabel(window.label),
    used: pct / 100,
    pct,
    hot: pct >= RESET_HINT_AT,
    reset: pct >= RESET_HINT_AT ? resetIn(window.resetsAt, now) : null,
  }
}

export type QuotaLine =
  | { kind: 'relogin'; text: string }
  | { kind: 'bars'; bars: QuotaBar[]; more: QuotaBar[]; stale: boolean; asOf: string | null; resets: number; resetPending: boolean }
  | { kind: 'error'; text: string; signedOut: boolean }
  | { kind: 'text'; text: string }

/** What the quota column shows: at most two windows inline (Magpie's first two), the rest in the title. */
export function quotaLine(account: MagpieAccount, now: number): QuotaLine {
  if (account.needsRelogin) return { kind: 'relogin', text: '登录已失效' }
  const quota = account.quota
  if (quota?.errorCode === 'signed_out') return { kind: 'relogin', text: quota.error ?? '登录已失效' }
  if (quota?.windows.length) {
    const bars = quota.windows.map((w) => quotaBar(w, now))
    return {
      kind: 'bars', bars: bars.slice(0, 2), more: bars.slice(2), stale: quota.stale || Boolean(quota.error), asOf: quota.asOf,
      resets: quota.resets?.count ?? 0, resetPending: quota.resetPending,
    }
  }
  if (quota?.error) return { kind: 'error', text: quota.error, signedOut: false }
  if (quota?.balance) return { kind: 'text', text: `余额 ${quota.balance}` }
  if (NO_USAGE_AGENTS.has(account.agent)) return { kind: 'text', text: '不报告用量' }
  if (!quota) return { kind: 'text', text: '用量读取中' }
  return { kind: 'text', text: '暂无用量数据' }
}

export type RowAction = 'first' | 'on' | 'off' | 'reset' | 'relogin' | 'egress' | 'forget'

export type MenuItem = {
  action: RowAction
  label: string
  /** why it cannot run now; null = enabled */
  disabled: string | null
  danger: boolean
}

/**
 * The ⋯ menu: Magpie's actions, plus 出口… when the proxy pool is there (`egress`: whether this kernel lets an
 * account hold an exit of its own, and why not). Items that cannot run stay listed, disabled, with the reason.
 */
export function rowMenu(account: MagpieAccount, egress?: { supported: boolean; reason: string | null } | null): MenuItem[] {
  const lapsed = account.needsRelogin || account.quota?.errorCode === 'signed_out'
  const items: MenuItem[] = []
  items.push({
    action: 'first', label: '设为首选', danger: false,
    disabled: account.active ? (account.first ? '已经是首选' : '正在使用') : lapsed ? '先重新登录' : null,
  })
  if (!account.on) items.push({ action: 'on', label: '同时启用', danger: false, disabled: lapsed ? '先重新登录' : null })
  else items.push({ action: 'off', label: '停用', danger: false, disabled: account.active ? '首选账号不能停用' : null })
  if (account.agent === 'codex') {
    const count = account.quota?.resets?.count ?? 0
    items.push({
      action: 'reset', label: count > 0 ? `使用重置 · 剩 ${count} 次` : '使用重置', danger: false,
      disabled: account.canReset ? null
        : lapsed ? '先重新登录'
          : account.quota?.resetPending ? '刚用过，等下次读取用量'
            : !account.quota ? '用量还没读到'
              : '没有可用的重置',
    })
  }
  if (lapsed) items.push({ action: 'relogin', label: '重新登录', danger: false, disabled: null })
  if (egress) items.push({ action: 'egress', label: '出口…', danger: false, disabled: egress.supported ? null : egress.reason ?? '当前内核不支持' })
  items.push({
    action: 'forget', label: '移除…', danger: true,
    disabled: account.active && ACTIVE_FORGET_LOCKED.has(account.agent) ? '先把其它账号设为首选' : null,
  })
  return items
}

/* ── the page ────────────────────────────────────────────────────────────────────────────────── */

export type HeadSummary = { text: string; attention: string | null }

export function headSummary(data: AccountsData | null | undefined): HeadSummary {
  const counts = data?.counts
  if (!data || data.backend !== 'magpie' || !counts) return { text: '来自 Magpie', attention: null }
  return {
    text: `${counts.accounts} 个 · 来自 Magpie`,
    attention: counts.attention > 0 ? `${counts.attention} 个需重新登录` : null,
  }
}

/** Providers that have accounts, in the kernel's order; inside a group the active account first (Magpie). */
export function groupsOf(data: AccountsData | null | undefined): MagpieAccountProvider[] {
  if (!data || data.backend !== 'magpie') return []
  return data.providers
    .filter((p) => p.accounts.length > 0)
    .map((p) => ({ ...p, accounts: [...p.accounts].sort((a, b) => Number(b.active) - Number(a.active)) }))
}

/** The muted line under a group name: plans seen, account count. */
export function groupFacts(provider: MagpieAccountProvider): string {
  const plans = [...new Set(provider.accounts.map((a) => a.plan).filter((p): p is string => Boolean(p)))]
  const parts = [`${provider.counts.total} 个`]
  if (provider.counts.total > 1) parts.push(`${provider.counts.on} 个启用`)
  if (plans.length) parts.unshift(plans.slice(0, 3).join(' · '))
  return parts.join(' · ')
}

/** The account a finished sign-in landed on (agent + user, case-insensitive), to flash its row. */
export function findSignedIn(data: AccountsData | null | undefined, agent: string, user: string | null): MagpieAccount | null {
  if (!user) return null
  const wanted = user.trim().toLowerCase()
  const provider = data?.providers.find((p) => p.agent === agent)
  return provider?.accounts.find((a) => a.user.trim().toLowerCase() === wanted) ?? null
}

/* ── the catalog sheet ───────────────────────────────────────────────────────────────────────── */

export type CatalogTile = {
  item: MagpieCatalogItem
  /** why the tile cannot start a sign-in (shown as its second line); null = it can */
  disabled: string | null
  /** second line: plans, or the reason */
  note: string
  risk: boolean
  /** accounts already signed in */
  signedIn: number
  signingIn: boolean
  /** the browser must be on the server itself */
  hostOnly: boolean
}

export function catalogItems(catalog: AccountsCatalog | null | undefined): MagpieCatalogItem[] {
  if (!catalog || catalog.backend !== 'magpie' || !catalog.available) return []
  return catalog.items.filter(isMagpieCatalogItem)
}

export function catalogTiles(catalog: AccountsCatalog | null | undefined, signingIn: ReadonlyArray<{ agent: string }> = []): CatalogTile[] {
  const live = new Set(signingIn.map((s) => s.agent))
  return catalogItems(catalog).map((item) => ({
    item,
    disabled: item.gated ? '需在服务器上开启' : null,
    note: item.gated ? '需在服务器上开启' : item.completion === 'local' ? `仅限本机 · ${item.plans}` : item.plans,
    risk: Boolean(item.risk),
    signedIn: item.signedIn,
    signingIn: live.has(item.agent),
    hostOnly: item.completion === 'local',
  }))
}

export function findCatalogItem(catalog: AccountsCatalog | null | undefined, agent: string | null | undefined): MagpieCatalogItem | null {
  if (!agent) return null
  return catalogItems(catalog).find((item) => item.agent === agent) ?? null
}

/** `{name}` / `{user}` / `{cli}` placeholders in Magpie's zh copy. */
export function fillCopy(template: string, values: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) => values[key] ?? match)
}

/** The login link as one short line: host + path, the query (state, challenge…) hidden but still copied. */
export function shortUrl(url: string): string {
  try {
    const u = new URL(url)
    const path = u.pathname.length > 28 ? `${u.pathname.slice(0, 27)}…` : u.pathname
    return `${u.host}${path === '/' ? '' : path}${u.search ? '?…' : ''}`
  } catch {
    return url.length > 48 ? `${url.slice(0, 47)}…` : url
  }
}

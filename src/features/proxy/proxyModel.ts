import type {
  ProxyAccountRow,
  ProxyEntryView,
  ProxyHealth,
  ProxyHealthCell,
  ProxyImportResult,
  ProxyKernelView,
  ProxyMigrationExit,
  ProxyPoolData,
  ProxyPreview,
  ProxyPreviewRow,
  ProxySubscriptionView,
} from '../../types.js'

/**
 * 代理 (settings #proxy, PROXY-SPEC §12): pure view model. Every value that reaches here is already masked by the
 * server; this file only words it. No fetches, no DOM.
 */

export const PROXY_SERVICES = [
  { key: 'claude', label: 'Claude' },
  { key: 'openai', label: 'OpenAI' },
  { key: 'google', label: 'Google' },
] as const
export type ProxyServiceKey = (typeof PROXY_SERVICES)[number]['key']

/** check state → word (server: proxyCheck.ts PROBE_STATE_LABEL) */
export const CHECK_WORD: Record<string, string> = {
  ok: '正常',
  'auth-expected': '正常',
  'region-blocked': '地区限制',
  challenge: '人机验证',
  blocked: '被拦截',
  'service-error': '服务异常',
  'proxy-auth-failed': '代理认证失败',
  'proxy-down': '代理不可达',
  upstream: '节点不通',
  dns: '解析失败',
  tls: 'TLS 异常',
  timeout: '超时',
}

export const isReachable = (state: string | null | undefined) => state === 'ok' || state === 'auth-expected'

export const PROTOCOL_LABEL: Record<string, string> = {
  http: 'HTTP',
  https: 'HTTPS',
  socks5: 'SOCKS5',
  ss: 'SS',
  ssr: 'SSR',
  vmess: 'VMess',
  vless: 'VLESS',
  trojan: 'Trojan',
  hysteria2: 'Hysteria2',
  tuic: 'TUIC',
  wireguard: 'WireGuard',
}
export const protocolLabel = (protocol: string | null | undefined) => (protocol ? PROTOCOL_LABEL[protocol] ?? protocol : '—')

export const PROVIDER_LABEL: Record<string, string> = {
  claude: 'Claude',
  anthropic: 'Claude',
  codex: 'Codex',
  openai: 'OpenAI',
  gemini: 'Gemini',
  'gemini-cli': 'Gemini CLI',
  antigravity: 'Antigravity',
  vertex: 'Vertex',
  kimi: 'Kimi',
  qwen: 'Qwen',
  iflow: 'iFlow',
  global: 'CPA 全局',
  other: '其它',
}
export const providerLabel = (provider: string | null | undefined) => (provider ? PROVIDER_LABEL[provider.toLowerCase()] ?? provider : '其它')

/* ── health cells ─────────────────────────────────────────────────── */

export type HealthCellView = {
  /** true ✓ · false ✗ · null never checked */
  ok: boolean | null
  /** `230ms` for ✓, the reason for ✗, '' when unchecked */
  text: string
  /** one line per host for the native title (a tooltip per cell is too heavy for a table) */
  title: string
}

const hostLine = (host: ProxyHealthCell['hosts'][number]) =>
  `${host.host} · ${CHECK_WORD[host.state] ?? host.state}${host.status ? ` ${host.status}` : ''}${host.ms !== null && host.ms !== undefined ? ` · ${host.ms}ms` : ''}`

export function healthCell(cell: ProxyHealthCell | null | undefined): HealthCellView {
  if (!cell || !cell.state) return { ok: null, text: '', title: '还没有检测' }
  const title = cell.hosts.length ? cell.hosts.map(hostLine).join('\n') : CHECK_WORD[cell.state] ?? cell.state
  if (isReachable(cell.state)) return { ok: true, text: cell.ms !== null && cell.ms !== undefined ? `${cell.ms}ms` : '', title }
  return { ok: false, text: CHECK_WORD[cell.state] ?? cell.state, title }
}

export type ExitView = { ip: string | null; country: string | null; failure: string | null }

export function exitView(health: ProxyHealth | null | undefined): ExitView {
  const exit = health?.exit
  if (!exit) return { ip: null, country: null, failure: null }
  const failure = exit.state && !isReachable(exit.state) ? CHECK_WORD[exit.state] ?? exit.state : null
  return { ip: exit.ip ?? null, country: exit.country ?? null, failure }
}

/** 203.0.113.7 → 203.0.•••; v6 keeps the first two groups. Display-only (privacy mask). */
export function maskIp(ip: string): string {
  if (ip.includes(':')) return `${ip.split(':').slice(0, 2).join(':')}:•••`
  const parts = ip.split('.')
  return parts.length === 4 ? `${parts[0]}.${parts[1]}.•••` : '•••'
}

/** Last check of an entry: the newest of exit / service times, or null. */
export function lastCheckedAt(health: ProxyHealth | null | undefined): string | null {
  if (!health) return null
  if (health.lastAt) return health.lastAt
  const times = [health.exit?.at, ...Object.values(health.services ?? {}).map(cell => cell.at)].filter((at): at is string => Boolean(at))
  return times.sort().at(-1) ?? null
}

/* ── rows and groups ──────────────────────────────────────────────── */

export type ProxyRowAction = 'test' | 'assign' | 'default' | 'edit' | 'toggle' | 'remove'

export type EntryFlag = { label: string; tone: 'plain' | 'outline' }

/** Quiet tags after the name: what makes this exit different from a plain working one. */
export function entryFlags(entry: ProxyEntryView): EntryFlag[] {
  const flags: EntryFlag[] = []
  if (!entry.enabled) flags.push({ label: '已停用', tone: 'plain' })
  if (entry.validity === 'invalid') flags.push({ label: '配置无效', tone: 'outline' })
  if (entry.external) flags.push({ label: '外部本机', tone: 'outline' })
  if (entry.stale) flags.push({ label: '订阅中已移除', tone: 'outline' })
  return flags
}

export type ProxyRow = ProxyEntryView & {
  exit: ExitView
  cells: Record<ProxyServiceKey, HealthCellView>
  checkedAt: string | null
  flags: EntryFlag[]
  /** 本机端口 :27891 for mihomo entries */
  portLabel: string | null
  /** usedBy, worded for the title: Claude 3 · Codex 2 */
  usedTitle: string
  /** `#k7q2` when another exit has the same name (e.g. two sessions of one residential gateway) */
  twin: string | null
  /** tags shown after the name (all tags still filter) */
  shownTags: string[]
}

export function toRow(entry: ProxyEntryView): ProxyRow {
  const services = entry.health?.services ?? {}
  return {
    ...entry,
    exit: exitView(entry.health),
    cells: {
      claude: healthCell(services.claude),
      openai: healthCell(services.openai),
      google: healthCell(services.google),
    },
    checkedAt: lastCheckedAt(entry.health),
    flags: entryFlags(entry),
    portLabel: entry.kind === 'mihomo' && entry.port ? `:${entry.port}` : null,
    usedTitle: Object.entries(entry.usedBy.byProvider).map(([provider, n]) => `${providerLabel(provider)} ${n}`).join(' · '),
    twin: null,
    shownTags: [...entry.tags],
  }
}

/**
 * Rows for the table. Exits that share a name get a short id suffix so they can be told apart; a subscription node
 * does not repeat its subscription's name as a tag (the group head already says it).
 */
export function toRows(entries: ProxyEntryView[], subscriptions: ProxySubscriptionView[] = []): ProxyRow[] {
  const seen = new Map<string, number>()
  for (const entry of entries) seen.set(entry.name, (seen.get(entry.name) ?? 0) + 1)
  const subName = new Map(subscriptions.map(item => [item.id, item.name]))
  return entries.map((entry) => {
    const row = toRow(entry)
    if ((seen.get(entry.name) ?? 0) > 1) row.twin = `#${entry.id.slice(-4)}`
    const own = entry.subscriptionId ? subName.get(entry.subscriptionId) : undefined
    if (own) row.shownTags = row.tags.filter(tag => tag !== own)
    return row
  })
}

export type RowGroup = { key: string; head: string; rows: ProxyRow[] }

const SOURCE_GROUP: Record<string, { key: string; head: string; order: number }> = {
  manual: { key: 'manual', head: '手动添加', order: 0 },
  clash: { key: 'manual', head: '手动添加', order: 0 },
  uri: { key: 'manual', head: '手动添加', order: 0 },
  'pool-import': { key: 'manual', head: '手动添加', order: 0 },
  migrated: { key: 'migrated', head: '从账号迁移', order: 1 },
  preset: { key: 'migrated', head: '从账号迁移', order: 1 },
}

/** 手动 / 迁移 / 订阅 <name>, in that order; rows keep the order they come in. */
export function groupRows(rows: ProxyRow[], subscriptions: ProxySubscriptionView[]): RowGroup[] {
  const names = new Map(subscriptions.map(item => [item.id, item.name]))
  const groups = new Map<string, RowGroup & { order: number }>()
  for (const row of rows) {
    const sub = row.source === 'subscription' && row.subscriptionId
      ? { key: `sub:${row.subscriptionId}`, head: `订阅 · ${names.get(row.subscriptionId) ?? '已删除'}`, order: 2 }
      : SOURCE_GROUP[row.source] ?? SOURCE_GROUP.manual
    const group = groups.get(sub.key) ?? { key: sub.key, head: sub.head, order: sub.order, rows: [] }
    group.rows.push(row)
    groups.set(sub.key, group)
  }
  return [...groups.values()].sort((a, b) => a.order - b.order || a.head.localeCompare(b.head, 'zh-CN')).map(({ order: _order, ...group }) => group)
}

export function matchesQuery(row: ProxyRow, query: string): boolean {
  const q = query.trim().toLowerCase()
  if (!q) return true
  return [row.name, row.server, row.protocol, row.display, row.exit.country ?? '', row.exit.ip ?? '', ...row.tags].some(value => value.toLowerCase().includes(q))
}

export function tagOptions(entries: ProxyEntryView[]): Array<{ value: string; label: string; count: number }> {
  const counts = new Map<string, number>()
  for (const entry of entries) for (const tag of entry.tags) counts.set(tag, (counts.get(tag) ?? 0) + 1)
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'zh-CN')).map(([tag, count]) => ({ value: tag, label: tag, count }))
}

/* ── head: summary, kernel, banners ───────────────────────────────── */

export function summaryLine(data: ProxyPoolData): string {
  const parts = [`${data.summary.entries} 个出口`]
  if (data.summary.accountsLinked) parts.push(`${data.summary.accountsLinked} 个账号在用`)
  if (data.summary.subscriptions) parts.push(`${data.summary.subscriptions} 个订阅`)
  return parts.join(' · ')
}

export const portRange = (ports: ProxyPoolData['ports']) => `${ports.base}–${ports.last}`

/** a subset of ui/types StatusKind (that module is not importable from the node-side model tests) */
export type KernelLine = { state: 'run' | 'busy' | 'pause' | 'idle' | 'bad' | 'warn' | 'stale'; label: string; detail: string; action: 'start' | 'restart' | null }

export function kernelLine(kernel: ProxyKernelView, data?: Pick<ProxyPoolData, 'summary'>): KernelLine {
  const version = typeof kernel.version === 'string' && kernel.version ? ` v${kernel.version.replace(/^v/, '')}` : ''
  const reason = typeof kernel.reason === 'string' ? kernel.reason : ''
  switch (kernel.state) {
    case 'unavailable':
      return { state: 'idle', label: '未安装', detail: '加密节点可保存但不可用 · 设置 MIHOMO_BIN 后重启控制台', action: null }
    case 'idle':
      return { state: 'idle', label: '未启动', detail: data && data.summary.mihomo === 0 ? '没有加密节点，不需要运行' : '有加密节点时自动启动', action: null }
    case 'starting':
      return { state: 'busy', label: '启动中', detail: version.trim(), action: null }
    case 'running':
      return { state: 'run', label: `运行中${version}`, detail: '', action: null }
    case 'degraded':
      return { state: 'warn', label: `部分异常${version}`, detail: reason || '有节点的本机端口没能监听', action: 'restart' }
    case 'failed':
      return { state: 'bad', label: '出错', detail: reason || '内核反复退出，已停止重启', action: 'restart' }
    case 'stopped':
      return { state: 'pause', label: '已停止', detail: '本机端口类出口暂不可用', action: 'start' }
    default:
      return { state: 'stale', label: String(kernel.state || '未知'), detail: reason, action: null }
  }
}

/** The kernel is worth a word in the settings index (hot) when it is in trouble. */
export const kernelHot = (kernel: ProxyKernelView) => kernel.state === 'degraded' || kernel.state === 'failed'

export function migrationBanner(migration: ProxyPoolData['migration']): string | null {
  const pending = migration.pending
  if (!pending || pending.exits <= 0) return null
  return `发现 ${pending.accounts} 个账号的代理还没进代理池（${pending.exits} 个出口）`
}

const DAY = 86_400_000

/** One-time note after the first-run import: shown for 3 days. */
export function firstRunNote(migration: ProxyPoolData['migration'], now = Date.now()): string | null {
  const n = migration.firstRunImported ?? 0
  const at = migration.firstRunAt ? Date.parse(migration.firstRunAt) : NaN
  if (n <= 0 || !Number.isFinite(at) || now - at > 3 * DAY) return null
  return `已从现有账号导入 ${n} 个出口 · 账号设置没有改动`
}

export function defaultLine(data: ProxyPoolData): string | null {
  const d = data.default
  if (d.mode === 'unsupported' || d.mode === 'unknown') return null
  if (d.mode === 'inherit' || d.mode === 'direct') return d.mode === 'direct' ? '直连' : '未设置'
  if (d.entryId) {
    const entry = data.entries.find(item => item.id === d.entryId)
    if (entry) return entry.name
  }
  return d.masked ?? '未设置'
}

/** Settings index (TOC) value: entry count, `◇ N 待导入` while the banner shows, `◆ 内核` when the kernel is in trouble. */
export function indexValue(data: ProxyPoolData): { value: string; hot: boolean } {
  if (kernelHot(data.kernel)) return { value: '◆ 内核', hot: true }
  if (data.migration.pending?.exits) return { value: `◇ ${data.migration.pending.exits}`, hot: true }
  return { value: `${data.summary.entries} 出口`, hot: false }
}

/* ── add: preview ─────────────────────────────────────────────────── */

const COUNT_WORD: Array<[ProxyPreviewRow['status'], string]> = [
  ['new', '新'],
  ['update', '更新'],
  ['duplicate', '已存在'],
  ['unsupported', '不支持'],
  ['invalid', '无效'],
  ['info', '提示行'],
]

export function previewCountLine(preview: ProxyPreview): string {
  return COUNT_WORD.filter(([status]) => preview.counts[status] > 0).map(([status, word]) => `${word} ${preview.counts[status]}`).join(' · ')
}

/** Rows the primary button imports: new + update, standalone or from an included subscription. */
export function importRows(preview: ProxyPreview, excluded: ReadonlySet<string>): ProxyPreviewRow[] {
  const failed = new Set(preview.subscriptions.filter(item => !item.ok).map(item => item.key))
  return preview.rows.filter(row => (row.status === 'new' || row.status === 'update')
    && (!row.subscriptionKey || (!excluded.has(row.subscriptionKey) && !failed.has(row.subscriptionKey))))
}

export function protocolTags(preview: ProxyPreview): Array<{ label: string; n: number }> {
  return Object.entries(preview.byProtocol).sort((a, b) => b[1] - a[1]).map(([protocol, n]) => ({ label: protocolLabel(protocol), n }))
}

export const FORMAT_WORD: Record<ProxyPreview['format'], string> = {
  export: '代理池导出文件',
  clash: 'Clash 配置',
  uri: '分享链接',
  base64: 'Base64 订阅内容',
  subscription: '订阅链接',
}

/** `host:port` of a preview row, or the type alone. */
export const rowEndpoint = (row: ProxyPreviewRow) => (row.server ? `${row.server.includes(':') ? `[${row.server}]` : row.server}${row.serverPort ? `:${row.serverPort}` : ''}` : '')

export const INTERVAL_OPTIONS = [6, 12, 24].map(h => ({ value: String(h), label: `每 ${h} 小时` }))

export function quotaLine(info: ProxySubscriptionView['info']): string | null {
  if (!info) return null
  const gb = (n?: number) => (typeof n === 'number' ? `${(n / 1024 ** 3).toFixed(n >= 100 * 1024 ** 3 ? 0 : 1)} GB` : null)
  const used = (info.upload ?? 0) + (info.download ?? 0)
  const parts: string[] = []
  if (info.total) parts.push(`已用 ${gb(used)} / ${gb(info.total)}`)
  if (info.expire) parts.push(`${new Date(info.expire * 1000).toISOString().slice(0, 10)} 到期`)
  return parts.length ? parts.join(' · ') : null
}

/* ── migration preview ────────────────────────────────────────────── */

export const MIGRATE_ACTION: Record<ProxyMigrationExit['action'], string> = {
  create: '新建',
  link: '关联',
  unchanged: '已在池中',
  skip: '跳过',
}

export function byProviderLine(byProvider: Record<string, number>): string {
  return Object.entries(byProvider).sort((a, b) => b[1] - a[1]).map(([provider, n]) => `${providerLabel(provider)} ${n}`).join(' · ')
}

/* ── assign ───────────────────────────────────────────────────────── */

export type AccountGroup = { provider: string; label: string; rows: ProxyAccountRow[] }

/** Accounts by provider (credential rows only; CPA 全局 is the 默认出口 action, Magpie rows are read-only here). */
export function accountGroups(rows: ProxyAccountRow[], filter: { entryId?: string | null; query?: string } = {}): AccountGroup[] {
  const q = (filter.query ?? '').trim().toLowerCase()
  const groups = new Map<string, AccountGroup>()
  for (const row of rows) {
    if (row.kind === 'global') continue
    if (filter.entryId && row.entryId !== filter.entryId) continue
    if (q && ![row.name, row.label, row.provider].some(value => value.toLowerCase().includes(q))) continue
    const provider = row.provider || 'other'
    const group = groups.get(provider) ?? { provider, label: providerLabel(provider), rows: [] }
    group.rows.push(row)
    groups.set(provider, group)
  }
  return [...groups.values()].sort((a, b) => b.rows.length - a.rows.length || a.label.localeCompare(b.label))
}

/** What an account currently uses, in words. */
export function accountExit(row: ProxyAccountRow): string {
  if (row.entryName) return row.entryName
  switch (row.mode) {
    case 'inherit': return '继承全局'
    case 'direct': return '直连'
    case 'url': return row.masked ?? '自定义地址'
    case 'invalid': return '地址无效'
    default: return '未读取'
  }
}

/** confirm facts for an assign: N accounts, from → to */
export function assignFacts(rows: ProxyAccountRow[], targetName: string): Array<{ k: string; v: string }> {
  const from = new Map<string, number>()
  for (const row of rows) from.set(accountExit(row), (from.get(accountExit(row)) ?? 0) + 1)
  const fromText = [...from.entries()].map(([name, n]) => (from.size > 1 ? `${name} ${n}` : name)).join(' · ')
  return [
    { k: '账号', v: `${rows.length} 个` },
    { k: '原出口', v: fromText || '—' },
    { k: '新出口', v: targetName },
  ]
}

/**
 * An export file's account assignments after its import: the pending ones this console can write, grouped by exit
 * (one assign call each); accounts it does not have, or only reads, are counted and left alone.
 */
export function restorePlan(plan: ProxyImportResult['assignPlan'], accounts: ProxyAccountRow[]) {
  const known = new Map(accounts.map(row => [row.ref, row]))
  const pending = plan.filter(item => item.status === 'pending')
  const byEntry = new Map<string, string[]>()
  let missing = 0
  for (const item of pending) {
    if (!known.get(item.accountRef)?.assignable) { missing++; continue }
    byEntry.set(item.entryId, [...(byEntry.get(item.entryId) ?? []), item.accountRef])
  }
  const groups = [...byEntry.entries()].map(([entryId, refs]) => ({ entryId, refs }))
  return { groups, accounts: groups.reduce((n, group) => n + group.refs.length, 0), missing, linked: plan.length - pending.length }
}

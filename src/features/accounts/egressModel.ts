import type { EgressAccount, EgressData, EgressEntry, EgressRead, EgressService, ProxyPreset } from '../../types.js'
import { CHECK_WORD, isReachable } from '../proxy/proxyModel.js'

/**
 * Account egress on /accounts (PROXY-SPEC §7, §12): which exit each account goes out through, where that exit
 * lands (country) and whether it reaches the account's own vendor — a Claude account shows its exit's Claude
 * check. Pure: every value arrives masked from /api/proxies/egress; this file only words it and maps picks to
 * writes. Picks are pool entry ids, so editing an entry later re-applies to every account linked to it.
 */

/* ── accounts ↔ refs ↔ services ───────────────────────────────────── */

export const cpaRef = (credential: string) => `cpa:${credential}`
export const magpieRef = (agent: string, user: string) => `magpie:${agent}:${user.trim().toLowerCase()}`

const SERVICE_OF: Record<string, EgressService> = {
  claude: 'claude', anthropic: 'claude',
  codex: 'openai', openai: 'openai', chatgpt: 'openai',
  antigravity: 'google', gemini: 'google', 'gemini-cli': 'google', google: 'google', vertex: 'google', aistudio: 'google',
}
/** the probe service of an account's provider / agent (mirrors server/proxyEgress.ts) */
export const serviceOf = (provider: string | null | undefined): EgressService | null => SERVICE_OF[String(provider ?? '').toLowerCase()] ?? null
export const SERVICE_LABEL: Record<EgressService, string> = { claude: 'Claude', openai: 'OpenAI', google: 'Google' }

/* ── one exit's reachability for one service ──────────────────────── */

export type CheckMark = {
  /** true ✓ · false ✗ · null not checked / no service to check */
  ok: boolean | null
  /** `✓ 230ms` · `✗ 地区限制` · `未检测` · '' */
  text: string
  title: string
}

export function checkMark(entry: EgressEntry | null | undefined, service: EgressService | null): CheckMark {
  if (!entry) return { ok: null, text: '', title: '' }
  if (entry.exitState) {
    const word = CHECK_WORD[entry.exitState] ?? entry.exitState
    return { ok: false, text: `✗ ${word}`, title: `出口本身不通：${word}` }
  }
  if (!service) return { ok: null, text: '', title: '' }
  const check = entry.checks[service]
  const label = SERVICE_LABEL[service]
  if (!check) return { ok: null, text: '未检测', title: `这个出口还没检测过 ${label}` }
  if (isReachable(check.state)) return { ok: true, text: check.ms !== null ? `✓ ${check.ms}ms` : '✓', title: `经这个出口可以访问 ${label}` }
  const word = CHECK_WORD[check.state] ?? check.state
  return { ok: false, text: `✗ ${word}`, title: `经这个出口访问 ${label}：${word}` }
}

/* ── what an account goes out through, in words ───────────────────── */

export type EgressBadge = {
  kind: 'entry' | 'inherit' | 'direct' | 'custom' | 'invalid'
  /** `东京-01` · `全局 · 东京-01` · `直连` · `自定义地址` */
  label: string
  country: string | null
  mark: CheckMark
  title: string
}

const entryById = (data: EgressData, id: string | null | undefined) => (id ? data.entries.find(entry => entry.id === id) ?? null : null)

/** What 继承 means here: CPA's global proxy, or (Magpie) the service's own proxy, else the kernel's: direct. */
function inherited(data: EgressData, ref: string): EgressAccount {
  if (data.backend === 'magpie') {
    const agent = ref.split(':')[1] ?? ''
    return data.services[agent] ?? { mode: 'direct', entryId: null, masked: null, at: null }
  }
  return { mode: data.default.mode, entryId: data.default.entryId, masked: null, at: null }
}

/**
 * The account's exit badge, or null when nothing is known about it yet (CPA lists carry no proxy; the pool knows an
 * account once a scan, an assign or a detail read has seen it). `read` (a fresher per-account read) wins.
 */
export function egressBadge(data: EgressData | null | undefined, ref: string, service: EgressService | null, read?: EgressRead | EgressAccount | null): EgressBadge | null {
  if (!data) return null
  const own = read ?? data.accounts[ref] ?? (data.backend === 'magpie' ? { mode: 'inherit' as const, entryId: null, masked: null, at: null } : null)
  if (!own || own.mode === 'unknown') return null
  if (own.mode === 'invalid') return { kind: 'invalid', label: '地址无效', country: null, mark: { ok: false, text: '', title: '' }, title: '账号里的代理地址无法解析' }
  if (own.mode === 'direct') return { kind: 'direct', label: '直连', country: null, mark: { ok: null, text: '', title: '' }, title: '不经过代理' }
  if (own.mode === 'url') {
    const entry = entryById(data, own.entryId)
    if (!entry) return { kind: 'custom', label: '自定义地址', country: null, mark: { ok: null, text: '', title: '' }, title: own.masked ? `不在代理池：${own.masked}` : '不在代理池' }
    const mark = checkMark(entry, service)
    return { kind: 'entry', label: entry.name, country: entry.country, mark, title: [entry.name, entry.country, mark.title].filter(Boolean).join(' · ') }
  }
  const base = inherited(data, ref)
  const scope = data.backend === 'cpa' ? '全局' : '服务'
  if (base.mode === 'url') {
    const entry = entryById(data, base.entryId)
    if (!entry) return { kind: 'inherit', label: `${scope} · 自定义地址`, country: null, mark: { ok: null, text: '', title: '' }, title: `继承${scope}出口（不在代理池）` }
    const mark = checkMark(entry, service)
    return { kind: 'inherit', label: `${scope} · ${entry.name}`, country: entry.country, mark, title: `继承${scope}出口 ${entry.name}${mark.title ? ` · ${mark.title}` : ''}` }
  }
  if (base.mode === 'direct' || base.mode === 'inherit') return { kind: 'inherit', label: `${scope} · 直连`, country: null, mark: { ok: null, text: '', title: '' }, title: `继承${scope}设置：不经过代理` }
  return { kind: 'inherit', label: '继承全局', country: null, mark: { ok: null, text: '', title: '' }, title: '继承 CPA 的全局代理（还没读到它的值）' }
}

/* ── the picker ───────────────────────────────────────────────────── */

export const EGRESS_CUSTOM = '__custom'
export const EGRESS_UNKNOWN = '__unknown'
const PRESET = 'preset:'

/** `东京-01 · JP · ✓ 230ms` / `… · ✗ 地区限制` / `… · 内核未安装` */
export function entryOptionLabel(entry: EgressEntry, service: EgressService | null): string {
  const mark = checkMark(entry, service)
  const check = mark.text ? (service && mark.ok !== null && !entry.exitState ? `${SERVICE_LABEL[service]} ${mark.text}` : mark.text) : ''
  return [entry.name, entry.country, entry.assignable ? check : entry.reason].filter(Boolean).join(' · ')
}

export function inheritLabel(data: EgressData | null | undefined, ref: string): string {
  if (!data) return '继承全局'
  const base = inherited(data, ref)
  const scope = data.backend === 'cpa' ? '继承全局' : '不单独设置'
  if (base.mode === 'url') return `${scope} · ${entryById(data, base.entryId)?.name ?? '自定义地址'}`
  if (base.mode === 'direct' || base.mode === 'inherit') return `${scope} · 直连`
  return scope
}

/** a picker row (the kit's SegmentItem shape; declared here so node tests never load the kit's Vue types) */
export type PickItem = { value: string; label: string; disabled?: boolean }

export type PickerOptions = { presets?: ProxyPreset[]; custom?: boolean; current?: string }

/**
 * 继承 · 直连 · the pool's enabled exits (unassignable ones stay listed, disabled, with the reason) · CPA presets that
 * are not pool entries · 自定义…. Every exit says where it lands and whether it reaches this account's vendor.
 */
export function egressOptions(data: EgressData | null | undefined, ref: string, service: EgressService | null, options: PickerOptions = {}): PickItem[] {
  const items: PickItem[] = [{ value: '', label: inheritLabel(data, ref) }, { value: 'direct', label: '直连' }]
  for (const entry of data?.entries ?? []) items.push({ value: entry.id, label: entryOptionLabel(entry, service), disabled: !entry.assignable })
  ;(options.presets ?? []).forEach((preset, index) => {
    if (!data?.presets[index]?.entryId) items.push({ value: `${PRESET}${index}`, label: `${preset.label} · 预设` })
  })
  if (options.custom) items.push({ value: EGRESS_CUSTOM, label: '自定义地址…' })
  if (options.current === EGRESS_UNKNOWN) items.push({ value: EGRESS_UNKNOWN, label: '读取中···', disabled: true })
  return items
}

/** The picker value for what the account holds now. */
export function egressChoice(read: EgressRead | EgressAccount | null | undefined, data: EgressData | null | undefined): string {
  if (!read || read.mode === 'unknown') return EGRESS_UNKNOWN
  if (read.mode === 'inherit') return ''
  if (read.mode === 'direct') return 'direct'
  if (read.entryId && data?.entries.some(entry => entry.id === read.entryId)) return read.entryId
  const preset = 'preset' in read ? read.preset : null
  if (preset !== null && preset !== undefined && !data?.presets[preset]?.entryId) return `${PRESET}${preset}`
  return EGRESS_CUSTOM
}

export type EgressWrite = { via: 'assign'; target: string } | { via: 'url'; url: string }

/** How a pick is written: inherit / direct / a pool entry through the pool's assign (records prev, links by id); a preset address through the account's own route. */
export function egressWrite(choice: string, presets: ProxyPreset[] = []): EgressWrite | null {
  if (choice === '') return { via: 'assign', target: 'inherit' }
  if (choice === 'direct') return { via: 'assign', target: 'direct' }
  if (/^px_[a-z2-7]{10}$/.test(choice)) return { via: 'assign', target: choice }
  if (choice.startsWith(PRESET)) {
    const preset = presets[Number(choice.slice(PRESET.length))]
    return preset ? { via: 'url', url: preset.url } : null
  }
  return null
}

/** A pick worth a second look before it is written: the exit's last check failed for this account's vendor. */
export function egressWarning(data: EgressData | null | undefined, choice: string, service: EgressService | null): string | null {
  const entry = data ? entryById(data, choice) : null
  if (!entry) return null
  const mark = checkMark(entry, service)
  if (mark.ok !== false) return null
  return mark.title
}

/** Words for a pick in a toast / confirm. */
export function choiceName(data: EgressData | null | undefined, ref: string, choice: string, presets: ProxyPreset[] = []): string {
  if (choice === '') return inheritLabel(data, ref)
  if (choice === 'direct') return '直连'
  if (choice.startsWith(PRESET)) return presets[Number(choice.slice(PRESET.length))]?.label ?? '预设'
  return data?.entries.find(entry => entry.id === choice)?.name ?? '出口'
}

/** What a sign-in itself goes through (no backend can send one sign-in through a chosen exit). */
export function signinVia(data: EgressData | null | undefined): { label: string; note: string } {
  if (!data) return { label: '', note: '' }
  if (data.signin.via === 'direct') return { label: '本机直连', note: data.signin.note }
  const entry = entryById(data, data.signin.exit.entryId)
  const exit = entry ? entry.name : data.signin.exit.mode === 'inherit' || data.signin.exit.mode === 'direct' ? '直连' : null
  return { label: exit ? `CPA 全局代理 · ${exit}` : 'CPA 全局代理', note: data.signin.note }
}

/** An account's exit after a write, in words (toasts). */
export function readLabel(read: EgressRead | EgressAccount): string {
  switch (read.mode) {
    case 'inherit': return '继承'
    case 'direct': return '直连'
    case 'url': return ('entryName' in read && read.entryName) || (read.masked ? `自定义 · ${read.masked}` : '自定义地址')
    case 'invalid': return '地址无效'
    default: return '未知'
  }
}

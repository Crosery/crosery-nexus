// 列表命令（channels / accounts / models / keys ls）的树形视图。层级、命名与顺序照 Web 控制台（src/）：
// 控制台改了下面标注出处的规则，这里要跟着改。只组装节点，渲染见 ui.mjs renderTree。
import { time, truncate, usd } from './ui.mjs'

const lower = value => String(value || '').trim().toLowerCase()

/* ────────── 供应商：API 渠道 + 订阅账号池（src/features/providers/ProvidersPage.vue） ────────── */

/** 订阅账号池 provider 目录，顺序即控制台的分组顺序（src/features/accounts/model.ts PROVIDERS）。 */
export const PROVIDERS = [
  { id: 'codex', types: ['codex', 'openai'], name: 'Codex', vendor: 'OpenAI · ChatGPT 订阅' },
  { id: 'claude', types: ['claude', 'anthropic'], name: 'Claude', vendor: 'Anthropic · Claude 订阅' },
  { id: 'antigravity', types: ['antigravity', 'google'], name: 'Antigravity', vendor: 'Google · 按模型家族计额' },
  { id: 'kimi', types: ['kimi'], name: 'Kimi', vendor: 'Moonshot · kimi.com 国内站' },
  { id: 'kimi-ai', types: ['kimi-ai'], name: 'Kimi 国际站', vendor: 'Moonshot · kimi.ai' },
  { id: 'xai', types: ['xai', 'grok'], name: 'Grok', vendor: 'xAI · SuperGrok' },
  { id: 'devin', types: ['devin'], name: 'Devin', vendor: 'Cognition' },
  { id: 'meta', types: ['meta', 'muse'], name: 'Meta AI', vendor: 'Meta · Muse' },
]

/** 凭据 type → 控制台的 provider 分组；目录外的 type 首字母大写、归「其它凭据」，排在目录之后。 */
export function providerInfo(type) {
  const key = lower(type)
  const order = PROVIDERS.findIndex(provider => provider.types.includes(key))
  if (order !== -1) return { ...PROVIDERS[order], order }
  return { id: key, name: key ? key.charAt(0).toUpperCase() + key.slice(1) : '其它', vendor: '其它凭据', order: PROVIDERS.length }
}

/** 名称后带上命令行要用的 type（只差大小写时不重复）。 */
const providerTitle = (info, type) => (lower(info.name) === lower(type) ? info.name : `${info.name}（${type}）`)

const byProvider = (a, b) => a.info.order - b.info.order || a.info.name.localeCompare(b.info.name)

/** 渠道类型（ProvidersPage.vue channelRows）。 */
export function channelType(row) {
  const url = String(row.baseUrl || '')
  if (url.includes('openrouter.ai') || String(row.name).includes('openrouter')) return '中转网关'
  if (url.includes('127.0.0.1') || url.includes('localhost')) return '本机服务'
  return '兼容渠道'
}

const models = row => (row.totalModels === null || row.totalModels === undefined ? '模型 -' : `模型 ${row.enabledModels}/${row.totalModels}`)

/** channels ls：API 渠道（服务端顺序）+ 订阅账号池（控制台 provider 顺序）。行数据就是 --json 的那一份。 */
export function channelsTree(rows) {
  const compat = rows.filter(row => row.kind === 'compat').map(row => {
    // 残留 = 网关里已不存在（src/features/channels/channelModel.ts classifyChannel）
    const state = row.stale ? { text: '残留', tone: 'err' } : row.enabled ? { text: '启用', tone: 'ok' } : { text: '停用', tone: 'warn' }
    return {
      kind: 'compat',
      cells: [row.name, state, channelType(row), models(row), `${row.keys ?? '-'} Key`, { text: row.baseUrl || '-', tone: 'muted' }],
      children: row.stale ? [{ kind: 'reason', cells: [{ text: '网关里已不存在 · 可清理：cradmin channels prune', tone: 'muted' }] }] : [],
    }
  })
  const oauth = rows.filter(row => row.kind === 'oauth').map(row => ({ row, info: providerInfo(row.name) })).sort(byProvider).map(({ row, info }) => ({
    kind: 'oauth',
    cells: [providerTitle(info, row.name), { text: row.state, tone: row.state === '启用' ? 'ok' : 'warn' }, { text: info.vendor, tone: 'muted' }, models(row), `${row.accounts} 账号`],
  }))
  return [
    { kind: 'section', cells: [{ text: 'API 渠道', bold: true }, { text: String(compat.length), tone: 'muted' }], children: compat },
    { kind: 'section', cells: [{ text: '订阅账号池', bold: true }, { text: String(oauth.length), tone: 'muted' }], children: oauth },
  ]
}

/* ────────── 订阅账号池：provider → 账号（src/features/accounts/model.ts viewOf / groupAccounts） ────────── */

const LAPSED_RE = /\b401\b|unauthori[sz]ed|invalid[_ ]grant|token[^a-z]*(has )?expired|refresh[_ ]token|revoked|signed[_ ]out|re-?auth|登录失效|授权失效|重新登录/i

export function reasonWords(message) {
  const m = message.toLowerCase()
  if (!m) return '上游暂时不可用'
  if (/\b429\b|rate.?limit|too many/.test(m)) return '429 限流 · Retry-After'
  if (/quota|usage.?limit|exceeded|exhausted|用尽|超额/.test(m)) return '额度用尽 · 到重置时刻恢复'
  if (/\b5\d\d\b|overload|unavailable|timeout|timed out|超时/.test(m)) return '上游不可用 · 自动重试'
  if (/\b403\b|forbidden/.test(m)) return '403 · 上游拒绝'
  const flat = message.replace(/\s+/g, ' ').trim()
  return flat.length > 48 ? `${flat.slice(0, 47)}…` : flat
}

const epoch = value => {
  if (typeof value === 'number') return Number.isFinite(value) && value > 0 ? value : null
  const ms = value ? Date.parse(String(value)) : Number.NaN
  return Number.isFinite(ms) ? ms : null
}

/**
 * 账号状态与「为什么」那一行。monitor = /api/monitor 的账号（accounts ls --quota 才读）；没有它时
 * 失效 / 冷却 / 优先级都无从判断，只按凭据的 disabled / status 分。
 */
export function accountState(credential, monitor, now = Date.now()) {
  const disabled = Boolean(credential.disabled)
  const status = lower(credential.status || monitor?.status)
  const message = String(monitor?.status_message || '').trim()
  const until = epoch(monitor?.next_retry_after)
  const lapsed = !disabled && (LAPSED_RE.test(message) || (status === 'error' && /\b401\b/.test(message)))
  const base = { lapsed, cooling: false, priority: monitor ? Number(monitor.priority) || 0 : null }
  if (disabled) return { ...base, key: 'pause', label: '暂停', tone: 'muted', leader: null }
  if (lapsed) return { ...base, key: 'bad', label: '失效', tone: 'err', leader: /\b401\b/.test(message) || !message ? '401 · 授权失效 · 重新授权后恢复' : `授权失效 · ${reasonWords(message)}` }
  if (until !== null && until > now) return { ...base, cooling: true, key: 'cool', label: '冷却', tone: 'warn', leader: `网关休息中：${reasonWords(message)} · 唯一可用时仍会被尝试` }
  if (status === 'error') return { ...base, key: 'warn', label: '异常', tone: 'warn', leader: message ? reasonWords(message) : monitor ? '网关标记为异常 · 原因未上报' : null }
  if (status === 'refreshing') return { ...base, key: 'busy', label: '刷新中', tone: 'info', leader: null }
  if (status === 'pending') return { ...base, key: 'warn', label: '待验证', tone: 'warn', leader: '等待外部验证' }
  return { ...base, key: 'run', label: '运行', tone: 'ok', leader: null }
}

const STATE_ORDER = { bad: 0, warn: 1, cool: 2, busy: 3, run: 4, pause: 5 }

/**
 * accounts ls：provider → 账号。items = [{row, state, quota}]，row 是 --json 的那一份（publicAccount），
 * state 来自 accountState，quota = 额度摘要（只在 --quota 时给）。
 */
export function accountsTree(items, { proxyLabel = value => value } = {}) {
  const groups = new Map()
  for (const item of items) {
    const info = providerInfo(item.row.provider)
    const group = groups.get(info.id) || { info, items: [] }
    group.items.push(item)
    groups.set(info.id, group)
  }
  return [...groups.values()].sort(byProvider).map(({ info, items: list }) => {
    const routable = list.filter(({ state }) => state.key !== 'pause' && !state.lapsed && !state.cooling)
    // 网关先选优先级最高的一档；「首选」只在恰好一个账号领先时才有意义
    const prios = routable.map(({ state }) => state.priority ?? 0)
    const leaders = routable.filter(({ state }) => (state.priority ?? 0) === Math.max(...prios))
    const first = routable.length > 1 && leaders.length === 1 && new Set(prios).size > 1 ? leaders[0] : null
    const tiered = new Set(list.map(({ state }) => state.priority ?? 0)).size > 1
    const facts = [`${list.length} 账号`, `${routable.length} 参与路由`, ...(tiered ? ['按优先级选号'] : [])].join(' · ')
    const label = ({ row }) => row.label || row.name
    const sorted = [...list].sort((a, b) => (STATE_ORDER[a.state.key] ?? 9) - (STATE_ORDER[b.state.key] ?? 9) || label(a).localeCompare(label(b)))
    return {
      kind: 'provider',
      cells: [{ text: info.name, bold: true }, { text: info.vendor, tone: 'muted' }, { text: facts, tone: 'muted' }],
      children: sorted.map(item => {
        // 冷却拿走了这个 provider 的最后一个可路由账号时，原因行要升级（DESIGN §2.2）
        const leader = item.state.cooling && !routable.length ? `${item.state.leader} · ${info.name} 已无可用账号` : item.state.leader
        return {
          kind: 'account',
          cells: [{ text: item.state.label, tone: item.state.tone }, `${label(item)}${item === first ? ' · 首选' : ''}`, `模型 ${item.row.modelCount}`, proxyLabel(item.row.proxyUrl), item.quota ?? ''],
          children: leader ? [{ kind: 'leader', cells: [{ text: leader, tone: 'muted' }] }] : [],
        }
      }),
    }
  })
}

/* ────────── 模型目录：厂商 → 模型（src/features/models/modelRows.ts、ModelsPage.vue） ────────── */

const VENDOR_ALIAS = {
  'x-ai': 'xai', 'z-ai': 'zhipu', zhipuai: 'zhipu', thudm: 'zhipu', moonshotai: 'moonshot', 'meta-llama': 'meta',
  mistralai: 'mistral', alibaba: 'qwen', 'qwen-ai': 'qwen', google: 'google', 'google-ai': 'google', anthropic: 'anthropic', openai: 'openai',
}
export const VENDOR_LABEL = {
  anthropic: 'Anthropic', openai: 'OpenAI', google: 'Google', xai: 'xAI', deepseek: 'DeepSeek', qwen: 'Qwen', zhipu: '智谱',
  moonshot: 'Moonshot', minimax: 'MiniMax', meta: 'Meta', mistral: 'Mistral', nvidia: 'NVIDIA', cohere: 'Cohere', openrouter: 'OpenRouter',
  other: '其他',
}
const VENDOR_KEYWORDS = [
  [/claude|opus|sonnet|haiku/, 'anthropic'],
  [/^(gpt|o\d|codex|chatgpt|dall-e|whisper|sora|tts-)/, 'openai'],
  [/gemini|gemma|lyria|imagen|veo-/, 'google'],
  [/grok/, 'xai'],
  [/deepseek/, 'deepseek'],
  [/qwen|qwq/, 'qwen'],
  [/glm/, 'zhipu'],
  [/kimi|moonshot/, 'moonshot'],
  [/minimax|abab/, 'minimax'],
  [/llama/, 'meta'],
  [/mistral|codestral|devstral|magistral|ministral/, 'mistral'],
  [/nemotron/, 'nvidia'],
]
const vendorKey = raw => {
  const value = lower(raw).replace(/^~/, '')
  return VENDOR_ALIAS[value] ?? value
}

/** 厂商：OpenRouter 来源 id 的前缀 → 不是来源渠道的 `vendor/` 前缀 → 关键词 → 其他。 */
export function modelVendor(model) {
  const sourceId = model?.pricingSources?.openrouter?.sourceId
  if (typeof sourceId === 'string' && sourceId.includes('/')) return vendorKey(sourceId.slice(0, sourceId.indexOf('/')))
  const id = String(model?.id || '')
  const slash = id.indexOf('/')
  if (slash > 0) {
    const prefix = id.slice(0, slash).toLowerCase()
    if (!(model.sources || []).some(source => lower(source.channel) === prefix)) return vendorKey(prefix)
  }
  let name = slash !== -1 ? id.slice(slash + 1) : id
  if (name.endsWith('[1m]')) name = name.slice(0, -4)
  for (const [pattern, vendor] of VENDOR_KEYWORDS) if (pattern.test(name.toLowerCase())) return vendor
  return 'other'
}

const KIND_TAG = { image: '图片', video: '视频', audio: '语音', embedding: '向量', rerank: '重排', other: '其他' }
const modelStatus = row => (row.catalogOnly ? { key: 2, text: '仅目录', tone: 'muted' } : row.enabledSources > 0 ? { key: 0, text: '启用', tone: 'ok' } : { key: 1, text: '停用', tone: 'warn' })

/**
 * models ls：厂商 → 模型。rows 是 --json 的那一份（modelRow），vendors = id → 厂商 key（modelVendor）。
 * 厂商按模型数从多到少、再按名称（ModelsPage.vue vendorOptions）；组内在用的在前，再按 id。
 * 类型标签同控制台：对话不标，按类型筛选时都不标（src/lib/modelKind.ts kindTag）。
 */
export function modelsTree(rows, vendors, { typeFilter = null } = {}) {
  const groups = new Map()
  for (const row of rows) {
    const vendor = vendors.get(row.id) || 'other'
    groups.set(vendor, [...(groups.get(vendor) || []), row])
  }
  const label = vendor => VENDOR_LABEL[vendor] ?? vendor
  return [...groups].sort(([a, x], [b, y]) => y.length - x.length || label(a).localeCompare(label(b))).map(([vendor, list]) => ({
    kind: 'vendor',
    cells: [{ text: label(vendor), bold: true }, { text: `${list.length} 个`, tone: 'muted' }],
    children: [...list].sort((a, b) => modelStatus(a).key - modelStatus(b).key || a.id.localeCompare(b.id)).map(row => {
      const status = modelStatus(row)
      const price = row.unpriced ? { text: '未定价', tone: 'muted', align: 'right' }
        : row.inputPer1M === 0 && row.outputPer1M === 0 ? { text: '免费', align: 'right' }
          : { text: `${usd(row.inputPer1M)} / ${usd(row.outputPer1M)}`, align: 'right' }
      return {
        kind: 'model',
        cells: [
          { text: status.text, tone: status.tone }, row.id, { text: typeFilter ? '' : KIND_TAG[row.kind] || '', tone: 'muted' }, price,
          { text: `渠道 ${row.enabledSources}/${row.totalSources}`, align: 'right' }, row.enabledSources >= 2 ? { text: '多渠道', tone: 'warn' } : '',
        ],
      }
    }),
  }))
}

/* ────────── 全部 Key（src/features/keys/keysModel.ts、KeysPage.vue） ────────── */

const limited = window => Boolean(window && window.limitUsd > 0)
const ratioOf = window => (!limited(window) ? null : typeof window.ratio === 'number' && Number.isFinite(window.ratio) ? window.ratio : window.spentUsd / window.limitUsd)

/** 额度压力 = 最满的有上限窗口；全都不限时 null。 */
export function pressure(key) {
  const ratios = ['daily', 'weekly', 'total'].map(window => ratioOf(key.quotaState?.[window])).filter(ratio => ratio !== null)
  return ratios.length ? Math.max(...ratios) : null
}

export const NEAR_LIMIT = 0.9

export function keyStatusView(key) {
  if (key.blockedReason) return { text: '超额停用', tone: 'err' }
  if (!key.enabled) return { text: '停用', tone: 'muted' }
  const p = pressure(key)
  return p !== null && p >= NEAR_LIMIT ? { text: '接近上限', tone: 'warn' } : { text: '启用', tone: 'ok' }
}

/** `全部渠道` / `无渠道` / 分组名用 ` · ` 连起来。 */
export function groupScope(key, groups) {
  const ids = key.groups || []
  if (!ids.length) return '无渠道'
  if (groups.length > 0 && groups.every(group => ids.includes(group.id))) return '全部渠道'
  return ids.map(id => groups.find(group => group.id === id)?.name ?? id).join(' · ')
}

const desc = (a, b) => (a === b ? 0 : a === null ? 1 : b === null ? -1 : b - a)

/** 控制台默认的「额度压力」排序：最满的窗口在前，同档里额度封禁在前，再按今日、本周花费，最后按名称。 */
export function sortKeys(keys) {
  const spent = (key, window) => key.quotaState?.[window]?.spentUsd ?? null
  return [...keys].sort((a, b) => desc(pressure(a), pressure(b))
    || Number(Boolean(b.blockedReason)) - Number(Boolean(a.blockedReason))
    || desc(spent(a, 'daily'), spent(b, 'daily'))
    || desc(spent(a, 'weekly'), spent(b, 'weekly'))
    || String(a.name).localeCompare(String(b.name), 'zh-CN', { numeric: true }))
}

const spendCell = (noun, window) => {
  const amount = window?.spentUsd ? usd(window.spentUsd) : '-'
  return `${noun} ${amount}${limited(window) ? `/${usd(window.limitUsd)}` : ''}`
}

/** keys ls：全部 Key，一把一行。keys 是 --json 的那一份（publicKey），groups = bootstrap.groups。 */
export function keysTree(keys, groups) {
  return sortKeys(keys).map(key => {
    const state = key.quotaState || {}
    return {
      kind: 'key',
      cells: [
        keyStatusView(key), { text: key.name, bold: true }, { text: String(key.maskedKey || '').replace(/[•●*]{2,}/g, '…'), tone: 'muted' },
        truncate(`${groupScope(key, groups)}${key.totalConcurrency ? ` · 并发 ${key.totalConcurrency}` : ''}`, 40),
        spendCell('今日', state.daily), spendCell('本周', state.weekly),
        limited(state.total) ? `累计 ${usd(state.total.spentUsd)} / ${usd(state.total.limitUsd)}` : '',
        { text: key.lastUsedAt ? time(key.lastUsedAt) : '从未', tone: 'muted' },
      ],
    }
  })
}

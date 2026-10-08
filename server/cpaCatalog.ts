import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { upstreamLimiter, type SyncOutcome } from './syncRegistry.js'

/**
 * CPA 模型目录 = 官方目录 ∪ 仓库补充目录（deploy/catalog/supplement.json）。
 *
 * CPA 的 `models.catalog` 指向本地文件时整份替换官方来源；它校验不过就保留上一份有效目录，文件被替换后约 15s 内重读。
 * 本任务每 3h 拉官方目录（两个地址，先到的有效者胜）、按模型 id 并入补充目录、用 CPA 同一套规则校验，
 * 再过保护规则（必需段不能为空、任一段模型数不能比上次写入少一半以上）才原子写入。任何一步失败都不写：
 * 旧文件原样留给 CPA，失败原因作为任务错误（告警）显示，并追加到变更历史。
 */

export const OFFICIAL_CATALOG_URLS = [
  'https://raw.githubusercontent.com/router-for-me/models/refs/heads/main/models.json',
  'https://models.router-for.me/models.json',
] as const

/** CPA validateModelsCatalog 逐段校验的段；本任务额外要求它们非空。 */
export const REQUIRED_SECTIONS = ['claude', 'gemini', 'vertex', 'aistudio', 'codex-free', 'codex-team', 'codex-plus', 'codex-pro', 'kimi', 'antigravity', 'xai', 'meta'] as const
/** staticModelsJSON 认识的全部段（devin 解码但不逐条校验）；其余键 CPA 忽略，原样透传。 */
const KNOWN_SECTIONS: readonly string[] = [...REQUIRED_SECTIONS, 'devin']

/** CPA readCatalogSource 的上限（maxCodexClientModelsSize）：超过它整份目录被拒。 */
export const MAX_CATALOG_BYTES = 8 << 20
export const CATALOG_INTERVAL_MS = 3 * 60 * 60_000
const FETCH_TIMEOUT_MS = 30_000

export const DEFAULT_SUPPLEMENT_FILE = fileURLToPath(new URL('../deploy/catalog/supplement.json', import.meta.url))

export type CatalogDoc = Record<string, unknown>

/* ────────────────────────── 校验：Go json.Unmarshal + validateModelSection 的移植 ────────────────────────── */

type Kind = 'string' | 'int' | 'float' | 'bool' | 'strings' | 'stringMap' | { object: Schema } | { list: Schema }
type Schema = Record<string, Kind>

const COST_TIER: Schema = { min_context_tokens: 'int', input: 'float', output: 'float', cache_read: 'float', cache_write: 'float' }

/** ModelInfo 里参与 JSON 解码的字段（键已小写：Go 按大小写不敏感匹配字段名）。未知字段 Go 直接忽略。 */
const MODEL: Schema = {
  id: 'string', object: 'string', created: 'int', owned_by: 'string', type: 'string', display_name: 'string', name: 'string',
  version: 'string', description: 'string', inputtokenlimit: 'int', outputtokenlimit: 'int', supportedgenerationmethods: 'strings',
  context_length: 'int', max_completion_tokens: 'int', supported_parameters: 'strings', supportedinputmodalities: 'strings',
  supportedoutputmodalities: 'strings', supports_web_search: 'bool', total_context_length: 'int', family: 'string',
  knowledge_cutoff: 'string', release_date: 'string', last_updated: 'string', supports_tool_call: 'bool',
  supports_structured_output: 'bool', supports_temperature: 'bool', supports_attachment: 'bool',
  cost: { object: { input: 'float', output: 'float', cache_read: 'float', cache_write: 'float', tiers: { list: COST_TIER } } },
  thinking: { object: { min: 'int', max: 'int', zero_allowed: 'bool', dynamic_allowed: 'bool', levels: 'strings' } },
  config: { object: { override_header: 'stringMap' } },
  native_capabilities: { object: { web_search: 'bool' } },
  support_configuration_update: 'bool',
}

/** Go int64 上限（2^63，浮点下与 2^63-1 相同） */
const INT64_MAX = 2 ** 63

const isObject = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value)

/** Go 解码 null 到任何字段都是空操作；类型不符则整份目录解码失败。 */
function checkKind(kind: Kind, value: unknown, where: string): string | null {
  if (value === null) return null
  if (kind === 'string') return typeof value === 'string' ? null : `${where} 应为字符串`
  if (kind === 'bool') return typeof value === 'boolean' ? null : `${where} 应为布尔值`
  if (kind === 'float') return typeof value === 'number' ? null : `${where} 应为数字`
  // JSON.parse 之后分不出 1000.0 与 1000：Go 拒绝前者，这里放行。上游目录从不这样写。
  if (kind === 'int') return typeof value === 'number' && Number.isInteger(value) && value >= -INT64_MAX && value < INT64_MAX ? null : `${where} 应为整数`
  if (kind === 'strings') {
    if (!Array.isArray(value)) return `${where} 应为字符串数组`
    const bad = value.findIndex(item => item !== null && typeof item !== 'string')
    return bad === -1 ? null : `${where}[${bad}] 应为字符串`
  }
  if (kind === 'stringMap') {
    if (!isObject(value)) return `${where} 应为对象`
    const bad = Object.entries(value).find(([, item]) => item !== null && typeof item !== 'string')
    return bad ? `${where}.${bad[0]} 应为字符串` : null
  }
  if ('list' in kind) {
    if (!Array.isArray(value)) return `${where} 应为数组`
    for (const [index, item] of value.entries()) {
      const problem = checkKind({ object: kind.list }, item, `${where}[${index}]`)
      if (problem) return problem
    }
    return null
  }
  if (!isObject(value)) return `${where} 应为对象`
  for (const [key, item] of Object.entries(value)) {
    const field = kind.object[key.toLowerCase()]
    if (!field) continue
    const problem = checkKind(field, item, `${where}.${key}`)
    if (problem) return problem
  }
  return null
}

/** Go 对同一字段的多个大小写变体按出现顺序覆盖：最后一个匹配 `id` 的键生效。 */
export function modelId(model: unknown): string {
  if (!isObject(model)) return ''
  let id: unknown
  for (const [key, value] of Object.entries(model)) if (key.toLowerCase() === 'id') id = value
  return typeof id === 'string' ? id.trim() : ''
}

/**
 * 与 CPA 接受目录的条件一致：顶层是对象、已知段是数组、条目是对象且字段类型能解码；
 * 必需段里没有 null 条目、空 id、重复 id。空段 CPA 只告警，这里也放行（由保护规则另行拦截）。
 * 比 CPA 更严的两处：顶层 null 与 devin 段里的 null 条目也拒绝。返回第一个问题，或 null。
 */
export function validateCpaCatalog(doc: unknown): string | null {
  if (!isObject(doc)) return '目录顶层必须是对象'
  for (const section of KNOWN_SECTIONS) {
    const models = doc[section]
    if (models === undefined || models === null) continue
    if (!Array.isArray(models)) return `${section} 应为数组`
    const seen = new Set<string>()
    for (const [index, model] of models.entries()) {
      if (model === null) return `${section}[${index}] 为 null`
      const problem = checkKind({ object: MODEL }, model, `${section}[${index}]`)
      if (problem) return problem
      if (section === 'devin') continue
      const id = modelId(model)
      if (!id) return `${section}[${index}] 缺少 id`
      if (seen.has(id)) return `${section} 有重复的模型 id ${JSON.stringify(id)}`
      seen.add(id)
    }
  }
  return null
}

/** 补充目录比官方更严：只允许已知段，段内每条都有 id 且不重复（含 devin）。 */
export function validateSupplement(doc: unknown): string | null {
  if (!isObject(doc)) return '补充目录顶层必须是对象'
  const unknown = Object.keys(doc).filter(key => !KNOWN_SECTIONS.includes(key))
  if (unknown.length) return `补充目录有未知段：${unknown.join('、')}`
  for (const [section, models] of Object.entries(doc)) {
    if (!Array.isArray(models)) return `补充目录 ${section} 应为数组`
    const seen = new Set<string>()
    for (const [index, model] of models.entries()) {
      const id = modelId(model).toLowerCase()
      if (!id) return `补充目录 ${section}[${index}] 缺少 id`
      if (seen.has(id)) return `补充目录 ${section} 有重复的模型 id ${JSON.stringify(id)}`
      seen.add(id)
    }
  }
  return validateCpaCatalog(doc)
}

/* ────────────────────────── 合并、差异、保护规则 ────────────────────────── */

/**
 * 按段、按模型 id（去空白、大小写不敏感，与 CPA upsertModelInfos 相同）整条替换或追加。
 * 替换保留官方的位置、追加放在段尾，结果只取决于两份输入，重复运行字节相同。
 */
export function mergeSupplement(official: CatalogDoc, supplement: CatalogDoc): CatalogDoc {
  const merged = structuredClone(official)
  for (const [section, extras] of Object.entries(supplement)) {
    if (!Array.isArray(extras)) continue
    const list: unknown[] = Array.isArray(merged[section]) ? merged[section] as unknown[] : []
    for (const extra of extras) {
      const key = modelId(extra).toLowerCase()
      const index = list.findIndex(model => modelId(model).toLowerCase() === key)
      if (index === -1) list.push(structuredClone(extra))
      else list[index] = structuredClone(extra)
    }
    merged[section] = list
  }
  return merged
}

export function sectionCounts(doc: CatalogDoc): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const [section, models] of Object.entries(doc)) if (Array.isArray(models)) counts[section] = models.length
  return counts
}

export type SectionDiff = { added: string[]; removed: string[]; changed: string[] }

/** 只列出有变化的段；changed = 同 id 但定义不同。 */
export function diffCatalog(previous: CatalogDoc | null, next: CatalogDoc): Record<string, SectionDiff> {
  const byId = (models: unknown) => new Map((Array.isArray(models) ? models : []).map(model => [modelId(model), JSON.stringify(model)] as const))
  const sections = new Set([...Object.keys(previous ?? {}), ...Object.keys(next)].filter(section => Array.isArray(previous?.[section]) || Array.isArray(next[section])))
  const diff: Record<string, SectionDiff> = {}
  for (const section of sections) {
    const before = byId(previous?.[section])
    const after = byId(next[section])
    const added = [...after.keys()].filter(id => !before.has(id))
    const removed = [...before.keys()].filter(id => !after.has(id))
    const changed = [...after.keys()].filter(id => before.has(id) && before.get(id) !== after.get(id))
    if (added.length || removed.length || changed.length) diff[section] = { added, removed, changed }
  }
  return diff
}

/** 必需段为空、或任一段比上次写入少了一半以上（不含正好一半）→ 返回拦截原因。 */
export function guardCatalog(next: CatalogDoc, baseline: Record<string, number> | null): string[] {
  const counts = sectionCounts(next)
  const problems: string[] = []
  for (const section of REQUIRED_SECTIONS) if (!counts[section]) problems.push(`${section} 段为空`)
  for (const [section, before] of Object.entries(baseline ?? {})) {
    const after = counts[section] ?? 0
    if (before > 0 && after * 2 < before) problems.push(`${section} 模型数 ${before} → ${after}，减少超过一半`)
  }
  return problems
}

/* ────────────────────────── 拉取与写入 ────────────────────────── */

export type CatalogFetch = (url: string, init: { signal: AbortSignal; headers: Record<string, string> }) => Promise<Response>

async function readLimited(response: Response, limit: number): Promise<string> {
  const declared = Number(response.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > limit) throw new Error('超过 8 MiB')
  if (!response.body) return ''
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > limit) {
      await reader.cancel().catch(() => undefined)
      throw new Error('超过 8 MiB')
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks).toString('utf8')
}

const hostOf = (url: string) => {
  try { return new URL(url).host } catch { return url }
}

/** 与 CPA catalogFetcher 相同：按顺序试每个地址，第一个能解析且通过校验的胜出。 */
export async function fetchOfficialCatalog(
  fetchImpl: CatalogFetch,
  urls: readonly string[],
  options: { timeoutMs?: number; onRequest?: () => void } = {},
): Promise<{ url: string; doc: CatalogDoc } | { errors: string[] }> {
  const errors: string[] = []
  for (const url of urls) {
    options.onRequest?.()
    try {
      const doc = await upstreamLimiter.run(async () => {
        const response = await fetchImpl(url, { signal: AbortSignal.timeout(options.timeoutMs ?? FETCH_TIMEOUT_MS), headers: { accept: 'application/json' } })
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        return JSON.parse(await readLimited(response, MAX_CATALOG_BYTES)) as unknown
      })
      const problem = validateCpaCatalog(doc)
      if (problem) throw new Error(`校验失败：${problem}`)
      return { url, doc: doc as CatalogDoc }
    } catch (error) {
      errors.push(`${hostOf(url)} ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  return { errors }
}

function fsyncDirectory(directory: string): void {
  try {
    const handle = fs.openSync(directory, 'r')
    try { fs.fsyncSync(handle) } finally { fs.closeSync(handle) }
  } catch {
    // 有的平台不允许 fsync 目录；rename 本身已是原子的
  }
}

/** 临时文件 + fsync + rename（0644，CPA 要能读）；旧文件先复制成 `.prev`，替换过程中正式文件始终存在。 */
export function writeCatalogAtomic(file: string, text: string): void {
  const directory = path.dirname(file)
  fs.mkdirSync(directory, { recursive: true })
  if (fs.existsSync(file)) {
    const previous = `${file}.prev`
    const staging = `${previous}.${process.pid}.tmp`
    fs.copyFileSync(file, staging)
    fs.chmodSync(staging, 0o644)
    fs.renameSync(staging, previous)
  }
  const temporary = `${file}.${process.pid}.tmp`
  const handle = fs.openSync(temporary, 'w', 0o644)
  try {
    fs.writeFileSync(handle, text)
    // 服务的 UMask=0077 会把 open 的 0644 收成 0600
    fs.fchmodSync(handle, 0o644)
    fs.fsyncSync(handle)
  } finally {
    fs.closeSync(handle)
  }
  fs.renameSync(temporary, file)
  fsyncDirectory(directory)
}

/* ────────────────────────── 任务 ────────────────────────── */

type CatalogJobData = {
  lastOkAt?: number
  lastWrittenAt?: number
  counts?: Record<string, number>
  lastChange?: { at: number; summary: string }
  lastAlarm?: { at: number; message: string }
}

/** 状态文件里的任务私有数据：类型不对的字段直接丢掉。 */
export function sanitizeCatalogData(data: Record<string, unknown>): void {
  const time = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value > 0
  for (const key of ['lastOkAt', 'lastWrittenAt'] as const) if (!time(data[key])) delete data[key]
  if (!isObject(data.counts) || !Object.values(data.counts).every(count => Number.isInteger(count) && (count as number) >= 0)) delete data.counts
  for (const key of ['lastChange', 'lastAlarm'] as const) {
    const value = data[key]
    if (!isObject(value) || !time(value.at) || typeof (value.summary ?? value.message) !== 'string') delete data[key]
  }
}

export type CpaCatalogOptions = {
  file: string
  historyFile: string
  /** 任务私有持久状态（同步中心的 data，原地修改） */
  data: Record<string, unknown>
  supplementFile?: string
  urls?: readonly string[]
  fetch?: CatalogFetch
  now?: () => number
  timeoutMs?: number
  countRequest?: () => void
  audit?: (action: string, target: string, detail: string) => void
}

const minute = (at: number) => `${new Date(at).toISOString().slice(0, 16).replace('T', ' ')}Z`

function readJson(file: string): { text: string; doc: unknown } | null {
  try {
    const text = fs.readFileSync(file, 'utf8')
    return { text, doc: JSON.parse(text) as unknown }
  } catch {
    return null
  }
}

function appendHistory(file: string, record: Record<string, unknown>): void {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.appendFileSync(file, `${JSON.stringify(record)}\n`, { mode: 0o600 })
  } catch {
    // 历史写不进去不影响目录本身；任务结果照常反映本轮
  }
}

function diffWords(diff: Record<string, SectionDiff>): string {
  const sum = (key: keyof SectionDiff) => Object.values(diff).reduce((total, section) => total + section[key].length, 0)
  const [added, removed, changed] = [sum('added'), sum('removed'), sum('changed')]
  return [added ? `+${added}` : '', removed ? `−${removed}` : '', changed ? `~${changed}` : ''].filter(Boolean).join(' ') || '无模型变化'
}

export async function runCpaCatalogSync(options: CpaCatalogOptions): Promise<SyncOutcome> {
  const now = (options.now ?? Date.now)()
  const at = new Date(now).toISOString()
  const data = options.data as CatalogJobData
  const kept = data.lastWrittenAt ? `保留 ${minute(data.lastWrittenAt)} 写入的目录` : '尚未写入目录'

  const alarm = (message: string, source: string | null = null): SyncOutcome => {
    appendHistory(options.historyFile, { at, type: 'alarm', source, reason: message })
    data.lastAlarm = { at: now, message: message.slice(0, 300) }
    return { result: 'error', error: `${message}；${kept}`, summary: data.lastOkAt ? `${kept} · 上次成功 ${minute(data.lastOkAt)}` : kept }
  }

  const supplementRead = readJson(options.supplementFile ?? DEFAULT_SUPPLEMENT_FILE)
  if (!supplementRead) return alarm('补充目录读取失败')
  const supplementProblem = validateSupplement(supplementRead.doc)
  if (supplementProblem) return alarm(supplementProblem)

  const fetched = await fetchOfficialCatalog(options.fetch ?? fetch, options.urls ?? OFFICIAL_CATALOG_URLS, { timeoutMs: options.timeoutMs, onRequest: options.countRequest })
  if ('errors' in fetched) return alarm(`官方目录拉取失败：${fetched.errors.join('；')}`)

  const merged = mergeSupplement(fetched.doc, supplementRead.doc as CatalogDoc)
  const problem = validateCpaCatalog(merged)
  if (problem) return alarm(`合并后校验失败：${problem}`, fetched.url)
  const text = `${JSON.stringify(merged, null, 2)}\n`
  if (Buffer.byteLength(text) > MAX_CATALOG_BYTES) return alarm('合并后目录超过 8 MiB', fetched.url)

  const currentRead = readJson(options.file)
  const current = currentRead && isObject(currentRead.doc) && !validateCpaCatalog(currentRead.doc) ? { text: currentRead.text, doc: currentRead.doc } : null
  const blocked = guardCatalog(merged, current ? sectionCounts(current.doc) : data.counts ?? null)
  if (blocked.length) return alarm(`保护规则拦截：${blocked.join('；')}`, fetched.url)

  const counts = sectionCounts(merged)
  const total = Object.values(counts).reduce((sum, count) => sum + count, 0)
  if (current?.text === text) {
    data.lastOkAt = now
    data.counts = counts
    const last = data.lastChange ? ` · 上次变更 ${minute(data.lastChange.at)} ${data.lastChange.summary}` : ''
    return { result: 'ok', summary: `无变化 · ${total} 模型${last}` }
  }

  const diff = diffCatalog(current?.doc ?? null, merged)
  try {
    writeCatalogAtomic(options.file, text)
  } catch (error) {
    return alarm(`写入失败：${error instanceof Error ? error.message : String(error)}`, fetched.url)
  }
  const words = diffWords(diff)
  appendHistory(options.historyFile, {
    at, type: 'write', source: fetched.url, sha256: crypto.createHash('sha256').update(text).digest('hex'), counts, sections: diff,
  })
  options.audit?.('cpa_catalog_update', path.basename(options.file), `${words} · 来源 ${hostOf(fetched.url)}`)
  data.lastOkAt = now
  data.lastWrittenAt = now
  data.counts = counts
  data.lastChange = { at: now, summary: words }
  return { result: 'ok', summary: `已更新 ${words} · ${total} 模型` }
}

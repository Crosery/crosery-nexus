import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import type express from 'express'
import { config } from './config.js'
import { addAudit } from './db.js'
import { KernelError, kernelCaller, kernelRefusal, type KernelCall } from './magpieKernel.js'
import { readMagpieUpstreamStatus } from './magpieUpstream.js'
import { modelKind, type ModelKind } from './modelKind.js'
import { MAGPIE_API_REVISION } from '../packages/contracts/magpie-upstream.generated.js'

/**
 * /api/gateway/settings — 网关功能 (#gateway-features). Magpie's gateway-effective settings (脱敏, 识图 / 生图模型)
 * are read and written through the kernel's private `/internal/settings`, which owns Magpie's settings.json;
 * the console stores nothing. Labels are Magpie's own zh copy from deploy/magpie/catalog.json `settings`
 * (scripts/magpie-settings.mjs, drift-checked against the pinned source). GATEWAY_ENGINE=cpa has no kernel:
 * `{available:false, reason:'cpa_engine'}`. Admin only: key sessions are refused by the default-deny guard.
 */

type Localized = { en: string; zh: string }
export type SettingsItem = {
  key: string; group: string; control: 'switch' | 'words' | 'rules' | 'model' | 'forced-off'; class: string
  default: unknown; name: Localized; sub: Localized; subOff?: Localized; placeholder?: Localized
}
export type SettingsCatalog = {
  revision: string
  groups: Array<{ id: string; title: Localized }>
  items: SettingsItem[]
  copy: Record<string, Localized>
  limits: {
    rules: { maxRules: number; minPrefix: number; maxPrefix: number; maxRegex: number; maxKind: number; minMatch: number }
    words: { maxWords: number; minBytes: number; maxBytes: number }
  }
}
export type RedactRule = { kind: string; prefix?: string; regex?: string }
export type GatewaySettingValues = {
  redact: boolean; redactPersonal: boolean; redactWords: string[]; redactRules: RedactRule[]; vision: string; imageGen: string
}
export type ModelOption = { id: string; label: string; provider: string; kind: ModelKind }
export type ModelChoice = { auto: string; effective: string; options: ModelOption[]; stale: boolean }
export type GatewaySettingsView = {
  available: boolean
  reason: string | null
  message: string | null
  revision: string
  catalog: Omit<SettingsCatalog, 'revision'> | null
  values: GatewaySettingValues | null
  models: { vision: ModelChoice; imageGen: ModelChoice & { admitted: boolean } } | null
  telemetry: { off: boolean; forced: boolean } | null
  applies: string | null
  upstream: { candidateRevision: string | null; added: string[]; changed: string[]; removed: string[] }
}

export class GatewaySettingsError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message) }
}

export const WRITABLE_KEYS = ['redact', 'redactPersonal', 'redactWords', 'redactRules', 'vision', 'imageGen'] as const
type WritableKey = typeof WRITABLE_KEYS[number]

export const REASONS: Record<string, string> = {
  cpa_engine: '仅 Magpie 网关可用 · 当前网关是 CPA',
  kernel_unavailable: '内核未运行',
  kernel_timeout: '内核响应超时',
  kernel_bad_response: '内核响应异常',
  kernel_outdated: '当前内核不支持网关设置，需要重新构建内核',
  catalog_missing: 'Magpie 设置目录缺失（deploy/magpie/catalog.json）',
}
/** The console admits no /v1/images/* route (server/magpieEngine.ts admissionRoutes); 生图模型 has no console client yet. */
export const IMAGE_ROUTES_ADMITTED = false

export const DEFAULT_SETTINGS_CATALOG = fileURLToPath(new URL('../deploy/magpie/catalog.json', import.meta.url))
const MODEL_ID = /^[^\s/]{1,120}\/\S{1,200}$/
const isObject = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value)
const localized = (value: unknown): value is Localized => isObject(value) && typeof value.en === 'string' && typeof value.zh === 'string'

let cache: { file: string; mtimeMs: number; catalog: SettingsCatalog | null } | null = null

/** catalog.json `settings` + revision; null when missing or malformed (re-read only when the file changes). */
export function loadSettingsCatalog(file = DEFAULT_SETTINGS_CATALOG): SettingsCatalog | null {
  try {
    const stat = fs.statSync(file)
    if (cache && cache.file === file && cache.mtimeMs === stat.mtimeMs) return cache.catalog
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>
    const section = raw.settings
    let catalog: SettingsCatalog | null = null
    if (typeof raw.revision === 'string' && isObject(section) && Array.isArray(section.items) && Array.isArray(section.groups) &&
        isObject(section.copy) && isObject(section.limits) &&
        section.items.every(item => isObject(item) && typeof item.key === 'string' && localized(item.name) && localized(item.sub)) &&
        section.groups.every(group => isObject(group) && typeof group.id === 'string' && localized(group.title))) {
      catalog = { revision: raw.revision, groups: section.groups, items: section.items, copy: section.copy, limits: section.limits } as SettingsCatalog
    }
    cache = { file, mtimeMs: stat.mtimeMs, catalog }
    return catalog
  } catch {
    return null
  }
}

const str = (value: unknown, max = 400) => (typeof value === 'string' ? value.slice(0, max) : '')

function parseValues(body: Record<string, unknown>): GatewaySettingValues {
  const rules = Array.isArray(body.redactRules) ? body.redactRules.filter(isObject).map((rule): RedactRule => ({
    kind: str(rule.kind, 64), ...(rule.prefix ? { prefix: str(rule.prefix) } : {}), ...(rule.regex ? { regex: str(rule.regex) } : {}),
  })) : []
  return {
    redact: body.redact === true, redactPersonal: body.redactPersonal === true,
    redactWords: Array.isArray(body.redactWords) ? body.redactWords.filter((word): word is string => typeof word === 'string') : [],
    redactRules: rules, vision: str(body.vision), imageGen: str(body.imageGen),
  }
}

type KernelModel = { id: string; name: string; providerName: string }
const kernelModels = (value: unknown): KernelModel[] => (Array.isArray(value) ? value : []).filter(isObject)
  .map(model => ({ id: str(model.id), name: str(model.name), providerName: str(model.providerName) }))
  .filter(model => MODEL_ID.test(model.id))
  .slice(0, 500)

const upstreamModel = (id: string) => id.slice(id.indexOf('/') + 1)
const option = (model: KernelModel, kind: (id: string) => ModelKind): ModelOption =>
  ({ id: model.id, label: model.name || upstreamModel(model.id), provider: model.providerName, kind: kind(upstreamModel(model.id)) })

function choice(value: string, auto: string, effective: string, options: ModelOption[]): ModelChoice {
  // a named model that no longer resolves (its channel changed) runs on the automatic pick: say so, never show it as active
  return { auto, effective, options, stale: Boolean(value) && value !== 'off' && effective !== value }
}

/** The kernel's view → values + model choices. 生图: Magpie's own drawers plus the gateway models the console classifies as kind=image. */
export function settingsFromKernel(body: unknown, kind: (id: string) => ModelKind = modelKind) {
  const value = isObject(body) ? body : {}
  const values = parseValues(value)
  const vision = kernelModels(value.visionModels).map(model => option(model, kind))
  const imageGen = new Map(kernelModels(value.imageGenModels).map(model => [model.id, option(model, kind)]))
  for (const model of kernelModels(value.models)) {
    const entry = option(model, kind)
    if (entry.kind === 'image' && !imageGen.has(entry.id)) imageGen.set(entry.id, entry)
  }
  const telemetry = isObject(value.telemetry) ? value.telemetry : {}
  return {
    values,
    models: {
      vision: choice(values.vision, str(value.visionAuto), str(value.visionEffective), vision),
      imageGen: { ...choice(values.imageGen, str(value.imageGenAuto), str(value.imageGenEffective), [...imageGen.values()]), admitted: IMAGE_ROUTES_ADMITTED },
    },
    telemetry: { off: telemetry.off !== false, forced: telemetry.forced !== false },
    applies: str(value.applies, 40) || 'next-request',
  }
}

const utf8Bytes = (text: string) => Buffer.byteLength(text, 'utf8')

/** Whitelist + the catalog's limits; the kernel validates again (RE2 compile, complexity, model resolve). */
export function validateUpdate(input: unknown, catalog: SettingsCatalog): Partial<GatewaySettingValues> {
  if (!isObject(input)) throw new GatewaySettingsError(400, 'invalid_setting', '请求体必须是 {设置: 值} 对象')
  const keys = Object.keys(input)
  if (!keys.length) throw new GatewaySettingsError(400, 'invalid_setting', '没有要修改的设置')
  const unknown = keys.filter(key => !(WRITABLE_KEYS as readonly string[]).includes(key))
  if (unknown.length) throw new GatewaySettingsError(400, 'unknown_setting', `不能在控制台修改：${unknown.join('、')}（可改：${WRITABLE_KEYS.join('、')}）`)
  const out: Partial<GatewaySettingValues> = {}
  const { rules: ruleLimits, words: wordLimits } = catalog.limits
  for (const key of keys as WritableKey[]) {
    const value = input[key]
    if (key === 'redact' || key === 'redactPersonal') {
      if (typeof value !== 'boolean') throw new GatewaySettingsError(400, 'invalid_setting', `${key} 必须是 true 或 false`)
      out[key] = value
    } else if (key === 'redactWords') {
      if (!Array.isArray(value) || value.some(word => typeof word !== 'string')) throw new GatewaySettingsError(400, 'invalid_setting', '脱敏词必须是字符串列表')
      const words = [...new Set((value as string[]).map(word => word.trim()).filter(Boolean))]
      if (words.length > wordLimits.maxWords) throw new GatewaySettingsError(400, 'invalid_setting', `脱敏词最多 ${wordLimits.maxWords} 个`)
      const bad = words.find(word => utf8Bytes(word) < wordLimits.minBytes || utf8Bytes(word) > wordLimits.maxBytes || /\p{Cc}/u.test(word))
      if (bad !== undefined) throw new GatewaySettingsError(400, 'invalid_setting', `每个脱敏词 ${wordLimits.minBytes}–${wordLimits.maxBytes} 字节，不含控制字符`)
      out.redactWords = words
    } else if (key === 'redactRules') {
      if (!Array.isArray(value) || value.some(rule => !isObject(rule))) throw new GatewaySettingsError(400, 'invalid_setting', '脱敏规则必须是 {kind, prefix|regex} 列表')
      if (value.length > ruleLimits.maxRules) throw new GatewaySettingsError(400, 'invalid_setting', `脱敏规则最多 ${ruleLimits.maxRules} 条`)
      out.redactRules = (value as Array<Record<string, unknown>>).map((rule, index) => {
        const extra = Object.keys(rule).filter(field => !['kind', 'prefix', 'regex'].includes(field))
        const prefix = typeof rule.prefix === 'string' ? rule.prefix.trim() : ''
        const regex = typeof rule.regex === 'string' ? rule.regex.trim() : ''
        const kind = typeof rule.kind === 'string' ? rule.kind.trim() : ''
        const where = `第 ${index + 1} 条规则`
        if (extra.length || (rule.kind !== undefined && typeof rule.kind !== 'string') || kind.length > 64) throw new GatewaySettingsError(400, 'invalid_setting', `${where}格式不对`)
        if (Boolean(prefix) === Boolean(regex)) throw new GatewaySettingsError(400, 'invalid_setting', `${where}要么填前缀，要么填正则`)
        if (prefix && (prefix.length < ruleLimits.minPrefix || prefix.length > ruleLimits.maxPrefix)) {
          throw new GatewaySettingsError(400, 'invalid_setting', `${where}的前缀 ${ruleLimits.minPrefix}–${ruleLimits.maxPrefix} 个字符`)
        }
        if (regex.length > ruleLimits.maxRegex) throw new GatewaySettingsError(400, 'invalid_setting', `${where}的正则最长 ${ruleLimits.maxRegex} 个字符`)
        return { kind, ...(prefix ? { prefix } : { regex }) }
      })
    } else {
      if (typeof value !== 'string') throw new GatewaySettingsError(400, 'invalid_setting', `${key} 必须是模型 id、off 或空（自动）`)
      const id = value.trim()
      if (id && id !== 'off' && !MODEL_ID.test(id)) throw new GatewaySettingsError(400, 'invalid_setting', `${key} 必须是 provider/model 形式的模型 id`)
      out[key] = id
    }
  }
  return out
}

/** Audit text: on/off, counts and model ids — never the masked words or rule patterns themselves. */
export function auditDetails(update: Partial<GatewaySettingValues>): string {
  return Object.entries(update).map(([key, value]) => {
    if (typeof value === 'boolean') return `${key}=${value ? 'on' : 'off'}`
    if (Array.isArray(value)) return `${key}=${value.length}项`
    return `${key}=${value || 'auto'}`
  }).join(', ')
}

export type GatewaySettingsDeps = {
  call?: KernelCall
  socket?: () => string
  /** true when GATEWAY_ENGINE=magpie (the kernel serves inference and owns the settings file) */
  magpie?: () => boolean
  catalogFile?: string
  audit?: (action: string, target: string, details: string) => void
  upstream?: () => GatewaySettingsView['upstream']
  kind?: (id: string) => ModelKind
}

function currentUpstream(): GatewaySettingsView['upstream'] {
  const status = readMagpieUpstreamStatus(MAGPIE_API_REVISION)
  const settings = status.status === 'review_required' ? status.changes.settings : undefined
  return { candidateRevision: status.candidateRevision, added: settings?.added ?? [], changed: settings?.changed ?? [], removed: settings?.removed ?? [] }
}

export function createGatewaySettingsService(deps: GatewaySettingsDeps = {}) {
  const call = deps.call ?? kernelCaller(deps.socket ?? (() => config.magpieKernelSocket))
  const magpie = deps.magpie ?? (() => config.gatewayEngine === 'magpie')
  const audit = deps.audit ?? addAudit
  const upstream = deps.upstream ?? currentUpstream
  const kind = deps.kind ?? modelKind

  function base(catalog: SettingsCatalog | null): GatewaySettingsView {
    let up: GatewaySettingsView['upstream'] = { candidateRevision: null, added: [], changed: [], removed: [] }
    try { up = upstream() } catch { /* the tracker's status is optional here */ }
    const { revision: _revision, ...rest } = catalog ?? { revision: '' }
    return {
      available: false, reason: null, message: null, revision: catalog?.revision ?? MAGPIE_API_REVISION,
      catalog: catalog ? rest as Omit<SettingsCatalog, 'revision'> : null, values: null, models: null, telemetry: null, applies: null, upstream: up,
    }
  }
  const unavailable = (view: GatewaySettingsView, reason: string): GatewaySettingsView => ({ ...view, reason, message: REASONS[reason] ?? REASONS.kernel_bad_response })

  async function kernel(method: 'GET' | 'POST', body?: unknown) {
    const reply = await call('/internal/settings', { method, body, timeoutMs: 8_000 })
    if (reply.status === 404) throw new GatewaySettingsError(503, 'kernel_outdated', REASONS.kernel_outdated)
    if (reply.status >= 400) {
      const refusal = kernelRefusal(reply.body)
      if (reply.status === 400) {
        throw new GatewaySettingsError(400, refusal.code || 'invalid_setting', `内核拒绝：${refusal.error || '设置无效'}`)
      }
      throw new GatewaySettingsError(502, 'kernel_bad_response', REASONS.kernel_bad_response)
    }
    return reply.body
  }

  async function read(): Promise<GatewaySettingsView> {
    const catalog = loadSettingsCatalog(deps.catalogFile)
    const view = base(catalog)
    if (!magpie()) return unavailable(view, 'cpa_engine')
    if (!catalog) return unavailable(view, 'catalog_missing')
    try {
      return { ...view, available: true, ...settingsFromKernel(await kernel('GET'), kind) }
    } catch (error) {
      if (error instanceof KernelError || error instanceof GatewaySettingsError) return unavailable(view, error.code)
      throw error
    }
  }

  async function write(input: unknown): Promise<GatewaySettingsView> {
    if (!magpie()) throw new GatewaySettingsError(409, 'cpa_engine', REASONS.cpa_engine)
    const catalog = loadSettingsCatalog(deps.catalogFile)
    if (!catalog) throw new GatewaySettingsError(503, 'catalog_missing', REASONS.catalog_missing)
    const update = validateUpdate(input, catalog)
    const target = Object.keys(update).join(',')
    try {
      const body = await kernel('POST', update)
      audit('gateway_settings', target, `${auditDetails(update)}, outcome=ok`)
      return { ...base(catalog), available: true, ...settingsFromKernel(body, kind) }
    } catch (error) {
      const failure = error instanceof KernelError || error instanceof GatewaySettingsError ? error : null
      audit('gateway_settings', target, `${auditDetails(update)}, outcome=error, code=${failure?.code ?? 'internal'}`)
      if (error instanceof KernelError) throw new GatewaySettingsError(error.status, error.code, error.message)
      throw error
    }
  }

  return { read, write }
}

export type GatewaySettingsService = ReturnType<typeof createGatewaySettingsService>

export function registerGatewaySettingsRoutes(app: express.Express, service: GatewaySettingsService): void {
  const handle = (run: (req: express.Request) => Promise<unknown>) => async (req: express.Request, res: express.Response) => {
    res.setHeader('Cache-Control', 'no-store')
    try {
      res.json(await run(req))
    } catch (error) {
      if (error instanceof GatewaySettingsError) res.status(error.status).json({ error: error.message, code: error.code })
      else res.status(500).json({ error: '网关设置读写失败', code: 'internal_error' })
    }
  }
  app.get('/api/gateway/settings', handle(() => service.read()))
  app.put('/api/gateway/settings', handle(req => service.write(req.body)))
}

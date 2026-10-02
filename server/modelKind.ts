/**
 * 模型类型（对话 / 图片 / 视频 / 语音 / 向量 / 重排 / 其他），按**输出**分：能看图的对话模型仍是对话。
 *
 * 依据的优先级：
 * 1. 真实元数据里的输出模态（只读、0 次上游请求，都是 crosery-models-sync 已经写好的产物）：
 *    - 共享目录 `catalog.json`：`models[].output`（网关核实过的对话模型）与 `dropped[]` 里 `reason: image-only`；
 *    - 同目录下 `cache/public-catalog.json`（同一次同步缓存的 OpenRouter `architecture.output_modalities`
 *      与 models.dev `modalities.output`）。读不到 / 版本不认识就当没有，不报错。
 * 2. 保守的名字规则（下面的 NAME_RULES）兜底；什么都不像就是对话。
 *
 * 向量 / 重排 / 审核是**接口类型**，输出模态表达不了（models.dev 把 embedding 也写成 text），所以名字优先。
 * 输出里同时有 text 和图片/视频/音频（gemini-3.1-flash-image、openrouter/auto 都是这样）时，要名字也指向
 * 同一种媒体才算媒体模型，否则是会顺带出图的对话模型。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export type ModelKind = 'chat' | 'image' | 'video' | 'audio' | 'embedding' | 'rerank' | 'other'
export const MODEL_KINDS: readonly ModelKind[] = ['chat', 'image', 'video', 'audio', 'embedding', 'rerank', 'other']

/** 小写 id → 输出模态（多个来源取并集）。 */
export type ModalityIndex = Map<string, Set<string>>

const SEG = String.raw`(?:^|[/:~])`

/**
 * 先匹配先赢。`endpoint` = 接口类型（向量 / 重排 / 审核 / 语音转文字），输出模态表达不了，名字说了算；
 * 其余是媒体规则，元数据在时只用来区分「出图/出视频/出声的专门模型」和「顺带能出的对话模型」。
 */
const NAME_RULES: Array<{ kind: ModelKind; pattern: RegExp; endpoint?: true }> = [
  { kind: 'rerank', pattern: /rerank/, endpoint: true },
  { kind: 'embedding', pattern: /embed/, endpoint: true },
  { kind: 'other', pattern: /moderation/, endpoint: true },
  // 语音转文字（qwen3-asr-flash 的输出模态就是 text）
  { kind: 'audio', pattern: /(?:^|[-_/:~])asr(?:[-_.:\d]|$)|whisper|transcribe/, endpoint: true },
  { kind: 'video', pattern: new RegExp(String.raw`${SEG}(?:veo|sora)(?:[-\d.]|$)|${SEG}(?:kling|seedance|hailuo)|${SEG}wan[\w.-]*?(?:t2v|i2v|video)|video|(?:^|[-_])(?:t2v|i2v)(?:[-_]|$)`) },
  { kind: 'image', pattern: new RegExp(String.raw`${SEG}(?:gpt-image|chatgpt-image|dall-e|imagen|flux|seedream|nano-banana|stable-diffusion|sdxl|sd\d)|-image(?:[-.:\d]|$)|${SEG}image-\d`) },
  { kind: 'audio', pattern: new RegExp(String.raw`(?:^|[-_/:~])(?:tts|audio)(?:[-_.:\d]|$)|realtime|${SEG}lyria`) },
]
/** 只在元数据确认输出音频时才用的补充词：Gemini Live / live-translate 是实时语音接口。 */
const AUDIO_CONFIRM = /(?:^|[-_])live(?:[-_]|$)/
const MEDIA = ['video', 'image', 'audio'] as const

const normalizeName = (id: string) => String(id || '').trim().toLowerCase().replace(/\[1m\]$/, '')

const nameRule = (id: string) => {
  const name = normalizeName(id)
  return NAME_RULES.find((rule) => rule.pattern.test(name)) ?? null
}

/** 只看名字；没有任何信号返回 null（调用方当对话）。 */
export function kindFromName(id: string): ModelKind | null {
  return nameRule(id)?.kind ?? null
}

const normalizeModality = (value: string) => {
  const m = value.trim().toLowerCase()
  return m === 'embeddings' ? 'embedding' : m
}

/** 元数据（输出模态）优先、名字兜底的分类。 */
export function classifyModel(id: string, outputs?: Iterable<string> | null): ModelKind {
  const rule = nameRule(id)
  if (rule?.endpoint) return rule.kind
  const byName = rule?.kind ?? null
  const out = new Set([...(outputs ?? [])].filter((item): item is string => typeof item === 'string').map(normalizeModality))
  if (!out.size) return byName ?? 'chat'
  const text = out.has('text')
  for (const media of MEDIA) {
    if (!out.has(media)) continue
    if (!text || byName === media || (media === 'audio' && AUDIO_CONFIRM.test(normalizeName(id)))) return media
  }
  if (text) return 'chat'
  if (out.has('embedding')) return 'embedding'
  return 'other'
}

/* ── 元数据索引 ── */

const SUFFIX = /:(?:free|batch|beta|nitro|extended|thinking|floor|online|exacto)$/

/** `google/gemini-x` → `gemini-x`（与 normalizeModelForPricing 同义：只剥第一个 `/` 之前的前缀）。 */
const dropVendor = (key: string) => (key.includes('/') ? key.slice(key.indexOf('/') + 1) : key)
const baseKey = (id: string) => normalizeName(id).replace(/^~/, '')

function register(index: ModalityIndex, key: string, outputs: unknown) {
  if (!key || !Array.isArray(outputs)) return
  const values = outputs.filter((item): item is string => typeof item === 'string' && item.trim() !== '').map(normalizeModality)
  if (!values.length) return
  const current = index.get(key)
  if (current) for (const value of values) current.add(value)
  else index.set(key, new Set(values))
}

function registerId(index: ModalityIndex, id: string, outputs: unknown) {
  const key = baseKey(id)
  register(index, key, outputs)
  const bare = dropVendor(key)
  if (bare !== key) register(index, bare, outputs)
}

const object = (value: unknown): Record<string, unknown> => (value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {})

/**
 * 从两个已有产物建索引（纯函数，便于测试）：
 * - `catalog`：共享目录（`{ models: [{ id, output }], dropped: [{ id, reason }] }`）；
 * - `publicCatalog`：同步缓存（`{ version: 2, entries: [["openrouter:vendor/id" | "provider:id", { output }]] }`）。
 */
export function buildModalityIndex(catalog: unknown, publicCatalog?: unknown): ModalityIndex {
  const index: ModalityIndex = new Map()
  const shared = object(catalog)
  for (const model of Array.isArray(shared.models) ? shared.models : []) {
    const row = object(model)
    if (typeof row.id === 'string') registerId(index, row.id, row.output)
  }
  for (const dropped of Array.isArray(shared.dropped) ? shared.dropped : []) {
    const row = object(dropped)
    if (typeof row.id === 'string' && row.reason === 'image-only') registerId(index, row.id, ['image'])
  }
  const cache = object(publicCatalog)
  if (cache.version === 2) {
    const entries = Array.isArray(cache.entries) ? cache.entries : Object.entries(object(cache.entries))
    for (const entry of entries) {
      if (!Array.isArray(entry) || typeof entry[0] !== 'string') continue
      const key = entry[0].toLowerCase()
      const output = object(entry[1]).output
      const colon = key.indexOf(':')
      if (colon <= 0) continue
      const source = key.slice(0, colon)
      const rest = key.slice(colon + 1)
      // openrouter:<vendor>/<id>：网关上的 `vendor/id` 与裸 id 都能对上；
      // <provider>:<id>（models.dev）：价格目录里带前缀的 id 原样对上，裸 id 也登记
      if (source !== 'openrouter') register(index, key, output)
      registerId(index, rest, output)
    }
  }
  return index
}

/** 精确 id → 去 `vendor/` → 去 `:free` 一类后缀；第一个命中的为准。 */
export function lookupOutputs(index: ModalityIndex, id: string): Set<string> | null {
  const key = baseKey(id)
  const candidates = [key, dropVendor(key)]
  for (const candidate of [...candidates]) {
    const stripped = candidate.replace(SUFFIX, '')
    if (stripped !== candidate) candidates.push(stripped)
  }
  for (const candidate of candidates) {
    const hit = index.get(candidate)
    if (hit) return hit
  }
  return null
}

/* ── 磁盘上的产物（按 mtime 缓存，最多 10 秒复查一次） ── */

/** 与 `modelSync.sharedCatalogPath()` 同一解析；放在这里是为了本模块不牵出 db / cpa 的导入链。 */
export function sharedCatalogFile(): string {
  return process.env.CROSERY_SHARED_CATALOG || path.join(os.homedir(), '.agents/crosery/catalog.json')
}

/** 同步实现把公开目录缓存在共享目录旁的 `cache/public-catalog.json`。 */
export function publicCatalogFile(catalogFile = sharedCatalogFile()): string {
  return path.join(path.dirname(catalogFile), 'cache', 'public-catalog.json')
}

const RECHECK_MS = 10_000
let snapshot: { stamp: string; index: ModalityIndex; checkedAt: number } | null = null

const stampOf = (file: string) => {
  try {
    const stat = fs.statSync(file)
    return `${file}:${stat.mtimeMs}:${stat.size}`
  } catch {
    return `${file}:none`
  }
}
const readJson = (file: string): unknown => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

export function currentModalityIndex(now = Date.now()): ModalityIndex {
  if (snapshot && now - snapshot.checkedAt < RECHECK_MS) return snapshot.index
  const catalogFile = sharedCatalogFile()
  const cacheFile = publicCatalogFile(catalogFile)
  const stamp = `${stampOf(catalogFile)}|${stampOf(cacheFile)}`
  if (!snapshot || snapshot.stamp !== stamp) snapshot = { stamp, index: buildModalityIndex(readJson(catalogFile), readJson(cacheFile)), checkedAt: now }
  else snapshot.checkedAt = now
  return snapshot.index
}

/** 仅供测试：丢掉缓存的索引（改了 CROSERY_SHARED_CATALOG 之后立即生效）。 */
export function resetModelKindCache(): void {
  snapshot = null
}

/** 一个 id 的类型（用磁盘上的元数据；拿不到就只看名字）。 */
export function modelKind(id: string): ModelKind {
  return classifyModel(id, lookupOutputs(currentModalityIndex(), id))
}

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  buildModalityIndex, classifyModel, kindFromName, lookupOutputs, modelKind, publicCatalogFile, resetModelKindCache, type ModelKind,
} from './modelKind.js'

/*
 * 模型类型按**输出**分（看图的对话模型仍是对话）。下面的 id 与输出模态取自本机 2026-10-02 的共享目录
 * `~/.agents/crosery/catalog.json` 和同步缓存 `cache/public-catalog.json`（原样摘录，不是编的）。
 */
const CATALOG = {
  version: 1,
  models: [
    { id: 'gemini-3.1-flash-image', input: ['text', 'image'], output: ['text', 'image'] },
    { id: 'gemini-3.8-flash', input: ['text', 'image'], output: ['text'] },
    { id: 'gpt-6-sol', input: ['text', 'image'], output: ['text'] },
    { id: 'claude-opus-5-5', input: ['text', 'image'], output: ['text'] },
    { id: 'qwen3.8-max', input: ['text', 'image'], output: ['text'] },
    { id: 'google/lyria-3-clip-preview', input: ['text', 'image'], output: ['text', 'audio'] },
    { id: 'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free', input: ['text', 'image'], output: ['text'] },
  ],
  dropped: [
    { id: 'gpt-image-2.5', reason: 'image-only' },
    { id: 'gpt-image-2.5-flare', reason: 'image-only' },
    { id: 'gpt-image-1.5', reason: 'image-only' },
  ],
}
const PUBLIC = {
  version: 2,
  entries: [
    ['openrouter:openrouter/auto', { input: ['text', 'image'], output: ['text', 'image'] }],
    ['openrouter:openai/gpt-5.4-image-2', { input: ['image', 'text'], output: ['image', 'text'] }],
    ['openrouter:openai/gpt-audio', { input: ['text'], output: ['text', 'audio'] }],
    ['openrouter:qwen/qwen3-vl-235b-a22b-instruct', { input: ['text', 'image'], output: ['text'] }],
    ['openrouter:deepseek/deepseek-v4-flash-vision-exp', { input: ['text', 'image'], output: ['text'] }],
    ['openrouter:google/gemma-4-31b-it:free', { input: ['image', 'text'], output: ['text'] }],
    ['google:veo-3.1-generate-preview', { input: ['text', 'image'], output: ['video'] }],
    ['google:gemini-omni-flash-preview', { input: ['text', 'image'], output: ['video'] }],
    ['google:gemini-2.5-flash-preview-tts', { input: ['text'], output: ['audio'] }],
    ['google:gemini-3.1-flash-live-preview', { input: ['text', 'image'], output: ['text', 'audio'] }],
    ['google:gemini-embedding-001', { input: ['text'], output: ['text'] }],
    ['google:deep-research-preview-04-2026', { input: ['text', 'image'], output: ['text', 'image'] }],
    ['openai:gpt-image-2', { input: ['text', 'image'], output: ['image'] }],
    ['openai:gpt-realtime-2.1', { input: ['text', 'image'], output: ['text', 'audio'] }],
    ['openai:text-embedding-3-large', { input: ['text'], output: ['text'] }],
    ['alibaba:qwen3-asr-flash', { output: ['text'] }],
    ['alibaba:qwen3-omni-flash', { input: ['text', 'image'], output: ['text', 'audio'] }],
  ],
}

const index = buildModalityIndex(CATALOG, PUBLIC)
const kindOf = (id: string) => classifyModel(id, lookupOutputs(index, id))

test('真实 id × 真实输出模态：按输出分，对话模型会看图也还是对话', () => {
  const table: Array<[string, ModelKind]> = [
    ['gemini-3.1-flash-image', 'image'], // 输出 text+image，名字也是出图模型
    ['google/gemini-3.1-flash-image', 'image'], // 网关上带厂商前缀的同一个模型
    ['gemini-3.8-flash', 'chat'],
    ['gpt-6-sol', 'chat'],
    ['claude-opus-5-5', 'chat'],
    ['qwen3.8-max', 'chat'],
    ['nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free', 'chat'],
    ['qwen/qwen3-vl-235b-a22b-instruct', 'chat'], // 视觉模型：输入图、输出文字
    ['deepseek/deepseek-v4-flash-vision-exp', 'chat'],
    ['google/gemma-4-31b-it:free', 'chat'],
    ['gpt-image-2.5', 'image'], // 共享目录 dropped: image-only
    ['gpt-image-2.5-flare', 'image'],
    ['openai:gpt-image-2', 'image'], // 价格目录里带 provider 前缀的 id
    ['gpt-image-2', 'image'],
    ['openai/gpt-5.4-image-2', 'image'],
    ['google:veo-3.1-generate-preview', 'video'],
    ['veo-3.1-generate-preview', 'video'],
    ['google:gemini-omni-flash-preview', 'video'], // 名字看不出，元数据只出视频
    ['google:gemini-2.5-flash-preview-tts', 'audio'],
    ['google:gemini-3.1-flash-live-preview', 'audio'], // Live：元数据确认出声 + live
    ['openai/gpt-audio', 'audio'],
    ['openai:gpt-realtime-2.1', 'audio'],
    ['google/lyria-3-clip-preview', 'audio'],
    ['alibaba:qwen3-asr-flash', 'audio'], // 语音转文字：输出就是 text，名字说了算
    ['alibaba:qwen3-omni-flash', 'chat'], // 全模态对话模型：顺带出声，不是语音专用
    ['openrouter/auto', 'chat'], // 路由器：输出含 image 但名字不是出图模型
    ['google:deep-research-preview-04-2026', 'chat'],
    ['openai:text-embedding-3-large', 'embedding'], // models.dev 把向量的输出写成 text
    ['google:gemini-embedding-001', 'embedding'],
  ]
  for (const [id, kind] of table) assert.equal(kindOf(id), kind, id)
})

test('没有元数据时只看名字：保守，只认明确的出图 / 视频 / 语音 / 向量 / 重排名字', () => {
  const table: Array<[string, ModelKind]> = [
    ['sora-2', 'video'], ['veo3.1-fast', 'video'], ['kling-v2.1-master', 'video'], ['seedance-1.0-pro', 'video'],
    ['wan2.5-t2v-preview', 'video'], ['wan-2.2-video', 'video'], ['hailuo-02', 'video'], ['minimax/video-01', 'video'],
    ['gpt-image-2.5-sunburst', 'image'], ['dall-e-3', 'image'], ['imagen-4.0-generate-001', 'image'], ['flux-kontext-pro', 'image'],
    ['black-forest-labs/flux.2-pro', 'image'], ['seedream-4.0', 'image'], ['nano-banana', 'image'], ['sd3.5-large', 'image'],
    ['qwen-image-edit', 'image'],
    ['tts-1-hd', 'audio'], ['gpt-4o-mini-tts', 'audio'], ['whisper-1', 'audio'], ['gpt-4o-transcribe', 'audio'], ['gpt-realtime', 'audio'],
    ['text-embedding-3-small', 'embedding'], ['jina-embeddings-v3', 'embedding'],
    ['bge-reranker-v2-m3', 'rerank'], ['rerank-2.5', 'rerank'],
    ['omni-moderation-latest', 'other'],
    // 不该被名字规则误伤的对话模型（本机渠道里的真实 id）
    ['mistralai/voxtral-small-24b-2507', 'chat'], ['qwen/qwen3.8-omni-flash', 'chat'], ['z-ai/glm-5v-turbo', 'chat'],
    ['inclusionai/ling-3.0-flash-vl', 'chat'], ['openai/gpt-5.6-sol:batch', 'chat'], ['~google/gemini-flash-latest', 'chat'],
    ['tencent/hy-mt2-7b', 'chat'], ['sakana/sakana-namazu', 'chat'], ['gpt-6-astra[1m]', 'chat'],
  ]
  for (const [id, kind] of table) assert.equal(classifyModel(id, null), kind, id)
  assert.equal(kindFromName('gemini-3.8-flash'), null)
})

test('元数据优先：输出只有文字就是对话（名字像也不算）；只有媒体输出就是媒体（名字不像也算）', () => {
  assert.equal(classifyModel('acme-image-chat', ['text']), 'chat')
  assert.equal(classifyModel('acme-studio', ['image']), 'image')
  assert.equal(classifyModel('acme-studio', ['video', 'text']), 'chat')
  assert.equal(classifyModel('acme-video', ['video', 'text']), 'video')
  assert.equal(classifyModel('acme-studio', ['embeddings']), 'embedding')
  assert.equal(classifyModel('acme-studio', ['pdf']), 'other')
  assert.equal(classifyModel('acme-studio', []), 'chat', '空模态 = 没有元数据')
})

test('查表：精确 id → 去厂商前缀 → 去 :free / :batch 后缀；~ 别名与 [1m] 也能对上', () => {
  assert.deepEqual([...(lookupOutputs(index, 'google/gemini-3.1-flash-image') ?? [])].sort(), ['image', 'text'])
  assert.deepEqual([...(lookupOutputs(index, 'gpt-image-2.5:batch') ?? [])], ['image'])
  assert.deepEqual([...(lookupOutputs(index, 'GPT-IMAGE-2.5') ?? [])], ['image'])
  assert.ok(lookupOutputs(index, '~openai/gpt-audio'))
  assert.ok(lookupOutputs(index, 'gemini-3.8-flash[1m]'))
  assert.equal(lookupOutputs(index, 'no-such-model'), null)
  // 不认识的缓存版本整份忽略，不猜格式
  assert.equal(buildModalityIndex(null, { version: 3, entries: PUBLIC.entries }).size, 0)
  assert.equal(buildModalityIndex({ models: 'oops', dropped: [{ id: 'x', reason: 'non-chat' }] }, null).size, 0)
})

test('从磁盘读共享目录 + 同步缓存（CROSERY_SHARED_CATALOG 决定位置）；读不到只看名字', () => {
  const previous = process.env.CROSERY_SHARED_CATALOG
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'model-kind-'))
  const file = path.join(dir, 'catalog.json')
  try {
    process.env.CROSERY_SHARED_CATALOG = file
    resetModelKindCache()
    // 什么都没有：名字兜底
    assert.equal(modelKind('google:veo-3.1-generate-preview'), 'video')
    assert.equal(modelKind('google:gemini-omni-flash-preview'), 'chat')
    fs.writeFileSync(file, JSON.stringify(CATALOG))
    fs.mkdirSync(path.dirname(publicCatalogFile(file)), { recursive: true })
    fs.writeFileSync(publicCatalogFile(file), JSON.stringify(PUBLIC))
    assert.equal(publicCatalogFile(file), path.join(dir, 'cache', 'public-catalog.json'))
    resetModelKindCache()
    assert.equal(modelKind('google:gemini-omni-flash-preview'), 'video')
    assert.equal(modelKind('gemini-3.1-flash-image'), 'image')
    assert.equal(modelKind('alibaba:qwen3-omni-flash'), 'chat')
    // 坏 JSON 不抛错
    fs.writeFileSync(publicCatalogFile(file), '{oops')
    resetModelKindCache()
    assert.equal(modelKind('google:gemini-omni-flash-preview'), 'chat')
    assert.equal(modelKind('gpt-image-2.5'), 'image')
  } finally {
    if (previous === undefined) delete process.env.CROSERY_SHARED_CATALOG
    else process.env.CROSERY_SHARED_CATALOG = previous
    resetModelKindCache()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

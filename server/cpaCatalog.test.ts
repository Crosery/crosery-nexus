import './testDataDir.js'

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { dataDirJsonFile } from './config.js'
import {
  DEFAULT_SUPPLEMENT_FILE, REQUIRED_SECTIONS, diffCatalog, guardCatalog, mergeSupplement, runCpaCatalogSync, validateCpaCatalog, validateSupplement,
  type CatalogDoc, type CatalogFetch,
} from './cpaCatalog.js'
import { testDataDir } from './testDataDir.js'

const model = (id: string, extra: Record<string, unknown> = {}) => ({ id, object: 'model', created: 1, owned_by: 'vendor', type: 'x', ...extra })
const catalog = (sizes: Partial<Record<string, number>> = {}): CatalogDoc =>
  Object.fromEntries(REQUIRED_SECTIONS.map(section => [section, Array.from({ length: sizes[section] ?? 2 }, (_, index) => model(`${section}-${index}`))]))
const ids = (doc: CatalogDoc, section: string) => (doc[section] as Array<{ id: string }>).map(entry => entry.id)

test('校验与 CPA 一致：类型能解码、必需段无 null / 空 id / 重复 id；空段与未知字段放行', () => {
  assert.equal(validateCpaCatalog(catalog()), null)
  assert.equal(validateCpaCatalog({ ...catalog(), claude: [], 'gemini-cli': 'ignored', devin: [{ display_name: 'no id is fine here' }] }), null)
  assert.equal(validateCpaCatalog({ ...catalog(), claude: [model('a', { unknown_field: { any: 'thing' }, cost: null })] }), null)
  const bad: Array<[unknown, RegExp]> = [
    [[], /顶层/],
    [null, /顶层/],
    [{ ...catalog(), claude: {} }, /claude 应为数组/],
    [{ ...catalog(), claude: [null] }, /claude\[0\] 为 null/],
    [{ ...catalog(), gemini: [model('')] }, /gemini\[0\] 缺少 id/],
    [{ ...catalog(), gemini: [model('   ')] }, /缺少 id/],
    [{ ...catalog(), kimi: [model('k'), model(' k ')] }, /kimi 有重复的模型 id "k"/],
    [{ ...catalog(), xai: [model('x', { context_length: 1.5 })] }, /context_length 应为整数/],
    [{ ...catalog(), xai: [model('x', { display_name: 3 })] }, /display_name 应为字符串/],
    [{ ...catalog(), xai: [model('x', { thinking: { levels: 'high' } })] }, /levels 应为字符串数组/],
    [{ ...catalog(), xai: [model('x', { cost: { tiers: [{ min_context_tokens: '200k' }] } })] }, /min_context_tokens 应为整数/],
    [{ ...catalog(), xai: [model('x', { config: { override_header: { 'user-agent': 1 } } })] }, /override_header.user-agent 应为字符串/],
    // Go 按大小写不敏感匹配字段：ID 也会被解码进 id
    [{ ...catalog(), meta: [{ ID: 5 }] }, /ID 应为字符串/],
  ]
  for (const [doc, pattern] of bad) assert.match(validateCpaCatalog(doc) ?? '', pattern)
})

test('仓库补充目录本身有效，且带着补丁 0005 内置的两个 Claude 定义', () => {
  const supplement = JSON.parse(fs.readFileSync(DEFAULT_SUPPLEMENT_FILE, 'utf8')) as CatalogDoc
  assert.equal(validateSupplement(supplement), null)
  assert.deepEqual(ids(supplement, 'claude'), ['claude-fable-5-1', 'claude-opus-5-5'])
  const [fable, opus] = supplement.claude as Array<Record<string, any>>
  assert.deepEqual([fable.context_length, fable.max_completion_tokens, fable.thinking.min, fable.thinking.max], [1_000_000, 128_000, 1024, 128_000])
  assert.deepEqual([opus.thinking.dynamic_allowed, opus.thinking.min, opus.thinking.levels.join(',')], [true, undefined, 'low,medium,high,xhigh,max'])
  assert.match(validateSupplement({ Claude: [] }) ?? '', /未知段：Claude/)
  assert.match(validateSupplement({ devin: [{ display_name: 'x' }] }) ?? '', /缺少 id/)
  assert.match(validateSupplement({ claude: [model('A'), model('a')] }) ?? '', /重复/)
})

test('合并：官方没有的补充模型追加到段尾，新段照建，其余段与未知段原样', () => {
  const official: CatalogDoc = { ...catalog(), claude: [model('claude-a'), model('claude-b')], 'gemini-cli': [model('cli')] }
  const { doc: merged, redundant } = mergeSupplement(official, { claude: [model('claude-new')], devin: [model('devin/x')] })
  assert.deepEqual(ids(merged, 'claude'), ['claude-a', 'claude-b', 'claude-new'])
  assert.deepEqual(ids(merged, 'devin'), ['devin/x'])
  assert.deepEqual(redundant, [])
  assert.deepEqual(merged.gemini, official.gemini)
  assert.deepEqual(merged['gemini-cli'], official['gemini-cli'])
  assert.deepEqual(ids(official, 'claude'), ['claude-a', 'claude-b'], '不改输入')
  assert.equal(JSON.stringify(mergeSupplement(official, { claude: [model('claude-new')] })), JSON.stringify(mergeSupplement(official, { claude: [model('claude-new')] })))
})

test('合并：补充 id 已被官方收录（大小写不敏感）时官方条目逐字节不变，id 记进 redundant', () => {
  const opus = model('Claude-Opus-5-5', { native_capabilities: { web_search: true }, description: 'upstream' })
  const official: CatalogDoc = { ...catalog(), claude: [model('claude-a'), opus, model('claude-b')] }
  const { doc: merged, redundant } = mergeSupplement(official, { claude: [model('claude-opus-5-5', { description: 'pinned' }), model('claude-new')] })
  assert.deepEqual(ids(merged, 'claude'), ['claude-a', 'Claude-Opus-5-5', 'claude-b', 'claude-new'])
  assert.equal(JSON.stringify((merged.claude as unknown[])[1]), JSON.stringify(opus))
  assert.deepEqual(redundant, ['claude-opus-5-5'])
})

test('保护规则：必需段为空、任一段比上次少一半以上都拦；正好一半放行；首次写入只查空段', () => {
  assert.deepEqual(guardCatalog(catalog(), null), [])
  assert.deepEqual(guardCatalog({ ...catalog(), meta: [] }, null), ['meta 段为空'])
  const next = catalog({ claude: 2, gemini: 2, kimi: 1 })
  assert.deepEqual(guardCatalog(next, { claude: 4, gemini: 5, kimi: 2, 'gemini-cli': 7 }), [
    'gemini 模型数 5 → 2，减少超过一半',
    'gemini-cli 模型数 7 → 0，减少超过一半',
  ])
})

test('差异：逐段列出新增、移除与定义变化', () => {
  const before: CatalogDoc = { claude: [model('a'), model('b'), model('c')], gemini: [model('g')] }
  const after: CatalogDoc = { claude: [model('a'), model('b', { display_name: 'B' }), model('d')], gemini: [model('g')], meta: [model('m')] }
  assert.deepEqual(diffCatalog(before, after), {
    claude: { added: ['d'], removed: ['c'], changed: ['b'] },
    meta: { added: ['m'], removed: [], changed: [] },
  })
})

/* ────────────────────────── 任务 ────────────────────────── */

const URLS = ['https://primary.example.test/models.json', 'https://fallback.example.test/models.json']

function stubFetch(routes: Record<string, () => Response | Promise<Response>>) {
  const calls: string[] = []
  const fetchImpl: CatalogFetch = async (url) => {
    calls.push(url)
    const route = routes[url]
    if (!route) throw new Error(`unexpected ${url}`)
    return route()
  }
  return { fetchImpl, calls }
}

const json = (doc: unknown) => () => new Response(JSON.stringify(doc), { status: 200, headers: { 'content-type': 'application/json' } })

function setup(name: string) {
  const dir = fs.mkdtempSync(path.join(testDataDir, `${name}-`))
  const supplementFile = path.join(dir, 'supplement.json')
  fs.writeFileSync(supplementFile, JSON.stringify({ claude: [model('claude-extra'), model('CLAUDE-0', { display_name: 'pinned' })] }))
  const audits: string[] = []
  const data: Record<string, unknown> = {}
  let clock = Date.parse('2026-10-09T00:00:00Z')
  const file = path.join(dir, 'cpa', 'models.json')
  const historyFile = path.join(dir, 'cpa-catalog-history.jsonl')
  const run = (fetchImpl: CatalogFetch) => {
    clock += 3 * 60 * 60_000
    return runCpaCatalogSync({ file, historyFile, data, supplementFile, urls: URLS, fetch: fetchImpl, now: () => clock, audit: (action, target, detail) => audits.push(`${action}:${target}:${detail}`) })
  }
  const history = () => (fs.existsSync(historyFile) ? fs.readFileSync(historyFile, 'utf8').trim().split('\n').map(line => JSON.parse(line) as Record<string, any>) : [])
  return { dir, file, supplementFile, data, audits, run, history }
}

test('首次运行：主地址失败回落到备用地址，写入官方 ∪ 补充（0644），记变更历史与审计', async () => {
  const env = setup('first')
  const { fetchImpl, calls } = stubFetch({ [URLS[0]]: () => new Response('boom', { status: 503 }), [URLS[1]]: json(catalog()) })
  const outcome = await env.run(fetchImpl)
  assert.equal(outcome.result, 'ok')
  assert.equal(outcome.summary, '已更新 +25 · 25 模型 · 补充已被官方收录：CLAUDE-0')
  assert.deepEqual(calls, URLS)
  const written = JSON.parse(fs.readFileSync(env.file, 'utf8')) as CatalogDoc
  assert.deepEqual(ids(written, 'claude'), ['claude-0', 'claude-1', 'claude-extra'])
  assert.deepEqual((written.claude as Array<Record<string, unknown>>)[0], model('claude-0'), '官方条目不被补充覆盖')
  assert.equal(validateCpaCatalog(written), null)
  assert.equal(fs.statSync(env.file).mode & 0o777, 0o644)
  assert.equal(fs.existsSync(`${env.file}.prev`), false)
  const [record] = env.history()
  assert.equal(record.type, 'write')
  assert.equal(record.source, URLS[1])
  assert.deepEqual(record.sections.claude.added, ['claude-0', 'claude-1', 'claude-extra'])
  assert.equal(record.counts.claude, 3)
  assert.deepEqual(record.redundant, ['CLAUDE-0'])
  assert.match(env.audits[0], /^cpa_catalog_update:models\.json:\+25 · 来源 fallback\.example\.test$/)
  assert.ok(typeof env.data.lastWrittenAt === 'number')
})

test('内容未变不重写、不记历史；上游变化时重写并把旧版本留成 .prev', async () => {
  const env = setup('change')
  await env.run(stubFetch({ [URLS[0]]: json(catalog()) }).fetchImpl)
  const firstText = fs.readFileSync(env.file, 'utf8')
  const firstMtime = fs.statSync(env.file).mtimeMs

  const same = await env.run(stubFetch({ [URLS[0]]: json(catalog()) }).fetchImpl)
  assert.equal(same.result, 'ok')
  assert.equal(same.summary, '无变化 · 25 模型 · 上次变更 2026-10-09 03:00Z +25 · 补充已被官方收录：CLAUDE-0')
  assert.equal(fs.statSync(env.file).mtimeMs, firstMtime)
  assert.equal(env.history().length, 1)

  const grown = catalog()
  ;(grown.gemini as unknown[]).push(model('gemini-new'))
  ;(grown.kimi as unknown[]).splice(1, 1)
  const changed = await env.run(stubFetch({ [URLS[0]]: json(grown) }).fetchImpl)
  assert.match(changed.summary ?? '', /^已更新 \+1 −1 · 25 模型 · /)
  assert.equal(fs.readFileSync(`${env.file}.prev`, 'utf8'), firstText)
  assert.deepEqual(env.history()[1].sections, { gemini: { added: ['gemini-new'], removed: [], changed: [] }, kimi: { added: [], removed: ['kimi-1'], changed: [] } })
  assert.equal(fs.readdirSync(path.dirname(env.file)).filter(name => name.endsWith('.tmp')).length, 0, '没有残留临时文件')
})

test('拦截：某段骤降过半 / 必需段为空 / 两个地址都失败 / 补充目录无效时旧文件原样保留并告警', async () => {
  const env = setup('guard')
  await env.run(stubFetch({ [URLS[0]]: json(catalog({ claude: 4 })) }).fetchImpl)
  const kept = fs.readFileSync(env.file, 'utf8')
  const keptAt = env.data.lastWrittenAt

  const shrunk = await env.run(stubFetch({ [URLS[0]]: json(catalog({ claude: 1 })) }).fetchImpl)
  assert.equal(shrunk.result, 'error')
  // 补充目录给 claude 补回 1 个：5 → 2 仍然少于一半
  assert.match(shrunk.error ?? '', /保护规则拦截：claude 模型数 5 → 2，减少超过一半；保留 2026-10-09 03:00Z 写入的目录/)
  assert.match(shrunk.summary ?? '', /保留 .* · 上次成功 2026-10-09 03:00Z/)

  const empty = await env.run(stubFetch({ [URLS[0]]: json({ ...catalog({ claude: 4 }), meta: [] }) }).fetchImpl)
  assert.match(empty.error ?? '', /meta 段为空/)

  const down = await env.run(stubFetch({ [URLS[0]]: () => { throw new Error('connect ECONNREFUSED') }, [URLS[1]]: () => new Response('{not json', { status: 200 }) }).fetchImpl)
  assert.match(down.error ?? '', /^官方目录拉取失败：primary\.example\.test connect ECONNREFUSED；fallback\.example\.test /)

  fs.writeFileSync(env.supplementFile, JSON.stringify({ claude: [model('dup'), model('DUP')] }))
  const { fetchImpl, calls } = stubFetch({ [URLS[0]]: json(catalog({ claude: 4 })) })
  const badSupplement = await env.run(fetchImpl)
  assert.match(badSupplement.error ?? '', /补充目录 claude 有重复的模型 id/)
  assert.deepEqual(calls, [], '补充目录无效时不打上游')

  assert.equal(fs.readFileSync(env.file, 'utf8'), kept)
  assert.equal(env.data.lastWrittenAt, keptAt)
  const alarms = env.history().filter(record => record.type === 'alarm')
  assert.equal(alarms.length, 4)
  assert.equal(alarms[0].source, URLS[0])
  assert.match(String((env.data.lastAlarm as { message: string }).message), /补充目录/)
})

test('拉取：CPA 不接受的目录（重复 id）与超过 8 MiB 的响应都跳到下一个地址', async () => {
  const env = setup('fallback')
  const invalid = { ...catalog(), claude: [model('x'), model('x')] }
  const huge = () => new Response('{}', { status: 200, headers: { 'content-length': String(9 << 20) } })
  const first = await env.run(stubFetch({ [URLS[0]]: json(invalid), [URLS[1]]: json(catalog()) }).fetchImpl)
  assert.equal(first.result, 'ok')
  assert.equal(env.history()[0].source, URLS[1])
  const second = await env.run(stubFetch({ [URLS[0]]: huge, [URLS[1]]: huge }).fetchImpl)
  assert.match(second.error ?? '', /primary\.example\.test 超过 8 MiB/)
})

test('CPA_MODELS_CATALOG_FILE 只接受 DATA_DIR 下的 .json 绝对路径', () => {
  const root = path.join(testDataDir, 'data-root')
  assert.equal(dataDirJsonFile('X', '', root), '')
  assert.equal(dataDirJsonFile('X', path.join(root, 'cpa/models.json'), root), path.join(root, 'cpa/models.json'))
  for (const value of ['cpa/models.json', path.join(root, '../elsewhere/models.json'), path.join(root, 'models.yaml'), `${root}-sibling/models.json`, '/etc/models.json']) {
    assert.throws(() => dataDirJsonFile('X', value, root), /DATA_DIR/, value)
  }
})

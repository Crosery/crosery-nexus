import assert from 'node:assert/strict'
import test from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { classifyClient, clientLabel, clientTypeSql, clientVersion, resolveClientIp } from './clientAgent.js'

/**
 * 用例全部取自生产 nginx access.log 里出现过的真实 UA，
 * 不是构造的样本。分类规则一旦漂移，这里会直接失败。
 */
const PRODUCTION_AGENTS: Array<[string, string]> = [
  ['claude-cli/2.1.250 (external, cli)', 'claude-code'],
  ['pi (darwin 24.6.0; arm64)', 'pi'],
  ['omp/18.1.14', 'omp'],
  ['omp/18.1.15', 'omp'],
  ['undici', 'script'],
  ['curl/8.5.0', 'script'],
  ['cc-switch/1.0', 'cc-switch'],
  ['Python-urllib/3.13', 'script'],
  ['cli-proxy-openai-compat', 'cpa-internal'],
  ['ibuki/0.1.0-rc.5 (+https://github.com/ibuki/ibuki)', 'ibuki'],
  ['ai/6.0.185 ai-sdk/provider-utils/4.0.40 runtime/node.js/24', 'vercel-ai-sdk'],
  ['Go-http-client/2.0', 'script'],
  ['node', 'script'],
  ['Codex Desktop/0.150.0-alpha.8 (Mac OS 15.7.5; arm64) unknown (Codex Desktop; 26.820.60940)', 'codex-desktop'],
  ['axios/1.16.1', 'script'],
  ['Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36', 'browser'],
]

test('every production user agent maps to a concrete client, never the catch-all', () => {
  for (const [agent, expected] of PRODUCTION_AGENTS) {
    assert.equal(classifyClient(agent), expected, `期望 ${agent} 归类为 ${expected}`)
  }
})

test('explicit Honeypot user agents stay separate from DSH and Ibuki', () => {
  assert.equal(classifyClient('deepseek-honeypot/1.0'), 'deepseek-honeypot')
  assert.equal(classifyClient('agent-honeypot/1.0'), 'agent-honeypot')
  assert.equal(classifyClient('deepseek-harness/0.1.1'), 'deepseek-harness')
  assert.equal(classifyClient('ibuki/0.1.0'), 'ibuki')
})

test('missing user agent stays unknown instead of being counted as a real client', () => {
  // nginx 对缺失 UA 写字面量 `-`，当成真实客户端会凭空多出一个调用方。
  assert.equal(classifyClient(''), 'unknown')
  assert.equal(classifyClient('   '), 'unknown')
  assert.equal(classifyClient('-'), 'unknown')
})

test('product clients win over the SDK they are built on', () => {
  // Claude Code 内部就是 Anthropic SDK；先匹配 SDK 会把两者混成一类。
  assert.equal(classifyClient('claude-cli/2.1.250 anthropic-sdk-python/0.39'), 'claude-code')
  assert.equal(classifyClient('Codex CLI/1.2 openai-python/1.55'), 'codex-cli')
})

test('unrecognized agents fall back to other and keep the raw string for triage', () => {
  assert.equal(classifyClient('some-internal-tool/9'), 'other')
  assert.equal(clientLabel('other'), '其他')
})

test('version is extracted for triage but kept out of the grouping key', () => {
  assert.equal(clientVersion('claude-cli/2.1.250 (external, cli)'), '2.1.250')
  // 无斜杠版本号的 UA 不能瞎猜版本
  assert.equal(clientVersion('pi (darwin 24.6.0; arm64)'), '')
})

test('forwarded address wins only when the direct peer is the local proxy', () => {
  // 经 nginx 后 client_ip 恒为回环，真实来源只在 XFF 里
  assert.equal(resolveClientIp('127.0.0.1', '117.136.38.183'), '117.136.38.183')
  assert.equal(resolveClientIp('::1', '203.0.113.9, 10.0.0.1'), '203.0.113.9')
  // 直连时不能被客户端伪造的 XFF 顶掉真实对端
  assert.equal(resolveClientIp('203.0.113.7', '1.2.3.4'), '203.0.113.7')
  assert.equal(resolveClientIp('', ''), '')
})

/**
 * 第二批生产 UA：从全部轮转日志里取出的真实调用方。
 * codex-tui 是 Codex 的主要形态（7805 次），早期只写 `^codex/\d` 会把它整段漏成 other。
 */
const ROTATED_LOG_AGENTS: Array<[string, string]> = [
  ['deepseek-harness/0.1.1-rc.2 (+https://github.com/deepseek-ai/deepseek-harness)', 'deepseek-harness'],
  ['codex-tui/0.149.1 (Mac OS 15.7.5; arm64) Orca/1.4.143-rc.0.xq.3 (codex-tui; 0.149.1)', 'codex-cli'],
  ['codex-tui/0.149.1 (Mac OS 15.7.5; arm64) ghostty/1.3.1 (codex-tui; 0.149.1)', 'codex-cli'],
  ['codex_exec/0.148.0 (Mac OS 15.7.5; arm64) ghostty/1.3.1 (codex_exec; 0.148.0)', 'codex-cli'],
  ['codex_cli_rs/0.148.0 (Mac OS 15.7.5; arm64) ghostty/1.3.1', 'codex-cli'],
  ['codex_vscode/0.150.0-alpha.8 (Windows 10.0.26200; x86_64) unknown (VS Code; 26.820.71523)', 'codex-vscode'],
  ['Codex Desktop/0.149.0-alpha.4.1 (Mac OS 15.7.5; arm64) unknown (Codex Desktop; 26.818.41509)', 'codex-desktop'],
  ['grpc-go/1.80.0', 'script'],
  ['python-httpx/0.28.1', 'script'],
]

test('rotated-log user agents including DSH and codex-tui classify correctly', () => {
  for (const [agent, expected] of ROTATED_LOG_AGENTS) {
    assert.equal(classifyClient(agent), expected, `期望 ${agent} 归类为 ${expected}`)
  }
})

test('embedded host program never steals the codex classification', () => {
  // Orca / ghostty / VS Code 只是宿主终端，不能盖过真正的调用方
  assert.equal(classifyClient('codex-tui/0.149.1 (Mac OS) Orca/1.4.143'), 'codex-cli')
  assert.notEqual(classifyClient('codex-tui/0.149.1 (Mac OS) Orca/1.4.143'), 'other')
})

test('official OpenAI JS SDK is recognized despite the space-separated UA', () => {
  // `OpenAI/JS 6.40.0` 不是 `openai/<数字>`，实测占生产总请求量约 13.8%，
  // 漏掉它会让最大的一类调用方全部掉进「其他」。
  assert.equal(classifyClient('OpenAI/JS 6.40.0'), 'openai-sdk')
  assert.equal(classifyClient('OpenAI/Python 1.55.0'), 'openai-sdk')
  assert.equal(classifyClient('Anthropic/JS 0.30.1'), 'anthropic-sdk')
})

test('AGY CLI is recognized from its real Google SDK user agent only on the AntiGravity provider', () => {
  const agent = 'google-genai-sdk/1.69.0 gl-go/go1.28-20260721-RC01 cl/951519500 +3ebc191975 X:fieldtrack,boringcrypto,simd,mapsplitgroup'
  assert.equal(classifyClient(agent, { provider: 'antigravity' }), 'antigravity-cli')
  // google-genai-sdk 也可能被普通 Gemini 集成使用，缺少 provider 证据时不能猜成 AGY。
  assert.equal(classifyClient(agent), 'other')
})

test('historical AntiGravity rows are reclassified at read time without rewriting production data', () => {
  const database = new DatabaseSync(':memory:')
  database.exec('CREATE TABLE usage_events (provider TEXT, user_agent TEXT, client_type TEXT)')
  const insert = database.prepare('INSERT INTO usage_events VALUES (?, ?, ?)')
  insert.run('antigravity', 'google-genai-sdk/1.69.0 gl-go/go1.28', 'other')
  insert.run('codex', 'google-genai-sdk/1.69.0 gl-go/go1.28', 'other')
  insert.run('antigravity', 'curl/8.5.0', 'script')

  const rows = database.prepare(`SELECT ${clientTypeSql()} type, COUNT(*) count FROM usage_events GROUP BY type ORDER BY type`).all()
    .map((row) => ({ type: String(row.type), count: Number(row.count) }))
  assert.deepEqual(rows, [
    { type: 'antigravity-cli', count: 1 },
    { type: 'other', count: 1 },
    { type: 'script', count: 1 },
  ])
})


test('OMP boundaries agree between ingestion and historical reads without mutating stored types', () => {
  const database = new DatabaseSync(':memory:')
  try {
    database.exec('CREATE TABLE usage_events (provider TEXT, user_agent TEXT, client_type TEXT)')
    const samples: Array<[string, string]> = [
      ['omp/18.1.14', 'omp'],
      [' OMP/18.1.15 OpenAI/JS 6.40.0 ', 'omp'],
      ['pi (darwin 24.6.0; arm64)', 'pi'],
      ['pi/18.1.15', 'pi'],
      ['xomp/18.1.15', 'other'],
      ['omp/not-a-version', 'other'],
      ['omp/', 'other'],
      ['tool omp/18.1.15', 'other'],
      ['', 'unknown'],
    ]
    const insert = database.prepare('INSERT INTO usage_events VALUES (?, ?, ?)')
    for (const [ua, expected] of samples) {
      assert.equal(classifyClient(ua), expected, ua)
      insert.run('codex', ua, expected === 'omp' ? 'other' : expected)
    }
    const types = database.prepare(`SELECT ${clientTypeSql('u')} type FROM usage_events u ORDER BY rowid`).all()
    assert.deepEqual(types.map((row) => row.type), samples.map(([, expected]) => expected))
    assert.equal(database.prepare("SELECT COUNT(*) count FROM usage_events WHERE client_type = 'other'").get()?.count, 6)
  } finally {
    database.close()
  }
})

import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { createServer } from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'

import { hashKey } from './cpa.js'

/**
 * task-73：`/v1/*` 自助面的三条保证
 *
 * ① **跨 Key 数据隔离**（把红队"因为 500 而没能验证"的那条变成已验证）：
 *    临时实例 + 两个**真实 Key** + 真实 `usage_events`（触发器同步维护 rollup）+ 互不相同的标记模型，
 *    做**返回集合级**对照；并用"把另一个 Key 的标识塞进参数"证明不能越权。
 * ② **管理面不可用时降级而不是掩盖**：200 + 显式标注（header + 响应字段），不是 500。
 * ③ **管理面正常时行为不变**：响应里没有降级字段/header，数值与独立 SQL 聚合一致。
 * ④ `/start` 与 `/callback` 对同一非法 provider 的状态码**必须一致**（R26-A）。
 */

const REPO = new URL('../', import.meta.url).pathname

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer()
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address()
      const port = typeof address === 'object' && address ? address.port : 0
      probe.close(() => (port ? resolve(port) : reject(new Error('拿不到空闲端口'))))
    })
  })
}

type Harness = { base: string; child: ChildProcess; dataDir: string; logs: () => string; stop: () => Promise<void> }

async function startHarness(env: Record<string, string>): Promise<Harness> {
  const port = await freePort()
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crosery-v1-usage-'))
  const child = spawn(process.execPath, ['--import', 'tsx', 'server/index.ts'], {
    cwd: REPO,
    env: {
      ...process.env,
      DATA_DIR: dataDir,
      PORT: String(port),
      HOST: '127.0.0.1',
      CONSOLE_USERNAME: 'admin',
      CONSOLE_PASSWORD: 'correct-horse-battery',
      SESSION_SECRET: 'v1-usage-secret',
      COOKIE_SECURE: 'false',
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let buffer = ''
  child.stdout?.on('data', chunk => { buffer += String(chunk) })
  child.stderr?.on('data', chunk => { buffer += String(chunk) })
  const base = `http://127.0.0.1:${port}`
  const deadline = Date.now() + 25_000
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`服务子进程提前退出：${child.exitCode}\n${buffer}`)
    try { if ((await fetch(`${base}/api/session`)).status < 500) break } catch { /* 还没起来 */ }
    await new Promise(resolve => setTimeout(resolve, 200))
  }
  const stop = async () => {
    child.kill('SIGTERM')
    await new Promise(resolve => setTimeout(resolve, 300))
    if (child.exitCode === null) child.kill('SIGKILL')
    fs.rmSync(dataDir, { recursive: true, force: true })
  }
  return { base, child, dataDir, logs: () => buffer, stop }
}

const KEY_A = 'sk-live-alpha-6f2a'
const KEY_B = 'sk-live-beta-91c7'
const MARKER_A = 'marker-alpha-model'
const MARKER_B = 'marker-beta-model'
const SHARED = 'shared-model'

/** 造两个真实 Key + 一组活跃渠道分组 + 各自的用量事件（触发器会同步维护 rollup）。 */
function seedDataPlane(dataDir: string): void {
  const database = new DatabaseSync(path.join(dataDir, 'console.db'))
  try {
    const now = new Date()
    const iso = now.toISOString()
    const ms = now.getTime()
    const insertKey = database.prepare(`INSERT OR REPLACE INTO api_keys
      (key_hash,key_value,name,note,enabled,groups_json,total_concurrency,group_concurrency_json,created_at,updated_at)
      VALUES (?,?,?,?,1,?,?,?,?,?)`)
    insertKey.run(hashKey(KEY_A), KEY_A, 'alpha-key', '', '["alpha"]', 4, '{}', iso, iso)
    insertKey.run(hashKey(KEY_B), KEY_B, 'beta-key', '', '["alpha"]', 4, '{}', iso, iso)

    // 管理面正常时的分组来源（reportingGroupStore 命中后不会再打管理面）
    database.prepare('INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run('reporting.groups.lastKnown.v1', JSON.stringify({
        version: 1,
        generatedAt: iso,
        groups: [{ id: 'alpha', name: 'Alpha', color: '#123456', kind: 'compat', models: [SHARED, MARKER_A, MARKER_B] }],
      }))

    const insertEvent = database.prepare(`INSERT INTO usage_events
      (request_id,timestamp,timestamp_ms,key_hash,provider,model,model_group,endpoint,success,status_code,
       latency_ms,ttft_ms,input_tokens,output_tokens,reasoning_tokens,cached_tokens,cache_write_tokens,total_tokens)
      VALUES (?,?,?,?,?,?,?,?,1,200,10,5,100,50,0,0,0,150)`)
    const rows: Array<[string, string, string]> = [
      [`req-a-1-${ms}`, hashKey(KEY_A), SHARED],
      [`req-a-2-${ms}`, hashKey(KEY_A), SHARED],
      [`req-a-3-${ms}`, hashKey(KEY_A), MARKER_A],
      [`req-b-1-${ms}`, hashKey(KEY_B), SHARED],
      [`req-b-2-${ms}`, hashKey(KEY_B), MARKER_B],
    ]
    for (const [requestId, keyHash, model] of rows) {
      insertEvent.run(requestId, iso, ms - 60_000, keyHash, 'alpha', model, 'alpha', '/v1/messages')
    }
  } finally {
    database.close()
  }
}

const usage = (base: string, key: string, query = '') =>
  fetch(`${base}/v1/usage?days=30${query}`, { headers: { authorization: `Bearer ${key}` } })

const modelSet = (body: { models?: Array<{ model?: string }> }): string[] =>
  [...new Set((body.models || []).map(entry => String(entry.model || '')))].sort()

/* ────────────────── ① 跨 Key 隔离（正向，管理面正常） ────────────────── */

test('跨 Key 隔离：两个真实 Key 各自只看到自己的标记模型（集合级对照 + 参数注入无效）', { timeout: 120_000 }, async () => {
  const harness = await startHarness({
    GATEWAY_ENGINE: 'magpie',
    MAGPIE_CONTROL_PLANE: 'local',
    MAGPIE_PORT: String(await freePort()),
    CPA_BASE_URL: 'http://127.0.0.1:9',
    CPA_MANAGEMENT_KEY: '',
  })
  try {
    seedDataPlane(harness.dataDir)

    // 独立参照：直接查库（不经过被测代码），事件表与 rollup 表两条路径都要对得上
    const database = new DatabaseSync(path.join(harness.dataDir, 'console.db'))
    const expected = new Map<string, string[]>()
    try {
      for (const [label, key] of [['A', KEY_A], ['B', KEY_B]] as const) {
        const rollupRows = database.prepare(
          'SELECT DISTINCT model FROM usage_hourly_rollup WHERE key_hash = ? AND hour_ms >= ? ORDER BY model',
        ).all(hashKey(key), Date.now() - 30 * 86_400_000) as Array<{ model: string }>
        const eventRows = database.prepare(
          'SELECT DISTINCT model FROM usage_events WHERE key_hash = ? AND timestamp_ms >= ? ORDER BY model',
        ).all(hashKey(key), Date.now() - 30 * 86_400_000) as Array<{ model: string }>
        const rollupSet = rollupRows.map(row => row.model).sort()
        const eventSet = eventRows.map(row => row.model).sort()
        assert.deepEqual(rollupSet, eventSet, `${label}：rollup 与 events（触发器维护）必须一致`)
        expected.set(label, eventSet)
      }
    } finally {
      database.close()
    }
    assert.deepEqual([...expected.get('A')!].sort(), [MARKER_A, SHARED].sort(), 'A 的库内数据：共享模型 + A 标记')
    assert.deepEqual([...expected.get('B')!].sort(), [MARKER_B, SHARED].sort(), 'B 的库内数据：共享模型 + B 标记')

    // A 的 Key → 只能看到 A 的数据
    const responseA = await usage(harness.base, KEY_A)
    const rawA = await responseA.text()
    assert.equal(responseA.status, 200, `A 的 /v1/usage 必须 200：${responseA.status} ${rawA.slice(0, 200)}`)
    const bodyA = JSON.parse(rawA) as { models?: Array<{ model?: string }>; degraded?: unknown; key?: { name?: string } }
    const textA = rawA
    assert.deepEqual(modelSet(bodyA), [...expected.get('A')!].sort(), 'A 的返回集合必须等于库内 A 的数据')
    assert.ok(!textA.includes(MARKER_B), `A 的响应里绝不允许出现 B 的标记模型：${textA.slice(0, 200)}`)
    assert.deepEqual(bodyA.key, { name: 'alpha-key' })
    assert.equal(bodyA.degraded, undefined, '管理面正常时不得出现降级字段')

    // B 的 Key → 只能看到 B 的数据
    const responseB = await usage(harness.base, KEY_B)
    const textB = await responseB.text()
    const bodyB = JSON.parse(textB) as { models?: Array<{ model?: string }> }
    assert.equal(responseB.status, 200)
    assert.deepEqual(modelSet(bodyB), [...expected.get('B')!].sort(), 'B 的返回集合必须等于库内 B 的数据')
    assert.ok(!textB.includes(MARKER_A), `B 的响应里绝不允许出现 A 的标记模型：${textB.slice(0, 200)}`)

    // 双方唯一的交集只能是那个共享模型（证明不是"整个渠道数据都看不见"）
    const aSet = new Set(modelSet(bodyA))
    assert.deepEqual(modelSet(bodyB).filter(model => aSet.has(model)), [SHARED])

    // 把 **B 的标识**塞进参数：A 的凭据仍然只能看到 A 的数据
    const injection = `&key=${encodeURIComponent(KEY_B)}&keyId=${hashKey(KEY_B)}&key_hash=${hashKey(KEY_B)}`
      + `&keyHash=${hashKey(KEY_B)}&hash=${hashKey(KEY_B)}&name=beta-key`
    const injectedResponse = await usage(harness.base, KEY_A, injection)
    const injectedText = await injectedResponse.text()
    assert.equal(injectedResponse.status, 200)
    assert.ok(!injectedText.includes(MARKER_B), `参数注入不得越权拿到 B 的数据：${injectedText.slice(0, 200)}`)

    // 同族的 /v1/usage/requests 在同一环境同样可用（红队指出的可用性不一致已消失）
    for (const [label, key] of [['A', KEY_A], ['B', KEY_B]] as const) {
      const listResponse = await fetch(`${harness.base}/v1/usage/requests?days=30`, { headers: { authorization: `Bearer ${key}` } })
      assert.equal(listResponse.status, 200, `${label} 的 /v1/usage/requests 必须 200`)
      const items = (await listResponse.json() as { items?: Array<{ model?: string }> }).items || []
      const models = [...new Set(items.map(item => String(item.model)))].sort()
      assert.deepEqual(models, [...expected.get(label)!].sort(), `${label} 的请求明细集合必须与汇总一致`)
    }

    // 不存在的 Key 仍然 401（隔离的边界）
    const unauthorized = await usage(harness.base, 'sk-not-a-real-key')
    assert.equal(unauthorized.status, 401)
  } finally {
    await harness.stop()
  }
})

/* ────────────────── ② 管理面不可用 → 降级（不是 500） ────────────────── */

test('管理面不可用时 /v1/usage 降级为 200 + 显式标注（不是 500，也不静默改语义）', { timeout: 120_000 }, async () => {
  const harness = await startHarness({
    GATEWAY_ENGINE: 'cpa',
    MAGPIE_CONTROL_PLANE: 'local',
    CPA_BASE_URL: 'http://127.0.0.1:9',
    CPA_MANAGEMENT_KEY: '', // ← 管理面不可用：listGroupsForReporting 拿不到分组
  })
  try {
    seedDataPlane(harness.dataDir)
    // 让分组缓存为空，强制走"管理面不可用"的分支
    const database = new DatabaseSync(path.join(harness.dataDir, 'console.db'))
    try { database.prepare('DELETE FROM app_settings WHERE key = ?').run('reporting.groups.lastKnown.v1') } finally { database.close() }

    const response = await usage(harness.base, KEY_A)
    const text = await response.text()
    assert.equal(response.status, 200, `管理面不可用时必须降级为 200，而不是 500：${response.status} ${text.slice(0, 200)}`)
    assert.equal(response.headers.get('x-usage-degraded'), 'provider_filter_unavailable', '降级必须通过 header 可见')
    const body = JSON.parse(text) as { degraded?: { reason?: string; note?: string }; models?: Array<{ model?: string }> }
    assert.equal(body.degraded?.reason, 'provider_filter_unavailable', `降级必须通过响应字段可见：${text.slice(0, 200)}`)
    assert.match(String(body.degraded?.note), /未按 provider 过滤/, '必须说明语义差异')
    // 降级仍然只查该 Key 自己（隔离不因降级而失效）
    const models = modelSet(body)
    assert.ok(models.includes(MARKER_A), `降级时也必须返回自己的数据：${models.join(',')}`)
    assert.ok(!models.includes(MARKER_B), `降级时不得看到别的 Key 的数据：${models.join(',')}`)
    assert.ok(!text.includes(MARKER_B))
  } finally {
    await harness.stop()
  }
})

/* ────────────────── ③ /start 与 /callback 状态码一致（R26-A） ────────────────── */

test('同一非法 provider：/start 与 /callback 状态码与 reason 必须一致（都不是 5xx）', { timeout: 120_000 }, async () => {
  const harness = await startHarness({
    GATEWAY_ENGINE: 'magpie',
    MAGPIE_CONTROL_PLANE: 'local',
    MAGPIE_PORT: String(await freePort()),
    CPA_BASE_URL: 'http://127.0.0.1:9',
    CPA_MANAGEMENT_KEY: '',
  })
  try {
    const login = await fetch(`${harness.base}/api/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'correct-horse-battery' }),
    })
    const cookie = String(login.headers.get('set-cookie') || '').split(';')[0]

    for (const provider of ['evil.com', '../../etc', 'claude; rm -rf /', 'unknown-provider']) {
      const start = await fetch(`${harness.base}/api/cpa/oauth/start`, {
        method: 'POST', headers: { cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ provider }),
      })
      const startBody = await start.json() as { error?: string; reason?: string }
      const callback = await fetch(`${harness.base}/api/cpa/oauth/callback`, {
        method: 'POST', headers: { cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ provider, redirectUrl: 'https://example.com/cb?code=abc' }),
      })
      const callbackBody = await callback.json() as { error?: string; reason?: string }
      assert.equal(start.status, callback.status,
        `同一非法 provider 两条路径状态码必须一致：start=${start.status} callback=${callback.status}（${provider}）`)
      assert.equal(start.status, 400, `非法 provider 必须 400 而不是 5xx：${provider} → ${start.status}`)
      assert.equal(startBody.reason, 'provider_not_supported')
      assert.equal(callbackBody.reason, 'provider_not_supported')
      assert.match(String(startBody.error), /不支持的 OAuth 提供商/)
      assert.match(String(startBody.error), /可选：/, '错误文案必须列出可选值')
    }

    // 空 provider 也是 400（两条路径都不许 5xx）
    const emptyStart = await fetch(`${harness.base}/api/cpa/oauth/start`, {
      method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ provider: '' }),
    })
    assert.equal(emptyStart.status, 400, `空 provider 必须 400：${emptyStart.status}`)
    assert.ok(emptyStart.status < 500)
  } finally {
    await harness.stop()
  }
})

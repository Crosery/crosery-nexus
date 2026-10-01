import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { createServer } from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

/**
 * task-79：把双源价格接进控制台自己的端点 + magpie 更新的服务端代跑。
 *
 * 端点级用例都是**真子进程 + 生产参数 + 真实 HTTP**；更新脚本用**替身**（记录调用参数），
 * 绝不碰真实运行时、不碰 launchd、不联网。
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

/** 更新脚本替身：把每次调用的 argv 追加到 calls.jsonl，并按 action 打印约定的 JSON。 */
function writeStubScript(dir: string, { fail = false } = {}): { script: string; calls: string } {
  const script = path.join(dir, 'stub-magpie-update.mjs')
  const calls = path.join(dir, 'calls.jsonl')
  fs.writeFileSync(script, `
import fs from 'node:fs'
const calls = ${JSON.stringify(calls)}
const argv = process.argv.slice(2)
fs.appendFileSync(calls, JSON.stringify(argv) + '\\n')
const action = argv[0]
const rootAt = argv.indexOf('--root')
const root = rootAt >= 0 ? argv[rootAt + 1] : null
const payload = action === 'apply' && ${fail ? 'true' : 'false'}
  ? { error: 'stub failure', status: 'rolled-back' }
  : { action, root, status: action === 'apply' ? 'updated' : 'update-available', changed: action === 'apply', backup: action === 'apply' ? '/tmp/backup-kernel' : null,
      currentVersion: 'crosery-0000000', latestVersion: 'crosery-1111111', lastCheckedAt: '2026-10-01T00:00:00.000Z', lastResult: action === 'apply' ? 'updated' : 'update-available', backupPath: action === 'apply' ? '/tmp/backup-kernel' : null, error: null }
process.stdout.write(JSON.stringify(payload) + '\\n')
process.exit(action === 'apply' && ${fail ? 'true' : 'false'} ? 1 : 0)
`)
  return { script, calls }
}

type Harness = { base: string; child: ChildProcess; dataDir: string; logs: () => string; stop: () => Promise<void> }

async function startHarness(env: Record<string, string>): Promise<Harness> {
  const port = await freePort()
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crosery-magpie-update-'))
  const child = spawn(process.execPath, ['--import', 'tsx', 'server/index.ts'], {
    cwd: REPO,
    env: {
      ...process.env,
      DATA_DIR: dataDir,
      PORT: String(port),
      HOST: '127.0.0.1',
      CONSOLE_USERNAME: 'admin',
      CONSOLE_PASSWORD: 'correct-horse-battery',
      SESSION_SECRET: 'magpie-update-secret',
      COOKIE_SECURE: 'false',
      GATEWAY_ENGINE: 'magpie',
      MAGPIE_CONTROL_PLANE: 'local',
      MAGPIE_PORT: String(await freePort()),
      CPA_BASE_URL: 'http://127.0.0.1:9',
      CPA_MANAGEMENT_KEY: '',
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

async function login(harness: Harness): Promise<string> {
  const response = await fetch(`${harness.base}/api/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'correct-horse-battery' }),
  })
  assert.equal(response.status, 200)
  return String(response.headers.get('set-cookie') || '').split(';')[0]
}

const callsOf = (file: string): string[][] => {
  try {
    return fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as string[])
  } catch {
    return []
  }
}

/* ────────────────── ① 默认拒绝 + 能力探测 ────────────────── */

test('两个新端点走默认拒绝：未认证一律 401（模型索引也一样）', { timeout: 120_000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'magpie-auth-'))
  const stub = writeStubScript(dir)
  const harness = await startHarness({ MAGPIE_UPDATE_SCRIPT: stub.script, MAGPIE_UPDATE_ROOT: dir })
  try {
    for (const [label, url, init] of [
      ['GET /api/magpie/update-status', '/api/magpie/update-status', undefined],
      ['POST /api/magpie/update', '/api/magpie/update', { method: 'POST', body: JSON.stringify({ action: 'check' }), headers: { 'content-type': 'application/json' } }],
      ['GET /api/model-index', '/api/model-index', undefined],
    ] as const) {
      const response = await fetch(`${harness.base}${url}`, init as RequestInit)
      assert.equal(response.status, 401, `${label} 未认证必须 401：${response.status}`)
    }
    assert.deepEqual(callsOf(stub.calls), [], '被 401 拦下时不得执行任何脚本调用')
  } finally {
    await harness.stop()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('能力探测如实：脚本不存在时 capability:false + 原因，且 POST 拒绝执行（503）', { timeout: 120_000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'magpie-nocap-'))
  const harness = await startHarness({ MAGPIE_UPDATE_SCRIPT: path.join(dir, 'missing-script.mjs'), MAGPIE_UPDATE_ROOT: dir })
  try {
    const cookie = await login(harness)
    const status = await fetch(`${harness.base}/api/magpie/update-status`, { headers: { cookie } })
    const body = await status.json() as { capability?: boolean; reason?: string; currentVersion?: unknown }
    assert.equal(status.status, 200)
    assert.equal(body.capability, false, '脚本不存在时必须如实说不可用，不假装有')
    assert.match(String(body.reason), /找不到更新脚本/)
    assert.equal(body.currentVersion, null, '不可用时不得编造版本号')

    const update = await fetch(`${harness.base}/api/magpie/update`, {
      method: 'POST', headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'apply', confirm: true }),
    })
    assert.equal(update.status, 503, '能力不可用时即使带确认也不能执行')
    assert.equal((await update.json() as { reason?: string }).reason, 'update_capability_unavailable')
  } finally {
    await harness.stop()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

/* ────────────────── ② 确认门与零副作用 ────────────────── */

test('POST apply 缺 confirm 必须 403 且**零副作用**（不得调用更新脚本）', { timeout: 120_000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'magpie-confirm-'))
  const stub = writeStubScript(dir)
  const harness = await startHarness({ MAGPIE_UPDATE_SCRIPT: stub.script, MAGPIE_UPDATE_ROOT: dir })
  try {
    const cookie = await login(harness)
    for (const body of [{ action: 'apply' }, { action: 'apply', confirm: false }, { action: 'apply', confirm: 'yes' }]) {
      const response = await fetch(`${harness.base}/api/magpie/update`, {
        method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify(body),
      })
      assert.equal(response.status, 403, `缺确认必须 403：${JSON.stringify(body)} → ${response.status}`)
      assert.equal((await response.json() as { reason?: string }).reason, 'confirm_required')
    }
    assert.deepEqual(callsOf(stub.calls), [], '被确认门拒绝时**一次脚本调用都不能发生**（零副作用）')

    // 拒绝也要进审计
    const audit = await fetch(`${harness.base}/api/audit`, { headers: { cookie } })
    const items = (await audit.json() as { items: Array<{ action?: string; target?: string; details?: string }> }).items
    assert.ok(items.some(item => item.action === 'magpie_update' && String(item.details).includes('refused:missing-confirm')),
      `拒绝事件必须进审计：${JSON.stringify(items.slice(0, 3))}`)
  } finally {
    await harness.stop()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('确认后 apply 才真正执行（调用参数含 --confirm-apply），check 无需确认，两者都进审计', { timeout: 120_000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'magpie-run-'))
  const stub = writeStubScript(dir)
  const harness = await startHarness({ MAGPIE_UPDATE_SCRIPT: stub.script, MAGPIE_UPDATE_ROOT: dir })
  try {
    const cookie = await login(harness)

    const check = await fetch(`${harness.base}/api/magpie/update`, {
      method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ action: 'check' }),
    })
    assert.equal(check.status, 200, `check 只读，无需确认：${check.status} ${await check.text()}`)

    const apply = await fetch(`${harness.base}/api/magpie/update`, {
      method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ action: 'apply', confirm: true }),
    })
    const applyBody = await apply.text()
    assert.equal(apply.status, 200, `确认后 apply 必须执行：${apply.status} ${applyBody}`)
    const parsed = JSON.parse(applyBody) as { result?: { status?: string; backup?: string } }
    assert.equal(parsed.result?.status, 'updated', '把脚本的结论原样返回')
    assert.equal(parsed.result?.backup, '/tmp/backup-kernel', '回滚备份路径要原样带回给 UI')

    const calls = callsOf(stub.calls)
    assert.equal(calls.length, 2, `应恰好执行两次（check + apply）：${JSON.stringify(calls)}`)
    assert.deepEqual(calls[0][0], 'check')
    assert.ok(calls[1].includes('apply') && calls[1].includes('--confirm-apply'), `apply 必须带 --confirm-apply：${JSON.stringify(calls[1])}`)

    const audit = await fetch(`${harness.base}/api/audit`, { headers: { cookie } })
    const items = (await audit.json() as { items: Array<{ action?: string; target?: string; details?: string }> }).items
    const updates = items.filter(item => item.action === 'magpie_update')
    assert.ok(updates.some(item => item.target === 'apply' && String(item.details).includes('exit=0')), `apply 必须进审计：${JSON.stringify(updates.slice(0, 3))}`)
    assert.ok(updates.some(item => item.target === 'check'), 'check 也要留痕')
  } finally {
    await harness.stop()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('更新失败时如实返回失败与回滚结论（非 0 退出 → 500 + reason=update_failed）', { timeout: 120_000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'magpie-fail-'))
  const stub = writeStubScript(dir, { fail: true })
  const harness = await startHarness({ MAGPIE_UPDATE_SCRIPT: stub.script, MAGPIE_UPDATE_ROOT: dir })
  try {
    const cookie = await login(harness)
    const response = await fetch(`${harness.base}/api/magpie/update`, {
      method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ action: 'apply', confirm: true }),
    })
    assert.equal(response.status, 500)
    const body = await response.json() as { reason?: string; result?: { status?: string } }
    assert.equal(body.reason, 'update_failed')
    assert.equal(body.result?.status, 'rolled-back', '脚本的回滚结论要原样带回来给 UI')
  } finally {
    await harness.stop()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

/* ────────────────── ③ 模型索引带双源价格（模块级，确定性） ────────────────── */

test('控制台模型索引：每条带 pricingSources / unpriced / availableOnGateway，并集含仅目录收录的模型', async () => {
  const pricing = await import('./pricing.js')
  const { mergePriceSourceEntries, withPriceSourceFields } = await import('./modelIndex.js')
  pricing.resetSharedPricing()
  pricing.applySharedPricing({
    sources: {
      openrouter: { ok: true, fetchedAt: 1_790_860_562_294, entries: 1 },
      'models.dev': { ok: false, fetchedAt: 0, error: 'HTTP 503' },
    },
    rows: [
      { id: 'claude-sonnet-4-6', source: 'openrouter', sourceId: 'anthropic/claude-sonnet-4.6', prices: { openrouter: { input: 3, output: 15, cacheRead: 0.3, unit: 'usd-per-million-tokens' } } },
      { id: 'fixture-price-only-4b7d', source: 'openrouter', sourceId: 'vendor/fixture-price-only-4b7d', prices: { openrouter: { input: 1, output: 2, unit: 'usd-per-million-tokens' } } },
    ],
  })

  // 网关目录里已有的模型：补齐双源价格字段（与模型总览组件的 props 对齐）
  const known = withPriceSourceFields({ id: 'claude-sonnet-4-6', pricing: null, sources: [], enabledSources: 1, contested: false })
  assert.deepEqual(Object.keys(known.pricingSources || {}), ['openrouter'], '双源价格接进了模型索引条目')
  assert.equal(known.availableOnGateway, true)
  assert.equal(known.unpriced, false)
  assert.equal((known.pricingSources as Record<string, { fetchedAt?: number }>).openrouter?.fetchedAt, 1_790_860_562_294, '抓取时间戳一起带出')

  // 没有任何价格的模型：unpriced 而不是 0 价
  const bare = withPriceSourceFields({ id: 'fixture-no-price-7c21', pricing: null, sources: [], enabledSources: 1, contested: false })
  assert.equal(bare.pricingSources, undefined, '没有来源价格就不带 pricingSources 字段')
  assert.equal(bare.unpriced, true, '没有价格 ⇒ unpriced（前端写「未收录」，不是 0）')

  // 并集：价格来源里有、目录里没有的模型
  const merged = mergePriceSourceEntries([])
  const extra = merged.find(entry => entry.id === 'fixture-price-only-4b7d')!
  assert.ok(extra, '价格来源里有、目录里没有的模型必须并进控制台视图')
  assert.equal(extra.availableOnGateway, false, '仅目录收录要标出来')
  assert.deepEqual(extra.sources, [])
  assert.equal(extra.contested, false)

  // 来源降级也要能被 UI 读到
  const status = pricing.pricingSourceStatus()
  assert.ok(status.degraded.includes('source-unavailable:models.dev'), JSON.stringify(status.degraded))
  pricing.resetSharedPricing()
})

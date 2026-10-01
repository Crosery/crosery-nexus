import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import { createServer, type Server } from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'

/**
 * 请求输入的收口（task-26 A / task-28 R7-C、R7-D）：**服务端不得静默改写用户输入**。
 * - 并发：`totalConcurrency` 空串/缺字段 → 400（R6-B）
 * - 额度：`totalUsd/dailyUsd/weeklyUsd` 空串/非数字 → 400，负数 → 400，缺字段保持原值，显式 0 合法（R7-C）
 * - 报表天数：`days=abc` 与默认值等价（R7-D）
 *
 * 端到端：真起一个 `server/index.ts` 子进程（临时 `DATA_DIR` + 本地 CPA stub），只打 HTTP 接口。
 * - 不用真实数据：`DATA_DIR` 用 mkdtemp；不用真实中转站：`CPA_BASE_URL` 指向本地 stub；
 *   子进程在 finally 里 SIGTERM/SIGKILL，临时目录删除。
 * - 本文件**不**引入 `./testDataDir.js`：它自己 `mkdtempSync` 并显式传给子进程
 *   （符合 testDataDir 文档写明的例外情形）。
 *
 * 为什么 PATCH 用「直接播种 sqlite 行」而不是先 POST 建 Key：新建 Key 会触发
 * `reconcileKeyModelAccess()` → `buildGroups()`，而临时实例里没有任何渠道，
 * 分组会被规范化成 `[]`，随后 `validatePolicy` 一律以「至少选择一个渠道分组」失败——
 * 那会让本测试测不到并发契约。播种行只依赖 `api_keys` 表结构（`server/db.ts:15-27`）。
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

/** 本地 CPA stub：`/api-keys` 足够让服务端启动与对账不报错，其余一律 200 {}。 */
async function startCpaStub(): Promise<{ server: Server; port: number }> {
  const server = createServer((req, res) => {
    const url = req.url ?? ''
    res.setHeader('content-type', 'application/json')
    if (url.startsWith('/api-keys')) {
      if (req.method === 'PUT') {
        req.on('data', () => undefined)
        req.on('end', () => res.end(JSON.stringify({ ok: true })))
        return
      }
      res.end(JSON.stringify({ 'api-keys': [] }))
      return
    }
    res.end(JSON.stringify({}))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  return { server, port: typeof address === 'object' && address ? address.port : 0 }
}

async function waitForReady(base: string, child: ChildProcess): Promise<void> {
  const deadline = Date.now() + 25_000
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`服务子进程提前退出：${child.exitCode}`)
    try {
      const res = await fetch(`${base}/api/session`)
      if (res.status < 500) return
    } catch {
      /* 还没起来 */
    }
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  throw new Error('服务子进程 25s 内没就绪')
}

type Harness = { base: string; auth: Record<string, string>; child: ChildProcess; dataDir: string }

async function startHarness(stubPort: number): Promise<Harness> {
  const port = await freePort()
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crosery-concurrency-test-'))
  const child = spawn(process.execPath, ['--import', 'tsx', 'server/index.ts'], {
    cwd: REPO,
    env: {
      ...process.env,
      DATA_DIR: dataDir,
      PORT: String(port),
      HOST: '127.0.0.1',
      CPA_BASE_URL: `http://127.0.0.1:${stubPort}`,
      CPA_MANAGEMENT_KEY: 'test-management-key',
      MAGPIE_CONTROL_PLANE: 'local',
      MAGPIE_PORT: String(stubPort),
      CONSOLE_USERNAME: 'admin',
      CONSOLE_PASSWORD: 'test-password',
      SESSION_SECRET: 'test-session-secret',
      COOKIE_SECURE: 'false',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const base = `http://127.0.0.1:${port}`
  await waitForReady(base, child)
  const login = await fetch(`${base}/api/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'test-password' }),
  })
  assert.equal(login.status, 200, '测试夹具需要先登录成功')
  const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0]
  assert.ok(cookie.includes('='), '登录应当返回会话 cookie')
  return { base, auth: { 'content-type': 'application/json', cookie }, child, dataDir }
}

/** 播种一行可用的 Key（分组非空、给定并发），让 validatePolicy 能走到并发分支。 */
function seedKey(harness: Harness, id: string, totalConcurrency = 7) {
  const db = new DatabaseSync(path.join(harness.dataDir, 'console.db'))
  const now = new Date().toISOString()
  db.prepare('DELETE FROM api_keys WHERE key_hash = ?').run(id)
  db.prepare(
    `INSERT INTO api_keys (key_hash,key_value,name,note,enabled,groups_json,total_concurrency,group_concurrency_json,created_at,updated_at)
     VALUES (?,?,?,?,1,?,?,?,?,?)`,
  ).run(id, `sk-seed-${id}`, '并发契约播种行', '', JSON.stringify(['g1']), totalConcurrency, JSON.stringify({ g1: 1 }), now, now)
  db.close()
}

/** 直接读库确认落库值（不看响应自述）。 */
function storedConcurrency(harness: Harness, id: string): number | undefined {
  const db = new DatabaseSync(path.join(harness.dataDir, 'console.db'))
  const row = db.prepare('SELECT total_concurrency FROM api_keys WHERE key_hash = ?').get(id) as { total_concurrency: number } | undefined
  db.close()
  return row ? Number(row.total_concurrency) : undefined
}

async function stopHarness(harness: Harness) {
  harness.child.kill('SIGTERM')
  await new Promise((resolve) => setTimeout(resolve, 300))
  if (harness.child.exitCode === null) harness.child.kill('SIGKILL')
  fs.rmSync(harness.dataDir, { recursive: true, force: true })
}

test('totalConcurrency 空串/缺字段不再被静默改写（POST 400；PATCH 空串 400；PATCH 缺字段保持原值）', async () => {
  const stub = await startCpaStub()
  let harness: Harness | null = null
  try {
    harness = await startHarness(stub.port)
    const h = harness
    const post = (body: unknown) => fetch(`${h.base}/api/keys`, { method: 'POST', headers: h.auth, body: JSON.stringify(body) })
    const patch = (id: string, body: unknown) =>
      fetch(`${h.base}/api/keys/${id}`, { method: 'PATCH', headers: h.auth, body: JSON.stringify(body) })

    // ① POST 空串：必须 400，且文案与 server/policy.ts 同源
    const empty = await post({ name: '并发契约-空串', groups: ['g1'], totalConcurrency: '' })
    assert.equal(empty.status, 400, '空串必须被拒（旧实现 `Number(v || 4)` 会静默变成 4）')
    const emptyError = ((await empty.json()) as { error?: string }).error ?? ''
    assert.match(emptyError, /总并发数不能为空/)
    assert.match(emptyError, /0 到 500 的整数，0 表示不限速/)

    // ② POST 缺字段：不再有隐式默认值 4
    const missing = await post({ name: '并发契约-缺字段', groups: ['g1'] })
    assert.equal(missing.status, 400, '缺字段必须被拒（旧实现会静默用 4）')
    assert.match(((await missing.json()) as { error?: string }).error ?? '', /请填写总并发数/)

    // ③ POST 越界：与 policy.ts 同源文案
    const tooBig = await post({ name: '并发契约-越界', groups: ['g1'], totalConcurrency: 501 })
    assert.equal(tooBig.status, 400)
    assert.match(((await tooBig.json()) as { error?: string }).error ?? '', /0 到 500 的整数/)

    const id = `hash-${Date.now().toString(36)}`

    // ④ PATCH 空串：绝不能落成 0（= 不限速）——旧实现 `Number('')` 会变成 0
    seedKey(h, id, 7)
    const patchEmpty = await patch(id, { totalConcurrency: '' })
    assert.equal(patchEmpty.status, 400, 'PATCH 空串必须被拒（旧实现会变成 0 = 不限速，方向更危险）')
    assert.match(((await patchEmpty.json()) as { error?: string }).error ?? '', /总并发数不能为空/)
    assert.equal(storedConcurrency(h, id), 7, '被拒之后库里必须仍是原值 7，不能被改成 0')

    // ⑤ PATCH 显式 0：不限速是合法值，允许落库，并在响应里回传生效值
    seedKey(h, id, 7)
    const unlimited = await patch(id, { totalConcurrency: 0 })
    assert.equal(unlimited.status, 200, `显式 0 应当成功：${await unlimited.clone().text()}`)
    assert.equal(((await unlimited.json()) as { item?: { totalConcurrency?: number } }).item?.totalConcurrency, 0)
    assert.equal(storedConcurrency(h, id), 0)

    // ⑥ PATCH 缺字段：表示「保持原值」（合法的部分更新），既不是 0 也不是 4
    seedKey(h, id, 7)
    const keep = await patch(id, { name: '并发契约-改名' })
    assert.equal(keep.status, 200, `PATCH 缺字段应当保持原值：${await keep.clone().text()}`)
    assert.equal(((await keep.json()) as { item?: { totalConcurrency?: number } }).item?.totalConcurrency, 7)
    assert.equal(storedConcurrency(h, id), 7)
    // ⑦ R7-C 额度接口：空串 / 非数字 / 负数 / 缺字段 / 显式 0
    const quota = (id: string, body: unknown, method: 'PATCH' = 'PATCH') =>
      fetch(`${h.base}/api/keys/${id}/quota`, { method, headers: h.auth, body: JSON.stringify(body) })

    seedKey(h, id, 7)
    const quotaEmpty = await quota(id, { totalUsd: '' })
    assert.equal(quotaEmpty.status, 400, '额度空串必须被拒（旧实现 `Number(...) || 0` 会静默变成 0 = 不限额）')
    assert.match(((await quotaEmpty.json()) as { error?: string }).error ?? '', /额度不能为空/)

    const quotaText = await quota(id, { totalUsd: 'abc' })
    assert.equal(quotaText.status, 400, '非数字必须被拒（旧实现 `Number("abc") || 0` 会静默变成 0 = 不限额）')
    assert.match(((await quotaText.json()) as { error?: string }).error ?? '', /额度必须是数字/)

    const quotaNegative = await quota(id, { totalUsd: -3 })
    assert.equal(quotaNegative.status, 400, '负数必须被拒（旧实现会原样落库 -3）')
    assert.match(((await quotaNegative.json()) as { error?: string }).error ?? '', /必须是 0 或正数/)

    const quotaMissing = await quota(id, {})
    assert.equal(quotaMissing.status, 200, `缺字段应当保持原值：${await quotaMissing.clone().text()}`)

    // 显式 0 = 「不限额」（UI 的「无额度限制」开关发的就是 0），不能被误伤
    const quotaZero = await quota(id, { totalUsd: 0 })
    assert.equal(quotaZero.status, 200, `显式 0 必须仍然合法：${await quotaZero.clone().text()}`)

    // ⑧ R7-D 报表天数：非数字必须与默认值等价（旧实现把它变成 NaN，报表返回完全不同的空结果）
    const daysDefault = await fetch(`${h.base}/api/usage-page?days=7`, { headers: h.auth })
    const daysText = await fetch(`${h.base}/api/usage-page?days=abc`, { headers: h.auth })
    const daysEmpty = await fetch(`${h.base}/api/usage-page?days=`, { headers: h.auth })
    assert.equal(daysDefault.status, 200)
    assert.equal(daysText.status, 200, 'days=abc 必须正常返回，而不是 500 或 NaN 报表')
    const [defaultBody, textBody, emptyBody] = await Promise.all([daysDefault.text(), daysText.text(), daysEmpty.text()])
    assert.equal(textBody, defaultBody, 'days=abc 必须与默认口径完全一致（NaN 会给出另一份空报表）')
    assert.equal(emptyBody, defaultBody, 'days= 也必须与默认口径一致')
    assert.doesNotMatch(textBody, /"days":null/)
  } finally {
    if (harness) await stopHarness(harness)
    await new Promise<void>((resolve) => stub.server.close(() => resolve()))
  }
})

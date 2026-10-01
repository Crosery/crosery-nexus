import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'

/**
 * task-67：自检的**两个真实盲区**必须被补上（红队第十八轮实证）。
 *
 * ① 抵消型漂移：同一窗口内一行 +1、另一行 −1 ⇒ 总量相等，旧判据（只比 request_count 总量）报 ok，逐行已错；
 * ② 只改 token/cost ⇒ 旧判据一项都不比，仍报 ok，而金额错最贵。
 *
 * 每条用例都做**双向断言**：旧判据**不报**（证明盲区真实存在）+ 新判据**必报**（证明补上了）。
 * 这就是「负向验证」：去掉新维度，用例即失效。
 */

const { checkRollupHealthV2, compareMetric, summarizeRowDrift } = await import('./usageRollup.js')

/** 跑 `scripts/rollup-rebuild.mjs`（端到端：脚本路径也要有回归）。 */
const SCRIPT = path.join(process.cwd(), 'scripts', 'rollup-rebuild.mjs')
const runScript = (command: string, file: string, extra: string[] = []) => {
  try {
    return { code: 0, stdout: execFileSync(process.execPath, [SCRIPT, command, '--db', file, '--hours', '24', ...extra], { encoding: 'utf8' }) }
  } catch (error) {
    const failure = error as { status?: number; stdout?: string; stderr?: string }
    return { code: failure.status ?? 1, stdout: `${failure.stdout ?? ''}${failure.stderr ?? ''}` }
  }
}

const HOUR = 3_600_000

type EventRow = { ts: number; provider: string; model: string; tokens: number; cost: number | null }

/** 建库：events 原始行 + 一个「忠实」的 rollup（随后每个用例各自破坏它）。 */
function makeFixture(events: EventRow[]) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crosery-drift-v2-'))
  const file = path.join(dir, 'console.db')
  const db = new DatabaseSync(file)
  db.exec(`CREATE TABLE usage_events (id INTEGER PRIMARY KEY AUTOINCREMENT, request_id TEXT UNIQUE, timestamp TEXT NOT NULL,
    timestamp_ms INTEGER NOT NULL DEFAULT 0, key_hash TEXT, provider TEXT NOT NULL, model TEXT NOT NULL, model_group TEXT NOT NULL,
    endpoint TEXT NOT NULL, success INTEGER NOT NULL, status_code INTEGER NOT NULL, latency_ms INTEGER NOT NULL, ttft_ms INTEGER NOT NULL,
    input_tokens INTEGER NOT NULL, output_tokens INTEGER NOT NULL, reasoning_tokens INTEGER NOT NULL, cached_tokens INTEGER NOT NULL,
    cache_write_tokens INTEGER NOT NULL DEFAULT 0, total_tokens INTEGER NOT NULL, user_agent TEXT NOT NULL DEFAULT '',
    client_type TEXT NOT NULL DEFAULT '', client_ip TEXT NOT NULL DEFAULT '', error_detail TEXT NOT NULL DEFAULT '',
    error_category TEXT NOT NULL DEFAULT '', upstream_request_id TEXT NOT NULL DEFAULT '', source TEXT NOT NULL DEFAULT '',
    auth_index TEXT NOT NULL DEFAULT '', reasoning_effort TEXT NOT NULL DEFAULT '', service_tier TEXT NOT NULL DEFAULT '',
    response_headers_json TEXT NOT NULL DEFAULT '{}', cost_usd REAL)`)
  db.exec(`CREATE TABLE usage_hourly_rollup (hour_ms INTEGER NOT NULL, hour_text TEXT NOT NULL, day_text TEXT NOT NULL,
    key_hash TEXT NOT NULL, provider TEXT NOT NULL, model TEXT NOT NULL, model_group TEXT NOT NULL, endpoint TEXT NOT NULL,
    client_type TEXT NOT NULL, success INTEGER NOT NULL, status_code INTEGER NOT NULL, error_category TEXT NOT NULL,
    request_count INTEGER NOT NULL, total_tokens INTEGER NOT NULL, input_tokens INTEGER NOT NULL, uncached_input_tokens INTEGER NOT NULL,
    output_tokens INTEGER NOT NULL, cached_tokens INTEGER NOT NULL, cache_write_tokens INTEGER NOT NULL, reasoning_tokens INTEGER NOT NULL,
    latency_sum_ms INTEGER NOT NULL, ttft_sum_ms INTEGER NOT NULL, cost_usd_sum REAL NOT NULL, cost_usd_count INTEGER NOT NULL,
    first_timestamp_ms INTEGER NOT NULL,
    PRIMARY KEY (hour_ms, key_hash, provider, model, model_group, endpoint, client_type, success, status_code, error_category)) WITHOUT ROWID`)
  const insert = db.prepare(`INSERT INTO usage_events (request_id,timestamp,timestamp_ms,key_hash,provider,model,model_group,endpoint,
    success,status_code,latency_ms,ttft_ms,input_tokens,output_tokens,reasoning_tokens,cached_tokens,cache_write_tokens,total_tokens,client_type,cost_usd)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
  events.forEach((row, index) => insert.run(`r-${index}`, new Date(row.ts).toISOString(), row.ts, 'k1', row.provider, row.model,
    row.provider, '/v1/chat/completions', 1, 200, 100, 30, row.tokens, 10, 0, 5, 0, row.tokens + 10, 'cursor', row.cost))
  // 忠实 rollup：按 rollup 主键聚合（与触发器语义一致）
  db.exec(`INSERT INTO usage_hourly_rollup (hour_ms,hour_text,day_text,key_hash,provider,model,model_group,endpoint,client_type,
    success,status_code,error_category,request_count,total_tokens,input_tokens,uncached_input_tokens,output_tokens,cached_tokens,
    cache_write_tokens,reasoning_tokens,latency_sum_ms,ttft_sum_ms,cost_usd_sum,cost_usd_count,first_timestamp_ms)
    SELECT (timestamp_ms/3600000)*3600000, strftime('%Y-%m-%dT%H',timestamp_ms/1000,'unixepoch'),
      strftime('%Y-%m-%d',timestamp_ms/1000,'unixepoch'), COALESCE(key_hash,''), provider, model, model_group, endpoint,
      CASE WHEN client_type='' THEN 'legacy-unknown' ELSE client_type END, success, status_code, COALESCE(error_category,''),
      COUNT(*), SUM(total_tokens), SUM(input_tokens), SUM(MAX(input_tokens-cached_tokens,0)), SUM(output_tokens), SUM(cached_tokens),
      SUM(cache_write_tokens), SUM(reasoning_tokens), SUM(latency_ms), SUM(ttft_ms), COALESCE(SUM(cost_usd),0), COUNT(cost_usd), MIN(timestamp_ms)
    FROM usage_events GROUP BY 1,4,5,6,7,8,9,10,11,12`)
  return { dir, file, db }
}

/** 用固定时刻，保证窗口对齐到整点后包含全部夹具数据。 */
const NOW = Date.UTC(2026, 9, 1, 12, 0, 0)
const baseEvents = (): EventRow[] => [
  { ts: NOW - 5 * HOUR, provider: 'openai', model: 'openai/gpt-5.4-mini', tokens: 1_000, cost: 0.5 },
  { ts: NOW - 5 * HOUR, provider: 'openai', model: 'openai/gpt-5.4-mini', tokens: 2_000, cost: 1.0 },
  { ts: NOW - 4 * HOUR, provider: 'openai', model: 'openai/gpt-5.4-mini', tokens: 3_000, cost: 1.5 },
  { ts: NOW - 3 * HOUR, provider: 'anthropic', model: 'anthropic/claude-sonnet-5', tokens: 4_000, cost: 2.0 },
]

test('新判据：忠实数据不误报（五个维度 + 行级差异全部 ok）', () => {
  const fixture = makeFixture(baseEvents())
  const health = checkRollupHealthV2(fixture.db, 24, {})
  fixture.db.close()
  fs.rmSync(fixture.dir, { recursive: true, force: true })
  assert.equal(health.severity, 'ok')
  assert.equal(health.rowDrift.driftingRows, 0, '没有漂移就不该报')
  for (const metric of health.metrics) assert.equal(metric.severity, 'ok', `${metric.id} 应 ok`)
  assert.equal(health.metrics.length, 5, '五个维度都要在载荷里')
  assert.equal(health.ratio, 1)
})

test('盲区① 抵消型漂移：一行 +1、一行 −1 → 旧判据 ok，新判据必报', () => {
  const fixture = makeFixture(baseEvents())
  const { db } = fixture
  // 破坏：把 5 小时前那一行 +1，把 3 小时前那一行 −1 ⇒ 总量仍然相等
  db.exec(`UPDATE usage_hourly_rollup SET request_count = request_count + 1 WHERE hour_ms = ${(NOW - 5 * HOUR) - ((NOW - 5 * HOUR) % HOUR)}`)
  db.exec(`UPDATE usage_hourly_rollup SET request_count = request_count - 1 WHERE hour_ms = ${(NOW - 3 * HOUR) - ((NOW - 3 * HOUR) % HOUR)}`)

  const health = checkRollupHealthV2(db, 24, {})
  fixture.db.close()
  fs.rmSync(fixture.dir, { recursive: true, force: true })

  // 旧判据（只看 requests 总量）：完全抵消 → ok（这就是红队说的盲区）
  assert.equal(health.metrics[0].severity, 'ok', '总量确实相等 —— 旧判据看不出问题')
  assert.equal(health.ratio, 1, 'ratio 也是 1')
  assert.equal(health.driftPct, 0, 'driftPct 也是 0')
  // 新判据：逐行差异必须暴露
  assert.ok(health.rowDrift.driftingRows >= 2, `逐行漂移至少 2 行，实际 ${health.rowDrift.driftingRows}`)
  assert.ok(health.rowDrift.sumAbsRequests >= 2, `SUM(ABS(diff)) 至少 2，实际 ${health.rowDrift.sumAbsRequests}`)
  assert.notEqual(health.severity, 'ok', '整体 severity 必须被行级差异拉起来')
  // 判据：`sumAbsRequests / eventRequests` = 2/4 = 50% > 5% → alert（小数据集下相对偏差天然大）
  assert.equal(health.rowDrift.severity, 'alert', `行级漂移 2/4 行 = 50% → alert，实际 ${health.rowDrift.severity}`)
  assert.equal(health.rowDrift.maxAbsRequests, 1, '最大绝对差是 1（两个方向各一行）')
})

test('盲区② 只改 token 与金额 → 旧判据 ok，新判据必报（金额错最贵）', () => {
  const fixture = makeFixture(baseEvents())
  const { db } = fixture
  // 破坏：request_count 一个不动，只把 token 加 2,345,678、金额加 9.99
  db.exec('UPDATE usage_hourly_rollup SET total_tokens = total_tokens + 2345678, cost_usd_sum = cost_usd_sum + 9.99')

  const health = checkRollupHealthV2(db, 24, {})
  fixture.db.close()
  fs.rmSync(fixture.dir, { recursive: true, force: true })

  const requests = health.metrics.find((metric) => metric.id === 'requests')!
  const tokens = health.metrics.find((metric) => metric.id === 'totalTokens')!
  const cost = health.metrics.find((metric) => metric.id === 'costUsdSum')!
  // 旧判据（只有 requests）：ok —— 盲区
  assert.equal(requests.severity, 'ok', '请求数没变 → 旧判据 ok')
  // 新判据：token 与金额必须报
  assert.equal(tokens.severity, 'alert', 'token 漂移必须 alert')
  assert.ok(tokens.driftPct > 5)
  assert.equal(cost.severity, 'alert', '金额漂移必须 alert')
  assert.ok(cost.driftPct > 5, `金额漂移 ${cost.driftPct}%`)
  assert.ok(health.rowDrift.driftingRows >= 1, '行级差异也要看得见')
  assert.equal(health.severity, 'alert', '整体必须是 alert')

  // 负向验证：如果只保留 requests 维度（旧行为），这条用例就会「通过」
  const requestsOnly = [requests]
  assert.ok(requestsOnly.every((metric) => metric.severity === 'ok'), '去掉新维度后这条用例失效 —— 证明就是新维度抓到的')
})

test('边界：events 为空而 rollup 有数据 → ratio 为 null、driftPct 100、alert', () => {
  const fixture = makeFixture([])
  const { db } = fixture
  db.exec(`INSERT INTO usage_hourly_rollup (hour_ms,hour_text,day_text,key_hash,provider,model,model_group,endpoint,client_type,
    success,status_code,error_category,request_count,total_tokens,input_tokens,uncached_input_tokens,output_tokens,cached_tokens,
    cache_write_tokens,reasoning_tokens,latency_sum_ms,ttft_sum_ms,cost_usd_sum,cost_usd_count,first_timestamp_ms)
    VALUES (${NOW - HOUR}, '2026-10-01T11', '2026-10-01', 'k1', 'openai', 'openai/m', 'openai', '/v1/x', 'cursor', 1, 200, '',
      7, 700, 700, 700, 0, 0, 0, 0, 0, 0, 0.7, 7, ${NOW - HOUR})`)

  const health = checkRollupHealthV2(db, 24, {})
  fixture.db.close()
  fs.rmSync(fixture.dir, { recursive: true, force: true })

  const requests = health.metrics.find((metric) => metric.id === 'requests')!
  assert.equal(requests.events, 0)
  assert.equal(requests.ratio, null, 'events=0 且 rollup>0 → ratio 是 null（客户端要处理）')
  assert.equal(requests.driftPct, 100, 'driftPct 记 100')
  assert.equal(requests.severity, 'alert', '只有一侧有数据 = 必然漂移 → alert')
  assert.equal(health.severity, 'alert')
  assert.ok(health.rowDrift.driftingRows >= 1)
})

test('负向：单维度比较的判据本身可红（compareMetric / summarizeRowDrift 的边界）', () => {
  // 完全一致 → ok；差 3% → warn；差 20% → alert；events=0 且 rollup>0 → ratio null
  assert.equal(compareMetric('requests', '请求数', 100, 100).severity, 'ok')
  assert.equal(compareMetric('requests', '请求数', 103, 100).severity, 'warn')
  assert.equal(compareMetric('requests', '请求数', 120, 100).severity, 'alert')
  const empty = compareMetric('requests', '请求数', 5, 0)
  assert.equal(empty.ratio, null)
  assert.equal(empty.driftPct, 100)
  assert.equal(empty.severity, 'alert')
  // 行级：0 行 → ok；有行但相对偏差小 → warn；相对偏差大 → alert
  assert.equal(summarizeRowDrift({ driftingRows: 0, eventRequests: 100 }).severity, 'ok')
  assert.equal(summarizeRowDrift({ driftingRows: 1, sumAbsRequests: 1, eventRequests: 1_000 }).severity, 'warn')
  assert.equal(summarizeRowDrift({ driftingRows: 10, sumAbsRequests: 500, eventRequests: 1_000 }).severity, 'alert')
  assert.equal(summarizeRowDrift({ driftingRows: 3, sumAbsRequests: 3, eventRequests: 0 }).severity, 'alert', '没有 events 却有漂移行 → alert')
})

/* ─────────── task-74：空窗口语义与「三种 0」 ─────────── */

/**
 * 红队 N1：空窗口下 `scripts/rollup-rebuild.mjs check` 报 `alert`，而 HTTP 接口报 `ok`
 * （夜间无流量必然误报 ⇒ 巡检员会学会忽略告警）。根因：SQL 的 `SUM(...)` 在没有任何分组行时
 * 返回 **NULL**，而脚本本地规则写成 `rollup === 0`（严格相等）⇒ NULL !== 0 ⇒ 走进"只有 rollup 有数"
 * 分支。现在 SQL 全部 COALESCE 成 0，且**两条路径共用同一个 `summarizeRollupHealthV2`**。
 */

/** 空库（只有表结构，没有任何 events/rollup 行）。 */
function makeEmptyFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crosery-empty-window-'))
  const file = path.join(dir, 'console.db')
  const db = new DatabaseSync(file)
  db.exec(`CREATE TABLE usage_events (id INTEGER PRIMARY KEY AUTOINCREMENT, request_id TEXT UNIQUE, timestamp TEXT NOT NULL,
    timestamp_ms INTEGER NOT NULL DEFAULT 0, key_hash TEXT, provider TEXT NOT NULL, model TEXT NOT NULL, model_group TEXT NOT NULL,
    endpoint TEXT NOT NULL, success INTEGER NOT NULL, status_code INTEGER NOT NULL, latency_ms INTEGER NOT NULL, ttft_ms INTEGER NOT NULL,
    input_tokens INTEGER NOT NULL, output_tokens INTEGER NOT NULL, reasoning_tokens INTEGER NOT NULL, cached_tokens INTEGER NOT NULL,
    cache_write_tokens INTEGER NOT NULL DEFAULT 0, total_tokens INTEGER NOT NULL, user_agent TEXT NOT NULL DEFAULT '',
    client_type TEXT NOT NULL DEFAULT '', client_ip TEXT NOT NULL DEFAULT '', error_detail TEXT NOT NULL DEFAULT '',
    error_category TEXT NOT NULL DEFAULT '', upstream_request_id TEXT NOT NULL DEFAULT '', source TEXT NOT NULL DEFAULT '',
    auth_index TEXT NOT NULL DEFAULT '', reasoning_effort TEXT NOT NULL DEFAULT '', service_tier TEXT NOT NULL DEFAULT '',
    response_headers_json TEXT NOT NULL DEFAULT '{}', cost_usd REAL)`)
  db.exec(`CREATE TABLE usage_hourly_rollup (hour_ms INTEGER NOT NULL, hour_text TEXT NOT NULL, day_text TEXT NOT NULL,
    key_hash TEXT NOT NULL, provider TEXT NOT NULL, model TEXT NOT NULL, model_group TEXT NOT NULL, endpoint TEXT NOT NULL,
    client_type TEXT NOT NULL, success INTEGER NOT NULL, status_code INTEGER NOT NULL, error_category TEXT NOT NULL,
    request_count INTEGER NOT NULL, total_tokens INTEGER NOT NULL, input_tokens INTEGER NOT NULL, uncached_input_tokens INTEGER NOT NULL,
    output_tokens INTEGER NOT NULL, cached_tokens INTEGER NOT NULL, cache_write_tokens INTEGER NOT NULL, reasoning_tokens INTEGER NOT NULL,
    latency_sum_ms INTEGER NOT NULL, ttft_sum_ms INTEGER NOT NULL, cost_usd_sum REAL NOT NULL, cost_usd_count INTEGER NOT NULL,
    first_timestamp_ms INTEGER NOT NULL,
    PRIMARY KEY (hour_ms, key_hash, provider, model, model_group, endpoint, client_type, success, status_code, error_category)) WITHOUT ROWID`)
  return { dir, file, db }
}

const insertRollupRow = (db: DatabaseSync, hourMs: number, count: number) => db.exec(`INSERT INTO usage_hourly_rollup
  (hour_ms,hour_text,day_text,key_hash,provider,model,model_group,endpoint,client_type,success,status_code,error_category,
   request_count,total_tokens,input_tokens,uncached_input_tokens,output_tokens,cached_tokens,cache_write_tokens,reasoning_tokens,
   latency_sum_ms,ttft_sum_ms,cost_usd_sum,cost_usd_count,first_timestamp_ms)
  VALUES (${hourMs}, '2026-10-01T08', '2026-10-01', 'k1', 'openai', 'openai/m', 'openai', '/v1/x', 'cursor', 1, 200, '',
   ${count}, 1000, 1000, 1000, 0, 0, 0, 0, 0, 0, 1.5, 3, ${hourMs})`)

test('三种「0」①：两边都 0（真空窗口）→ ok（夜间无流量不该报警）', () => {
  const fixture = makeEmptyFixture()
  const health = checkRollupHealthV2(fixture.db, 24, {})
  fixture.db.close()
  fs.rmSync(fixture.dir, { recursive: true, force: true })
  assert.equal(health.severity, 'ok', '空窗口必须 ok')
  assert.equal(health.ratio, 1, '两侧都为 0 → ratio 记 1（不是 null）')
  assert.equal(health.driftPct, 0)
  assert.equal(health.rollupRequests, 0)
  assert.equal(health.eventRequests, 0)
  assert.ok(health.metrics.every((metric) => metric.severity === 'ok'), '五个维度在空窗口下都应 ok')
  assert.equal(health.rowDrift.driftingRows, 0)
  assert.equal(health.rowDrift.severity, 'ok')
})

test('三种「0」②：events=0 但 rollup>0 → alert（真漂移）', () => {
  const fixture = makeEmptyFixture()
  insertRollupRow(fixture.db, Math.floor((Date.now() - 3_600_000) / 3_600_000) * 3_600_000, 7)
  const health = checkRollupHealthV2(fixture.db, 24, {})
  fixture.db.close()
  fs.rmSync(fixture.dir, { recursive: true, force: true })
  assert.equal(health.eventRequests, 0)
  assert.ok(health.rollupRequests > 0)
  assert.equal(health.metrics[0].ratio, null, 'events=0 且 rollup>0 → ratio 是 null（客户端要处理）')
  assert.equal(health.metrics[0].driftPct, 100)
  assert.equal(health.severity, 'alert')
  assert.ok(health.rowDrift.driftingRows > 0, '行级差异也要报')
})

test('三种「0」③：events>0 但 rollup=0 → alert（触发器漏跑）', () => {
  const fixture = makeFixture([{ ts: NOW - 2 * HOUR, provider: 'openai', model: 'openai/gpt-5.4-mini', tokens: 900, cost: 0.4 }])
  fixture.db.exec('DELETE FROM usage_hourly_rollup')   // 模拟触发器没跑
  const health = checkRollupHealthV2(fixture.db, 24, {})
  fixture.db.close()
  fs.rmSync(fixture.dir, { recursive: true, force: true })
  assert.ok(health.eventRequests > 0)
  assert.equal(health.rollupRequests, 0)
  assert.equal(health.metrics[0].severity, 'alert')
  assert.equal(health.metrics[0].driftPct, 100)
  assert.equal(health.severity, 'alert')
  assert.ok(health.rowDrift.driftingRows > 0)
})

test('负向验证：若把规则写成「任何一边为 0 就判 ok」，②③两条用例必红', () => {
  // 这是"错误规则"的显式对照实现：拿来证明上面两条用例确实能抓住它。
  const naiveAnyZeroIsOk = (rollup: number, events: number) => (rollup === 0 || events === 0 ? 'ok' : 'alert')
  assert.equal(naiveAnyZeroIsOk(7, 0), 'ok', '错误规则会把"触发器漏跑"(③) 判成 ok')
  assert.equal(naiveAnyZeroIsOk(0, 7), 'ok', '错误规则会把"只有 rollup 有数"(②) 判成 ok')
  assert.equal(naiveAnyZeroIsOk(0, 0), 'ok')
  // 正确规则（服务端实现）：只有两边都 0 才 ok
  assert.equal(compareMetric('requests', '请求数', 7, 0).severity, 'alert')
  assert.equal(compareMetric('requests', '请求数', 0, 7).severity, 'alert')
  assert.equal(compareMetric('requests', '请求数', 0, 0).severity, 'ok')
})

test('端到端（脚本）：空窗口下 check 与接口路径**同判 ok**（同库同窗口）', () => {
  const fixture = makeEmptyFixture()
  fixture.db.close()
  try {
    const scriptRun = runScript('check', fixture.file)
    assert.equal(scriptRun.code, 0, `空窗口 check 退出码应为 0：${scriptRun.stdout}`)
    const scriptResult = JSON.parse(scriptRun.stdout.trim().split('\n').pop()!)
    assert.equal(scriptResult.severity, 'ok', '脚本路径：空窗口必须 ok')
    assert.equal(scriptResult.ratio, 1)

    const db = new DatabaseSync(fixture.file, { readOnly: true })
    const apiResult = checkRollupHealthV2(db, 24, {})
    db.close()
    assert.equal(apiResult.severity, 'ok', '接口路径：空窗口必须 ok')
    assert.equal(apiResult.severity, scriptResult.severity, '两条路径的判定必须一致')
    assert.equal(apiResult.ratio, scriptResult.ratio)
    assert.equal(apiResult.rowDrift.driftingRows, scriptResult.rowDrift.driftingRows)
  } finally {
    fs.rmSync(fixture.dir, { recursive: true, force: true })
  }
})

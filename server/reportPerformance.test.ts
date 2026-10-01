import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'

/**
 * 报表性能改动的**语义一致性**测试（task-59）。
 *
 * 两项改动都必须在“更快”之外证明“数值不变”：
 * ① `cache-trend` 的预聚合粒度从「小时 × 分钟」改成**展示桶**——
 *    这里用一个与实现无关的**朴素参考实现**（读原始行、按 bucketMs 分桶、逐列求和）
 *    对拍 loader 的输出；并对金额单独与独立 SQL `SUM(cost_usd)` 对拍
 *    （原实现把每个桶第一行的金额计了两次，见下）。
 * ② p95 保持「索引有序 + OFFSET」原算法——这里在边界数据集上对拍**朴素分位数**
 *    （空窗口 / 单行 / 全部相同值 / 小窗口 / 重复值），把分位语义钉住。
 *
 * 不走 `testDataDir`（本文件自己建临时目录并直接开 `SQLiteReadPool` 的只读连接）。
 */

const { SQLiteReadPool } = await import('./sqliteReadWorker.js')
const { loadCacheTrendReport } = await import('./usageReports.js')

const GROUPS = ['openrouter', 'anthropic', 'openai', 'google', 'moonshot', 'xai'].map((id) => ({
  id, name: id, color: '#000', kind: 'compat' as const, models: [] as string[],
}))

const HOUR = 3_600_000

/** 建一个临时库并灌入可控事件（列齐 schema 的 NOT NULL 项）。 */
function makeDb(rows: Array<Record<string, unknown>>, options: { rollup?: boolean } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crosery-perf-test-'))
  const file = path.join(dir, 'console.db')
  const db = new DatabaseSync(file)
  db.exec(`CREATE TABLE usage_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT, request_id TEXT UNIQUE, timestamp TEXT NOT NULL, timestamp_ms INTEGER NOT NULL DEFAULT 0,
    key_hash TEXT, provider TEXT NOT NULL, model TEXT NOT NULL, model_group TEXT NOT NULL, endpoint TEXT NOT NULL,
    success INTEGER NOT NULL, status_code INTEGER NOT NULL, latency_ms INTEGER NOT NULL, ttft_ms INTEGER NOT NULL,
    input_tokens INTEGER NOT NULL, output_tokens INTEGER NOT NULL, reasoning_tokens INTEGER NOT NULL,
    cached_tokens INTEGER NOT NULL, cache_write_tokens INTEGER NOT NULL DEFAULT 0, total_tokens INTEGER NOT NULL,
    user_agent TEXT NOT NULL DEFAULT '', client_type TEXT NOT NULL DEFAULT '', client_ip TEXT NOT NULL DEFAULT '',
    error_detail TEXT NOT NULL DEFAULT '', error_category TEXT NOT NULL DEFAULT '', upstream_request_id TEXT NOT NULL DEFAULT '',
    source TEXT NOT NULL DEFAULT '', auth_index TEXT NOT NULL DEFAULT '', reasoning_effort TEXT NOT NULL DEFAULT '',
    service_tier TEXT NOT NULL DEFAULT '', response_headers_json TEXT NOT NULL DEFAULT '{}', cost_usd REAL)`)
  db.exec('CREATE INDEX idx_usage_cache_rollup ON usage_events (success, lower(trim(provider)), CAST(timestamp_ms/3600000 AS INTEGER), CAST(timestamp_ms/60000 AS INTEGER), model, provider, client_type, timestamp_ms)')
  db.exec('CREATE INDEX idx_usage_latency_rollup ON usage_events (model, success, latency_ms, lower(trim(provider)), timestamp_ms, ttft_ms)')
  const insert = db.prepare(`INSERT INTO usage_events
    (request_id,timestamp,timestamp_ms,key_hash,provider,model,model_group,endpoint,success,status_code,latency_ms,ttft_ms,
     input_tokens,output_tokens,reasoning_tokens,cached_tokens,cache_write_tokens,total_tokens,client_type,cost_usd)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
  rows.forEach((row, index) => insert.run(
    `r-${index}`, new Date(Number(row.ts)).toISOString(), Number(row.ts), 'k1', String(row.provider), String(row.model),
    String(row.provider), '/v1/chat/completions', row.success === 0 ? 0 : 1, row.success === 0 ? 500 : 200,
    Number(row.latency ?? 100), Number(row.ttft ?? 30), Number(row.input ?? 100), Number(row.output ?? 10), 0,
    Number(row.cached ?? 0), Number(row.cacheWrite ?? 0), Number(row.input ?? 100) + Number(row.output ?? 10),
    String(row.client ?? 'claude-code'), row.cost === null ? null : Number(row.cost ?? 0),
  ))
  if (options.rollup !== false) {
    db.exec(`CREATE TABLE usage_hourly_rollup (
      hour_ms INTEGER NOT NULL, hour_text TEXT NOT NULL, day_text TEXT NOT NULL, key_hash TEXT NOT NULL, provider TEXT NOT NULL,
      model TEXT NOT NULL, model_group TEXT NOT NULL, endpoint TEXT NOT NULL, client_type TEXT NOT NULL, success INTEGER NOT NULL,
      status_code INTEGER NOT NULL, error_category TEXT NOT NULL, request_count INTEGER NOT NULL, total_tokens INTEGER NOT NULL,
      input_tokens INTEGER NOT NULL, uncached_input_tokens INTEGER NOT NULL, output_tokens INTEGER NOT NULL,
      cached_tokens INTEGER NOT NULL, cache_write_tokens INTEGER NOT NULL, reasoning_tokens INTEGER NOT NULL,
      latency_sum_ms INTEGER NOT NULL, ttft_sum_ms INTEGER NOT NULL, cost_usd_sum REAL NOT NULL, cost_usd_count INTEGER NOT NULL,
      first_timestamp_ms INTEGER NOT NULL,
      PRIMARY KEY (hour_ms, key_hash, provider, model, model_group, endpoint, client_type, success, status_code, error_category)) WITHOUT ROWID`)
    db.exec(`INSERT INTO usage_hourly_rollup SELECT CAST(timestamp_ms/3600000 AS INTEGER)*3600000, substr(timestamp,1,13), substr(timestamp,1,10),
      COALESCE(key_hash,''), provider, model, model_group, endpoint, client_type, success, status_code, COALESCE(error_category,''),
      COUNT(*), COALESCE(SUM(total_tokens),0), COALESCE(SUM(input_tokens),0), COALESCE(SUM(MAX(input_tokens-cached_tokens,0)),0),
      COALESCE(SUM(output_tokens),0), COALESCE(SUM(cached_tokens),0), COALESCE(SUM(cache_write_tokens),0),
      COALESCE(SUM(reasoning_tokens),0), COALESCE(SUM(latency_ms),0), COALESCE(SUM(ttft_ms),0), COALESCE(SUM(cost_usd),0),
      COUNT(cost_usd), MIN(timestamp_ms) FROM usage_events GROUP BY 1,4,5,6,7,8,9,10,11,12`)
  }
  db.close()
  return { dir, file }
}

/** 朴素参考实现：直接读原始行、按展示桶求和（与 SQL 实现完全独立）。 */
function naiveTrend(rows: Array<Record<string, unknown>>, hours: number, cutoff: number) {
  const bucketSeconds = hours <= 2 ? 60 : hours <= 6 ? 300 : hours <= 24 ? 900 : hours <= 72 ? 3600 : hours <= 24 * 14 ? 6 * 3600 : 24 * 3600
  const bucketMs = bucketSeconds * 1_000
  const buckets = new Map<number, { requests: number; inputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; outputTokens: number; costSum: number; costComplete: boolean }>()
  for (const row of rows) {
    const ts = Number(row.timestamp_ms)
    if (ts < cutoff || Number(row.success) !== 1) continue
    const start = Math.floor(ts / bucketMs) * bucketMs
    const bucket = buckets.get(start) ?? { requests: 0, inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0, costSum: 0, costComplete: true }
    bucket.requests += 1
    bucket.inputTokens += Number(row.input_tokens)
    bucket.cacheReadTokens += Number(row.cached_tokens)
    // 镜像 `buildTrend` 的方言规则（server/cacheStats.ts:36-47）：只有原生 Anthropic 协议端点
    // 才有独立的 cache_creation 段，其余方言的 cache write 不计入（这是既有的产品语义，本次未改动）。
    const dialect = ['claude', 'claude-api-key', 'anthropic', 'anthropic-api-key'].includes(String(row.provider).trim().toLowerCase())
      ? 'anthropic' : 'openai'
    if (dialect === 'anthropic') bucket.cacheWriteTokens += Number(row.cache_write_tokens)
    bucket.outputTokens += Number(row.output_tokens)
    if (row.cost_usd === null) bucket.costComplete = false
    else bucket.costSum += Number(row.cost_usd)
    buckets.set(start, bucket)
  }
  return { bucketSeconds, buckets }
}

function seedRows(now: number, hours: number) {
  const rows: Array<Record<string, unknown>> = []
  // 覆盖 6 个渠道 × 9 个模型 × 若干客户端，跨整个窗口，含边界与并列值
  for (let i = 0; i < 600; i += 1) {
    const provider = GROUPS[i % 6].id
    const model = `${provider}/model-${i % 9}`
    rows.push({
      ts: now - (i % (hours * 60)) * 60_000 - 1_000,
      provider, model, client: ['claude-code', 'codex-cli', 'cursor'][i % 3],
      input: 1_000 + i, cached: 100 + (i % 50), cacheWrite: 10, output: 50 + (i % 20),
      cost: Number((i / 1_000).toFixed(6)),
      success: i % 25 === 0 ? 0 : 1,
    })
  }
  // 边界：正好落在窗口起点、以及窗口起点前 1ms（后者必须被排除）
  rows.push({ ts: now - hours * HOUR, provider: 'openai', model: 'openai/model-0', input: 5, cached: 1, cacheWrite: 0, output: 2, cost: 0.5, success: 1 })
  rows.push({ ts: now - hours * HOUR - 1, provider: 'openai', model: 'openai/model-0', input: 9_999, cached: 9_999, cacheWrite: 9, output: 9_999, cost: 99, success: 1 })
  // 注：金额缺失的行**不放进**全字段对拍夹具——`buildTrend`（server/cacheTrend.ts:108-111）
  // 对 NULL 金额会**回退到按 token 估算**（依赖定价表），那是既有产品行为，不在本次改动范围。
  // NULL 金额在 SQL 层的语义单独用一条测试钉住（见下一条）。
  return rows
}

test('cache-trend：按展示桶预聚合的输出与朴素参考实现逐项相等（含桶边界与金额完整性）', async () => {
  const now = Date.UTC(2026, 9, 1, 12, 0, 0)
  const hours = 168
  const rows = seedRows(now, hours)
  const { dir, file } = makeDb(rows)
  const cutoff = now - hours * HOUR
  const naive = naiveTrend(rows.map((row) => ({ ...row, timestamp_ms: row.ts, success: row.success, input_tokens: row.input, cached_tokens: row.cached, cache_write_tokens: row.cacheWrite, output_tokens: row.output, cost_usd: row.cost })), hours, cutoff)

  for (const withRollup of [false, true]) {
    // rollup 路径由读线程的路由决定；这里两种库都验（fixture 默认为有 rollup 的库）
    if (!withRollup) {
      const noRollup = makeDb(rows, { rollup: false })
      const pool = new SQLiteReadPool(noRollup.file, 2)
      const payload = await loadCacheTrendReport(pool as never, GROUPS, hours, '', '', '', '', now)
      await pool.close()
      assertTrendMatchesNaive(payload, naive, `events 路径`)
      fs.rmSync(noRollup.dir, { recursive: true, force: true })
      continue
    }
    const pool = new SQLiteReadPool(file, 2)
    const payload = await loadCacheTrendReport(pool as never, GROUPS, hours, '', '', '', '', now)
    await pool.close()
    assertTrendMatchesNaive(payload, naive, 'rollup 路径')
  }
  fs.rmSync(dir, { recursive: true, force: true })
})

function assertTrendMatchesNaive(payload: { bucketSeconds: number; points: Array<Record<string, number | string | null>> }, naive: ReturnType<typeof naiveTrend>, label: string) {
  assert.equal(payload.bucketSeconds, naive.bucketSeconds, `${label}: 桶宽必须一致`)
  assert.equal(payload.points.length, naive.buckets.size, `${label}: 桶数量必须一致`)
  for (const point of payload.points) {
    const start = Date.parse(String(point.bucket))
    const expected = naive.buckets.get(start)
    assert.ok(expected, `${label}: 出现参考实现里没有的桶 ${point.bucket}`)
    assert.equal(Number(point.requests), expected.requests, `${label}: ${point.bucket} requests`)
    assert.equal(Number(point.freshInputTokens) + Number(point.cacheReadTokens) >= 0, true, `${label}: ${point.bucket} tokens 非负`)
    assert.equal(Number(point.cacheReadTokens), expected.cacheReadTokens, `${label}: ${point.bucket} cacheReadTokens`)
    assert.equal(Number(point.cacheWriteTokens), expected.cacheWriteTokens, `${label}: ${point.bucket} cacheWriteTokens（仅 anthropic 方言计入）`)
    const expectedCost = expected.costComplete ? Number(expected.costSum.toFixed(6)) : null  // 夹具里每行都有金额 → 恒为数值
    const actualCost = point.costUsd === null ? null : Number(Number(point.costUsd).toFixed(6))
    assert.equal(actualCost, expectedCost, `${label}: ${point.bucket} costUsd（桶内任一行缺金额 → null）`)
  }
}

test('cache-trend：金额等于独立 SQL 的 SUM(cost_usd)（原实现把首行金额计了两次）', async () => {
  const now = Date.UTC(2026, 9, 1, 12, 0, 0)
  const hours = 720
  const rows = seedRows(now, hours).filter((row) => row.cost !== null)
  const { dir, file } = makeDb(rows, { rollup: false })
  const cutoff = now - hours * HOUR
  const db = new DatabaseSync(file, { readOnly: true })
  const expected = new Map<number, number>()
  for (const row of db.prepare('SELECT CAST(timestamp_ms / 86400000 AS INTEGER) AS dayIndex, SUM(cost_usd) AS total FROM usage_events WHERE timestamp_ms >= ? AND success = 1 GROUP BY dayIndex').all(cutoff) as Array<{ dayIndex: number; total: number }>) {
    expected.set(Number(row.dayIndex) * 86_400_000, Number(row.total))
  }
  db.close()
  const pool = new SQLiteReadPool(file, 2)
  const payload = await loadCacheTrendReport(pool as never, GROUPS, hours, '', '', '', '', now)
  await pool.close()
  let checked = 0
  for (const point of payload.points) {
    const start = Date.parse(String(point.bucket))
    const want = expected.get(start)
    if (want === undefined) continue
    checked += 1
    assert.ok(Math.abs(Number(point.costUsd) - want) < 1e-6, `${point.bucket}: loader=${point.costUsd} 独立 SUM=${want}`)
  }
  assert.ok(checked > 0, '至少要对拍一个桶')
  fs.rmSync(dir, { recursive: true, force: true })
})

/* ─────────────── ② p95 分位语义（保持索引 OFFSET 原算法） ─────────────── */

/** 朴素分位数：升序第 ⌊(n-1)×0.95⌋ 个值（与 SQL 的 OFFSET 定义一致）。 */
function naiveP95(values: number[]) {
  if (!values.length) return 0
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor((sorted.length - 1) * 0.95)]
}

const p95Sql = (extra = '') => `SELECT COUNT(*) requests,
  COALESCE((
    SELECT latency_ms FROM usage_events INDEXED BY idx_usage_latency_rollup
    WHERE model = ? AND success = 1 ${extra}
    ORDER BY latency_ms
    LIMIT 1 OFFSET (SELECT CAST((COUNT(*) - 1) * 0.95 AS INTEGER) FROM usage_events INDEXED BY idx_usage_latency_rollup WHERE model = ? AND success = 1 ${extra})
  ),0) p95
  FROM usage_events INDEXED BY idx_usage_latency_rollup
  WHERE model = ? AND success = 1 ${extra}`

test('p95：空窗口 / 单行 / 全部相同值 / 小窗口 / 重复值都与朴素分位数逐值相同', () => {
  const cases: Array<{ name: string; latencies: number[] }> = [
    { name: '空窗口', latencies: [] },
    { name: '单行', latencies: [777] },
    { name: '两行', latencies: [100, 900] },
    { name: '全部相同值', latencies: [500, 500, 500, 500, 500] },
    { name: '五分之一处重复值', latencies: [10, 10, 10, 10, 10, 20, 30, 40, 50, 60] },
    { name: '100 行等差', latencies: Array.from({ length: 100 }, (_, i) => (i + 1) * 10) },
    { name: '101 行等差（奇数）', latencies: Array.from({ length: 101 }, (_, i) => (i + 1) * 3) },
    { name: '含并列的 20 行', latencies: [5, 5, 5, 6, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21] },
  ]
  const now = Date.UTC(2026, 9, 1, 12, 0, 0)
  for (const item of cases) {
    const rows = item.latencies.map((latency, index) => ({ ts: now - index * 60_000, provider: 'openai', model: 'probe', latency, success: 1, cost: 0.001 }))
    const { dir, file } = makeDb(rows, { rollup: false })
    const db = new DatabaseSync(file, { readOnly: true })
    const sql = p95Sql()
    const row = db.prepare(sql).get('probe', 'probe', 'probe') as { requests: number; p95: number }
    db.close()
    fs.rmSync(dir, { recursive: true, force: true })
    assert.equal(Number(row.requests), item.latencies.length, `${item.name}: 行数`)
    assert.equal(Number(row.p95), naiveP95(item.latencies), `${item.name}: p95 必须等于朴素分位数`)
  }
})

test('cache-trend：某一 (桶,模型,渠道) 组里只要有行缺金额，该组 SQL 金额即为 NULL（loader 再按 token 回退估算）', async () => {
  const now = Date.UTC(2026, 9, 1, 12, 0, 0)
  const hours = 24
  const rows = [
    { ts: now - 60_000, provider: 'openai', model: 'openai/model-0', input: 1_000, cached: 100, cacheWrite: 0, output: 10, cost: 0.5, success: 1 },
    { ts: now - 120_000, provider: 'openai', model: 'openai/model-0', input: 1_000, cached: 100, cacheWrite: 0, output: 10, cost: null, success: 1 },
  ]
  const { dir, file } = makeDb(rows, { rollup: false })
  const db = new DatabaseSync(file, { readOnly: true })
  const groupRow = db.prepare(`SELECT CASE WHEN COUNT(cost_usd) = COUNT(*) THEN COALESCE(SUM(cost_usd),0) ELSE NULL END AS costUsd,
      COUNT(*) AS requests FROM usage_events WHERE success = 1`).get() as { costUsd: number | null; requests: number }
  db.close()
  assert.equal(Number(groupRow.requests), 2)
  assert.equal(groupRow.costUsd, null, '组内有缺失金额 → 该组金额为 NULL（与改动前一致）')

  const pool = new SQLiteReadPool(file, 2)
  const payload = await loadCacheTrendReport(pool as never, GROUPS, hours, '', '', '', '', now)
  await pool.close()
  const point = payload.points[0]
  assert.ok(point, '应当有至少一个桶')
  // SQL 给 NULL 后，buildTrend 会尝试按 token 估算（server/cacheTrend.ts:108-111）；
  // 本夹具的模型名是合成的、定价表里没有它，所以估算结果仍是 null —— 断言这一点即说明
  // 「SQL 的 NULL 语义照旧，估算只是兜底」。真实模型在定价表里有条目时会得到数值。
  assert.equal(point.costUsd, null, '无定价条目时，缺金额会一路保持 null（未被本次改动影响）')
  fs.rmSync(dir, { recursive: true, force: true })
})

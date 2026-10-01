import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'

/**
 * 读线程的**路由与参数契约**测试（task-62 ②）。
 *
 * 背景：`server/sqliteReadWorker.mjs` 会按**SQL 文本**决定是否把查询改写到 `usage_hourly_rollup`，
 * 并按**位置**读取参数（`params[0]`=cutoff、`params[2]`=provider、`params[3]`=key）。
 * 这类「字符串契约 + 位置参数」有两个危险失败模式，2026-10-01（task-59）我都踩过：
 * 1. 多绑一个占位符 → 查询**静默返回空结果**且变快（0.4ms），不报错；
 * 2. 位置错位 → 结果错但不报错。
 * 因此这里做三件事：
 * - **逐行**比对直连 `DatabaseSync` 与经读线程池的结果（不是只比行数）；
 * - 把「哪些 SQL 文本会被路由」写死成测试（改 SQL 文本会红）；
 * - 参数个数与占位符不匹配时必须是**显式错误**（含负向验证）。
 *
 * 本文件不引入 `./testDataDir.js`：自己建临时目录与库文件。
 */

const { SQLiteReadPool } = await import('./sqliteReadWorker.js')
const REPORTS = await import('./usageReports.js')

const GROUPS = ['openrouter', 'anthropic', 'openai', 'google', 'moonshot', 'xai'].map((id) => ({
  id, name: id, color: '#000', kind: 'compat' as const, models: [] as string[],
}))

type Fixture = { dir: string; file: string }

/** 建一个小库：usage_events + cache/latency 索引，可选 rollup 表（按小时从 events 聚合）。 */
function makeFixture(now: number, options: { rollup?: boolean; hours?: number } = {}): Fixture {
  const hours = options.hours ?? 168
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crosery-worker-contract-'))
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
  db.exec('CREATE INDEX idx_usage_cache_rollup ON usage_events (success, lower(trim(provider)), CAST(timestamp_ms/3600000 AS INTEGER), CAST(timestamp_ms/60000 AS INTEGER), model, provider, client_type, timestamp_ms, input_tokens, cached_tokens, cache_write_tokens, output_tokens)')
  db.exec('CREATE INDEX idx_usage_latency_rollup ON usage_events (model, success, latency_ms, lower(trim(provider)), timestamp_ms, ttft_ms)')
  const insert = db.prepare(`INSERT INTO usage_events
    (request_id,timestamp,timestamp_ms,key_hash,provider,model,model_group,endpoint,success,status_code,latency_ms,ttft_ms,
     input_tokens,output_tokens,reasoning_tokens,cached_tokens,cache_write_tokens,total_tokens,client_type,cost_usd)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
  // 事件按小时铺开：每小时 20 条，跨 6 个渠道/3 个客户端
  const total = hours * 20
  for (let i = 0; i < total; i += 1) {
    const ts = now - (hours * 3_600_000) + i * 180_000 + 1_000
    const provider = GROUPS[i % 6].id
    insert.run(`r-${i}`, new Date(ts).toISOString(), ts, 'k1', provider, `${provider}/model-${i % 3}`, provider,
      '/v1/chat/completions', 1, 200, 100 + (i % 500), 30, 1_000 + i, 50, 0, 100 + (i % 50), 5, 1_050 + i,
      ['claude-code', 'cursor', 'codex-cli'][i % 3], 0.001 * (i % 7))
  }
  if (options.rollup) {
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

/** 用 FakeReader 取出 loader 实际下发的 SQL + 参数（不执行），用于直连 vs 经池对比。 */
function captureOperations(reader: { operations: Array<{ sql: string; params: unknown[] }> }) {
  return reader.operations
}

const fakeReader = (groups: string[] = GROUPS.map((group) => group.id)) => {
  const operations: Array<{ sql: string; params: unknown[] }> = []
  return {
    operations,
    run: async (ops: Array<{ sql: string; params?: unknown[] }>) => {
      // 产出与 groups 等长的空结果集，只为把 SQL/参数记录下来
      operations.push(...ops.map((op) => ({ sql: op.sql, params: (op.params ?? []) as unknown[] })))
      return groups.map(() => [])
    },
    runParallel: async (ops: Array<{ sql: string; params?: unknown[] }>) => {
      operations.push(...ops.map((op) => ({ sql: op.sql, params: (op.params ?? []) as unknown[] })))
      return groups.map(() => [])
    },
  }
}

/**
 * 行对象归一化：直连 `DatabaseSync` 返回的行是 **null 原型对象**，而跨读线程回来的行是
 * structured-clone 之后的**普通对象**。两者值相同但原型不同，`assert.deepEqual`
 * （= deepStrictEqual）会因此失败 —— 逐行比较前先归一化。
 */
const plain = <T extends Record<string, unknown>>(rows: T[]) => rows.map((row) => ({ ...row }))

const directRows = (file: string, sql: string, params: unknown[]) => {
  const db = new DatabaseSync(file, { readOnly: true })
  const rows = db.prepare(sql).all(...(params as never[]))
  db.close()
  return rows
}

test('契约：cache-trend 的 SQL 文本带 `INDEXED BY idx_usage_cache_rollup`（路由的判定依据）', async () => {
  const now = Date.UTC(2026, 9, 1, 12, 0, 0)
  const reader = fakeReader()
  await REPORTS.loadCacheTrendReport(reader as never, GROUPS, 168, '', '', '', '', now)
  const [operation] = captureOperations(reader)
  assert.ok(operation, 'loader 必须至少下发一条查询')
  // 路由判定就是靠这个 hint 字符串：改了它，rollup 路径静默失效（回落到 events）
  assert.match(operation.sql, /INDEXED BY idx_usage_cache_rollup/)
  // 参数表的位置契约：读线程按位置读 params[0]=cutoff、params[2]=provider
  assert.equal(operation.params.length, 3, '不带 keyId 时应是 3 个参数（cutoff, cutoff, provider）')
  assert.equal(Number(operation.params[0]), now - 168 * 3_600_000, 'params[0] 必须是 cutoff')
  assert.equal(operation.params[2], [...GROUPS.map((group) => group.id)].sort()[0], 'params[2] 必须是渠道名（activeProviderValues 会排序）')
})

test('契约：不命中路由的查询，直连与经池**逐行相等**', async () => {
  const now = Date.UTC(2026, 9, 1, 12, 0, 0)
  const fixture = makeFixture(now, { rollup: true })
  const pool = new SQLiteReadPool(fixture.file, 2)
  try {
    // latency 明细：带 idx_usage_latency_rollup hint，不该被 cache 路由命中
    // 顺序必须确定：latency_ms 有大量并列值，仅 ORDER BY latency_ms 时两次执行的行序可能不同
    const sql = `SELECT id, provider, client_type, latency_ms FROM usage_events INDEXED BY idx_usage_latency_rollup
      WHERE model = ? AND success = 1 AND timestamp_ms >= ? ORDER BY latency_ms, id LIMIT 50`
    const params = ['openrouter/model-0', now - 168 * 3_600_000]
    const expected = directRows(fixture.file, sql, params)
    const [pooled] = await pool.run([{ method: 'all', sql, params }])
    assert.deepEqual(plain(pooled as Array<Record<string, unknown>>), plain(expected as Array<Record<string, unknown>>),
      '直连与经池必须逐行相同（归一化原型后比较值）')
    assert.ok(expected.length > 0, '夹具应产生非空结果，否则这条测试没有意义')
  } finally {
    await pool.close()
    fs.rmSync(fixture.dir, { recursive: true, force: true })
  }
})

test('契约：命中路由时，经池结果必须等于「独立写的 rollup 查询」（逐行相等，且桶值按小时对齐）；无窗口标记 → 维持路由（安全默认）', async () => {
  const now = Date.UTC(2026, 9, 1, 12, 0, 0)
  const hours = 24
  const fixture = makeFixture(now, { rollup: true, hours })
  const cutoff = now - hours * 3_600_000
  const pool = new SQLiteReadPool(fixture.file, 2)
  try {
    const sql = `SELECT CAST(timestamp_ms / 900000 AS INTEGER) * 15 minuteBucket,
      model, provider, client_type clientType, MIN(timestamp_ms) firstTimestampMs, COUNT(*) requests
      FROM usage_events INDEXED BY idx_usage_cache_rollup
      WHERE timestamp_ms >= ? AND CAST(timestamp_ms / 3600000 AS INTEGER) >= CAST(? / 3600000 AS INTEGER)
        AND success = 1 AND lower(trim(provider)) = ?
      GROUP BY CAST(timestamp_ms / 900000 AS INTEGER) * 15, model, provider, client_type`
    const [pooled] = await pool.run([{ method: 'all', sql, params: [cutoff, cutoff, 'openrouter'] }])
    const rows = pooled as Array<Record<string, unknown>>
    assert.ok(rows.length > 0, '路由后必须有行')

    // 独立写一条等价的 rollup 查询：worker 的改写是否忠实，就靠这条对齐
    const expected = directRows(fixture.file, `SELECT (hour_ms / 60000) AS minuteBucket,
      CASE WHEN instr(model,'/')>0 THEN substr(model, instr(model,'/')+1) ELSE model END model, provider,
      client_type clientType, first_timestamp_ms firstTimestampMs, SUM(request_count) requests,
      COALESCE(SUM(input_tokens),0) inputTokens,
      COALESCE(SUM(uncached_input_tokens),0) uncachedInputTokens,
      COALESCE(SUM(cached_tokens),0) cacheReadTokens,
      COALESCE(SUM(cache_write_tokens),0) cacheWriteTokens,
      COALESCE(SUM(output_tokens),0) outputTokens,
      CASE WHEN SUM(cost_usd_count) = SUM(request_count) THEN COALESCE(SUM(cost_usd_sum),0) ELSE NULL END costUsd
      FROM usage_hourly_rollup WHERE hour_ms >= ? AND success = 1 AND lower(trim(provider)) = ?
      GROUP BY hour_ms, CASE WHEN instr(model,'/')>0 THEN substr(model, instr(model,'/')+1) ELSE model END, provider, client_type`,
    [cutoff, 'openrouter'])
    const canon = (list: Array<Record<string, unknown>>) => list.map((row) => JSON.stringify(row)).sort()
    assert.deepEqual(canon(rows), canon(expected), '路由结果必须与独立 rollup 查询逐行相同（含全部聚合列）')

    // 路由**发生了**的可判定证据：rollup 行按小时聚合，minuteBucket 全是 60 的整数倍（events 路径是 15 分钟粒度，不会全是）
    for (const row of rows) assert.equal(Number(row.minuteBucket) % 60, 0, `minuteBucket 应按小时对齐：${row.minuteBucket}`)
  } finally {
    await pool.close()
    fs.rmSync(fixture.dir, { recursive: true, force: true })
  }
})

test('契约：去掉 hint 后同一 SQL 不再被路由（字符串契约的可红性）', async () => {
  const now = Date.UTC(2026, 9, 1, 12, 0, 0)
  const hours = 24
  const fixture = makeFixture(now, { rollup: true, hours })
  const cutoff = now - hours * 3_600_000
  const pool = new SQLiteReadPool(fixture.file, 2)
  try {
    const groupBy = 'CAST(timestamp_ms / 900000 AS INTEGER) * 15'
    // 路由路径按**位置**读参数：params[0]=cutoff、params[2]=provider。所以调用方的参数表必须是
    // `[cutoff, cutoff, provider]`（这正是 loader 的形状）；只给 2 个参数会因 params[2] 缺失而显式报错。
    const withHint = `SELECT ${groupBy} minuteBucket, COUNT(*) requests FROM usage_events INDEXED BY idx_usage_cache_rollup
      WHERE timestamp_ms >= ? AND CAST(timestamp_ms / 3600000 AS INTEGER) >= CAST(? / 3600000 AS INTEGER)
        AND success = 1 AND lower(trim(provider)) = ? GROUP BY ${groupBy}`
    const withoutHint = `SELECT ${groupBy} minuteBucket, COUNT(*) requests FROM usage_events
      WHERE timestamp_ms >= ? AND CAST(timestamp_ms / 3600000 AS INTEGER) >= CAST(? / 3600000 AS INTEGER)
        AND success = 1 AND lower(trim(provider)) = ? GROUP BY ${groupBy}`
    const params = [cutoff, cutoff, 'openrouter']
    const [routed] = await pool.run([{ method: 'all', sql: withHint, params }])
    const [plain] = await pool.run([{ method: 'all', sql: withoutHint, params }])
    const routedRows = routed as Array<{ minuteBucket: number }>
    const plainRows = plain as Array<{ minuteBucket: number }>
    assert.ok(routedRows.length > 0 && plainRows.length > 0)
    assert.ok(routedRows.every((row) => Number(row.minuteBucket) % 60 === 0), '带 hint → 走 rollup（小时对齐）')
    assert.ok(plainRows.some((row) => Number(row.minuteBucket) % 60 !== 0), '不带 hint → 走 events（15 分钟粒度）')
    // 值也不同：这条断言的作用是「一旦有人删掉/改掉 hint，测试会红」
    assert.notDeepEqual(routedRows, plainRows, '路由与不路由的结果形状不同 —— hint 是契约的一部分')
  } finally {
    await pool.close()
    fs.rmSync(fixture.dir, { recursive: true, force: true })
  }
})

test('契约（task-63）：路由判据 = 窗口宽度 + hint；短窗口即使带 hint 也不路由（拿回细粒度）', async () => {
  const now = Date.UTC(2026, 9, 1, 12, 0, 0)
  const hours = 24
  const fixture = makeFixture(now, { rollup: true, hours })
  const cutoff = now - hours * 3_600_000
  const pool = new SQLiteReadPool(fixture.file, 2)
  const build = (marker?: number) => `SELECT CAST(timestamp_ms / 900000 AS INTEGER) * 15 minuteBucket, COUNT(*) requests
      FROM usage_events INDEXED BY idx_usage_cache_rollup${marker === undefined ? '' : ` /* cache-trend-window-hours:${marker} */`}
      WHERE timestamp_ms >= ? AND CAST(timestamp_ms / 3600000 AS INTEGER) >= CAST(? / 3600000 AS INTEGER)
        AND success = 1 AND lower(trim(provider)) = ? GROUP BY CAST(timestamp_ms / 900000 AS INTEGER) * 15`
  const params = [cutoff, cutoff, 'openrouter']
  const minuteAligned = (rows: Array<{ minuteBucket: number }>) => rows.some((row) => Number(row.minuteBucket) % 60 !== 0)
  try {
    const [short] = await pool.run([{ method: 'all', sql: build(24), params }])
    assert.ok(minuteAligned(short as Array<{ minuteBucket: number }>), 'hours=24（15 分钟桶）必须走 events → 出现非整点的桶')
    const [boundary] = await pool.run([{ method: 'all', sql: build(168), params }])
    assert.ok(minuteAligned(boundary as Array<{ minuteBucket: number }>), 'hours=168 是阈值边界（>168 才路由）→ 仍走 events')
    const [long] = await pool.run([{ method: 'all', sql: build(720), params }])
    assert.ok(!minuteAligned(long as Array<{ minuteBucket: number }>), 'hours=720 超过阈值 → 走 rollup（小时对齐）')
    const [noMarker] = await pool.run([{ method: 'all', sql: build(undefined), params }])
    assert.ok(!minuteAligned(noMarker as Array<{ minuteBucket: number }>), '没有窗口标记时维持原行为（路由）——避免"忘记加注释就静默换路径"')
  } finally {
    await pool.close()
    fs.rmSync(fixture.dir, { recursive: true, force: true })
  }
})

test('契约（task-63）：短窗口下 loader 在「有 rollup」与「无 rollup」的库上产出完全相同的负载（细粒度已恢复）', async () => {
  const now = Date.UTC(2026, 9, 1, 12, 0, 0)
  const hours = 24
  const withRollup = makeFixture(now, { rollup: true, hours })
  const withoutRollup = makeFixture(now, { rollup: false, hours })
  const poolA = new SQLiteReadPool(withRollup.file, 2)
  const poolB = new SQLiteReadPool(withoutRollup.file, 2)
  try {
    const routed = await REPORTS.loadCacheTrendReport(poolA as never, GROUPS, hours, '', '', '', '', now)
    const events = await REPORTS.loadCacheTrendReport(poolB as never, GROUPS, hours, '', '', '', '', now)
    assert.equal(routed.bucketSeconds, 900, '24h 窗口应当是 15 分钟桶')
    assert.ok(routed.points.length > 90, `细粒度必须恢复（15 分钟桶），实际 ${routed.points.length} 个点`)
    assert.deepEqual(routed.points, events.points, '两个库的负载必须逐项相同')
  } finally {
    await poolA.close()
    await poolB.close()
    fs.rmSync(withRollup.dir, { recursive: true, force: true })
    fs.rmSync(withoutRollup.dir, { recursive: true, force: true })
  }
})

test('负向：参数少于占位符必须显式报错（而不能静默返回空结果）', async () => {
  const now = Date.UTC(2026, 9, 1, 12, 0, 0)
  const fixture = makeFixture(now, { rollup: false, hours: 2 })
  const pool = new SQLiteReadPool(fixture.file, 2)
  try {
    const sql = 'SELECT COUNT(*) n FROM usage_events WHERE success = 1 AND provider = ? AND client_type = ?'
    // 先证明直连会**静默**把缺的参数当 NULL（这就是我们必须在读线程里挡住的行为）
    const silent = directRows(fixture.file, sql, ['openrouter'])
    assert.equal(Number((silent[0] as { n: number }).n), 0, '直连时缺参数被当作 NULL → 静默 0 行（这正是危险点）')
    await assert.rejects(
      () => pool.run([{ method: 'all', sql, params: ['openrouter'] }]),
      /参数个数与占位符不匹配|需要 2 个/,
      '经读线程池必须显式报错',
    )
    // 参数过多同样显式报错
    await assert.rejects(
      () => pool.run([{ method: 'all', sql, params: ['openrouter', 'cursor', 'extra'] }]),
      /参数个数与占位符不匹配|需要 2 个/,
    )
    // 正确个数仍然可用（负向验证不能把正常路径也挡掉）
    const [ok] = await pool.run([{ method: 'all', sql, params: ['openrouter', 'cursor'] }])
    assert.ok(Array.isArray(ok))
  } finally {
    await pool.close()
    fs.rmSync(fixture.dir, { recursive: true, force: true })
  }
})

test('负向：占位符计数会跳过字符串字面量与注释里的 `?`', async () => {
  const now = Date.UTC(2026, 9, 1, 12, 0, 0)
  const fixture = makeFixture(now, { rollup: false, hours: 2 })
  const pool = new SQLiteReadPool(fixture.file, 2)
  try {
    // 字面量里有两个 `?`，真正的占位符只有 1 个 → 传 1 个参数必须成功
    const sql = "SELECT COUNT(*) n FROM usage_events WHERE success = 1 AND client_type = '?' /* ? */ AND provider = ?"
    const [ok] = await pool.run([{ method: 'all', sql, params: ['openrouter'] }])
    assert.ok(Array.isArray(ok), '字面量/注释里的 ? 不能被算成占位符')
    // 传 2 个 → 显式报错（说明计数确实只认 1 个真占位符）
    await assert.rejects(() => pool.run([{ method: 'all', sql, params: ['openrouter', 'x'] }]), /参数个数与占位符不匹配/)
  } finally {
    await pool.close()
    fs.rmSync(fixture.dir, { recursive: true, force: true })
  }
})

test('跨路径一致性（task-63 更新）：168h 及以下两条路径完全一致；720h 仍路由，首个不完整小时的差异是已被接受的既有语义', async () => {
  // 短/中窗口：判据是「窗口宽度 + hint」，168h 不超过阈值 ⇒ 有 rollup 的库也不路由 ⇒ 两条路径**完全相同**
  //（顺带修掉了 task-62 记录的「首个不完整小时整点丢弃」——它在 ≤168h 窗口上不再出现）。
  const now = Date.UTC(2026, 9, 1, 7, 38, 36)
  const hours = 168
  const withRollup = makeFixture(now, { rollup: true, hours })
  const withoutRollup = makeFixture(now, { rollup: false, hours })
  const poolA = new SQLiteReadPool(withRollup.file, 2)
  const poolB = new SQLiteReadPool(withoutRollup.file, 2)
  const quantize = (point: Record<string, unknown>) => Object.fromEntries(
    Object.entries(point).map(([key, value]) => [key, typeof value === 'number' ? Number(value.toFixed(6)) : value]),
  )
  try {
    const routed = await REPORTS.loadCacheTrendReport(poolA as never, GROUPS, hours, '', '', '', '', now)
    const events = await REPORTS.loadCacheTrendReport(poolB as never, GROUPS, hours, '', '', '', '', now)
    assert.equal(routed.points.length, events.points.length)
    for (const index of routed.points.keys()) {
      assert.deepEqual(quantize(routed.points[index]), quantize(events.points[index]), `168h 第 ${index} 个桶必须逐字段相等（已不路由）`)
    }
  } finally {
    await poolA.close()
    await poolB.close()
    fs.rmSync(withRollup.dir, { recursive: true, force: true })
    fs.rmSync(withoutRollup.dir, { recursive: true, force: true })
  }

  // 长窗口（720h）仍走 rollup：只有「首个不完整小时」与浮点求和顺序不同 —— Lead 已判定可接受，
  // 这里保留断言以防差异扩大。
  const longHours = 720
  const longWithRollup = makeFixture(now, { rollup: true, hours: longHours })
  const longWithoutRollup = makeFixture(now, { rollup: false, hours: longHours })
  const poolC = new SQLiteReadPool(longWithRollup.file, 2)
  const poolD = new SQLiteReadPool(longWithoutRollup.file, 2)
  try {
    const routed = await REPORTS.loadCacheTrendReport(poolC as never, GROUPS, longHours, '', '', '', '', now)
    const events = await REPORTS.loadCacheTrendReport(poolD as never, GROUPS, longHours, '', '', '', '', now)
    assert.equal(routed.points.length, events.points.length)
    const differing = routed.points
      .map((point, index) => (JSON.stringify(quantize(point)) === JSON.stringify(quantize(events.points[index])) ? null : index))
      .filter((index): index is number => index !== null)
    assert.deepEqual(differing, [0], `720h 只允许首个桶（不完整小时）有差异，实际 ${JSON.stringify(differing)}`)
    assert.ok(Number(routed.points[0].requests) < Number(events.points[0].requests), 'rollup 路径丢掉不完整小时 → 首个桶更小')
  } finally {
    await poolC.close()
    await poolD.close()
    fs.rmSync(longWithRollup.dir, { recursive: true, force: true })
    fs.rmSync(longWithoutRollup.dir, { recursive: true, force: true })
  }
})

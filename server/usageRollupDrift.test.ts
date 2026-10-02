import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'

/**
 * rollup 漂移自检与重建的测试（task-64）。
 *
 * 覆盖：
 * - 分级判据（<1% ok / 1–5% warn / >5% alert）与空窗口、整点对齐；
 * - 在临时库上「制造漂移 → 自检报 alert → 重建 → 回到 1.000 → 再重建仍一致（幂等）」，
 *   并直接跑 `scripts/rollup-rebuild.mjs`（重建脚本本身也要有回归）。
 *
 * 不引入 `./testDataDir.js`：自己建临时目录。
 */

const { alignedCutoffMs, checkRollupHealth, summarizeRollupHealth } = await import('./usageRollup.js')

const SCRIPT = path.join(process.cwd(), 'scripts', 'rollup-rebuild.mjs')

test('分级判据：<1% ok、1–5% warn、>5% alert，空窗口记 ok', () => {
  const options = { windowHours: 24, cutoffMs: 0, now: 0 }
  assert.equal(summarizeRollupHealth(1000, 1000, options).severity, 'ok')
  assert.equal(summarizeRollupHealth(1005, 1000, options).severity, 'ok', '0.5% 算正常')
  assert.equal(summarizeRollupHealth(1030, 1000, options).severity, 'warn', '3% 警告')
  assert.equal(summarizeRollupHealth(1100, 1000, options).severity, 'alert', '10% 告警')
  assert.equal(summarizeRollupHealth(2000, 1000, options).severity, 'alert', '2× 必须告警')
  assert.equal(summarizeRollupHealth(1000, 2000, options).severity, 'alert', '偏小同样告警（绝对值）')
  assert.equal(summarizeRollupHealth(0, 0, options).severity, 'ok', '两侧都空 → 没有数据，不是漂移')
  assert.equal(summarizeRollupHealth(5, 0, options).severity, 'alert', '只有 rollup 有数 → 告警')
  const doubled = summarizeRollupHealth(2000, 1000, options)
  assert.equal(doubled.ratio, 2)
  assert.equal(doubled.driftPct, 100)
})

test('窗口对齐到整点（避免首个不完整小时造成假漂移）', () => {
  const now = Date.UTC(2026, 9, 1, 8, 47, 33)
  const cutoff = alignedCutoffMs(3, now)
  assert.equal(cutoff % 3_600_000, 0, '必须是整点')
  assert.equal(new Date(cutoff).toISOString(), '2026-10-01T05:00:00.000Z')
  assert.ok(cutoff <= now - 3 * 3_600_000, '不能把窗口缩短')
})

/** 建一个「events + 按 trigger 语义聚合的 rollup」的小库，并可选把 rollup 放大 N 倍。 */
function makeFixture(rows: Array<{ ts: number; provider: string; tokens: number; cost: number | null }>, driftFactor = 1) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crosery-rollup-drift-'))
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
  rows.forEach((row, index) => insert.run(`r-${index}`, new Date(row.ts).toISOString(), row.ts, 'k1', row.provider,
    `${row.provider}/m`, row.provider, '/v1/chat/completions', 1, 200, 100, 30, row.tokens, 10, 0, 5, 0, row.tokens + 10,
    'cursor', row.cost))
  for (let factor = 0; factor < driftFactor; factor += 1) {
    db.exec(`INSERT INTO usage_hourly_rollup (hour_ms,hour_text,day_text,key_hash,provider,model,model_group,endpoint,client_type,
      success,status_code,error_category,request_count,total_tokens,input_tokens,uncached_input_tokens,output_tokens,cached_tokens,
      cache_write_tokens,reasoning_tokens,latency_sum_ms,ttft_sum_ms,cost_usd_sum,cost_usd_count,first_timestamp_ms)
      SELECT (timestamp_ms/3600000)*3600000, strftime('%Y-%m-%dT%H',timestamp_ms/1000,'unixepoch'),
        strftime('%Y-%m-%d',timestamp_ms/1000,'unixepoch'), COALESCE(key_hash,''), provider, model, model_group, endpoint,
        CASE WHEN client_type='' THEN 'legacy-unknown' ELSE client_type END, success, status_code, COALESCE(error_category,''),
        COUNT(*), SUM(total_tokens), SUM(input_tokens), SUM(MAX(input_tokens-cached_tokens,0)), SUM(output_tokens), SUM(cached_tokens),
        SUM(cache_write_tokens), SUM(reasoning_tokens), SUM(latency_ms), SUM(ttft_ms), COALESCE(SUM(cost_usd),0), COUNT(cost_usd), MIN(timestamp_ms)
      FROM usage_events GROUP BY 1,4,5,6,7,8,9,10,11,12
      ON CONFLICT (hour_ms,key_hash,provider,model,model_group,endpoint,client_type,success,status_code,error_category)
      DO UPDATE SET request_count = request_count + excluded.request_count`)
  }
  db.close()
  return { dir, file }
}

const runScript = (command: string, file: string, extra: string[] = []) => {
  try {
    const stdout = execFileSync(process.execPath, [SCRIPT, command, '--db', file, '--hours', '24', ...extra], { encoding: 'utf8' })
    return { code: 0, stdout }
  } catch (error) {
    const failure = error as { status?: number; stdout?: string; stderr?: string }
    return { code: failure.status ?? 1, stdout: `${failure.stdout ?? ''}${failure.stderr ?? ''}` }
  }
}

test('端到端（脚本）：一致的库 → check 退出码 0 / ok；漂移 2× 的库 → 退出码 1 / alert', () => {
  // 脚本按真实时钟取 24h 窗口：夹具锚定当前时刻，写死日期会随时间滑出窗口（空窗口恒 ok）
  const now = Date.now()
  const rows = Array.from({ length: 400 }, (_, index) => ({ ts: now - (index % 200) * 60_000, provider: ['openai', 'claude'][index % 2], tokens: 1_000, cost: 0.01 }))

  const clean = makeFixture(rows, 1)
  const cleanRun = runScript('check', clean.file)
  assert.equal(cleanRun.code, 0, `一致库应退出 0：${cleanRun.stdout}`)
  assert.match(cleanRun.stdout, /"severity":"ok"/)

  const drifted = makeFixture(rows, 2)
  const driftedRun = runScript('check', drifted.file)
  assert.equal(driftedRun.code, 1, '漂移库必须退出非 0，才能在 CI/巡检里被看见')
  assert.match(driftedRun.stdout, /"severity":"alert"/)
  assert.match(driftedRun.stdout, /"ratio":2/)

  for (const fixture of [clean, drifted]) fs.rmSync(fixture.dir, { recursive: true, force: true })
})

test('端到端（脚本）：重建把漂移拉回 1.000，且**跑两遍结果一致**（幂等）', () => {
  const now = Date.UTC(2026, 9, 1, 8, 47, 33)
  const rows = Array.from({ length: 600 }, (_, index) => ({ ts: now - (index % 300) * 60_000, provider: ['openai', 'claude', 'cursor'][index % 3], tokens: 2_000, cost: index % 2 ? 0.02 : null }))
  const fixture = makeFixture(rows, 3)
  try {
    const result = runScript('rebuild', fixture.file, ['--backup-dir', path.join(fixture.dir, 'backups')])
    assert.equal(result.code, 0, `重建应成功：${result.stdout}`)
    assert.match(result.stdout, /"verdict":"rebuilt-and-verified"/)
    assert.match(result.stdout, /"idempotent":true/, '两次重建的指纹必须一致')
    assert.match(result.stdout, /"phase":"backup"/, '必须先备份')
    assert.match(result.stdout, /"severity":"ok"/, '重建后自检必须回到 ok')

    // 备份文件确实存在（先备份原则的可验证证据）
    const backups = fs.readdirSync(path.join(fixture.dir, 'backups'))
    assert.equal(backups.length, 1, `应产生一个备份：${backups.join(', ')}`)

    // 重建后的库：自检退出码 0
    const recheck = runScript('check', fixture.file)
    assert.equal(recheck.code, 0)
    assert.match(recheck.stdout, /"ratio":1/)

    // 幂等：再跑一次重建，指纹仍相同
    const second = runScript('rebuild', fixture.file, ['--backup-dir', path.join(fixture.dir, 'backups2')])
    assert.equal(second.code, 0)
    assert.match(second.stdout, /"idempotent":true/)
  } finally {
    fs.rmSync(fixture.dir, { recursive: true, force: true })
  }
})

test('安全护栏：拒绝在生产库路径上重建（除非显式 --allow-production）', () => {
  const result = runScript('rebuild', '/opt/crosery-api-console/data/console.db')
  assert.notEqual(result.code, 0, '生产路径必须被拒绝')
  assert.match(result.stdout, /拒绝直接操作生产库路径/)
})

test('同步库上的自检（checkRollupHealth）在整点窗口内比较两侧', () => {
  const now = Date.UTC(2026, 9, 1, 8, 47, 33)
  const rows = Array.from({ length: 120 }, (_, index) => ({ ts: now - (index % 60) * 60_000, provider: 'openai', tokens: 500, cost: 0.005 }))
  const fixture = makeFixture(rows, 1)
  const db = new DatabaseSync(fixture.file, { readOnly: true })
  const health = checkRollupHealth(db, 24)
  db.close()
  fs.rmSync(fixture.dir, { recursive: true, force: true })
  assert.equal(health.severity, 'ok')
  assert.equal(health.rollupRequests, health.eventRequests)
  assert.equal(health.cutoffMs % 3_600_000, 0, '窗口起点必须是整点')
})

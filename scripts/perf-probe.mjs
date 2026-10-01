/**
 * 报表性能探针（task-59，新增）：在**已灌好生产规模数据**的临时实例上量各 loader，
 * 并把每条 SQL 的耗时单独打出来（根因证据：哪条 SQL、调了几次、各花多久）。
 *
 * 用法：
 *   DATA_DIR=/tmp/perf-base node --import tsx scripts/perf-probe.mjs            # 全量
 *   DATA_DIR=/tmp/perf-base ROUTE=cache-trend node --import tsx scripts/perf-probe.mjs
 *
 * 说明：只读探针，不写任何数据；不改动 Lead 的 `qa-*.mjs`。
 */
const dataDir = process.env.DATA_DIR
if (!dataDir) throw new Error('必须显式设置 DATA_DIR（指向 perf-seed 灌好的临时目录）')

const { SQLiteReadPool } = await import('../server/sqliteReadWorker.ts')
const Reports = await import('../server/usageReports.ts')

const GROUPS = ['openrouter', 'anthropic', 'openai', 'google', 'moonshot', 'xai'].map((id) => ({
  id, name: id, color: '#000', kind: 'compat', models: [],
}))

const percentile = (values, p) => {
  if (!values.length) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))
  return sorted[index]
}

/** 记录每条 SQL 的调用次数与总耗时，用于定位「哪条 SQL 慢」。 */
const sqlStats = []
function instrument(pool) {
  const record = (operations, elapsed) => {
    for (const op of operations) {
      const sql = String(op.sql).replace(/\s+/g, ' ').trim()
      const existing = sqlStats.find((entry) => entry.sql === sql)
      if (existing) {
        existing.calls += 1
        existing.totalMs += elapsed / operations.length
        existing.maxMs = Math.max(existing.maxMs, elapsed / operations.length)
      } else {
        sqlStats.push({ sql, calls: 1, totalMs: elapsed / operations.length, maxMs: elapsed / operations.length })
      }
    }
  }
  return {
    async run(operations) {
      const started = performance.now()
      const result = await pool.run(operations)
      record(operations, performance.now() - started)
      return result
    },
    async runParallel(operations) {
      const started = performance.now()
      const result = await pool.runParallel(operations)
      record(operations, performance.now() - started)
      return result
    },
  }
}

const pool = new SQLiteReadPool(`${dataDir}/console.db`, 2)
const reader = instrument(pool)
const samples = Number(process.env.SAMPLES || 5)
// NOW_MS：把窗口起点钉死，before/after 两次测量才可比（否则窗口边界附近的几条事件会来回进出）
const pinnedNow = Number(process.env.NOW_MS || 0) || Date.now()
console.log(JSON.stringify({ pinnedNow: new Date(pinnedNow).toISOString() }))
const which = process.env.ROUTE || 'all'

const cases = {
  'cache-trend-1h': () => Reports.loadCacheTrendReport(reader, GROUPS, 1, '', '', '', '', pinnedNow),
  'cache-trend-6h': () => Reports.loadCacheTrendReport(reader, GROUPS, 6, '', '', '', '', pinnedNow),
  'cache-trend-72h': () => Reports.loadCacheTrendReport(reader, GROUPS, 72, '', '', '', '', pinnedNow),
  'cache-trend-168h': () => Reports.loadCacheTrendReport(reader, GROUPS, 168, '', '', '', '', pinnedNow),
  'cache-trend-24h': () => Reports.loadCacheTrendReport(reader, GROUPS, 24, '', '', '', '', pinnedNow),
  'cache-trend-720h': () => Reports.loadCacheTrendReport(reader, GROUPS, 720, '', '', '', '', pinnedNow),
  'analytics-30d': () => Reports.loadAnalyticsReport(reader, GROUPS, 30, '', pinnedNow),
  'analytics-7d': () => Reports.loadAnalyticsReport(reader, GROUPS, 7, '', pinnedNow),
  'charts-latency-30d': () => Reports.loadChartsLatencyReport(reader, GROUPS, 30, '', pinnedNow),
  'usage-overview-30d': () => Reports.loadUsageOverviewReport(reader, GROUPS, 30, '', pinnedNow),
}

const selected = which === 'all' ? Object.keys(cases) : Object.keys(cases).filter((name) => name.includes(which))
const results = {}
for (const name of selected) {
  const timings = []
  let payload = null
  for (let i = 0; i < samples; i += 1) {
    const started = performance.now()
    payload = await cases[name]()
    timings.push(performance.now() - started)
  }
  results[name] = {
    bucketSeconds: payload?.bucketSeconds, points: payload?.points?.length,
    p50: Number(percentile(timings, 50).toFixed(1)),
    p95: Number(percentile(timings, 95).toFixed(1)),
    samples: timings.map((value) => Number(value.toFixed(1))),
    // 聚合指纹：用于「优化前后数值语义不变」的逐项比对
    fingerprint: fingerprintOf(payload),
  }
  console.log(JSON.stringify({ loader: name, ...results[name] }))
}

/** 把 loader 的返回结构压成一个稳定的指纹（数组顺序敏感，浮点保留 6 位）。 */
function fingerprintOf(value) {
  const seen = new WeakSet()
  const walk = (node) => {
    if (node === null || node === undefined) return null
    if (typeof node === 'number') return Number.isInteger(node) ? node : Number(node.toFixed(6))
    if (typeof node !== 'object') return node
    if (seen.has(node)) return '[circular]'
    seen.add(node)
    if (Array.isArray(node)) return node.map(walk)
    return Object.fromEntries(Object.keys(node).sort().map((key) => [key, walk(node[key])]))
  }
  return JSON.stringify(walk(value))
}

console.log(JSON.stringify({ sqlSlowest: sqlStats.sort((a, b) => b.totalMs - a.totalMs).slice(0, 6).map((entry) => ({
  calls: entry.calls, totalMs: Number(entry.totalMs.toFixed(1)), maxMs: Number(entry.maxMs.toFixed(1)), sql: entry.sql.slice(0, 220),
})) }, null, 1))

if (process.env.FINGERPRINTS_OUT) {
  const { writeFileSync } = await import('node:fs')
  writeFileSync(process.env.FINGERPRINTS_OUT, JSON.stringify(results, null, 2))
  console.log(JSON.stringify({ fingerprintsWritten: process.env.FINGERPRINTS_OUT }))
}
await pool.close?.()
process.exit(0)

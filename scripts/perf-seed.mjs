/**
 * 报表性能预演用的**造数脚本**（task-59，新增；不改动 Lead 的 `qa-*.mjs`）。
 *
 * 目标：在**临时 DATA_DIR** 里造出与生产**逐数字一致**的规模，用于定位与回归 `cache-trend`
 * 与 p95 子查询的慢点。数字取自 Lead 在生产库的只读实测（见
 * `docs/qa/deploy/prod-db-profile.md` 与红队 `data-scale-rehearsal.md` 附录 A）：
 *
 *   usage_events 全量      957,736
 *   最近 7 天              147,082
 *   最近 30 天             448,021
 *   时间跨度               66 天
 *   api_keys               50
 *   channel_states         30
 *
 * **与红队的差别（有意）**：`usage_hourly_rollup` 按**生产粒度**生成——即按 rollup 表的主键
 * 从 events 聚合（红队上一轮造出 628,812 行 = 生产 34,316 的 18×，会让走 rollup 的 loader 偏悲观）。
 *
 * 用法：
 *   DATA_DIR=/tmp/perf-XXXX node --import tsx scripts/perf-seed.mjs
 *   （目录不存在时脚本自己创建；已存在时先删同名表数据再重灌，保证可重复）
 */
import { mkdirSync } from 'node:fs'
import path from 'node:path'

const dataDir = process.env.DATA_DIR
if (!dataDir) throw new Error('必须显式设置 DATA_DIR（脚本只往临时目录灌数，永不碰生产库）')
if (!/^\/tmp\/|^\/private\/tmp\//.test(dataDir) && process.env.PERF_SEED_ALLOW_NON_TMP !== '1') {
  throw new Error(`拒绝往非临时目录灌数：${dataDir}（如确需，设置 PERF_SEED_ALLOW_NON_TMP=1）`)
}
mkdirSync(dataDir, { recursive: true })

const { db } = await import('../server/db.ts')

const TOTAL = 957_736
const LAST_7D = 147_082
const LAST_30D = 448_021
const DAYS = 66
const KEYS = 50
const PROVIDERS = ['openrouter', 'anthropic', 'openai', 'google', 'moonshot', 'xai']
const MODELS = [
  'anthropic/claude-sonnet-5', 'anthropic/claude-opus-5-5', 'openai/gpt-5.4-pro', 'openai/gpt-5.4-mini',
  'google/gemini-3.1-pro', 'google/gemini-3.1-flash', 'moonshot/kimi-k2-5', 'xai/grok-4-1', 'qwen/qwen3.7-max',
]
const CLIENTS = ['claude-code', 'codex-cli', 'cursor', 'cline', 'openai-sdk', 'legacy-unknown']
const ENDPOINTS = ['/v1/chat/completions', '/v1/messages', '/v1/responses', '/v1/images/generations']

/**
 * 每天的请求数：分三段**精确**分配（块的最后一个日子吸收取整残差），
 * 保证三个数字与生产实测**逐数字相等**：总计 957,736 / 近 7 天 147,082 / 近 30 天 448,021。
 */
function dailyCounts() {
  const counts = new Array(DAYS).fill(0)
  /** 把 total 按 shape 分配到 indices 上，残差落在最后一个 index。 */
  const distribute = (indices, total, shape) => {
    const weights = indices.map((i) => shape(DAYS - 1 - i))
    const weightSum = weights.reduce((a, b) => a + b, 0)
    let assigned = 0
    indices.forEach((index, position) => {
      const value = position === indices.length - 1 ? total - assigned : Math.floor((weights[position] / weightSum) * total)
      counts[index] = value
      assigned += value
    })
  }
  const newish = (daysAgo) => Math.exp(-daysAgo / 25) * (1 + 0.15 * Math.sin((daysAgo / 7) * Math.PI * 2))
  const all = [...Array(DAYS).keys()]
  distribute(all.filter((i) => DAYS - 1 - i < 7), LAST_7D, newish)
  distribute(all.filter((i) => { const d = DAYS - 1 - i; return d >= 7 && d < 30 }), LAST_30D - LAST_7D, newish)
  distribute(all.filter((i) => DAYS - 1 - i >= 30), TOTAL - LAST_30D, newish)
  return counts
}

const counts = dailyCounts()
const sum = (xs) => xs.reduce((a, b) => a + b, 0)
console.log(JSON.stringify({
  planned: {
    total: sum(counts),
    last7: sum(counts.slice(DAYS - 7)),
    last30: sum(counts.slice(DAYS - 30)),
  },
  target: { total: TOTAL, last7: LAST_7D, last30: LAST_30D },
}))

const now = Date.now()
const dayMs = 24 * 60 * 60 * 1000

db.exec('DELETE FROM usage_events')
db.exec('DELETE FROM usage_hourly_rollup')
db.exec("DELETE FROM api_keys WHERE key_hash LIKE 'perf-%'")
db.exec('DELETE FROM channel_states')

// api_keys / channel_states：报表的渠道与 Key 维度（50 / 30，与红队一致）
const insertKey = db.prepare('INSERT OR REPLACE INTO api_keys (key_hash,key_value,name,note,enabled,groups_json,total_concurrency,group_concurrency_json,created_at,updated_at) VALUES (?,?,?,?,1,?,4,?,?,?)')
const insertChannel = db.prepare('INSERT OR REPLACE INTO channel_states (name, enabled, snapshot_json, updated_at) VALUES (?,1,?,?)')
const stamp = new Date(now).toISOString()
for (let i = 0; i < KEYS; i += 1) {
  insertKey.run(`perf-key-${i}`, `sk-perf-${i}`, `perf key ${i}`, '', JSON.stringify([PROVIDERS[i % PROVIDERS.length]]), '{}', stamp, stamp)
}
// channel_states：只存快照 JSON（字段 name/enabled/snapshot_json/updated_at）
for (let i = 0; i < 30; i += 1) {
  insertChannel.run(`perf-channel-${i}`, JSON.stringify({ baseUrl: `http://127.0.0.1:9/${i}`, models: [MODELS[i % MODELS.length]] }), stamp)
}

// usage_events：单事务批量写入（红队口径：5% 失败、0.5% 超大 token 行）
const insertEvent = db.prepare(`INSERT OR REPLACE INTO usage_events
  (request_id,timestamp,timestamp_ms,key_hash,provider,model,model_group,endpoint,success,status_code,
   latency_ms,ttft_ms,input_tokens,output_tokens,reasoning_tokens,cached_tokens,cache_write_tokens,total_tokens,
   user_agent,client_type,client_ip,error_detail,error_category,upstream_request_id,source,auth_index,
   reasoning_effort,service_tier,response_headers_json,cost_usd)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)

let written = 0
const started = Date.now()
db.exec('BEGIN')  // 单事务批量写入：逐行自动提交会把 95 万行拖成分钟级
const HOUR_MS = 3_600_000

/**
 * **真实流量形状**（这一点很重要）：生产的 rollup 只有 34,316 行 / 66 天 ≈ 21.7 行/小时，
 * 说明每小时落库的 (key,provider,model,endpoint,client) 组合只有 ~20 个（含 success/status 变体），而不是笛卡尔积。
 * 上一版我按组合轮转造数，rollup 涨到 485,015 行（生产 14×）——那会让「走 rollup」的 loader 结论失真。
 * 这里改成：每个小时先固定一组组合（~20 个），事件在这些组合间轮转，并只让少数几分钟承担失败行。
 */
function hourCombos(hourIndex) {
  const combos = []
  for (let i = 0; i < 10; i += 1) {
    combos.push({
      key: `perf-key-${(hourIndex * 7 + i * 3) % KEYS}`,
      provider: PROVIDERS[(hourIndex + i) % PROVIDERS.length],
      model: MODELS[(hourIndex * 2 + i) % MODELS.length],
      endpoint: ENDPOINTS[(hourIndex + i * 5) % ENDPOINTS.length],
      client: CLIENTS[(hourIndex + i * 3) % CLIENTS.length],
    })
  }
  return combos
}

counts.forEach((count, dayIndex) => {
  const daysAgo = DAYS - 1 - dayIndex
  const dayStart = now - daysAgo * dayMs - (dayMs - 1)
  // 把当天请求分到 24 小时（白天多、凌晨少），再在小时内按分钟铺开
  const hourWeights = Array.from({ length: 24 }, (_, hour) => 0.35 + Math.exp(-((hour - 15) ** 2) / 40))
  const hourWeightSum = hourWeights.reduce((a, b) => a + b, 0)
  let assignedToDay = 0
  for (let hour = 0; hour < 24; hour += 1) {
    const hourIndex = dayIndex * 24 + hour
    const hourCount = hour === 23 ? count - assignedToDay : Math.floor((hourWeights[hour] / hourWeightSum) * count)
    assignedToDay += hourCount
    if (hourCount <= 0) continue
    const combos = hourCombos(hourIndex)
    const hourStart = dayStart + hour * HOUR_MS
    for (let i = 0; i < hourCount; i += 1) {
      const combo = combos[i % combos.length]
      // 每 ~10 个请求换一分钟 → 一小时内铺满分钟，但不制造无意义的高基数
      const minute = Math.min(59, Math.floor((i / hourCount) * 60))
      const ts = hourStart + minute * 60_000 + (i % 997)
      const isError = i % 20 === 0
      const huge = i % 200 === 0
      const inputTokens = huge ? 180_000 + (i % 5_000) : 400 + (i % 12_000)
      const cachedTokens = Math.floor(inputTokens * ((i % 9) / 20))
      const cacheWrite = Math.floor(inputTokens * ((i % 5) / 40))
      const outputTokens = 80 + (i % 3_000)
      const total = inputTokens + outputTokens
      const latency = isError ? 50 + (i % 1_500) : 400 + (i % 9_000)
      insertEvent.run(
        `perf-${dayIndex}-${hour}-${i}`, new Date(ts).toISOString(), ts, combo.key, combo.provider, combo.model,
        combo.provider, combo.endpoint, isError ? 0 : 1, isError ? (i % 2 ? 429 : 500) : 200,
        latency, Math.floor(latency / 3), inputTokens, outputTokens, Math.floor(outputTokens / 4), cachedTokens,
        cacheWrite, total, 'perf-seed', combo.client, '127.0.0.1', '', isError ? 'upstream_error' : '',
        `up-${dayIndex}-${hour}-${i}`, 'gateway', '', '', 'default', '{}',
        Number((total / 1_000_000 * 3).toFixed(6)),
      )
      written += 1
    }
  }
})
db.exec('COMMIT')
console.log(JSON.stringify({ eventsWritten: written, rowsAdded: written, seedMs: Date.now() - started }))

// rollup：**按生产粒度**从 events 聚合（红队那轮造出 18×，会让走 rollup 的 loader 偏悲观）
const rollupStarted = Date.now()
db.exec(`INSERT OR REPLACE INTO usage_hourly_rollup
  (hour_ms,hour_text,day_text,key_hash,provider,model,model_group,endpoint,client_type,success,status_code,error_category,
   request_count,total_tokens,input_tokens,uncached_input_tokens,output_tokens,cached_tokens,cache_write_tokens,
   reasoning_tokens,latency_sum_ms,ttft_sum_ms,cost_usd_sum,cost_usd_count,first_timestamp_ms)
  SELECT CAST(timestamp_ms / 3600000 AS INTEGER) * 3600000,
         substr(timestamp, 1, 13),
         substr(timestamp, 1, 10),
         COALESCE(key_hash,''), provider, model, model_group, endpoint, client_type, success, status_code,
         COALESCE(error_category,''),
         COUNT(*), COALESCE(SUM(total_tokens),0), COALESCE(SUM(input_tokens),0),
         COALESCE(SUM(MAX(input_tokens - cached_tokens, 0)),0), COALESCE(SUM(output_tokens),0),
         COALESCE(SUM(cached_tokens),0), COALESCE(SUM(cache_write_tokens),0), COALESCE(SUM(reasoning_tokens),0),
         COALESCE(SUM(latency_ms),0), COALESCE(SUM(ttft_ms),0), COALESCE(SUM(cost_usd),0),
         COUNT(cost_usd), MIN(timestamp_ms)
  FROM usage_events GROUP BY 1,4,5,6,7,8,9,10,11,12`)
const rollupRows = db.prepare('SELECT COUNT(*) n FROM usage_hourly_rollup').get().n

// 只读校验：三个规模数字与 rollup 行数
const count = (where) => db.prepare(`SELECT COUNT(*) n FROM usage_events ${where}`).get().n
const overview = {
  total: count(''),
  last7: count(`WHERE timestamp_ms >= ${now - 7 * dayMs}`),
  last30: count(`WHERE timestamp_ms >= ${now - 30 * dayMs}`),
  rollupRows,
  rollupMs: Date.now() - rollupStarted,
}
console.log(JSON.stringify({ overview }))
const ok = overview.total === TOTAL && overview.last7 === LAST_7D && overview.last30 === LAST_30D
console.log(JSON.stringify({ matchesProductionProfile: ok }))
if (!ok) process.exitCode = 1

/**
 * rollup 一致性自检 + 幂等重建（task-64，新增脚本）。
 *
 * 背景：`usage_hourly_rollup` 由 **3 个 `AFTER INSERT` 累加式触发器**维护，schema 里**没有
 * `AFTER DELETE`**（见 `server/usageRollup.ts`）。任何把同一条逻辑事件写入两次的路径
 * （回填脚本跑两遍、重建中断后重跑…）都会**永久**放大 rollup，而走 rollup 的 loader 会安静地
 * 显示错数。events 侧有 `request_id UNIQUE` + `INSERT OR IGNORE`，是可信参照。
 *
 * 两个子命令（**都只读或只在副本上写**，绝不动生产数据）：
 *   node scripts/rollup-rebuild.mjs check  --db <path> [--hours 24]
 *   node scripts/rollup-rebuild.mjs rebuild --db <path> [--backup-dir <dir>] [--hours 24]
 *
 * 安全设计：
 * - `--db` 必填；把库路径解析成绝对路径后，**显式拒绝**生产路径 `/opt/crosery-api-console/`，
 *   除非加 `--allow-production`（而运行手册明确写「不要在生产上重建」，这里保留开关只为演练同一个
 *   路径）。默认 `--backup-dir` 是 `<db 同目录>/backups`，备份用 `VACUUM INTO`（在线、只读源库）。
 * - 重建 = `DELETE FROM usage_hourly_rollup` + 按 events 全量重算。因为重算**从 events 出发**，
 *   重复执行结果一致（幂等）——脚本会自证：重建两次并比较指纹。
 * - 重建后自动跑自检，要求 `|drift| < 1%`（整点对齐窗口）。
 */
import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { rollupDriftSql, summarizeRollupHealthV2 } from '../server/usageRollup.ts'

const args = process.argv.slice(2)
const command = args[0]
const flag = (name, fallback) => {
  const index = args.indexOf(`--${name}`)
  return index >= 0 ? args[index + 1] : fallback
}
const has = (name) => args.includes(`--${name}`)

if (command !== 'check' && command !== 'rebuild') {
  console.error('用法：node scripts/rollup-rebuild.mjs <check|rebuild> --db <path> [--hours 24] [--backup-dir <dir>]')
  process.exit(2)
}
const dbPathArg = flag('db')
if (!dbPathArg) throw new Error('必须显式给出 --db <path>（脚本只做只读自检或对副本重建）')
const dbPath = path.resolve(dbPathArg)
// 生产路径护栏放在**存在性检查之前**：否则在别的机器上跑（该路径不存在）会先报「库不存在」，
// 掩盖真正该给出的拒绝理由。
if (dbPath.startsWith('/opt/crosery-api-console/') && !has('allow-production')) {
  throw new Error('拒绝直接操作生产库路径；运行手册要求在生产上只跑 check。确需演练同一路径请加 --allow-production')
}
if (!fs.existsSync(dbPath)) throw new Error(`库不存在：${dbPath}`)
const windowHours = Number(flag('hours', '24'))

/** 对齐到整点：不对齐时首个不完整小时会造成 1–3% 假漂移（生产 3h 窗口实测 1.023）。 */
const alignedCutoffMs = (hours, now = Date.now()) => Math.floor((now - hours * 3_600_000) / 3_600_000) * 3_600_000

const severityOf = (driftPct) => (driftPct < 1 ? 'ok' : driftPct <= 5 ? 'warn' : 'alert')

/**
 * 自检（task-67 起为多维度 + 行级差异版）：一次分组扫描同时给出两边总量与逐行差异。
 * `all = true` 时不做窗口过滤（整表，含历史漂移）——这是窗口自检看不见的那部分。
 */
/**
 * 自检 = **直接复用服务端同一份判定**（task-74）。
 *
 * 之前这里自己写了一套 severity 计算，结果在空窗口上和服务端**判得不一样**：SQL 的 `SUM(...)`
 * 在没有任何分组行时返回 NULL，而本地规则写的是 `rollup === 0`（严格相等）⇒ NULL !== 0 ⇒ 走进
 * "只有 rollup 有数"分支 ⇒ **空窗口误报 alert**（红队 N1：夜间无流量必然误报，会让巡检员
 * 学会忽略告警）。现在两条路径共用 `summarizeRollupHealthV2`，判定不可能再漂移；
 * SQL 侧也统一 COALESCE 成 0（`server/usageRollup.ts`）。
 *
 * 三种「0」的语义：两边都 0 = 真空窗口 → ok；只有一边为 0 = 漂移（events=0&rollup>0 是多余数据，
 * events>0&rollup=0 是触发器漏跑）→ alert。
 */
function checkHealth(db, hours = windowHours, all = false) {
  const cutoffMs = all ? 0 : alignedCutoffMs(hours)
  const sql = rollupDriftSql(cutoffMs)
  const row = db.prepare(sql).get(cutoffMs, cutoffMs)
  return summarizeRollupHealthV2(row, { windowHours: all ? 0 : hours, cutoffMs })
}

/** rollup 表指纹：重建幂等性的判据。 */
function fingerprint(db) {
  const row = db.prepare(`SELECT COUNT(*) rows, COALESCE(SUM(request_count),0) requests,
    COALESCE(SUM(total_tokens),0) totalTokens, COALESCE(SUM(cached_tokens),0) cached,
    ROUND(COALESCE(SUM(cost_usd_sum),0), 6) cost FROM usage_hourly_rollup`).get()
  return JSON.stringify(row)
}

/** 全量重算：表达式与 `trg_usage_hourly_rollup_insert` 逐项一致（client_type 归一、uncached、cost 计数）。 */
function rebuild(db) {
  db.exec('BEGIN IMMEDIATE')
  try {
    db.exec('DELETE FROM usage_hourly_rollup')
    db.exec(`
      INSERT INTO usage_hourly_rollup (
        hour_ms, hour_text, day_text, key_hash, provider, model, model_group,
        endpoint, client_type, success, status_code, error_category,
        request_count, total_tokens, input_tokens, uncached_input_tokens,
        output_tokens, cached_tokens, cache_write_tokens, reasoning_tokens,
        latency_sum_ms, ttft_sum_ms, cost_usd_sum, cost_usd_count, first_timestamp_ms
      )
      SELECT
        (timestamp_ms / 3600000) * 3600000,
        strftime('%Y-%m-%dT%H', timestamp_ms / 1000, 'unixepoch'),
        strftime('%Y-%m-%d', timestamp_ms / 1000, 'unixepoch'),
        COALESCE(key_hash, ''), provider, model, model_group, endpoint,
        (CASE
          WHEN lower(trim(user_agent)) LIKE 'omp/%' AND substr(trim(user_agent),5,1) BETWEEN '0' AND '9' THEN 'omp'
          WHEN lower(trim(provider))='antigravity' AND lower(trim(user_agent)) LIKE 'google-genai-sdk/%' THEN 'antigravity-cli'
          WHEN client_type='' THEN 'legacy-unknown'
          ELSE client_type
        END),
        success, status_code, error_category,
        COUNT(*), COALESCE(SUM(total_tokens),0), COALESCE(SUM(input_tokens),0),
        COALESCE(SUM(MAX(input_tokens - cached_tokens, 0)),0), COALESCE(SUM(output_tokens),0),
        COALESCE(SUM(cached_tokens),0), COALESCE(SUM(cache_write_tokens),0), COALESCE(SUM(reasoning_tokens),0),
        COALESCE(SUM(latency_ms),0), COALESCE(SUM(ttft_ms),0), COALESCE(SUM(cost_usd),0),
        COUNT(cost_usd), MIN(timestamp_ms)
      FROM usage_events
      GROUP BY 1, 4, 5, 6, 7, 8, 9, 10, 11, 12`)
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}

const checkAll = has('all')
const db = new DatabaseSync(dbPath)
try {
  const before = checkHealth(db, windowHours, checkAll)
  console.log(JSON.stringify({ command, db: dbPath, phase: 'before', ...before }))

  if (command === 'check') {
    db.close()
    process.exit(before.severity === 'alert' ? 1 : 0)
  }

  // 备份（VACUUM INTO：只读源库，写出一个独立文件）
  const backupDir = path.resolve(flag('backup-dir', path.join(path.dirname(dbPath), 'backups')))
  fs.mkdirSync(backupDir, { recursive: true })
  const backupPath = path.join(backupDir, `console-before-rollup-rebuild-${new Date().toISOString().replace(/[:.]/g, '-')}.db`)
  const backupStart = performance.now()
  db.exec(`VACUUM INTO '${backupPath.replace(/'/g, "''")}'`)
  console.log(JSON.stringify({ phase: 'backup', backupPath, backupMb: Number((fs.statSync(backupPath).size / 1048576).toFixed(1)), backupMs: Math.round(performance.now() - backupStart) }))

  const firstStart = performance.now()
  rebuild(db)
  const firstMs = Math.round(performance.now() - firstStart)
  const afterFirst = fingerprint(db)
  const healthFirst = checkHealth(db, windowHours)
  console.log(JSON.stringify({ phase: 'rebuild#1', ms: firstMs, ...healthFirst }))

  const secondStart = performance.now()
  rebuild(db)
  const secondMs = Math.round(performance.now() - secondStart)
  const afterSecond = fingerprint(db)
  const healthSecond = checkHealth(db, windowHours)
  console.log(JSON.stringify({ phase: 'rebuild#2', ms: secondMs, ...healthSecond }))
  console.log(JSON.stringify({ idempotent: afterFirst === afterSecond, fingerprint: JSON.parse(afterSecond),
    verdict: healthSecond.severity === 'ok' ? 'rebuilt-and-verified' : 'still-drifted' }))
  db.close()
  process.exit(healthSecond.severity === 'ok' && afterFirst === afterSecond ? 0 : 1)
} catch (error) {
  console.error(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }))
  process.exit(1)
}

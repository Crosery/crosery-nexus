import type { DatabaseSync } from 'node:sqlite'

export function migrateUsageRollup(database: DatabaseSync) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS usage_hourly_rollup (
      hour_ms INTEGER NOT NULL,
      hour_text TEXT NOT NULL,
      day_text TEXT NOT NULL,
      key_hash TEXT NOT NULL,
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      model_group TEXT NOT NULL,
      endpoint TEXT NOT NULL,
      client_type TEXT NOT NULL,
      success INTEGER NOT NULL,
      status_code INTEGER NOT NULL,
      error_category TEXT NOT NULL,
      request_count INTEGER NOT NULL,
      total_tokens INTEGER NOT NULL,
      input_tokens INTEGER NOT NULL,
      uncached_input_tokens INTEGER NOT NULL,
      output_tokens INTEGER NOT NULL,
      cached_tokens INTEGER NOT NULL,
      cache_write_tokens INTEGER NOT NULL,
      reasoning_tokens INTEGER NOT NULL,
      latency_sum_ms INTEGER NOT NULL,
      ttft_sum_ms INTEGER NOT NULL,
      cost_usd_sum REAL NOT NULL,
      cost_usd_count INTEGER NOT NULL,
      first_timestamp_ms INTEGER NOT NULL,
      PRIMARY KEY (hour_ms, key_hash, provider, model, model_group, endpoint, client_type, success, status_code, error_category)
    ) WITHOUT ROWID;

    CREATE INDEX IF NOT EXISTS idx_uhr_hour ON usage_hourly_rollup(hour_ms);
    CREATE INDEX IF NOT EXISTS idx_uhr_key_hour ON usage_hourly_rollup(key_hash, hour_ms);
    CREATE INDEX IF NOT EXISTS idx_uhr_day ON usage_hourly_rollup(day_text);
    CREATE INDEX IF NOT EXISTS idx_uhr_hour_prov ON usage_hourly_rollup(hour_ms, provider);
    CREATE INDEX IF NOT EXISTS idx_uhr_cache ON usage_hourly_rollup(success, provider, hour_ms, client_type, model);

    CREATE TRIGGER IF NOT EXISTS trg_usage_hourly_rollup_insert
    AFTER INSERT ON usage_events
    BEGIN
      INSERT INTO usage_hourly_rollup (
        hour_ms, hour_text, day_text, key_hash, provider, model, model_group,
        endpoint, client_type, success, status_code, error_category,
        request_count, total_tokens, input_tokens, uncached_input_tokens,
        output_tokens, cached_tokens, cache_write_tokens, reasoning_tokens,
        latency_sum_ms, ttft_sum_ms, cost_usd_sum, cost_usd_count, first_timestamp_ms
      ) VALUES (
        (NEW.timestamp_ms / 3600000) * 3600000,
        strftime('%Y-%m-%dT%H', NEW.timestamp_ms / 1000, 'unixepoch'),
        strftime('%Y-%m-%d', NEW.timestamp_ms / 1000, 'unixepoch'),
        COALESCE(NEW.key_hash, ''),
        NEW.provider,
        NEW.model,
        NEW.model_group,
        NEW.endpoint,
        (CASE
          WHEN lower(trim(NEW.user_agent)) LIKE 'omp/%' AND substr(trim(NEW.user_agent),5,1) BETWEEN '0' AND '9' THEN 'omp'
          WHEN lower(trim(NEW.provider))='antigravity' AND lower(trim(NEW.user_agent)) LIKE 'google-genai-sdk/%' THEN 'antigravity-cli'
          WHEN NEW.client_type='' THEN 'legacy-unknown'
          ELSE NEW.client_type
        END),
        NEW.success,
        NEW.status_code,
        NEW.error_category,
        1,
        NEW.total_tokens,
        NEW.input_tokens,
        MAX(NEW.input_tokens - NEW.cached_tokens, 0),
        NEW.output_tokens,
        NEW.cached_tokens,
        NEW.cache_write_tokens,
        NEW.reasoning_tokens,
        NEW.latency_ms,
        NEW.ttft_ms,
        COALESCE(NEW.cost_usd, 0),
        CASE WHEN NEW.cost_usd IS NOT NULL THEN 1 ELSE 0 END,
        NEW.timestamp_ms
      )
      ON CONFLICT (hour_ms, key_hash, provider, model, model_group, endpoint, client_type, success, status_code, error_category)
      DO UPDATE SET
        request_count = usage_hourly_rollup.request_count + 1,
        total_tokens = usage_hourly_rollup.total_tokens + excluded.total_tokens,
        input_tokens = usage_hourly_rollup.input_tokens + excluded.input_tokens,
        uncached_input_tokens = usage_hourly_rollup.uncached_input_tokens + excluded.uncached_input_tokens,
        output_tokens = usage_hourly_rollup.output_tokens + excluded.output_tokens,
        cached_tokens = usage_hourly_rollup.cached_tokens + excluded.cached_tokens,
        cache_write_tokens = usage_hourly_rollup.cache_write_tokens + excluded.cache_write_tokens,
        reasoning_tokens = usage_hourly_rollup.reasoning_tokens + excluded.reasoning_tokens,
        latency_sum_ms = usage_hourly_rollup.latency_sum_ms + excluded.latency_sum_ms,
        ttft_sum_ms = usage_hourly_rollup.ttft_sum_ms + excluded.ttft_sum_ms,
        cost_usd_sum = usage_hourly_rollup.cost_usd_sum + excluded.cost_usd_sum,
        cost_usd_count = usage_hourly_rollup.cost_usd_count + excluded.cost_usd_count,
        first_timestamp_ms = MIN(usage_hourly_rollup.first_timestamp_ms, excluded.first_timestamp_ms);
    END;

    CREATE TRIGGER IF NOT EXISTS trg_usage_hourly_rollup_update_key
    AFTER UPDATE OF key_hash ON usage_events
    WHEN (OLD.key_hash IS NULL AND NEW.key_hash IS NOT NULL) OR (OLD.key_hash != NEW.key_hash)
    BEGIN
      UPDATE usage_hourly_rollup SET
        request_count = request_count - 1,
        total_tokens = total_tokens - OLD.total_tokens,
        input_tokens = input_tokens - OLD.input_tokens,
        uncached_input_tokens = uncached_input_tokens - MAX(OLD.input_tokens - OLD.cached_tokens, 0),
        output_tokens = output_tokens - OLD.output_tokens,
        cached_tokens = cached_tokens - OLD.cached_tokens,
        cache_write_tokens = cache_write_tokens - OLD.cache_write_tokens,
        reasoning_tokens = reasoning_tokens - OLD.reasoning_tokens,
        latency_sum_ms = latency_sum_ms - OLD.latency_ms,
        ttft_sum_ms = ttft_sum_ms - OLD.ttft_ms,
        cost_usd_sum = cost_usd_sum - COALESCE(OLD.cost_usd, 0),
        cost_usd_count = cost_usd_count - (CASE WHEN OLD.cost_usd IS NOT NULL THEN 1 ELSE 0 END)
      WHERE hour_ms = (OLD.timestamp_ms / 3600000) * 3600000
        AND key_hash = COALESCE(OLD.key_hash, '')
        AND provider = OLD.provider
        AND model = OLD.model
        AND model_group = OLD.model_group
        AND endpoint = OLD.endpoint
        AND client_type = (CASE
          WHEN lower(trim(OLD.user_agent)) LIKE 'omp/%' AND substr(trim(OLD.user_agent),5,1) BETWEEN '0' AND '9' THEN 'omp'
          WHEN lower(trim(OLD.provider))='antigravity' AND lower(trim(OLD.user_agent)) LIKE 'google-genai-sdk/%' THEN 'antigravity-cli'
          WHEN OLD.client_type='' THEN 'legacy-unknown'
          ELSE OLD.client_type
        END)
        AND success = OLD.success
        AND status_code = OLD.status_code
        AND error_category = OLD.error_category;

      DELETE FROM usage_hourly_rollup WHERE request_count <= 0;

      INSERT INTO usage_hourly_rollup (
        hour_ms, hour_text, day_text, key_hash, provider, model, model_group,
        endpoint, client_type, success, status_code, error_category,
        request_count, total_tokens, input_tokens, uncached_input_tokens,
        output_tokens, cached_tokens, cache_write_tokens, reasoning_tokens,
        latency_sum_ms, ttft_sum_ms, cost_usd_sum, cost_usd_count, first_timestamp_ms
      ) VALUES (
        (NEW.timestamp_ms / 3600000) * 3600000,
        strftime('%Y-%m-%dT%H', NEW.timestamp_ms / 1000, 'unixepoch'),
        strftime('%Y-%m-%d', NEW.timestamp_ms / 1000, 'unixepoch'),
        COALESCE(NEW.key_hash, ''),
        NEW.provider,
        NEW.model,
        NEW.model_group,
        NEW.endpoint,
        (CASE
          WHEN lower(trim(NEW.user_agent)) LIKE 'omp/%' AND substr(trim(NEW.user_agent),5,1) BETWEEN '0' AND '9' THEN 'omp'
          WHEN lower(trim(NEW.provider))='antigravity' AND lower(trim(NEW.user_agent)) LIKE 'google-genai-sdk/%' THEN 'antigravity-cli'
          WHEN NEW.client_type='' THEN 'legacy-unknown'
          ELSE NEW.client_type
        END),
        NEW.success,
        NEW.status_code,
        NEW.error_category,
        1,
        NEW.total_tokens,
        NEW.input_tokens,
        MAX(NEW.input_tokens - NEW.cached_tokens, 0),
        NEW.output_tokens,
        NEW.cached_tokens,
        NEW.cache_write_tokens,
        NEW.reasoning_tokens,
        NEW.latency_ms,
        NEW.ttft_ms,
        COALESCE(NEW.cost_usd, 0),
        CASE WHEN NEW.cost_usd IS NOT NULL THEN 1 ELSE 0 END,
        NEW.timestamp_ms
      )
      ON CONFLICT (hour_ms, key_hash, provider, model, model_group, endpoint, client_type, success, status_code, error_category)
      DO UPDATE SET
        request_count = usage_hourly_rollup.request_count + 1,
        total_tokens = usage_hourly_rollup.total_tokens + excluded.total_tokens,
        input_tokens = usage_hourly_rollup.input_tokens + excluded.input_tokens,
        uncached_input_tokens = usage_hourly_rollup.uncached_input_tokens + excluded.uncached_input_tokens,
        output_tokens = usage_hourly_rollup.output_tokens + excluded.output_tokens,
        cached_tokens = usage_hourly_rollup.cached_tokens + excluded.cached_tokens,
        cache_write_tokens = usage_hourly_rollup.cache_write_tokens + excluded.cache_write_tokens,
        reasoning_tokens = usage_hourly_rollup.reasoning_tokens + excluded.reasoning_tokens,
        latency_sum_ms = usage_hourly_rollup.latency_sum_ms + excluded.latency_sum_ms,
        ttft_sum_ms = usage_hourly_rollup.ttft_sum_ms + excluded.ttft_sum_ms,
        cost_usd_sum = usage_hourly_rollup.cost_usd_sum + excluded.cost_usd_sum,
        cost_usd_count = usage_hourly_rollup.cost_usd_count + excluded.cost_usd_count,
        first_timestamp_ms = MIN(usage_hourly_rollup.first_timestamp_ms, excluded.first_timestamp_ms);
    END;

    CREATE TRIGGER IF NOT EXISTS trg_usage_hourly_rollup_update_cost
    AFTER UPDATE OF cost_usd ON usage_events
    WHEN (OLD.cost_usd IS NULL AND NEW.cost_usd IS NOT NULL) OR (OLD.cost_usd != NEW.cost_usd)
    BEGIN
      UPDATE usage_hourly_rollup SET
        cost_usd_sum = cost_usd_sum - COALESCE(OLD.cost_usd, 0) + COALESCE(NEW.cost_usd, 0),
        cost_usd_count = cost_usd_count - (CASE WHEN OLD.cost_usd IS NOT NULL THEN 1 ELSE 0 END) + (CASE WHEN NEW.cost_usd IS NOT NULL THEN 1 ELSE 0 END)
      WHERE hour_ms = (NEW.timestamp_ms / 3600000) * 3600000
        AND key_hash = COALESCE(NEW.key_hash, '')
        AND provider = NEW.provider
        AND model = NEW.model
        AND model_group = NEW.model_group
        AND endpoint = NEW.endpoint
        AND client_type = (CASE
          WHEN lower(trim(NEW.user_agent)) LIKE 'omp/%' AND substr(trim(NEW.user_agent),5,1) BETWEEN '0' AND '9' THEN 'omp'
          WHEN lower(trim(NEW.provider))='antigravity' AND lower(trim(NEW.user_agent)) LIKE 'google-genai-sdk/%' THEN 'antigravity-cli'
          WHEN NEW.client_type='' THEN 'legacy-unknown'
          ELSE NEW.client_type
        END)
        AND success = NEW.success
        AND status_code = NEW.status_code
        AND error_category = NEW.error_category;
    END;
  `)

  // 初始回填：若已有 usage_events 但 rollup 为空，一次性补齐
  const hasRollup = Boolean(database.prepare('SELECT 1 FROM usage_hourly_rollup LIMIT 1').get())
  const hasEvents = Boolean(database.prepare('SELECT 1 FROM usage_events LIMIT 1').get())
  if (!hasRollup && hasEvents) {
    database.exec(`
      INSERT INTO usage_hourly_rollup
      SELECT
        (timestamp_ms / 3600000) * 3600000 AS hour_ms,
        strftime('%Y-%m-%dT%H', timestamp_ms / 1000, 'unixepoch') AS hour_text,
        strftime('%Y-%m-%d', timestamp_ms / 1000, 'unixepoch') AS day_text,
        COALESCE(key_hash, '') AS key_hash,
        provider,
        model,
        model_group,
        endpoint,
        (CASE
          WHEN lower(trim(user_agent)) LIKE 'omp/%' AND substr(trim(user_agent),5,1) BETWEEN '0' AND '9' THEN 'omp'
          WHEN lower(trim(provider))='antigravity' AND lower(trim(user_agent)) LIKE 'google-genai-sdk/%' THEN 'antigravity-cli'
          WHEN client_type='' THEN 'legacy-unknown'
          ELSE client_type
        END) AS client_type,
        success,
        status_code,
        error_category,
        COUNT(*) AS request_count,
        COALESCE(SUM(total_tokens), 0) AS total_tokens,
        COALESCE(SUM(input_tokens), 0) AS input_tokens,
        COALESCE(SUM(MAX(input_tokens - cached_tokens, 0)), 0) AS uncached_input_tokens,
        COALESCE(SUM(output_tokens), 0) AS output_tokens,
        COALESCE(SUM(cached_tokens), 0) AS cached_tokens,
        COALESCE(SUM(cache_write_tokens), 0) AS cache_write_tokens,
        COALESCE(SUM(reasoning_tokens), 0) AS reasoning_tokens,
        COALESCE(SUM(latency_ms), 0) AS latency_sum_ms,
        COALESCE(SUM(ttft_ms), 0) AS ttft_sum_ms,
        TOTAL(cost_usd) AS cost_usd_sum,
        COUNT(cost_usd) AS cost_usd_count,
        MIN(timestamp_ms) AS first_timestamp_ms
      FROM usage_events
      GROUP BY 1,4,5,6,7,8,9,10,11,12;
    `)
  }
}

/* ─────────────────── rollup 漂移自检（task-64） ─────────────────── */

/**
 * rollup 表会**静默漂移**：它由 3 个 `AFTER INSERT` 的**累加式**触发器维护
 * （见本文件顶部的 `trg_usage_hourly_rollup_insert`），而 schema 里没有 `AFTER DELETE`。
 * 任何把同一条逻辑事件写入两次的路径（回填脚本跑两遍、重建中断后重跑、手工重放…）
 * 都会**永久**放大 rollup，而所有走 rollup 的 loader 会安静地显示错数。
 *
 * events 侧因为有 `request_id UNIQUE` + `INSERT OR IGNORE` 保持正确，正好是可信参照：
 * 同一窗口内 `SUM(usage_hourly_rollup.request_count)` 应当等于 `COUNT(*) FROM usage_events`。
 *
 * 窗口**对齐到整点**：不对齐时首个不完整小时会被 rollup 侧整点丢弃/多算，产生 1–3% 的假漂移
 * （生产 3h 窗口实测 1.023 就是这么来的）。
 */
export type RollupHealth = {
  windowHours: number
  /** 对齐到整点后的窗口起点（ms）。 */
  cutoffMs: number
  rollupRequests: number
  eventRequests: number
  /** rollup / events；两侧都为空时按 1 记。 */
  ratio: number
  /** 相对偏差（绝对百分比），例如 0.3 表示 0.3%。 */
  driftPct: number
  severity: 'ok' | 'warn' | 'alert' | 'unknown'
  checkedAt: string
}

/** 对齐到整点的窗口起点：避免首个不完整小时带来的假漂移。 */
export const alignedCutoffMs = (windowHours: number, now = Date.now()) =>
  Math.floor((now - windowHours * 3_600_000) / 3_600_000) * 3_600_000

/** 汇总两个计数 → 分级结果（纯函数，便于单测）。 */
export function summarizeRollupHealth(
  rollupRequests: number,
  eventRequests: number,
  options: { windowHours: number; cutoffMs: number; now?: number },
): RollupHealth {
  const rollup = Number(rollupRequests) || 0
  const events = Number(eventRequests) || 0
  const ratio = events === 0 ? (rollup === 0 ? 1 : Number.POSITIVE_INFINITY) : rollup / events
  const driftPct = events === 0 ? (rollup === 0 ? 0 : 100) : Math.abs(rollup - events) / events * 100
  const severity: RollupHealth['severity'] = events === 0 && rollup === 0
    ? 'ok'
    : driftPct < 1 ? 'ok' : driftPct <= 5 ? 'warn' : 'alert'
  return {
    windowHours: options.windowHours,
    cutoffMs: options.cutoffMs,
    rollupRequests: rollup,
    eventRequests: events,
    ratio: Number.isFinite(ratio) ? Number(ratio.toFixed(4)) : ratio,
    driftPct: Number(driftPct.toFixed(3)),
    severity,
    checkedAt: new Date(options.now ?? Date.now()).toISOString(),
  }
}

/** 自检用的两条只读 SQL（可以交给读线程池执行，不占主线程）。 */
export function rollupHealthOperations(cutoffMs: number) {
  return [
    { method: 'get' as const, sql: 'SELECT COALESCE(SUM(request_count), 0) requests FROM usage_hourly_rollup WHERE hour_ms >= ?', params: [cutoffMs] },
    { method: 'get' as const, sql: 'SELECT COUNT(*) requests FROM usage_events WHERE timestamp_ms >= ?', params: [cutoffMs] },
  ]
}

/** 同步库上的自检（脚本/测试用；HTTP 路由请用读线程池版本）。 */
export function checkRollupHealth(database: DatabaseSync, windowHours = 24): RollupHealth {
  const cutoffMs = alignedCutoffMs(windowHours)
  const rollup = database.prepare('SELECT COALESCE(SUM(request_count), 0) requests FROM usage_hourly_rollup WHERE hour_ms >= ?').get(cutoffMs) as { requests: number }
  const events = database.prepare('SELECT COUNT(*) requests FROM usage_events WHERE timestamp_ms >= ?').get(cutoffMs) as { requests: number }
  return summarizeRollupHealth(rollup.requests, events.requests, { windowHours, cutoffMs })
}


/* ─────────────── 多维度 + 抵消型（行级）漂移自检（task-67） ─────────────── */

/**
 * task-67 修的两个**真实盲区**（红队第十八轮实证）：
 *
 * ① **抵消型漂移**：同一窗口内一行 `+1`、另一行 `-1` ⇒ 总量完全相等，旧自检报 ok，但逐行已错；
 * ② **只改 token/cost**（例如 +234 万 tokens、+$9.99）⇒ 旧自检只比 `request_count`，仍然报 ok，
 *    而金额错恰恰是最贵的。
 *
 * 新自检做两件事，**并保留原有总量判据**（`requests` 那一项的 ratio/driftPct/severity 字段不变）：
 * - **多维度**：`requests` / `totalTokens` / `cachedTokens` / `latencySumMs` / `costUsdSum` 各自
 *   ratio + driftPct + severity；
 * - **行级差异**：把 rollup 与「按 rollup 主键重新聚合的 events」两边 UNION 后按主键分组，
 *   得到 `driftingRows`（有多少行不一致）、`sumAbs*`（`SUM(ABS(diff))`）、`maxAbs*`（最大绝对差）
 *   —— 抵消型漂移在这里必然暴露（逐行 delta 不全为 0）。
 *
 * 成本：**一次分组扫描**就同时得到「两边总量」和「行级差异」，所以没有把两个昂贵查询叠加起来。
 * 实测（生产规模合成库 95.7 万事件）：24h ≈ 50ms、168h ≈ 250ms；生产库（12.5k/147k 行窗口）更低。
 *
 * 边界（红队要求写明）：
 * - `events = 0 且 rollup > 0` ⇒ 该维度 `ratio = null`、`driftPct = 100`、severity `alert`
 *   （有数据只在一侧 = 必然漂移），客户端要能处理 `null`；
 * - 自检只看**请求窗口内**的数据：**窗口外的历史漂移看不见**，这是有意的取舍（对比全表的代价是
 *   每次都要扫 95 万行）；要看全表请用 `scripts/rollup-rebuild.mjs check --all`。
 */
export type RollupMetricHealth = {
  id: 'requests' | 'totalTokens' | 'cachedTokens' | 'latencySumMs' | 'costUsdSum'
  label: string
  rollup: number
  events: number
  /** events 为 0 而 rollup > 0 时为 null（客户端需处理）。 */
  ratio: number | null
  driftPct: number
  severity: 'ok' | 'warn' | 'alert'
}

export type RollupRowDrift = {
  driftingRows: number
  sumAbsRequests: number
  maxAbsRequests: number
  sumAbsTokens: number
  maxAbsTokens: number
  sumAbsCost: number
  maxAbsCost: number
  severity: 'ok' | 'warn' | 'alert'
}

export type RollupHealthV2 = RollupHealth & {
  severity: 'ok' | 'warn' | 'alert' | 'unknown'
  metrics: RollupMetricHealth[]
  rowDrift: RollupRowDrift
}

/** 单维度比较：与 task-64 的 requests 判据完全一致（ratio/driftPct/severity）。 */
export function compareMetric(
  id: RollupMetricHealth['id'],
  label: string,
  rollupValue: number,
  eventValue: number,
): RollupMetricHealth {
  const rollup = Number(rollupValue) || 0
  const events = Number(eventValue) || 0
  const base = summarizeRollupHealth(rollup, events, { windowHours: 0, cutoffMs: 0 })
  return {
    id,
    label,
    rollup,
    events,
    ratio: events === 0 ? (rollup === 0 ? 1 : null) : Number((rollup / events).toFixed(6)),
    driftPct: base.driftPct === 100 && rollup === 0 && events === 0 ? 0 : base.driftPct,
    severity: base.severity === 'unknown' ? 'ok' : base.severity,
  }
}

/** 行级差异的分级：只要有行不一致，至少 warn；相对偏差 >5% 直接 alert。 */
export function summarizeRowDrift(row: Partial<RollupRowDrift> & { eventRequests: number }): RollupRowDrift {
  const driftingRows = Number(row.driftingRows) || 0
  const sumAbsRequests = Number(row.sumAbsRequests) || 0
  const maxAbsRequests = Number(row.maxAbsRequests) || 0
  const sumAbsTokens = Number(row.sumAbsTokens) || 0
  const maxAbsTokens = Number(row.maxAbsTokens) || 0
  const sumAbsCost = Number(row.sumAbsCost) || 0
  const maxAbsCost = Number(row.maxAbsCost) || 0
  const events = Number(row.eventRequests) || 0
  const relative = events === 0 ? (driftingRows > 0 ? 100 : 0) : (sumAbsRequests / events) * 100
  const severity: RollupRowDrift['severity'] = driftingRows === 0
    ? 'ok'
    : relative > 5 ? 'alert' : 'warn'
  return {
    driftingRows,
    sumAbsRequests: Number(sumAbsRequests.toFixed(6)),
    maxAbsRequests,
    sumAbsTokens: Number(sumAbsTokens.toFixed(6)),
    maxAbsTokens,
    sumAbsCost: Number(sumAbsCost.toFixed(6)),
    maxAbsCost: Number(maxAbsCost.toFixed(6)),
    severity,
  }
}

const ROW_KEY_COLUMNS = 'h,k,provider,model,model_group,endpoint,ct,success,status_code,ec'

/** 一次分组扫描：同时给出两边总量（多维度）与行级差异。 */
export function rollupDriftSql(_cutoffMs: number) {
  const clientType = `(CASE
    WHEN lower(trim(user_agent)) LIKE 'omp/%' AND substr(trim(user_agent),5,1) BETWEEN '0' AND '9' THEN 'omp'
    WHEN lower(trim(provider))='antigravity' AND lower(trim(user_agent)) LIKE 'google-genai-sdk/%' THEN 'antigravity-cli'
    WHEN client_type='' THEN 'legacy-unknown' ELSE client_type END)`
  return `
    SELECT
      -- 空窗口（没有任何分组行）时 SUM(...) 是 NULL，会让上游把 null 当成"非 0"从而误报；
      -- 统一 COALESCE 成 0：**两边都 0 = 真空窗口**（判 ok），只有一边为 0 才是漂移。
      COALESCE(SUM(r_requests), 0) rollupRequests, COALESCE(SUM(e_requests), 0) eventRequests,
      COALESCE(SUM(r_tokens), 0) rollupTokens, COALESCE(SUM(e_tokens), 0) eventTokens,
      COALESCE(SUM(r_cached), 0) rollupCached, COALESCE(SUM(e_cached), 0) eventCached,
      COALESCE(SUM(r_latency), 0) rollupLatency, COALESCE(SUM(e_latency), 0) eventLatency,
      ROUND(COALESCE(SUM(r_cost), 0), 6) rollupCost, ROUND(COALESCE(SUM(e_cost), 0), 6) eventCost,
      COALESCE(SUM(CASE WHEN r_requests <> e_requests
                 OR ABS(r_tokens - e_tokens) > 1e-6
                 OR ABS(r_cached - e_cached) > 1e-6
                 OR ABS(r_latency - e_latency) > 1e-6
                 OR ABS(r_cost - e_cost) > 1e-6 THEN 1 ELSE 0 END), 0) driftingRows,
      COALESCE(SUM(ABS(r_requests - e_requests)), 0) sumAbsRequests, COALESCE(MAX(ABS(r_requests - e_requests)), 0) maxAbsRequests,
      COALESCE(SUM(ABS(r_tokens - e_tokens)), 0) sumAbsTokens, COALESCE(MAX(ABS(r_tokens - e_tokens)), 0) maxAbsTokens,
      COALESCE(SUM(ABS(r_cost - e_cost)), 0) sumAbsCost, COALESCE(MAX(ABS(r_cost - e_cost)), 0) maxAbsCost
    FROM (
      SELECT ${ROW_KEY_COLUMNS},
        COALESCE(SUM(CASE WHEN src='r' THEN requests END), 0) r_requests,
        COALESCE(SUM(CASE WHEN src='e' THEN 1 END), 0) e_requests,
        COALESCE(SUM(CASE WHEN src='r' THEN tokens END), 0) r_tokens,
        COALESCE(SUM(CASE WHEN src='e' THEN total_tokens END), 0) e_tokens,
        COALESCE(SUM(CASE WHEN src='r' THEN cached END), 0) r_cached,
        COALESCE(SUM(CASE WHEN src='e' THEN cached_tokens END), 0) e_cached,
        COALESCE(SUM(CASE WHEN src='r' THEN latency END), 0) r_latency,
        COALESCE(SUM(CASE WHEN src='e' THEN latency_ms END), 0) e_latency,
        COALESCE(SUM(CASE WHEN src='r' THEN cost END), 0) r_cost,
        COALESCE(SUM(CASE WHEN src='e' THEN COALESCE(cost_usd,0) END), 0) e_cost
      FROM (
        SELECT 'r' src, hour_ms h, key_hash k, provider, model, model_group, endpoint, client_type ct,
               success, status_code, error_category ec, request_count requests, total_tokens tokens,
               cached_tokens cached, latency_sum_ms latency, cost_usd_sum cost,
               -- 后四列是 events 侧的原始列（UNION 两侧列数必须一致）；列名沿用第一个 SELECT，
               -- 所以这里必须叫 total_tokens/cached_tokens/latency_ms/cost_usd，不能加后缀
               0 total_tokens, 0 cached_tokens, 0 latency_ms, 0 cost_usd
        FROM usage_hourly_rollup WHERE hour_ms >= ?
        UNION ALL
        SELECT 'e' src, (timestamp_ms / 3600000) * 3600000 h, COALESCE(key_hash,'') k, provider, model, model_group, endpoint,
               ${clientType} ct, success, status_code, COALESCE(error_category,'') ec, 0, 0, 0, 0, 0,
               total_tokens, cached_tokens, latency_ms, COALESCE(cost_usd,0)
        FROM usage_events WHERE timestamp_ms >= ?
      )
      GROUP BY ${ROW_KEY_COLUMNS}
    )`
}

type DriftRowResult = {
  rollupRequests: number; eventRequests: number
  rollupTokens: number; eventTokens: number
  rollupCached: number; eventCached: number
  rollupLatency: number; eventLatency: number
  rollupCost: number; eventCost: number
  driftingRows: number
  sumAbsRequests: number; maxAbsRequests: number
  sumAbsTokens: number; maxAbsTokens: number
  sumAbsCost: number; maxAbsCost: number
}

/** 把行级/多维度结果汇总成最终健康报告（纯函数，便于单测）。 */
export function summarizeRollupHealthV2(
  row: Partial<DriftRowResult>,
  options: { windowHours: number; cutoffMs: number; now?: number },
): RollupHealthV2 {
  const metrics = [
    compareMetric('requests', '请求数', Number(row.rollupRequests) || 0, Number(row.eventRequests) || 0),
    compareMetric('totalTokens', '总 token', Number(row.rollupTokens) || 0, Number(row.eventTokens) || 0),
    compareMetric('cachedTokens', '缓存命中 token', Number(row.rollupCached) || 0, Number(row.eventCached) || 0),
    compareMetric('latencySumMs', '延迟合计(ms)', Number(row.rollupLatency) || 0, Number(row.eventLatency) || 0),
    compareMetric('costUsdSum', '金额(USD)', Number(row.rollupCost) || 0, Number(row.eventCost) || 0),
  ]
  const rowDrift = summarizeRowDrift({ ...row, eventRequests: Number(row.eventRequests) || 0 })
  const base = summarizeRollupHealth(metrics[0].rollup, metrics[0].events, options)
  const rank = { ok: 0, warn: 1, alert: 2, unknown: 0 } as const
  const severity = [...metrics.map((metric) => metric.severity), rowDrift.severity]
    .reduce((worst, current) => (rank[current] > rank[worst] ? current : worst), 'ok' as 'ok' | 'warn' | 'alert')
  return {
    ...base,
    severity,
    // 保留 task-64 的顶层字段语义（requests 维度），客户端无需改动即可继续读
    ratio: metrics[0].ratio ?? base.ratio,
    driftPct: metrics[0].driftPct,
    metrics,
    rowDrift,
  }
}

/** 自检用的只读 SQL 集合（交给读线程池执行）。 */
export function rollupHealthV2Operations(cutoffMs: number) {
  return [{ method: 'get' as const, sql: rollupDriftSql(cutoffMs), params: [cutoffMs, cutoffMs] }]
}

/** 同步库上的 v2 自检（脚本/测试用）。`all = true` 时不做窗口过滤（整表，含历史漂移）。 */
export function checkRollupHealthV2(database: DatabaseSync, windowHours = 24, options: { all?: boolean } = {}): RollupHealthV2 {
  const cutoffMs = options.all ? 0 : alignedCutoffMs(windowHours)
  const row = database.prepare(rollupDriftSql(cutoffMs)).get(cutoffMs, cutoffMs) as Partial<DriftRowResult>
  return summarizeRollupHealthV2(row, { windowHours, cutoffMs })
}

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

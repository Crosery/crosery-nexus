import type { DatabaseSync } from "node:sqlite";
import { sumCost, type QuotaSpend, type UsageCostRow } from "./quota.js";

export type QuotaLedgerRow = UsageCostRow;

export type QuotaSpendWindow = {
	keyHash: string;
	totalSince: string;
	dailySince: string;
	weeklySince: string;
};

type LedgerSchema = {
	hasProvider: boolean;
	hasTimestampMs: boolean;
	hasCacheWriteTokens: boolean;
	hasCostUsd: boolean;
};

type BatchCostRow = {
	keyHash: string;
	model: string;
	windowMask: number;
	newInputTokens: number;
	outputTokens: number;
	cacheTokens: number;
	cacheWriteTokens: number;
	costUsd: number | null;
};

const schemaCache = new WeakMap<DatabaseSync, LedgerSchema>();

function ledgerSchema(database: DatabaseSync): LedgerSchema {
	const cached = schemaCache.get(database);
	if (cached) return cached;
	const columns = new Set(
		(
			database.prepare("PRAGMA table_info(quota_usage_events)").all() as Array<{
				name: string;
			}>
		).map((column) => column.name),
	);
	const schema = {
		hasProvider: columns.has("provider"),
		hasTimestampMs: columns.has("timestamp_ms"),
		hasCacheWriteTokens: columns.has("cache_write_tokens"),
		hasCostUsd: columns.has("cost_usd"),
	};
	schemaCache.set(database, schema);
	return schema;
}

/**
 * 把文本时间一次性归一化为 epoch 毫秒，并让后续未显式写 timestamp_ms 的
 * 同步任务由触发器补齐。旧版表只承担一次 O(N) 回填和一次索引构建。
 */
export function migrateQuotaLedger(database: DatabaseSync) {
	const columns = new Set(
		(
			database.prepare("PRAGMA table_info(quota_usage_events)").all() as Array<{
				name: string;
			}>
		).map((column) => column.name),
	);
	const addedTimestampMs = !columns.has("timestamp_ms");
	const hasTimestampIndex = Boolean(
		database
			.prepare(
				"SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'idx_quota_usage_key_timestamp_ms'",
			)
			.get(),
	);
	if (addedTimestampMs) {
		database.exec(
			"ALTER TABLE quota_usage_events ADD COLUMN timestamp_ms INTEGER NOT NULL DEFAULT 0",
		);
	}
	// 索引是迁移完成标记；若进程在 ALTER 后退出，下次仍会补齐历史行。
	if (addedTimestampMs || !hasTimestampIndex) {
		database.exec(`
      UPDATE quota_usage_events
      SET timestamp_ms = COALESCE(
        CAST(ROUND((julianday(timestamp) - 2440587.5) * 86400000) AS INTEGER),
        0
      )
      WHERE timestamp_ms = 0
    `);
	}
	database.exec(`
    CREATE INDEX IF NOT EXISTS idx_quota_usage_key_timestamp_ms
    ON quota_usage_events(key_hash, timestamp_ms);

    CREATE TRIGGER IF NOT EXISTS set_quota_usage_timestamp_ms
    AFTER INSERT ON quota_usage_events
    WHEN NEW.timestamp_ms = 0
    BEGIN
      UPDATE quota_usage_events
      SET timestamp_ms = COALESCE(
        CAST(ROUND((julianday(NEW.timestamp) - 2440587.5) * 86400000) AS INTEGER),
        0
      )
      WHERE request_id = NEW.request_id;
    END;
  `);
	schemaCache.delete(database);
}

const emptySpend = (): QuotaSpend => ({ total: 0, daily: 0, weekly: 0 });

function costRow(row: BatchCostRow): UsageCostRow {
	return {
		model: row.model,
		newInputTokens: row.newInputTokens,
		outputTokens: row.outputTokens,
		cacheTokens: row.cacheTokens,
		cacheWriteTokens: row.cacheWriteTokens,
		costUsd: row.costUsd,
	};
}

/**
 * 一个预编译批次得出所有 key 的总/日/周窗口，避免逐 key 重复探测表结构。
 * 旧测试表仍走 julianday()，生产迁移表的三个范围都直接命中整数索引。
 */
export function quotaSpendForWindows(
	database: DatabaseSync,
	windows: QuotaSpendWindow[],
): Map<string, QuotaSpend> {
	const spendByKey = new Map(
		windows.map(({ keyHash }) => [keyHash, emptySpend()]),
	);
	if (!windows.length) return spendByKey;

	const schema = ledgerSchema(database);
	const inputSql = schema.hasProvider
		? "CASE WHEN lower(trim(q.provider)) IN ('claude','claude-api-key','anthropic','anthropic-api-key') THEN q.input_tokens ELSE MAX(q.input_tokens - q.cached_tokens, 0) END"
		: "CASE WHEN lower(CASE WHEN instr(q.model,'/')>0 THEN substr(q.model, instr(q.model,'/')+1) ELSE q.model END) LIKE 'claude%' THEN q.input_tokens ELSE MAX(q.input_tokens - q.cached_tokens, 0) END";
	const cacheWriteSql = schema.hasCacheWriteTokens
		? "q.cache_write_tokens"
		: "0";
	const costSql = schema.hasCostUsd
		? "CASE WHEN COUNT(q.cost_usd) = COUNT(*) THEN COALESCE(SUM(q.cost_usd), 0) ELSE NULL END"
		: "NULL";
	const eventTime = schema.hasTimestampMs
		? "q.timestamp_ms"
		: "julianday(q.timestamp)";
	const windowValue = schema.hasTimestampMs ? "?" : "julianday(?)";
	const query = database.prepare(`
    SELECT q.key_hash keyHash, q.model,
      (${eventTime} >= ${windowValue})
        + 2 * (${eventTime} >= ${windowValue})
        + 4 * (${eventTime} >= ${windowValue}) windowMask,
      COALESCE(SUM(${inputSql}), 0) newInputTokens,
      COALESCE(SUM(q.output_tokens), 0) outputTokens,
      COALESCE(SUM(q.cached_tokens), 0) cacheTokens,
      COALESCE(SUM(${cacheWriteSql}), 0) cacheWriteTokens,
      ${costSql} costUsd
	    FROM quota_usage_events q
	    WHERE q.key_hash = ? AND ${eventTime} >= ${windowValue}
	    GROUP BY q.key_hash, q.model, windowMask
	  `);

	for (const window of windows) {
		const starts = [
			window.totalSince,
			window.dailySince,
			window.weeklySince,
		] as const;
		const earliest = starts.reduce((left, right) =>
			Date.parse(left) <= Date.parse(right) ? left : right,
		);
		const bindTime = (value: string) =>
			schema.hasTimestampMs ? Date.parse(value) : value;
		const rows = query.all(
			...starts.map(bindTime),
			window.keyHash,
			bindTime(earliest),
		) as BatchCostRow[];
		const spend = spendByKey.get(window.keyHash) ?? emptySpend();
		for (const row of rows) {
			const cost = sumCost([costRow(row)]);
			if (row.windowMask & 1) spend.total += cost;
			if (row.windowMask & 2) spend.daily += cost;
			if (row.windowMask & 4) spend.weekly += cost;
		}
		spendByKey.set(window.keyHash, spend);
	}
	return spendByKey;
}

export function quotaSpendSince(
	database: DatabaseSync,
	keyHash: string,
	since: string,
): number {
	return (
		quotaSpendForWindows(database, [
			{
				keyHash,
				totalSince: since,
				dailySince: since,
				weeklySince: since,
			},
		]).get(keyHash)?.total ?? 0
	);
}

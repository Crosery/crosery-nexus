import path from "node:path";
import { addAudit, db } from "./db.js";
import { getCPAKeys, replaceCPAKeys } from "./cpa.js";
import { config } from "./config.js";
import {
	evaluateQuota,
	planQuotaActions,
	quotaWindowTiming,
	sumCost,
	WINDOW_LABELS,
	type KeyQuota,
	type KeyQuotaState,
} from "./quota.js";
import { quotaSpendForWindows } from "./quotaLedger.js";
import { SQLiteReadPool, type ReadOperation } from "./sqliteReadWorker.js";

export type KeyQuotaRow = {
	key_hash: string;
	key_value: string;
	name: string;
	note: string;
	enabled: number;
	quota_total_usd: number;
	quota_daily_usd: number;
	quota_weekly_usd: number;
	quota_blocked_reason: string;
	quota_total_since: string;
	quota_daily_since: string;
	quota_weekly_since: string;
};

export const quotaOf = (row: KeyQuotaRow): KeyQuota => ({
	totalUsd: Number(row.quota_total_usd) || 0,
	dailyUsd: Number(row.quota_daily_usd) || 0,
	weeklyUsd: Number(row.quota_weekly_usd) || 0,
});

const quotaReader = new SQLiteReadPool(path.join(config.dataDir, "console.db"), 1);

type QuotaReader = {
	run(operations: readonly ReadOperation[]): Promise<unknown[]>;
};

type AsyncCostRow = {
	model: string;
	windowMask: number;
	newInputTokens: number;
	outputTokens: number;
	cacheTokens: number;
	cacheWriteTokens: number;
	costUsd: number | null;
};

const timingFor = (rows: KeyQuotaRow[], now: Date) =>
	new Map(
		rows.map((row) => [
			row.key_hash,
			quotaWindowTiming(
				row.quota_total_since,
				row.quota_daily_since,
				row.quota_weekly_since,
				now,
			),
		]),
	);

const statesFromSpend = (
	rows: KeyQuotaRow[],
	timingByKey: ReturnType<typeof timingFor>,
	spendByKey: Map<string, { total: number; daily: number; weekly: number }>,
): Map<string, KeyQuotaState> =>
	new Map<string, KeyQuotaState>(
		rows.map((row) => {
			const timing = timingByKey.get(row.key_hash)!;
			return [
				row.key_hash,
				evaluateQuota(
					quotaOf(row),
					spendByKey.get(row.key_hash) ?? { total: 0, daily: 0, weekly: 0 },
					timing,
				),
			] as [string, KeyQuotaState];
		}),
	);

export function quotaStatesFor(
	rows: KeyQuotaRow[],
	now = new Date(),
): Map<string, KeyQuotaState> {
	const timingByKey = timingFor(rows, now);
	const spendByKey = quotaSpendForWindows(
		db,
		rows.map((row) => {
			const timing = timingByKey.get(row.key_hash)!;
			return {
				keyHash: row.key_hash,
				totalSince: timing.total.startsAt,
				dailySince: timing.daily.startsAt,
				weeklySince: timing.weekly.startsAt,
			};
		}),
	);
	return statesFromSpend(rows, timingByKey, spendByKey);
}

/** Production fast path: the indexed ledger scan runs outside the Node event loop. */
export async function quotaStatesForAsync(
	rows: KeyQuotaRow[],
	now = new Date(),
	reader: QuotaReader = quotaReader,
): Promise<Map<string, KeyQuotaState>> {
	if (!rows.length) return new Map();
	const timingByKey = timingFor(rows, now);
	const operations = rows.map((row): ReadOperation => {
		const timing = timingByKey.get(row.key_hash)!;
		const starts = [
			Date.parse(timing.total.startsAt),
			Date.parse(timing.daily.startsAt),
			Date.parse(timing.weekly.startsAt),
		];
		const hasTotalLimit = (Number(row.quota_total_usd) || 0) > 0 || Boolean(row.quota_total_since);
		const earliest = hasTotalLimit ? Math.min(...starts) : Math.min(starts[1], starts[2]);
		return {
			method: "all",
			sql: `
	      SELECT model,
	        (timestamp_ms >= ?) + 2 * (timestamp_ms >= ?) + 4 * (timestamp_ms >= ?) windowMask,
	        COALESCE(SUM(CASE
	          WHEN lower(trim(provider)) IN ('claude','claude-api-key','anthropic','anthropic-api-key')
	            THEN input_tokens
	          ELSE MAX(input_tokens - cached_tokens, 0)
	        END), 0) newInputTokens,
	        COALESCE(SUM(output_tokens), 0) outputTokens,
	        COALESCE(SUM(cached_tokens), 0) cacheTokens,
	        COALESCE(SUM(cache_write_tokens), 0) cacheWriteTokens,
	        CASE WHEN COUNT(cost_usd) = COUNT(*) THEN COALESCE(SUM(cost_usd), 0) ELSE NULL END costUsd
	      FROM quota_usage_events
	      WHERE key_hash = ? AND timestamp_ms >= ?
	      GROUP BY model, windowMask
	    `,
			params: [...starts, row.key_hash, earliest],
		};
	});
	const results = await reader.run(operations);
	const spendByKey = new Map<string, { total: number; daily: number; weekly: number }>();
	rows.forEach((row, index) => {
		const spend = { total: 0, daily: 0, weekly: 0 };
		for (const costRow of results[index] as AsyncCostRow[]) {
			const cost = sumCost([costRow]);
			if (costRow.windowMask & 1) spend.total += cost;
			if (costRow.windowMask & 2) spend.daily += cost;
			if (costRow.windowMask & 4) spend.weekly += cost;
		}
		spendByKey.set(row.key_hash, spend);
	});
	return statesFromSpend(rows, timingByKey, spendByKey);
}

export function quotaStateFor(row: KeyQuotaRow, now = new Date()): KeyQuotaState {
	return quotaStatesFor([row], now).get(row.key_hash)!;
}

/** 手动重置某个窗口：把起算点推到当前时刻，此前的消耗不再计入。 */
export function resetQuotaWindow(
	keyHash: string,
	window: "total" | "daily" | "weekly",
) {
	const column = {
		total: "quota_total_since",
		daily: "quota_daily_since",
		weekly: "quota_weekly_since",
	}[window];
	db.prepare(
		`UPDATE api_keys SET ${column} = ?, updated_at = ? WHERE key_hash = ?`,
	).run(new Date().toISOString(), new Date().toISOString(), keyHash);
}

const listKeys = () =>
	db.prepare("SELECT * FROM api_keys").all() as KeyQuotaRow[];

/**
 * 超限的 key 从 CPA 的 api-keys 列表里摘掉——CPA 没有按 key 的额度机制，
 * 摘除是唯一能真正拦住请求的手段。恢复额度后自动加回。
 */
export async function enforceQuotas() {
	const rows = listKeys();
	if (!rows.length) return { blocked: 0, restored: 0 };

	const byHash = new Map(rows.map((row) => [row.key_hash, row]));
	const states = await quotaStatesForAsync(rows);
	const plan = planQuotaActions(
		rows.map((row) => ({
			keyHash: row.key_hash,
			enabled: Boolean(row.enabled),
			blockedReason: row.quota_blocked_reason,
			state: states.get(row.key_hash) as KeyQuotaState,
		})),
	);

	const toBlock = plan.block.map(({ keyHash, window }) => {
		const state = states.get(keyHash) as KeyQuotaState;
		const detail = state[window];
		return {
			row: byHash.get(keyHash) as KeyQuotaRow,
			reason: `${WINDOW_LABELS[window]}已用 $${detail.spentUsd.toFixed(2)} / $${detail.limitUsd.toFixed(2)}`,
		};
	});
	const toRestore = plan.restore.map(
		(keyHash) => byHash.get(keyHash) as KeyQuotaRow,
	);
	if (!toBlock.length && !toRestore.length) return { blocked: 0, restored: 0 };

	const cpaKeys = new Set(await getCPAKeys());
	const now = new Date().toISOString();
	for (const { row, reason } of toBlock) {
		cpaKeys.delete(row.key_value);
		db.prepare(
			"UPDATE api_keys SET enabled = 0, quota_blocked_reason = ?, updated_at = ? WHERE key_hash = ?",
		).run(reason, now, row.key_hash);
		addAudit("quota-block", `${row.name}：${reason}`);
	}
	for (const row of toRestore) {
		cpaKeys.add(row.key_value);
		db.prepare(
			"UPDATE api_keys SET enabled = 1, quota_blocked_reason = '', updated_at = ? WHERE key_hash = ?",
		).run(now, row.key_hash);
		addAudit("quota-restore", row.name);
	}
	await replaceCPAKeys([...cpaKeys]);
	return { blocked: toBlock.length, restored: toRestore.length };
}

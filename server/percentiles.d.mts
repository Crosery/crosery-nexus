export type PercentileSummaryRow = { dim: 'a' | 'm' | 'p' | 'b'; k: string | number; n: number; p50: number | null; p95: number | null }

export function percentileSummary(rows: Iterable<Record<string, unknown>>, fields: readonly string[]): Record<string, PercentileSummaryRow[]>

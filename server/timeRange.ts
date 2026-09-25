export type TimeUnit = 'days' | 'hours'

export function epochMsForTimestamp(timestamp: string): number {
  const value = Date.parse(timestamp)
  if (!Number.isFinite(value)) throw new Error(`非法时间戳: ${timestamp}`)
  return value
}

export function cutoffEpochMs(amount: number, unit: TimeUnit, now = Date.now()): number {
  const multiplier = unit === 'days' ? 24 * 60 * 60 * 1000 : 60 * 60 * 1000
  return now - amount * multiplier
}

export function usageWindow(
  amount: number,
  keyId = '',
  timestampColumn = 'timestamp_ms',
  now = Date.now(),
  keyColumn = 'key_hash',
  unit: TimeUnit = 'days',
): { where: string; params: Array<number | string> } {
  return keyId
    ? { where: `${timestampColumn} >= ? AND ${keyColumn} = ?`, params: [cutoffEpochMs(amount, unit, now), keyId] }
    : { where: `${timestampColumn} >= ?`, params: [cutoffEpochMs(amount, unit, now)] }
}

export function readBearerToken(header: string | undefined): string | null {
  const match = header?.match(/^Bearer\s+(.+)$/i)
  const token = match?.[1]?.trim()
  return token || null
}

export function boundedInteger(value: unknown, fallback: number, minimum: number, maximum: number): number {
  if (value === undefined || value === null || value === '') return fallback
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.max(minimum, Math.min(maximum, Math.floor(parsed)))
}

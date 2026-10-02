/**
 * `GET /api/pulse` — the console header's live edge and the statusline gateway figures (CONTRACTS C6).
 *
 * Read-only over the local `usage_events` ingest table (indexed on `timestamp_ms` and
 * `(success, timestamp_ms)`): per-second request / error counts for the last 90 s, plus rpm, p95 and success
 * rate over the last 5 minutes. One computation per second is shared by every open tab, so N admin tabs
 * polling every 2 s cost at most one small query burst per second. It never calls an upstream.
 *
 * p95 is the nearest rank over successful requests that reported a latency: `latency_ms = 0` means "not
 * reported" (the 性能 tab's rule), so it is left out of the ranking instead of counting as a measured 0 ms.
 * rpm and success rate keep the whole population.
 */
import type express from 'express'
import type { DatabaseSync } from 'node:sqlite'

export const PULSE_WINDOW_SEC = 90
export const PULSE_STATS_MS = 5 * 60_000
/** Usage rows land after the collector's next tick; the newest seconds are always incomplete. */
export const PULSE_LAG_SEC = 2
const CACHE_MS = 1_000

export type PulsePayload = {
  windowSec: number
  samples: Array<{ t: number; rps: number; err: number }>
  rpm: number | null
  p95Ms: number | null
  successRate: number | null
  generatedAt: string
}

type Row = Record<string, number | null>

export function createPulseReader(db: DatabaseSync, now: () => number = Date.now) {
  const buckets = db.prepare(`
    SELECT timestamp_ms / 1000 AS s, COUNT(*) AS n, SUM(CASE WHEN success = 0 THEN 1 ELSE 0 END) AS err
    FROM usage_events WHERE timestamp_ms >= ? AND timestamp_ms < ? GROUP BY s`)
  const totals = db.prepare(`
    SELECT COUNT(*) AS n, SUM(CASE WHEN success = 1 THEN 1 ELSE 0 END) AS ok,
      SUM(CASE WHEN success = 1 AND latency_ms > 0 THEN 1 ELSE 0 END) AS measured
    FROM usage_events WHERE timestamp_ms >= ? AND timestamp_ms < ?`)
  const latencyAt = db.prepare(`
    SELECT latency_ms AS v FROM usage_events
    WHERE success = 1 AND latency_ms > 0 AND timestamp_ms >= ? AND timestamp_ms < ? ORDER BY latency_ms LIMIT 1 OFFSET ?`)

  let cached: { at: number; value: PulsePayload } | null = null

  function compute(): PulsePayload {
    const nowMs = now()
    const endSec = Math.floor(nowMs / 1000) - PULSE_LAG_SEC
    const startSec = endSec - PULSE_WINDOW_SEC + 1
    const counts = new Map<number, { n: number; err: number }>()
    for (const row of buckets.all(startSec * 1000, (endSec + 1) * 1000) as Row[]) {
      counts.set(Number(row.s), { n: Number(row.n ?? 0), err: Number(row.err ?? 0) })
    }
    const samples: PulsePayload['samples'] = []
    for (let s = startSec; s <= endSec; s += 1) {
      const hit = counts.get(s)
      samples.push({ t: s * 1000, rps: hit?.n ?? 0, err: hit?.err ?? 0 })
    }

    const statsEnd = (endSec + 1) * 1000
    const statsStart = statsEnd - PULSE_STATS_MS
    const total = totals.get(statsStart, statsEnd) as Row | undefined
    const n = Number(total?.n ?? 0)
    const ok = Number(total?.ok ?? 0)
    const measured = Number(total?.measured ?? 0)
    let p95Ms: number | null = null
    if (measured > 0) {
      const offset = Math.max(0, Math.ceil(measured * 0.95) - 1)
      const row = latencyAt.get(statsStart, statsEnd, offset) as Row | undefined
      p95Ms = row?.v ?? null
    }
    return {
      windowSec: PULSE_WINDOW_SEC,
      samples,
      rpm: Math.round((n / (PULSE_STATS_MS / 60_000)) * 10) / 10,
      p95Ms,
      successRate: n > 0 ? ok / n : null,
      generatedAt: new Date(nowMs).toISOString(),
    }
  }

  return {
    read(): PulsePayload {
      const at = now()
      if (!cached || at - cached.at >= CACHE_MS || at < cached.at) cached = { at, value: compute() }
      return cached.value
    },
  }
}

export function registerPulseRoutes(app: express.Express, db: DatabaseSync) {
  const reader = createPulseReader(db)
  app.get('/api/pulse', (_req, res) => {
    res.setHeader('Cache-Control', 'no-store')
    try {
      res.json(reader.read())
    } catch (error) {
      // fixed text for the browser; the DB / driver message stays in the server log
      console.warn(`[pulse] 读取失败：${error instanceof Error ? error.message : '未知错误'}`)
      res.status(503).json({ error: '实时脉搏暂不可用', code: 'pulse_unavailable' })
    }
  })
}

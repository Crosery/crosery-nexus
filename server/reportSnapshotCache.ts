import { createHash } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'

import { DEFAULT_SNAPSHOT_MAX_STALE_MS, SnapshotStore } from './snapshotStore.js'

type ReportPayload = Record<string, unknown>
const REPORT_STORAGE_PREFIX = 'report-v1:'
const DEFAULT_REPORT_MEMORY_ENTRIES = 128
const DEFAULT_REPORT_PERSISTENT_ENTRIES = 512

function parseReportPayload(value: unknown): ReportPayload {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('report snapshot payload must be an object')
  }
  return value as ReportPayload
}

function storageKey(cacheKey: string) {
  const digest = createHash('sha256').update(cacheKey).digest('hex')
  return `${REPORT_STORAGE_PREFIX}${digest}`
}

/**
 * Persistent stale-while-revalidate cache for bounded reporting payloads.
 * The hash keeps arbitrary filter values out of the shared snapshot key while
 * the v1 prefix isolates future response-contract changes.
 */
export class ReportSnapshotCache {
  private readonly store: SnapshotStore<ReportPayload>
  private readonly database: DatabaseSync
  private readonly now: () => number
  private readonly maxStaleMs: number
  private readonly maxPersistentEntries: number

  constructor(
    database: DatabaseSync,
    options: {
      maxStaleMs?: number
      now?: () => number
      schedule?: (task: () => void) => void
      maxMemoryEntries?: number
      maxPersistentEntries?: number
    } = {},
  ) {
    this.database = database
    this.now = options.now ?? Date.now
    this.maxStaleMs = options.maxStaleMs ?? DEFAULT_SNAPSHOT_MAX_STALE_MS
    this.maxPersistentEntries = options.maxPersistentEntries ?? DEFAULT_REPORT_PERSISTENT_ENTRIES
    if (!Number.isSafeInteger(this.maxPersistentEntries) || this.maxPersistentEntries < 1) {
      throw new Error('report snapshot maxPersistentEntries must be a positive integer')
    }
    this.store = new SnapshotStore(database, parseReportPayload, {
      maxStaleMs: this.maxStaleMs,
      now: this.now,
      schedule: options.schedule,
      maxMemoryEntries: options.maxMemoryEntries ?? DEFAULT_REPORT_MEMORY_ENTRIES,
    })
    this.prunePersistent()
  }

  private prunePersistent() {
    this.database.prepare(`
      DELETE FROM data_plane_snapshots
      WHERE snapshot_key LIKE ? AND generated_at < ?
    `).run(`${REPORT_STORAGE_PREFIX}%`, this.now() - this.maxStaleMs)
    this.database.prepare(`
      DELETE FROM data_plane_snapshots WHERE snapshot_key IN (
        SELECT snapshot_key FROM data_plane_snapshots
        WHERE snapshot_key LIKE ?
        ORDER BY stored_at DESC, snapshot_key DESC
        LIMIT -1 OFFSET ?
      )
    `).run(`${REPORT_STORAGE_PREFIX}%`, this.maxPersistentEntries)
  }

  async run<T extends ReportPayload>(
    cacheKey: string,
    freshForMs: number,
    loader: () => Promise<T>,
  ): Promise<T> {
    const key = storageKey(cacheKey)
    const hadSnapshot = this.store.get(key, freshForMs) !== null
    const snapshot = await this.store.getOrRefresh(key, freshForMs, async () => ({
      value: await loader(),
    }))
    // Existing keys cannot grow L2. Keep the hot cached path free of a
    // synchronous DELETE transaction and prune only after a new scope appears.
    if (!hadSnapshot) this.prunePersistent()
    return snapshot.value as T
  }

  clearMemory(cacheKey?: string) {
    this.store.clearMemory(cacheKey === undefined ? undefined : storageKey(cacheKey))
  }
}

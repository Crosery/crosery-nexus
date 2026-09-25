import type { DatabaseSync } from 'node:sqlite'

export type SnapshotValue<T> = {
  value: T
  generatedAt: number
  storedAt: number
  stale: boolean
}

type StoredSnapshot<T> = Omit<SnapshotValue<T>, 'stale'>
type SnapshotLoader<T> = () => Promise<{ value: T; generatedAt?: number }>
type SnapshotDecoder<T> = (value: unknown) => T
type Schedule = (task: () => void) => void

const SNAPSHOT_KEY = /^[a-zA-Z0-9][a-zA-Z0-9:._-]{0,159}$/
export const DEFAULT_SNAPSHOT_MAX_STALE_MS = 5 * 60_000
export const DEFAULT_SNAPSHOT_MEMORY_ENTRIES = 256

function snapshotKey(value: string): string {
  if (!SNAPSHOT_KEY.test(value)) throw new Error('snapshot key is invalid')
  return value
}

/**
 * L1 memory + L2 SQLite snapshot storage. A snapshot is replaced by one SQLite
 * UPSERT, so readers never observe a partially written JSON value.
 */
export class SnapshotStore<T> {
  private readonly memory = new Map<string, StoredSnapshot<T>>()
  private readonly refreshing = new Map<string, Promise<void>>()
  private readonly refreshQueued = new Set<string>()
  private readonly now: () => number
  private readonly schedule: Schedule
  private readonly maxStaleMs: number
  private readonly maxMemoryEntries: number

  constructor(
    private readonly database: DatabaseSync,
    private readonly decode: SnapshotDecoder<T>,
    options: { now?: () => number; schedule?: Schedule; maxStaleMs?: number; maxMemoryEntries?: number } = {},
  ) {
    this.now = options.now ?? Date.now
    this.schedule = options.schedule ?? ((task) => setImmediate(task))
    this.maxStaleMs = options.maxStaleMs ?? DEFAULT_SNAPSHOT_MAX_STALE_MS
    this.maxMemoryEntries = options.maxMemoryEntries ?? DEFAULT_SNAPSHOT_MEMORY_ENTRIES
    if (!Number.isSafeInteger(this.maxStaleMs) || this.maxStaleMs < 0) {
      throw new Error('snapshot maxStaleMs must be a non-negative integer')
    }
    if (!Number.isSafeInteger(this.maxMemoryEntries) || this.maxMemoryEntries < 1) {
      throw new Error('snapshot maxMemoryEntries must be a positive integer')
    }
    database.exec(`
      CREATE TABLE IF NOT EXISTS data_plane_snapshots (
        snapshot_key TEXT PRIMARY KEY,
        payload_json TEXT NOT NULL,
        generated_at INTEGER NOT NULL,
        stored_at INTEGER NOT NULL
      )
    `)
  }

  private remember(key: string, snapshot: StoredSnapshot<T>) {
    // Map insertion order is the LRU order. Refreshing an existing key moves it
    // to the end; the oldest process-local entry is discarded at the cap.
    this.memory.delete(key)
    this.memory.set(key, snapshot)
    while (this.memory.size > this.maxMemoryEntries) {
      const oldest = this.memory.keys().next().value as string | undefined
      if (oldest === undefined) break
      this.memory.delete(oldest)
    }
  }

  private persistent(key: string): StoredSnapshot<T> | null {
    const row = this.database.prepare(`
      SELECT payload_json payloadJson, generated_at generatedAt, stored_at storedAt
      FROM data_plane_snapshots WHERE snapshot_key = ?
    `).get(key) as { payloadJson: string; generatedAt: number; storedAt: number } | undefined
    if (!row) return null
    try {
      const value = this.decode(JSON.parse(row.payloadJson))
      if (!Number.isFinite(row.generatedAt) || !Number.isFinite(row.storedAt)) return null
      return { value, generatedAt: row.generatedAt, storedAt: row.storedAt }
    } catch {
      // A corrupt or incompatible L2 entry is a cache miss. It is never returned
      // and a later successful refresh atomically repairs it.
      return null
    }
  }

  get(keyValue: string, freshForMs: number): SnapshotValue<T> | null {
    const key = snapshotKey(keyValue)
    const current = this.memory.get(key) ?? this.persistent(key)
    if (!current) return null
    const ageMs = Math.max(0, this.now() - current.generatedAt)
    if (ageMs > this.maxStaleMs) {
      this.memory.delete(key)
      return null
    }
    this.remember(key, current)
    return { ...current, stale: ageMs > freshForMs }
  }

  put(keyValue: string, value: T, generatedAt = this.now()): SnapshotValue<T> {
    const key = snapshotKey(keyValue)
    if (!Number.isFinite(generatedAt)) throw new Error('snapshot generatedAt is invalid')
    const decoded = this.decode(value)
    const payload = JSON.stringify(decoded)
    const storedAt = this.now()
    this.database.prepare(`
      INSERT INTO data_plane_snapshots (snapshot_key, payload_json, generated_at, stored_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(snapshot_key) DO UPDATE SET
        payload_json = excluded.payload_json,
        generated_at = excluded.generated_at,
        stored_at = excluded.stored_at
    `).run(key, payload, generatedAt, storedAt)
    const stored = { value: decoded, generatedAt, storedAt }
    this.remember(key, stored)
    return { ...stored, stale: false }
  }

  private refresh(key: string, loader: SnapshotLoader<T>): Promise<void> {
    const running = this.refreshing.get(key)
    if (running) return running
    const pending = loader()
      .then((result) => { this.put(key, result.value, result.generatedAt ?? this.now()) })
      .finally(() => this.refreshing.delete(key))
    this.refreshing.set(key, pending)
    return pending
  }

  /**
   * Fresh snapshots return immediately. Stale snapshots also return immediately
   * while one refresh runs in the background. A failed refresh keeps last-good.
   */
  async getOrRefresh(keyValue: string, freshForMs: number, loader: SnapshotLoader<T>): Promise<SnapshotValue<T>> {
    const key = snapshotKey(keyValue)
    const current = this.get(key, freshForMs)
    if (current && !current.stale) return current
    if (current) {
      if (!this.refreshing.has(key) && !this.refreshQueued.has(key)) {
        this.refreshQueued.add(key)
        this.schedule(() => {
          this.refreshQueued.delete(key)
          void this.refresh(key, loader).catch(() => undefined)
        })
      }
      return current
    }
    await this.refresh(key, loader)
    const loaded = this.get(key, freshForMs)
    if (!loaded) throw new Error('snapshot refresh did not produce a readable value')
    return loaded
  }

  clearMemory(keyValue?: string): void {
    if (keyValue === undefined) this.memory.clear()
    else this.memory.delete(snapshotKey(keyValue))
  }
}

import { createHash } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import {
  MAX_INGEST_BATCH_SIZE,
  parseIngestUsageResponse,
  parseSnapshotEnvelope,
  parseUsageEvent,
  type UsageEvent,
  type UsageSnapshot,
} from '../packages/contracts/index.js'
import { SnapshotStore, type SnapshotValue } from './snapshotStore.js'

export type DataPlaneUsageEvent = UsageEvent

export type DataPlaneRelayOptions = {
  enabled: boolean
  baseUrl: string
  token: string
  timeoutMs: number
  batchSize: number
  intervalMs: number
  backoffBaseMs: number
  backoffMaxMs: number
  fetch?: typeof fetch
  now?: () => number
  schedule?: (task: () => void) => void
}

export type RelayResult = {
  sent: number
  pending: number
  errorCode: string | null
}

export type DataPlaneRelayStatus = {
  enabled: boolean
  pending: number
  deadLetters: number
  oldestPendingAgeMs: number | null
  lastErrorCode: string | null
  lastAttemptAt: number | null
  lastSuccessAt: number | null
  effectiveBatchSize: number
}

type OutboxRow = { requestId: string; payloadJson: string; attempts: number }
type RelayStateRow = {
  lastErrorCode: string
  lastAttemptAt: number | null
  lastSuccessAt: number | null
  effectiveBatchSize: number
}
type StableIdentityValue = string | number | boolean | null

function quarantineJson(input: unknown): string {
  const record = input && typeof input === 'object' ? input as Record<string, unknown> : {}
  const knownFields = Object.fromEntries([
    'requestId', 'timestamp', 'timestampMs', 'keyHash', 'provider', 'model', 'modelGroup', 'endpoint',
    'success', 'statusCode', 'latencyMs', 'ttftMs', 'inputTokens', 'outputTokens', 'reasoningTokens',
    'cachedTokens', 'cacheWriteTokens', 'totalTokens', 'errorCategory', 'source', 'authIndex', 'clientType',
  ].map((key) => [key, record[key]]))
  return JSON.stringify(knownFields, (_key, value) => {
    if (typeof value === 'number' && !Number.isFinite(value)) return { invalidNumber: String(value) }
    if (typeof value === 'bigint') return { invalidBigInt: String(value) }
    return value
  }) ?? '{}'
}

/** Stable fallback for legacy CPA events that do not carry request_id. */
export function stableUsageRequestId(identity: Record<string, StableIdentityValue>): string {
  const canonical = Object.keys(identity).sort().map((key) => {
    const value = identity[key]
    if (typeof value === 'number' && !Number.isFinite(value)) return [key, `number:${String(value)}`]
    return [key, value]
  })
  return `fallback-${createHash('sha256').update(JSON.stringify(canonical)).digest('hex')}`
}

/**
 * CPA versions without request_id cannot distinguish two otherwise identical
 * queue entries. Allocate a durable source sequence inside the caller's SQLite
 * transaction so legitimate duplicate-looking requests remain distinct and a
 * rollback also rolls the allocation back.
 */
export function nextLegacyUsageRequestId(database: DatabaseSync, identity: Record<string, StableIdentityValue>): string {
  const row = database.prepare(`
    UPDATE data_plane_source_state
    SET next_sequence = next_sequence + 1
    WHERE source = 'cpa-legacy-usage'
    RETURNING next_sequence - 1 sequence
  `).get() as { sequence: number } | undefined
  if (!row || !Number.isSafeInteger(row.sequence) || row.sequence < 1) {
    throw new Error('legacy usage source sequence is unavailable')
  }
  return stableUsageRequestId({ ...identity, sourceSequence: row.sequence })
}

class RelayHttpError extends Error {
  constructor(readonly status: number) {
    super(`http_${status}`)
  }
}

function relayErrorCode(error: unknown): string {
  if (error instanceof Error && error.name === 'AbortError') return 'timeout'
  if (error instanceof Error && /^http_[1-5][0-9]{2}$/.test(error.message)) return error.message
  if (error instanceof Error && error.message === 'invalid_ack') return 'invalid_ack'
  return 'network'
}

function configuredBatchSize(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_INGEST_BATCH_SIZE) {
    throw new Error(`data plane batch size must be between 1 and ${MAX_INGEST_BATCH_SIZE}`)
  }
  return value
}

function joinInternalUrl(baseUrl: string, path: string): string {
  if (!path.startsWith('/internal/v1/')) throw new Error('data plane path must be internal v1')
  return `${baseUrl.replace(/\/$/, '')}${path}`
}

async function timedFetch(fetchImpl: typeof fetch, url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  timer.unref?.()
  try {
    return await fetchImpl(url, { ...init, signal: controller.signal })
  } finally {
    clearTimeout(timer)
  }
}

/** Durable, at-least-once relay. The receiver deduplicates by requestId. */
export class DataPlaneRelay {
  private readonly fetchImpl: typeof fetch
  private readonly now: () => number
  private readonly schedule: (task: () => void) => void
  private inflight: Promise<RelayResult> | null = null
  private timer: NodeJS.Timeout | null = null
  private readonly configuredBatchSize: number
  private effectiveBatchSize: number
  private resizeMode: 'fast' | 'cautious' = 'fast'
  private successfulFullBatches = 0

  constructor(private readonly database: DatabaseSync, private readonly options: DataPlaneRelayOptions) {
    this.fetchImpl = options.fetch ?? fetch
    this.now = options.now ?? Date.now
    this.schedule = options.schedule ?? ((task) => setImmediate(task))
    this.configuredBatchSize = configuredBatchSize(options.batchSize)
    this.effectiveBatchSize = this.configuredBatchSize
    database.exec(`
      CREATE TABLE IF NOT EXISTS data_plane_outbox (
        request_id TEXT PRIMARY KEY,
        payload_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        next_attempt_at INTEGER NOT NULL DEFAULT 0,
        last_error_code TEXT NOT NULL DEFAULT ''
      );
      CREATE INDEX IF NOT EXISTS idx_data_plane_outbox_due
        ON data_plane_outbox(next_attempt_at, created_at);
      CREATE INDEX IF NOT EXISTS idx_data_plane_outbox_created
        ON data_plane_outbox(created_at);
      CREATE TABLE IF NOT EXISTS data_plane_dead_letters (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        request_id TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        error_code TEXT NOT NULL,
        attempts INTEGER NOT NULL,
        quarantined_at INTEGER NOT NULL,
        UNIQUE(request_id, payload_json)
      );
      CREATE TABLE IF NOT EXISTS data_plane_relay_state (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        last_error_code TEXT NOT NULL DEFAULT '',
        last_attempt_at INTEGER,
        last_success_at INTEGER,
        effective_batch_size INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS data_plane_source_state (
        source TEXT PRIMARY KEY,
        next_sequence INTEGER NOT NULL CHECK (next_sequence > 0)
      );
    `)
    database.prepare(`
      INSERT OR IGNORE INTO data_plane_relay_state (id, effective_batch_size) VALUES (1, ?)
    `).run(this.effectiveBatchSize)
    database.prepare(`
      INSERT OR IGNORE INTO data_plane_source_state (source, next_sequence)
      VALUES ('cpa-legacy-usage', 1)
    `).run()
    const state = this.state()
    this.effectiveBatchSize = Math.min(this.effectiveBatchSize, Math.max(1, state.effectiveBatchSize))
    // A reduced persisted size may have come from a 413 before restart. Resume
    // with the safer recovery policy and a fresh success streak.
    if (this.effectiveBatchSize < this.configuredBatchSize) this.resizeMode = 'cautious'
    this.updateState({ effectiveBatchSize: this.effectiveBatchSize })
  }

  private noteSuccessfulBatch(sent: number): void {
    if (this.effectiveBatchSize >= this.configuredBatchSize) {
      this.successfulFullBatches = 0
      return
    }
    if (sent !== this.effectiveBatchSize) {
      this.successfulFullBatches = 0
      return
    }
    this.successfulFullBatches += 1
    const threshold = this.resizeMode === 'cautious' ? 8 : 1
    if (this.successfulFullBatches < threshold) return
    const increment = this.resizeMode === 'cautious'
      ? Math.max(1, Math.floor(this.effectiveBatchSize / 4))
      : this.effectiveBatchSize
    this.effectiveBatchSize = Math.min(this.configuredBatchSize, this.effectiveBatchSize + increment)
    this.successfulFullBatches = 0
    this.updateState({ effectiveBatchSize: this.effectiveBatchSize })
  }

  enqueue(event: DataPlaneUsageEvent): boolean {
    if (!this.options.enabled) return false
    let item: DataPlaneUsageEvent
    try {
      item = parseUsageEvent(event)
    } catch {
      const payloadJson = quarantineJson(event)
      const rawRequestId = typeof event?.requestId === 'string' ? event.requestId : ''
      const requestId = rawRequestId && rawRequestId.length <= 200
        ? rawRequestId
        : `invalid-${createHash('sha256').update(payloadJson).digest('hex')}`
      this.database.prepare(`
        INSERT OR IGNORE INTO data_plane_dead_letters
          (request_id, payload_json, error_code, attempts, quarantined_at)
        VALUES (?, ?, 'invalid_event', 0, ?)
      `).run(requestId, payloadJson, this.now())
      return false
    }
    const result = this.database.prepare(`
      INSERT OR IGNORE INTO data_plane_outbox
        (request_id, payload_json, created_at, attempts, next_attempt_at, last_error_code)
      VALUES (?, ?, ?, 0, 0, '')
    `).run(item.requestId, JSON.stringify(item), this.now())
    return result.changes > 0
  }

  pending(): number {
    const row = this.database.prepare('SELECT COUNT(*) count FROM data_plane_outbox').get() as { count: number }
    return row.count
  }

  quarantined(): number {
    const row = this.database.prepare('SELECT COUNT(*) count FROM data_plane_dead_letters').get() as { count: number }
    return row.count
  }

  status(): DataPlaneRelayStatus {
    return readDataPlaneRelayStatus(this.database, this.options.enabled, this.now)
  }

  private state(): RelayStateRow {
    return this.database.prepare(`
      SELECT last_error_code lastErrorCode, last_attempt_at lastAttemptAt,
        last_success_at lastSuccessAt, effective_batch_size effectiveBatchSize
      FROM data_plane_relay_state WHERE id = 1
    `).get() as RelayStateRow
  }

  private updateState(update: {
    errorCode?: string | null
    attemptedAt?: number
    succeededAt?: number
    effectiveBatchSize?: number
  }): void {
    const current = this.state()
    this.database.prepare(`
      UPDATE data_plane_relay_state
      SET last_error_code = ?, last_attempt_at = ?, last_success_at = ?, effective_batch_size = ?
      WHERE id = 1
    `).run(
      update.errorCode === undefined ? current.lastErrorCode : (update.errorCode ?? ''),
      update.attemptedAt ?? current.lastAttemptAt,
      update.succeededAt ?? current.lastSuccessAt,
      update.effectiveBatchSize ?? current.effectiveBatchSize,
    )
  }

  private due(): OutboxRow[] {
    return this.database.prepare(`
      SELECT request_id requestId, payload_json payloadJson, attempts
      FROM data_plane_outbox
      WHERE next_attempt_at <= ?
      ORDER BY created_at, request_id
      LIMIT ?
    `).all(this.now(), this.effectiveBatchSize) as OutboxRow[]
  }

  private quarantine(rows: OutboxRow[], errorCode: string, attempted = false): void {
    if (!rows.length) return
    const insert = this.database.prepare(`
      INSERT OR IGNORE INTO data_plane_dead_letters
        (request_id, payload_json, error_code, attempts, quarantined_at)
      VALUES (?, ?, ?, ?, ?)
    `)
    const remove = this.database.prepare('DELETE FROM data_plane_outbox WHERE request_id = ?')
    this.database.exec('BEGIN IMMEDIATE')
    try {
      for (const row of rows) {
        insert.run(row.requestId, row.payloadJson, errorCode, row.attempts + (attempted ? 1 : 0), this.now())
        remove.run(row.requestId)
      }
      this.database.exec('COMMIT')
    } catch (error) {
      this.database.exec('ROLLBACK')
      throw error
    }
  }

  private retry(rows: OutboxRow[], errorCode: string, forceMaximumDelay = false): void {
    const retry = this.database.prepare(`
      UPDATE data_plane_outbox
      SET attempts = attempts + 1, next_attempt_at = ?, last_error_code = ?
      WHERE request_id = ?
    `)
    this.database.exec('BEGIN IMMEDIATE')
    try {
      for (const row of rows) {
        const exponentialDelay = Math.min(
          this.options.backoffMaxMs,
          this.options.backoffBaseMs * (2 ** Math.min(row.attempts, 20)),
        )
        retry.run(this.now() + (forceMaximumDelay ? this.options.backoffMaxMs : exponentialDelay), errorCode, row.requestId)
      }
      this.database.exec('COMMIT')
    } catch (error) {
      this.database.exec('ROLLBACK')
      throw error
    }
  }

  private async send(): Promise<RelayResult> {
    if (!this.options.enabled) return { sent: 0, pending: this.pending(), errorCode: null }
    const rows = this.due()
    if (!rows.length) return { sent: 0, pending: this.pending(), errorCode: null }

    const validRows: OutboxRow[] = []
    const events: DataPlaneUsageEvent[] = []
    const invalidRows: OutboxRow[] = []
    for (const row of rows) {
      try {
        events.push(parseUsageEvent(JSON.parse(row.payloadJson)))
        validRows.push(row)
      } catch {
        invalidRows.push(row)
      }
    }
    this.quarantine(invalidRows, 'invalid_outbox')
    if (!validRows.length) {
      this.updateState({ errorCode: 'invalid_outbox' })
      return { sent: 0, pending: this.pending(), errorCode: 'invalid_outbox' }
    }
    const batchId = createHash('sha256').update(JSON.stringify(validRows.map((row) => row.requestId))).digest('hex')
    const attemptedAt = this.now()
    this.updateState({ attemptedAt })

    try {
      const response = await timedFetch(this.fetchImpl, joinInternalUrl(this.options.baseUrl, '/internal/v1/usage/batches'), {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.options.token}`,
          'Content-Type': 'application/json',
          'X-Idempotency-Key': batchId,
        },
        body: JSON.stringify({ batchId, events }),
      }, this.options.timeoutMs)
      if (!response.ok) throw new RelayHttpError(response.status)
      const acknowledgement = await response.json().catch(() => { throw new Error('invalid_ack') })
      // The receiver owns per-request idempotency and must acknowledge the whole
      // batch, including rows it had already seen. Partial or ambiguous success
      // is replayed rather than deleting data locally.
      try {
        parseIngestUsageResponse(acknowledgement, batchId, validRows.length)
      } catch {
        throw new Error('invalid_ack')
      }

      const remove = this.database.prepare('DELETE FROM data_plane_outbox WHERE request_id = ?')
      this.database.exec('BEGIN IMMEDIATE')
      try {
        for (const row of validRows) remove.run(row.requestId)
        this.database.exec('COMMIT')
      } catch (error) {
        this.database.exec('ROLLBACK')
        throw error
      }
      this.noteSuccessfulBatch(validRows.length)
      const errorCode = invalidRows.length ? 'invalid_outbox' : null
      this.updateState({ errorCode, succeededAt: this.now() })
      return { sent: validRows.length, pending: this.pending(), errorCode }
    } catch (error) {
      this.successfulFullBatches = 0
      const errorCode = relayErrorCode(error)
      const status = error instanceof RelayHttpError ? error.status : null
      // A conflict can be caused by one reused request identity. Narrow the
      // batch until only that row is isolated; never discard unrelated rows.
      if (status === 409 && validRows.length === 1) {
        this.quarantine(validRows, errorCode, true)
      } else {
        if ((status === 409 || status === 413) && validRows.length > 1) {
          this.effectiveBatchSize = Math.max(1, Math.floor(validRows.length / 2))
          this.resizeMode = status === 413 ? 'cautious' : 'fast'
          this.successfulFullBatches = 0
          this.updateState({ effectiveBatchSize: this.effectiveBatchSize })
        }
        // Locally validated 400/422 responses and 404/405/415 indicate contract
        // or deployment drift. Keep the rows durably and back off for operator
        // action instead of turning an entire valid batch into dead letters.
        const contractOrDeploymentFailure = status !== null && [400, 404, 405, 415, 422].includes(status)
        this.retry(validRows, errorCode,
          status === 401 || status === 403 || contractOrDeploymentFailure || (status === 413 && validRows.length === 1))
      }
      this.updateState({ errorCode })
      return { sent: 0, pending: this.pending(), errorCode }
    }
  }

  flush(): Promise<RelayResult> {
    if (this.inflight) return this.inflight
    this.inflight = this.send().finally(() => { this.inflight = null })
    return this.inflight
  }

  requestFlush(): void {
    if (!this.options.enabled || this.inflight) return
    this.schedule(() => { void this.flush() })
  }

  start(): void {
    if (!this.options.enabled || this.timer) return
    this.requestFlush()
    this.timer = setInterval(() => this.requestFlush(), this.options.intervalMs)
    this.timer.unref()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }
}

export class DataPlaneSnapshotClient {
  private readonly fetchImpl: typeof fetch

  constructor(
    private readonly store: SnapshotStore<UsageSnapshot>,
    private readonly options: Pick<DataPlaneRelayOptions, 'enabled' | 'baseUrl' | 'token' | 'timeoutMs' | 'fetch'>,
  ) {
    this.fetchImpl = options.fetch ?? fetch
  }

  async read(snapshotKey: string, endpoint: string, freshForMs: number): Promise<SnapshotValue<UsageSnapshot> | null> {
    const local = this.store.get(snapshotKey, freshForMs)
    if (!this.options.enabled) return local
    try {
      return await this.store.getOrRefresh(snapshotKey, freshForMs, async () => {
        const response = await timedFetch(this.fetchImpl, joinInternalUrl(this.options.baseUrl, endpoint), {
          headers: { Authorization: `Bearer ${this.options.token}`, Accept: 'application/json' },
        }, this.options.timeoutMs)
        if (!response.ok) throw new Error(`http_${response.status}`)
        const envelope = parseSnapshotEnvelope(await response.json())
        return { value: envelope.data, generatedAt: Date.parse(envelope.generatedAt) }
      })
    } catch {
      // Cold remote failure is a cache miss. Callers can continue using their
      // existing local query path; a stale last-good value was already returned.
      return local
    }
  }
}

export function readDataPlaneRelayStatus(
  database: DatabaseSync,
  enabled: boolean,
  now: () => number = Date.now,
): DataPlaneRelayStatus {
  const pending = database.prepare('SELECT COUNT(*) count FROM data_plane_outbox').get() as { count: number }
  const deadLetters = database.prepare('SELECT COUNT(*) count FROM data_plane_dead_letters').get() as { count: number }
  const oldest = database.prepare('SELECT MIN(created_at) createdAt FROM data_plane_outbox').get() as { createdAt: number | null }
  const state = database.prepare(`
    SELECT last_error_code lastErrorCode, last_attempt_at lastAttemptAt,
      last_success_at lastSuccessAt, effective_batch_size effectiveBatchSize
    FROM data_plane_relay_state WHERE id = 1
  `).get() as RelayStateRow
  return {
    enabled,
    pending: pending.count,
    deadLetters: deadLetters.count,
    oldestPendingAgeMs: oldest.createdAt === null ? null : Math.max(0, now() - oldest.createdAt),
    lastErrorCode: state.lastErrorCode || null,
    lastAttemptAt: state.lastAttemptAt,
    lastSuccessAt: state.lastSuccessAt,
    effectiveBatchSize: state.effectiveBatchSize,
  }
}

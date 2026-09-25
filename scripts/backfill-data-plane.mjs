#!/usr/bin/env node

import { createHash, randomBytes } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'

import {
  MAX_INGEST_BATCH_SIZE,
  parseIngestUsageRequest,
  parseIngestUsageResponse,
  parseUsageEvent,
} from '../packages/contracts/index.ts'

const CHECKPOINT_VERSION = 1
const INGEST_PATH = '/internal/v1/usage/batches'
const MAX_ACK_BYTES = 64 * 1024
const DEFAULTS = {
  batchRows: 200,
  // Stay below the data service's default 1 MiB HTTP body limit after the
  // request envelope and JSON escaping are included.
  batchBytes: 900_000,
  timeoutMs: 10_000,
  maxRetries: 8,
  retryBaseMs: 500,
  retryMaxMs: 30_000,
}

const REQUIRED_COLUMNS = [
  'id',
  'request_id',
  'timestamp',
  'key_hash',
  'provider',
  'model',
  'model_group',
  'endpoint',
  'success',
  'status_code',
  'latency_ms',
  'ttft_ms',
  'input_tokens',
  'output_tokens',
  'reasoning_tokens',
  'cached_tokens',
  'cache_write_tokens',
  'total_tokens',
  'source',
  'auth_index',
  'client_type',
  'error_category',
]

const REQUIRED_QUOTA_COLUMNS = ['request_id', 'key_hash']

// A new CPA key can reach the collector before key reconciliation creates its
// api_keys row. In that window usage_events keeps NULL for its foreign key, but
// the same transaction stores the real hash in quota_usage_events and in the
// live outbox payload. Reconstruct it here so overlap with the outbox remains
// byte-for-byte idempotent at the receiver. The quota ledger itself is not sent.
const SELECT_BATCH = `
  SELECT ${REQUIRED_COLUMNS.map((column) => column === 'key_hash'
    ? 'COALESCE(usage.key_hash, quota.key_hash) key_hash'
    : `usage.${column}`).join(', ')}
  FROM usage_events usage
  LEFT JOIN quota_usage_events quota ON quota.request_id = usage.request_id
  WHERE usage.id > ? AND usage.id <= ?
  ORDER BY usage.id
  LIMIT ?
`

class BackfillError extends Error {
  constructor(message, options) {
    super(message, options)
    this.name = 'BackfillError'
  }
}

class HttpStatusError extends BackfillError {
  constructor(status) {
    super(`data-plane returned HTTP ${status}`)
    this.status = status
  }
}

function integerSetting(name, value, fallback, min, max) {
  const candidate = value === undefined ? fallback : Number(value)
  if (!Number.isSafeInteger(candidate) || candidate < min || candidate > max) {
    throw new BackfillError(`${name} must be an integer between ${min} and ${max}`)
  }
  return candidate
}

function requiredSetting(name, value, maxLength = 4_096) {
  const text = value?.trim()
  if (!text || text.length > maxLength) throw new BackfillError(`${name} is required and must be at most ${maxLength} characters`)
  return text
}

function normalizedBaseUrl(value) {
  let url
  try {
    url = new URL(requiredSetting('DATA_PLANE_BASE_URL or --base-url', value))
  } catch (error) {
    if (error instanceof BackfillError) throw error
    throw new BackfillError('DATA_PLANE_BASE_URL or --base-url must be an absolute HTTP(S) URL')
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new BackfillError('data-plane base URL must use HTTP(S) without credentials, query, or fragment')
  }
  if (url.pathname !== '/' && url.pathname !== '') {
    throw new BackfillError('data-plane base URL must not contain a path')
  }
  return url.origin
}

function validateBearerToken(token, sourceName) {
  if (token.length < 32 || token.length > 4_096 || !/^[\x21-\x7e]+$/u.test(token)) {
    throw new BackfillError(`${sourceName} must contain one 32-4096 character Bearer token without whitespace`)
  }
  return token
}

export function loadBearerToken(env = process.env) {
  const direct = env.DATA_PLANE_TOKEN?.trim()
  const filename = env.DATA_PLANE_TOKEN_FILE?.trim()
  if (direct && filename) throw new BackfillError('DATA_PLANE_TOKEN and DATA_PLANE_TOKEN_FILE cannot both be set')
  if (direct) return validateBearerToken(direct, 'DATA_PLANE_TOKEN')
  if (!filename) throw new BackfillError('DATA_PLANE_TOKEN or DATA_PLANE_TOKEN_FILE is required')

  let stat
  let token
  try {
    stat = fs.statSync(filename)
    if (!stat.isFile() || stat.size > 16 * 1024) throw new Error('invalid token file')
    if (process.platform !== 'win32' && (stat.mode & 0o077) !== 0) throw new Error('insecure token file mode')
    token = fs.readFileSync(filename, 'utf8').replace(/[\r\n]+$/u, '')
  } catch {
    throw new BackfillError('DATA_PLANE_TOKEN_FILE must be a readable, private regular file no larger than 16 KiB')
  }
  return validateBearerToken(token, 'DATA_PLANE_TOKEN_FILE')
}

function argumentValues(argv) {
  const values = new Map()
  let help = false
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--help' || argument === '-h') {
      help = true
      continue
    }
    if (!argument.startsWith('--')) throw new BackfillError(`unexpected positional argument: ${argument}`)
    const separator = argument.indexOf('=')
    const name = separator === -1 ? argument : argument.slice(0, separator)
    let value = separator === -1 ? argv[index + 1] : argument.slice(separator + 1)
    if (separator === -1) index += 1
    if (value === undefined || value.startsWith('--')) throw new BackfillError(`${name} requires a value`)
    if (values.has(name)) throw new BackfillError(`${name} may be specified only once`)
    values.set(name, value)
  }
  return { values, help }
}

export function parseCliOptions(argv = process.argv.slice(2), env = process.env) {
  const { values, help } = argumentValues(argv)
  const allowed = new Set([
    '--sqlite', '--source-id', '--checkpoint', '--base-url', '--batch-rows', '--batch-bytes',
    '--timeout-ms', '--max-retries', '--retry-base-ms', '--retry-max-ms',
  ])
  for (const name of values.keys()) {
    if (!allowed.has(name)) throw new BackfillError(`unknown option: ${name}`)
  }
  if (help) return { help: true }

  const sqlitePath = path.resolve(requiredSetting('BACKFILL_SQLITE_PATH or --sqlite', values.get('--sqlite') ?? env.BACKFILL_SQLITE_PATH))
  const checkpointPath = path.resolve(requiredSetting('BACKFILL_CHECKPOINT_PATH or --checkpoint', values.get('--checkpoint') ?? env.BACKFILL_CHECKPOINT_PATH))
  const sourceId = requiredSetting('BACKFILL_SOURCE_ID or --source-id', values.get('--source-id') ?? env.BACKFILL_SOURCE_ID, 200)
  if (/\p{Cc}/u.test(sourceId)) throw new BackfillError('source identity must not contain control characters')

  const options = {
    sqlitePath,
    checkpointPath,
    sourceId,
    baseUrl: normalizedBaseUrl(values.get('--base-url') ?? env.DATA_PLANE_BASE_URL),
    token: loadBearerToken(env),
    batchRows: integerSetting('--batch-rows', values.get('--batch-rows') ?? env.BACKFILL_BATCH_ROWS, DEFAULTS.batchRows, 1, MAX_INGEST_BATCH_SIZE),
    batchBytes: integerSetting('--batch-bytes', values.get('--batch-bytes') ?? env.BACKFILL_BATCH_BYTES, DEFAULTS.batchBytes, 1_024, 16 * 1024 * 1024),
    timeoutMs: integerSetting('--timeout-ms', values.get('--timeout-ms') ?? env.BACKFILL_TIMEOUT_MS, DEFAULTS.timeoutMs, 100, 60_000),
    maxRetries: integerSetting('--max-retries', values.get('--max-retries') ?? env.BACKFILL_MAX_RETRIES, DEFAULTS.maxRetries, 0, 20),
    retryBaseMs: integerSetting('--retry-base-ms', values.get('--retry-base-ms') ?? env.BACKFILL_RETRY_BASE_MS, DEFAULTS.retryBaseMs, 10, 60_000),
    retryMaxMs: integerSetting('--retry-max-ms', values.get('--retry-max-ms') ?? env.BACKFILL_RETRY_MAX_MS, DEFAULTS.retryMaxMs, 10, 300_000),
  }
  if (options.retryMaxMs < options.retryBaseMs) throw new BackfillError('--retry-max-ms must be greater than or equal to --retry-base-ms')
  if (options.sqlitePath === options.checkpointPath) throw new BackfillError('checkpoint path must be separate from the SQLite backup')
  return options
}

function sourceFileIdentity(filename) {
  const stat = fs.statSync(filename, { bigint: true })
  if (!stat.isFile()) throw new BackfillError('SQLite backup must be a regular file')
  return {
    device: String(stat.dev),
    inode: String(stat.ino),
    size: String(stat.size),
    mtimeNs: String(stat.mtimeNs),
  }
}

function sameFileIdentity(left, right) {
  return left.device === right.device
    && left.inode === right.inode
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
}

function schemaIdentity(tables) {
  const normalized = Object.fromEntries(Object.entries(tables).map(([table, columns]) => [
    table,
    columns.map((column) => ({
      cid: column.cid,
      name: column.name,
      type: column.type,
      notnull: column.notnull,
      pk: column.pk,
    })),
  ]))
  return createHash('sha256').update(JSON.stringify(normalized)).digest('hex')
}

function safeSourceInteger(value, name, { allowZero = true } = {}) {
  if (!Number.isSafeInteger(value) || value < (allowZero ? 0 : 1)) {
    throw new BackfillError(`${name} must be a ${allowZero ? 'non-negative' : 'positive'} safe integer`)
  }
  return value
}

function inspectSource(database, sourcePath, sourceId) {
  const quickCheck = database.prepare('PRAGMA quick_check').all()
  if (quickCheck.length !== 1 || quickCheck[0]?.quick_check !== 'ok') {
    throw new BackfillError('SQLite backup failed PRAGMA quick_check')
  }

  const columns = database.prepare('PRAGMA table_info(usage_events)').all()
  const available = new Set(columns.map((column) => column.name))
  const missing = REQUIRED_COLUMNS.filter((column) => !available.has(column))
  if (missing.length) throw new BackfillError(`SQLite usage_events is missing required columns: ${missing.join(', ')}`)
  const quotaColumns = database.prepare('PRAGMA table_info(quota_usage_events)').all()
  const availableQuotaColumns = new Set(quotaColumns.map((column) => column.name))
  const missingQuotaColumns = REQUIRED_QUOTA_COLUMNS.filter((column) => !availableQuotaColumns.has(column))
  if (missingQuotaColumns.length) {
    throw new BackfillError(`SQLite quota_usage_events is missing required columns: ${missingQuotaColumns.join(', ')}`)
  }

  const bounds = database.prepare(`
    SELECT COALESCE(MIN(id), 0) minId, COALESCE(MAX(id), 0) maxId, COUNT(*) rowCount
    FROM usage_events
  `).get()
  const minId = safeSourceInteger(bounds.minId, 'source minimum id')
  const maxId = safeSourceInteger(bounds.maxId, 'source maximum id')
  const rowCount = safeSourceInteger(bounds.rowCount, 'source row count')
  if (rowCount > 0 && minId < 1) throw new BackfillError('usage_events IDs must be positive')

  return {
    id: sourceId,
    path: sourcePath,
    table: 'usage_events',
    schemaSha256: schemaIdentity({ usage_events: columns, quota_usage_events: quotaColumns }),
    minId,
    maxId,
    rowCount,
    file: sourceFileIdentity(sourcePath),
  }
}

function validTimestamp(value, name) {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) throw new BackfillError(`${name} must be a valid timestamp`)
  return value
}

function newCheckpoint(source, now) {
  const timestamp = new Date(now()).toISOString()
  return {
    version: CHECKPOINT_VERSION,
    source,
    cursor: { lastId: 0 },
    totals: { acknowledged: 0, inserted: 0, duplicates: 0, batches: 0 },
    status: source.rowCount === 0 ? 'complete' : 'running',
    createdAt: timestamp,
    updatedAt: timestamp,
    completedAt: source.rowCount === 0 ? timestamp : null,
  }
}

function validateCheckpoint(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new BackfillError('checkpoint must contain a JSON object')
  if (value.version !== CHECKPOINT_VERSION) throw new BackfillError(`checkpoint version must be ${CHECKPOINT_VERSION}`)
  if (!value.source || typeof value.source !== 'object') throw new BackfillError('checkpoint source is missing')
  if (!value.cursor || typeof value.cursor !== 'object') throw new BackfillError('checkpoint cursor is missing')
  if (!value.totals || typeof value.totals !== 'object') throw new BackfillError('checkpoint totals are missing')

  const source = value.source
  const cursor = value.cursor
  const totals = value.totals
  requiredSetting('checkpoint source id', source.id, 200)
  requiredSetting('checkpoint source path', source.path)
  requiredSetting('checkpoint schema identity', source.schemaSha256, 64)
  if (source.table !== 'usage_events') throw new BackfillError('checkpoint source table is invalid')
  safeSourceInteger(source.minId, 'checkpoint source minimum id')
  safeSourceInteger(source.maxId, 'checkpoint source maximum id')
  safeSourceInteger(source.rowCount, 'checkpoint source row count')
  safeSourceInteger(cursor.lastId, 'checkpoint cursor')
  for (const name of ['acknowledged', 'inserted', 'duplicates', 'batches']) safeSourceInteger(totals[name], `checkpoint total ${name}`)
  if (!['running', 'complete'].includes(value.status)) throw new BackfillError('checkpoint status is invalid')
  validTimestamp(value.createdAt, 'checkpoint createdAt')
  validTimestamp(value.updatedAt, 'checkpoint updatedAt')
  if (value.completedAt !== null) validTimestamp(value.completedAt, 'checkpoint completedAt')
  if (cursor.lastId > source.maxId) throw new BackfillError('checkpoint cursor exceeds the fixed source maximum id')
  if (totals.acknowledged > source.rowCount || totals.inserted + totals.duplicates !== totals.acknowledged) {
    throw new BackfillError('checkpoint totals are inconsistent')
  }
  if (value.status === 'complete'
    && (cursor.lastId !== source.maxId || totals.acknowledged !== source.rowCount || value.completedAt === null)) {
    throw new BackfillError('completed checkpoint does not cover the fixed source snapshot')
  }
  if (value.status === 'running' && (cursor.lastId === source.maxId || value.completedAt !== null)) {
    throw new BackfillError('running checkpoint has an inconsistent completion state')
  }
  if (!source.file || !['device', 'inode', 'size', 'mtimeNs'].every((name) => typeof source.file[name] === 'string')) {
    throw new BackfillError('checkpoint source file identity is invalid')
  }
  return value
}

export function readCheckpoint(filename) {
  let contents
  try {
    contents = fs.readFileSync(filename, 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') return null
    throw new BackfillError('checkpoint is not readable', { cause: error })
  }
  try {
    return validateCheckpoint(JSON.parse(contents))
  } catch (error) {
    if (error instanceof BackfillError) throw error
    throw new BackfillError('checkpoint is not valid JSON', { cause: error })
  }
}

export function writeCheckpointAtomic(filename, checkpoint) {
  validateCheckpoint(checkpoint)
  const directory = path.dirname(filename)
  if (!fs.statSync(directory).isDirectory()) throw new BackfillError('checkpoint parent must be a directory')
  const temporary = path.join(directory, `.${path.basename(filename)}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`)
  let descriptor
  try {
    descriptor = fs.openSync(temporary, 'wx', 0o600)
    fs.writeFileSync(descriptor, `${JSON.stringify(checkpoint, null, 2)}\n`, 'utf8')
    fs.fsyncSync(descriptor)
    fs.closeSync(descriptor)
    descriptor = undefined
    fs.renameSync(temporary, filename)
    const directoryDescriptor = fs.openSync(directory, 'r')
    try {
      fs.fsyncSync(directoryDescriptor)
    } finally {
      fs.closeSync(directoryDescriptor)
    }
  } catch (error) {
    if (descriptor !== undefined) {
      try { fs.closeSync(descriptor) } catch { /* preserve the original checkpoint error */ }
    }
    try { fs.unlinkSync(temporary) } catch { /* rename may already have consumed it */ }
    throw new BackfillError('checkpoint could not be committed atomically', { cause: error })
  }
}

function assertSameSource(checkpoint, source) {
  if (checkpoint.source.id !== source.id) throw new BackfillError('checkpoint source identity does not match --source-id')
  if (checkpoint.source.path !== source.path) throw new BackfillError('checkpoint is bound to a different SQLite backup path')
  if (checkpoint.source.schemaSha256 !== source.schemaSha256) throw new BackfillError('SQLite usage_events schema changed after checkpoint creation')
  if (checkpoint.source.maxId !== source.maxId) throw new BackfillError('SQLite source maximum id changed after checkpoint creation')
  if (checkpoint.source.minId !== source.minId || checkpoint.source.rowCount !== source.rowCount) {
    throw new BackfillError('SQLite source row bounds changed after checkpoint creation')
  }
  if (!sameFileIdentity(checkpoint.source.file, source.file)) {
    throw new BackfillError('SQLite backup file identity changed after checkpoint creation')
  }
}

function fallbackRequestId(sourceId, sourceRowId) {
  const digest = createHash('sha256')
    .update(JSON.stringify(['sqlite-backfill-v1', sourceId, 'usage_events', sourceRowId]))
    .digest('hex')
  return `sqlite-${digest}`
}

export function rowToUsageEvent(row, sourceId) {
  const sourceRowId = safeSourceInteger(row.id, 'usage_events.id', { allowZero: false })
  const originalRequestId = typeof row.request_id === 'string' ? row.request_id : ''
  const requestId = originalRequestId.length > 0 && originalRequestId.length <= 200
    ? originalRequestId
    : fallbackRequestId(sourceId, sourceRowId)
  if (row.success !== 0 && row.success !== 1) throw new BackfillError(`usage_events row ${sourceRowId} has an invalid success flag`)
  if (typeof row.timestamp !== 'string' || !Number.isFinite(Date.parse(row.timestamp))) {
    throw new BackfillError(`usage_events row ${sourceRowId} has an invalid timestamp`)
  }

  try {
    return parseUsageEvent({
      requestId,
      timestamp: row.timestamp,
      timestampMs: Date.parse(row.timestamp),
      keyHash: row.key_hash,
      provider: row.provider,
      model: row.model,
      modelGroup: row.model_group ?? '',
      endpoint: row.endpoint ?? '',
      success: row.success === 1,
      statusCode: row.status_code,
      latencyMs: row.latency_ms ?? 0,
      ttftMs: row.ttft_ms ?? 0,
      inputTokens: row.input_tokens ?? 0,
      outputTokens: row.output_tokens ?? 0,
      reasoningTokens: row.reasoning_tokens ?? 0,
      cachedTokens: row.cached_tokens ?? 0,
      cacheWriteTokens: row.cache_write_tokens ?? 0,
      totalTokens: row.total_tokens ?? 0,
      source: row.source ?? '',
      authIndex: row.auth_index ?? '',
      clientType: row.client_type ?? '',
      errorCategory: row.error_category ?? '',
    })
  } catch (error) {
    throw new BackfillError(`usage_events row ${sourceRowId} does not satisfy the data-plane v1 contract`, { cause: error })
  }
}

function batchIdFor(sourceId, sourceRows, serializedEvents) {
  const digest = createHash('sha256')
    .update(JSON.stringify([
      'sqlite-backfill-batch-v1',
      sourceId,
      sourceRows.map((row) => row.id),
      serializedEvents,
    ]))
    .digest('hex')
  return digest
}

export function buildBatch(rows, sourceId, maxBytes) {
  const selectedRows = []
  const events = []
  const serializedEvents = []
  const envelopeBytes = Buffer.byteLength(`{"batchId":"${'0'.repeat(64)}","events":[]}`)
  let eventBytes = 0

  for (const row of rows) {
    const event = rowToUsageEvent(row, sourceId)
    const serialized = JSON.stringify(event)
    const nextBytes = envelopeBytes + eventBytes + Buffer.byteLength(serialized) + (selectedRows.length > 0 ? 1 : 0)
    if (nextBytes > maxBytes) {
      if (selectedRows.length === 0) throw new BackfillError(`usage_events row ${row.id} exceeds the configured batch byte limit`)
      break
    }
    selectedRows.push(row)
    events.push(event)
    serializedEvents.push(serialized)
    eventBytes += Buffer.byteLength(serialized) + (selectedRows.length > 1 ? 1 : 0)
  }

  if (selectedRows.length === 0) throw new BackfillError('cannot create an empty backfill batch')
  const batchId = batchIdFor(sourceId, selectedRows, serializedEvents)
  const request = parseIngestUsageRequest({ batchId, events }, MAX_INGEST_BATCH_SIZE)
  const body = Buffer.from(JSON.stringify(request))
  if (body.length > maxBytes) throw new BackfillError('constructed batch exceeds the configured byte limit')
  return {
    batchId,
    body,
    events: request.events,
    sourceRows: selectedRows,
    firstId: selectedRows[0].id,
    lastId: selectedRows.at(-1).id,
  }
}

async function discardResponse(response) {
  try { await response.body?.cancel() } catch { /* connection cleanup is best effort */ }
}

async function responseJson(response) {
  const mediaType = (response.headers.get('content-type') ?? '').split(';', 1)[0].trim().toLowerCase()
  if (mediaType !== 'application/json') throw new BackfillError('data-plane acknowledgement must be application/json')
  const contentLength = Number(response.headers.get('content-length') ?? 0)
  if (Number.isFinite(contentLength) && contentLength > MAX_ACK_BYTES) throw new BackfillError('data-plane acknowledgement is too large')
  const chunks = []
  let received = 0
  if (response.body) {
    const reader = response.body.getReader()
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      received += value.byteLength
      if (received > MAX_ACK_BYTES) {
        await reader.cancel()
        throw new BackfillError('data-plane acknowledgement is too large')
      }
      chunks.push(Buffer.from(value))
    }
  }
  const text = Buffer.concat(chunks, received).toString('utf8')
  try {
    return JSON.parse(text)
  } catch (error) {
    throw new BackfillError('data-plane acknowledgement is not valid JSON', { cause: error })
  }
}

function retryableStatus(status) {
  return status === 408 || status === 425 || status === 429 || status >= 500
}

function retryAfterMs(response, now) {
  const raw = response.headers.get('retry-after')
  if (!raw) return null
  const seconds = Number(raw)
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1_000)
  const date = Date.parse(raw)
  return Number.isFinite(date) ? Math.max(0, date - now()) : null
}

function retryDelay(attempt, options, response, now) {
  const exponential = Math.min(options.retryMaxMs, options.retryBaseMs * (2 ** Math.min(attempt, 20)))
  const requested = response ? retryAfterMs(response, now) : null
  return Math.min(options.retryMaxMs, Math.max(exponential, requested ?? 0))
}

export async function postBatch(batch, options) {
  const fetchImpl = options.fetchImpl ?? fetch
  const sleep = options.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)))
  const now = options.now ?? Date.now
  const log = options.log ?? (() => undefined)
  const url = `${options.baseUrl}${INGEST_PATH}`

  for (let attempt = 0; attempt <= options.maxRetries; attempt += 1) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), options.timeoutMs)
    timer.unref?.()
    let response
    let retryCode = 'network'
    try {
      response = await fetchImpl(url, {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${options.token}`,
          'Content-Type': 'application/json',
          'X-Idempotency-Key': batch.batchId,
        },
        body: batch.body,
        redirect: 'error',
        signal: controller.signal,
      })
      if (!response.ok) {
        retryCode = `http_${response.status}`
        throw new HttpStatusError(response.status)
      } else {
        retryCode = 'invalid_ack'
        const acknowledgement = await responseJson(response)
        try {
          return parseIngestUsageResponse(acknowledgement, batch.batchId, batch.events.length)
        } catch (error) {
          throw new BackfillError('data-plane acknowledgement violates the v1 contract', { cause: error })
        }
      }
    } catch (error) {
      if (error instanceof HttpStatusError && !retryableStatus(error.status)) {
        await discardResponse(response)
        throw error
      }
      if (attempt === options.maxRetries) {
        await discardResponse(response)
        if (error instanceof BackfillError) throw error
        throw new BackfillError('data-plane request failed after bounded retries', { cause: error })
      }
      const delayMs = retryDelay(attempt, options, response, now)
      log({ event: 'backfill.retry', attempt: attempt + 1, delayMs, code: retryCode })
      await discardResponse(response)
      await sleep(delayMs)
    } finally {
      clearTimeout(timer)
    }
  }
  throw new BackfillError('data-plane request exhausted retries')
}

function checkpointAfterBatch(checkpoint, batch, acknowledgement, now) {
  const completed = batch.lastId === checkpoint.source.maxId
  const timestamp = new Date(now()).toISOString()
  return {
    ...checkpoint,
    cursor: { lastId: batch.lastId },
    totals: {
      acknowledged: checkpoint.totals.acknowledged + batch.events.length,
      inserted: checkpoint.totals.inserted + acknowledgement.inserted,
      duplicates: checkpoint.totals.duplicates + acknowledgement.duplicates,
      batches: checkpoint.totals.batches + 1,
    },
    status: completed ? 'complete' : 'running',
    updatedAt: timestamp,
    completedAt: completed ? timestamp : null,
  }
}

function structuredLogger(logger) {
  if (typeof logger === 'function') return logger
  return (entry) => logger.log(JSON.stringify(entry))
}

export async function runBackfill(options) {
  const now = options.now ?? Date.now
  const log = structuredLogger(options.logger ?? console)
  const sourcePath = fs.realpathSync(options.sqlitePath)
  const checkpointPath = path.resolve(options.checkpointPath)
  if (sourcePath === checkpointPath) throw new BackfillError('checkpoint path must be separate from the SQLite backup')

  const database = new DatabaseSync(sourcePath, { readOnly: true })
  try {
    database.exec('PRAGMA query_only = ON; BEGIN;')
    const source = inspectSource(database, sourcePath, options.sourceId)
    let checkpoint = readCheckpoint(checkpointPath)
    if (checkpoint) {
      assertSameSource(checkpoint, source)
      const acknowledged = database.prepare('SELECT COUNT(*) count FROM usage_events WHERE id <= ?').get(checkpoint.cursor.lastId).count
      if (acknowledged !== checkpoint.totals.acknowledged) {
        throw new BackfillError('checkpoint cursor does not match its acknowledged source row total')
      }
    } else {
      checkpoint = newCheckpoint(source, now)
      writeCheckpointAtomic(checkpointPath, checkpoint)
    }

    log({
      event: 'backfill.start',
      sourceId: source.id,
      sourceMaxId: source.maxId,
      sourceRows: source.rowCount,
      lastId: checkpoint.cursor.lastId,
      batchRows: options.batchRows,
      batchBytes: options.batchBytes,
    })

    if (checkpoint.status === 'complete') {
      log({ event: 'backfill.complete', sourceId: source.id, ...checkpoint.totals, lastId: checkpoint.cursor.lastId })
      return checkpoint
    }

    const select = database.prepare(SELECT_BATCH)
    while (checkpoint.cursor.lastId < source.maxId) {
      const rows = select.all(checkpoint.cursor.lastId, source.maxId, options.batchRows)
      if (rows.length === 0) throw new BackfillError('source cursor could not reach the fixed maximum id')
      const batch = buildBatch(rows, source.id, options.batchBytes)
      const acknowledgement = await postBatch(batch, { ...options, log, now })
      if (!sameFileIdentity(source.file, sourceFileIdentity(sourcePath))) {
        throw new BackfillError('SQLite backup changed while the backfill was running')
      }
      checkpoint = checkpointAfterBatch(checkpoint, batch, acknowledgement, now)
      writeCheckpointAtomic(checkpointPath, checkpoint)
      log({
        event: 'backfill.batch_committed',
        batch: checkpoint.totals.batches,
        firstId: batch.firstId,
        lastId: batch.lastId,
        rows: batch.events.length,
        bytes: batch.body.length,
        inserted: acknowledgement.inserted,
        duplicates: acknowledgement.duplicates,
      })
    }

    if (checkpoint.totals.acknowledged !== source.rowCount) {
      throw new BackfillError('acknowledged row total does not match the fixed source row count')
    }
    log({ event: 'backfill.complete', sourceId: source.id, ...checkpoint.totals, lastId: checkpoint.cursor.lastId })
    return checkpoint
  } finally {
    try { database.exec('ROLLBACK') } catch { /* closing a read-only snapshot remains safe */ }
    database.close()
  }
}

export const HELP = `Usage:
  DATA_PLANE_TOKEN_FILE=/run/secrets/cpe-data-token npm run backfill:data -- \\
    --sqlite /path/to/console.backup.db \\
    --source-id <immutable-backup-id> \\
    --checkpoint /path/to/backfill.checkpoint.json \\
    --base-url http://<tailnet-data-host>:8792

Required options (or environment variables):
  --sqlite       BACKFILL_SQLITE_PATH
  --source-id    BACKFILL_SOURCE_ID
  --checkpoint   BACKFILL_CHECKPOINT_PATH
  --base-url     DATA_PLANE_BASE_URL

Bearer authentication is accepted only through DATA_PLANE_TOKEN or
DATA_PLANE_TOKEN_FILE. The two variables are mutually exclusive.

Optional limits:
  --batch-rows <1-${MAX_INGEST_BATCH_SIZE}>  (default ${DEFAULTS.batchRows})
  --batch-bytes <1024-16777216>   (default ${DEFAULTS.batchBytes})
  --timeout-ms <100-60000>        (default ${DEFAULTS.timeoutMs})
  --max-retries <0-20>            (default ${DEFAULTS.maxRetries})
  --retry-base-ms <10-60000>      (default ${DEFAULTS.retryBaseMs})
  --retry-max-ms <10-300000>      (default ${DEFAULTS.retryMaxMs})
`

async function main() {
  const options = parseCliOptions()
  if (options.help) {
    console.log(HELP)
    return
  }
  await runBackfill(options)
}

const invokedPath = process.argv[1] ? fs.realpathSync(path.resolve(process.argv[1])) : ''
const modulePath = fs.realpathSync(fileURLToPath(import.meta.url))
if (invokedPath === modulePath) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : 'unknown backfill failure'
    console.error(JSON.stringify({ event: 'backfill.failed', error: message }))
    process.exitCode = 1
  })
}

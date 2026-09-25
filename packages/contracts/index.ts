export const SNAPSHOT_PERIODS = [1, 7, 30, 90] as const
export type SnapshotPeriod = (typeof SNAPSHOT_PERIODS)[number]
export const MAX_INGEST_BATCH_SIZE = 500
export const SNAPSHOT_DIMENSION_LIMITS = {
  providers: 100,
  models: 100,
  keys: 1_000,
  clients: 100,
} as const

const MAX_TOKEN_COUNT = 1_000_000_000_000
const MAX_DURATION_MS = 86_400_000
const MIN_EVENT_TIMESTAMP_MS = Date.UTC(2000, 0, 1)
const MAX_EVENT_TIMESTAMP_MS = Date.UTC(2101, 0, 1) - 1

export type UsageEvent = {
  requestId: string
  timestamp: string
  timestampMs: number
  keyHash: string | null
  provider: string
  model: string
  modelGroup: string
  endpoint: string
  source: string
  authIndex: string
  success: boolean
  statusCode: number
  latencyMs: number
  ttftMs: number
  inputTokens: number
  outputTokens: number
  reasoningTokens: number
  cachedTokens: number
  cacheWriteTokens: number
  totalTokens: number
  clientType: string
  errorCategory: string
}

export type IngestUsageRequest = { batchId: string; events: UsageEvent[] }

export type IngestUsageResponse = {
  batchId: string
  accepted: number
  received: number
  inserted: number
  duplicates: number
  sourceWatermark: string | null
}

export type SnapshotEnvelope<T = UsageSnapshot> = {
  data: T
  generatedAt: string
}

export type UsageSummary = {
  requests: number
  errors: number
  totalTokens: number
  inputTokens: number
  outputTokens: number
  cachedTokens: number
  cacheWriteTokens: number
  reasoningTokens: number
  averageLatencyMs: number
  averageTtftMs: number
}

export type UsageDimension = UsageSummary & { name: string }
export type UsageTrendPoint = UsageSummary & { bucket: string }

export type UsageSnapshot = {
  version: 1
  days: SnapshotPeriod
  generatedAt: string
  sourceWatermark: string | null
  summary: UsageSummary
  trend: UsageTrendPoint[]
  providers: UsageDimension[]
  models: UsageDimension[]
  keys: UsageDimension[]
  clients: UsageDimension[]
}

export type UsageQuery = {
  days: number
  keyHash?: string
  limit: number
}

export type UsageQueryResponse = {
  generatedAt: string
  query: UsageQuery
  summary: UsageSummary
  recent: UsageEvent[]
}

export class ContractValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ContractValidationError'
  }
}

const recordOf = (value: unknown, label: string): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ContractValidationError(`${label} must be an object`)
  }
  return value as Record<string, unknown>
}

const stringOf = (value: unknown, label: string, maxLength: number, allowEmpty = true): string => {
  if (typeof value !== 'string' || value.length > maxLength || (!allowEmpty && value.length === 0)) {
    throw new ContractValidationError(`${label} must be a string of at most ${maxLength} characters`)
  }
  return value
}

const integerOf = (value: unknown, label: string, max = Number.MAX_SAFE_INTEGER): number => {
  if (!Number.isSafeInteger(value) || Number(value) < 0 || Number(value) > max) {
    throw new ContractValidationError(`${label} must be a non-negative integer`)
  }
  return Number(value)
}

const finiteNumberOf = (value: unknown, label: string): number => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new ContractValidationError(`${label} must be a finite non-negative number`)
  }
  return value
}

const timestampOf = (value: unknown, label: string): string => {
  const text = stringOf(value, label, 64, false)
  if (!Number.isFinite(Date.parse(text))) throw new ContractValidationError(`${label} must be an ISO timestamp`)
  return new Date(text).toISOString()
}

const eventTimestampOf = (value: unknown, label: string): string => {
  const timestamp = timestampOf(value, label)
  const milliseconds = Date.parse(timestamp)
  if (milliseconds < MIN_EVENT_TIMESTAMP_MS || milliseconds > MAX_EVENT_TIMESTAMP_MS) {
    throw new ContractValidationError(`${label} must be between years 2000 and 2100`)
  }
  return timestamp
}

export function parseUsageEvent(value: unknown, index = 0): UsageEvent {
  const input = recordOf(value, `events[${index}]`)
  const statusCode = integerOf(input.statusCode, `events[${index}].statusCode`, 599)
  if (statusCode < 100) throw new ContractValidationError(`events[${index}].statusCode must be between 100 and 599`)
  if (typeof input.success !== 'boolean') throw new ContractValidationError(`events[${index}].success must be a boolean`)
  const keyHash = input.keyHash === null || input.keyHash === undefined
    ? null
    : stringOf(input.keyHash, `events[${index}].keyHash`, 64, false)
  if (keyHash !== null && !/^[a-f0-9]{64}$/.test(keyHash)) {
    throw new ContractValidationError(`events[${index}].keyHash must be a lowercase SHA-256 digest`)
  }
  const timestamp = eventTimestampOf(input.timestamp, `events[${index}].timestamp`)
  const timestampMs = integerOf(input.timestampMs, `events[${index}].timestampMs`, MAX_EVENT_TIMESTAMP_MS)
  if (timestampMs !== Date.parse(timestamp)) throw new ContractValidationError(`events[${index}].timestampMs must match timestamp`)
  return {
    requestId: stringOf(input.requestId, `events[${index}].requestId`, 200, false),
    timestamp,
    timestampMs,
    keyHash,
    provider: stringOf(input.provider, `events[${index}].provider`, 128, false),
    model: stringOf(input.model, `events[${index}].model`, 256, false),
    modelGroup: stringOf(input.modelGroup ?? '', `events[${index}].modelGroup`, 128),
    endpoint: stringOf(input.endpoint ?? '', `events[${index}].endpoint`, 256),
    source: stringOf(input.source ?? '', `events[${index}].source`, 128),
    authIndex: stringOf(input.authIndex ?? '', `events[${index}].authIndex`, 256),
    success: input.success,
    statusCode,
    latencyMs: integerOf(input.latencyMs ?? 0, `events[${index}].latencyMs`, MAX_DURATION_MS),
    ttftMs: integerOf(input.ttftMs ?? 0, `events[${index}].ttftMs`, MAX_DURATION_MS),
    inputTokens: integerOf(input.inputTokens ?? 0, `events[${index}].inputTokens`, MAX_TOKEN_COUNT),
    outputTokens: integerOf(input.outputTokens ?? 0, `events[${index}].outputTokens`, MAX_TOKEN_COUNT),
    reasoningTokens: integerOf(input.reasoningTokens ?? 0, `events[${index}].reasoningTokens`, MAX_TOKEN_COUNT),
    cachedTokens: integerOf(input.cachedTokens ?? 0, `events[${index}].cachedTokens`, MAX_TOKEN_COUNT),
    cacheWriteTokens: integerOf(input.cacheWriteTokens ?? 0, `events[${index}].cacheWriteTokens`, MAX_TOKEN_COUNT),
    totalTokens: integerOf(input.totalTokens ?? 0, `events[${index}].totalTokens`, MAX_TOKEN_COUNT),
    clientType: stringOf(input.clientType ?? '', `events[${index}].clientType`, 128),
    errorCategory: stringOf(input.errorCategory ?? '', `events[${index}].errorCategory`, 128),
  }
}

export function parseIngestUsageRequest(value: unknown, maxBatchSize = MAX_INGEST_BATCH_SIZE): IngestUsageRequest {
  const input = recordOf(value, 'body')
  const batchId = stringOf(input.batchId, 'batchId', 200, false)
  if (!Array.isArray(input.events) || input.events.length === 0 || input.events.length > maxBatchSize) {
    throw new ContractValidationError(`events must contain between 1 and ${maxBatchSize} items`)
  }
  const events = input.events.map((event, index) => parseUsageEvent(event, index))
  if (new Set(events.map((event) => event.requestId)).size !== events.length) {
    throw new ContractValidationError('events must not contain duplicate requestId values')
  }
  return { batchId, events }
}

export function parseIngestUsageResponse(value: unknown, expectedBatchId: string, expectedCount: number): IngestUsageResponse {
  const input = recordOf(value, 'response')
  const batchId = stringOf(input.batchId, 'response.batchId', 200, false)
  if (batchId !== expectedBatchId) throw new ContractValidationError('response.batchId does not match the request')
  const accepted = integerOf(input.accepted, 'response.accepted')
  const received = integerOf(input.received, 'response.received')
  const inserted = integerOf(input.inserted, 'response.inserted')
  const duplicates = integerOf(input.duplicates, 'response.duplicates')
  if (accepted !== expectedCount || received !== expectedCount) {
    throw new ContractValidationError('response did not acknowledge the complete batch')
  }
  if (inserted + duplicates !== expectedCount) {
    throw new ContractValidationError('response inserted and duplicate counts do not balance')
  }
  const sourceWatermark = input.sourceWatermark === null
    ? null
    : timestampOf(input.sourceWatermark, 'response.sourceWatermark')
  return { batchId, accepted, received, inserted, duplicates, sourceWatermark }
}

export function parseSnapshotPeriod(value: unknown): SnapshotPeriod {
  const parsed = Number(value)
  if (!SNAPSHOT_PERIODS.includes(parsed as SnapshotPeriod)) {
    throw new ContractValidationError('days must be one of 1, 7, 30, or 90')
  }
  return parsed as SnapshotPeriod
}

export function parseUsageQuery(search: URLSearchParams): UsageQuery {
  const days = Number(search.get('days') ?? 7)
  const limit = Number(search.get('limit') ?? 100)
  if (!Number.isInteger(days) || days < 1 || days > 90) throw new ContractValidationError('days must be an integer between 1 and 90')
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new ContractValidationError('limit must be an integer between 1 and 200')
  const keyHash = search.get('keyHash')?.trim()
  if (keyHash && keyHash.length > 128) throw new ContractValidationError('keyHash must be at most 128 characters')
  return { days, limit, ...(keyHash ? { keyHash } : {}) }
}

const parseUsageSummary = (value: unknown, label: string): UsageSummary => {
  const input = recordOf(value, label)
  const requests = integerOf(input.requests, `${label}.requests`)
  const errors = integerOf(input.errors, `${label}.errors`)
  if (errors > requests) throw new ContractValidationError(`${label}.errors cannot exceed requests`)
  return {
    requests,
    errors,
    totalTokens: integerOf(input.totalTokens, `${label}.totalTokens`),
    inputTokens: integerOf(input.inputTokens, `${label}.inputTokens`),
    outputTokens: integerOf(input.outputTokens, `${label}.outputTokens`),
    cachedTokens: integerOf(input.cachedTokens, `${label}.cachedTokens`),
    cacheWriteTokens: integerOf(input.cacheWriteTokens, `${label}.cacheWriteTokens`),
    reasoningTokens: integerOf(input.reasoningTokens, `${label}.reasoningTokens`),
    averageLatencyMs: finiteNumberOf(input.averageLatencyMs, `${label}.averageLatencyMs`),
    averageTtftMs: finiteNumberOf(input.averageTtftMs, `${label}.averageTtftMs`),
  }
}

const arrayOf = <T>(value: unknown, label: string, maxLength: number, parser: (item: unknown, index: number) => T): T[] => {
  if (!Array.isArray(value) || value.length > maxLength) throw new ContractValidationError(`${label} must be an array with at most ${maxLength} items`)
  return value.map(parser)
}

const parseDimension = (value: unknown, label: string): UsageDimension => {
  const input = recordOf(value, label)
  return { name: stringOf(input.name, `${label}.name`, 256, false), ...parseUsageSummary(input, label) }
}

const parseTrendPoint = (value: unknown, label: string): UsageTrendPoint => {
  const input = recordOf(value, label)
  return { bucket: timestampOf(input.bucket, `${label}.bucket`), ...parseUsageSummary(input, label) }
}

export function parseUsageSnapshot(value: unknown): UsageSnapshot {
  const input = recordOf(value, 'snapshot')
  if (input.version !== 1) throw new ContractValidationError('snapshot.version must be 1')
  const days = parseSnapshotPeriod(input.days)
  const generatedAt = timestampOf(input.generatedAt, 'snapshot.generatedAt')
  const sourceWatermark = input.sourceWatermark === null
    ? null
    : timestampOf(input.sourceWatermark, 'snapshot.sourceWatermark')
  return {
    version: 1,
    days,
    generatedAt,
    sourceWatermark,
    summary: parseUsageSummary(input.summary, 'snapshot.summary'),
    trend: arrayOf(input.trend, 'snapshot.trend', 2_200, (item, index) => parseTrendPoint(item, `snapshot.trend[${index}]`)),
    providers: arrayOf(input.providers, 'snapshot.providers', SNAPSHOT_DIMENSION_LIMITS.providers, (item, index) => parseDimension(item, `snapshot.providers[${index}]`)),
    models: arrayOf(input.models, 'snapshot.models', SNAPSHOT_DIMENSION_LIMITS.models, (item, index) => parseDimension(item, `snapshot.models[${index}]`)),
    keys: arrayOf(input.keys, 'snapshot.keys', SNAPSHOT_DIMENSION_LIMITS.keys, (item, index) => parseDimension(item, `snapshot.keys[${index}]`)),
    clients: arrayOf(input.clients, 'snapshot.clients', SNAPSHOT_DIMENSION_LIMITS.clients, (item, index) => parseDimension(item, `snapshot.clients[${index}]`)),
  }
}

export function parseSnapshotEnvelope(value: unknown): SnapshotEnvelope {
  const input = recordOf(value, 'envelope')
  const data = parseUsageSnapshot(input.data)
  const generatedAt = timestampOf(input.generatedAt, 'envelope.generatedAt')
  if (generatedAt !== data.generatedAt) throw new ContractValidationError('envelope.generatedAt must match snapshot.generatedAt')
  return { data, generatedAt }
}

import fs from 'node:fs'
import path from 'node:path'
import { MAX_INGEST_BATCH_SIZE } from '../packages/contracts/index.js'

import { parseProxyPresets } from './proxyPresets.js'

export function positiveInteger(name: string, raw: string | undefined, fallback: number, range: { min: number; max: number }) {
  const value = raw === undefined || raw === '' ? fallback : Number(raw)
  if (!Number.isSafeInteger(value) || value < range.min || value > range.max) {
    throw new Error(`${name} 必须是 ${range.min} 到 ${range.max} 的整数`)
  }
  return value
}

export function booleanSetting(name: string, raw: string | undefined, fallback: boolean) {
  if (raw === undefined || raw === '') return fallback
  if (raw === 'true') return true
  if (raw === 'false') return false
  throw new Error(`${name} 必须是 true 或 false`)
}

export function choiceSetting<const T extends string>(name: string, raw: string | undefined, fallback: T, choices: readonly T[]): T {
  const value = raw === undefined || raw === '' ? fallback : raw
  if (!choices.includes(value as T)) throw new Error(`${name} 必须是 ${choices.join('、')} 之一`)
  return value as T
}

export function internalHttpBaseUrl(name: string, raw: string | undefined, required: boolean): string {
  const value = String(raw || '').trim().replace(/\/$/, '')
  if (!value) {
    if (required) throw new Error(`${name} 在数据桥启用时不能为空`)
    return ''
  }
  let parsed: URL
  try { parsed = new URL(value) } catch { throw new Error(`${name} 必须是有效 URL`) }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error(`${name} 必须是不含凭据、查询参数和片段的 HTTP(S) 地址`)
  }
  return value
}

export function internalToken(name: string, raw: string | undefined, required: boolean): string {
  const value = String(raw || '').trim()
  if (!value) {
    if (required) throw new Error(`${name} 在数据桥启用时不能为空`)
    return ''
  }
  if (value.length < 32) throw new Error(`${name} 必须至少包含 32 个字符`)
  return value
}

export function fileBackedSecret(name: string, direct: string | undefined, filename: string | undefined): string | undefined {
  if (direct?.trim() && filename?.trim()) throw new Error(`${name} 与 ${name}_FILE 不能同时设置`)
  if (!filename?.trim()) return direct
  try {
    const stat = fs.statSync(filename)
    if (!stat.isFile() || stat.size > 16 * 1024) throw new Error('invalid secret file')
    if (process.platform !== 'win32' && (stat.mode & 0o077) !== 0) throw new Error('insecure secret file')
    const value = fs.readFileSync(filename, 'utf8').replace(/[\r\n]+$/u, '')
    if (!value) throw new Error('empty secret file')
    return value
  } catch {
    throw new Error(`${name}_FILE 必须是私有、可读且不超过 16 KiB 的普通文件`)
  }
}

const dataDir = process.env.DATA_DIR || path.resolve('data')
const dataPlaneEnabled = booleanSetting('DATA_PLANE_ENABLED', process.env.DATA_PLANE_ENABLED, false)
const dataPlaneBaseUrl = internalHttpBaseUrl('DATA_PLANE_BASE_URL', process.env.DATA_PLANE_BASE_URL, dataPlaneEnabled)
const dataPlaneToken = internalToken(
  'DATA_PLANE_TOKEN',
  fileBackedSecret('DATA_PLANE_TOKEN', process.env.DATA_PLANE_TOKEN, process.env.DATA_PLANE_TOKEN_FILE),
  dataPlaneEnabled,
)
const dataPlaneDashboardReadMode = choiceSetting('DATA_PLANE_DASHBOARD_READ_MODE', process.env.DATA_PLANE_DASHBOARD_READ_MODE, 'sqlite', ['sqlite', 'snapshot'] as const)
if (dataPlaneDashboardReadMode === 'snapshot' && !dataPlaneEnabled) {
  throw new Error('DATA_PLANE_DASHBOARD_READ_MODE=snapshot 要求 DATA_PLANE_ENABLED=true')
}

const gatewayEngine = choiceSetting('GATEWAY_ENGINE', process.env.GATEWAY_ENGINE, 'cpa', ['cpa', 'magpie'] as const)

export const config = {
  gatewayEngine,
  /**
   * Model discovery writes newly found models into the channel table; under CPA that table is live routing.
   * Default: on its timer with the Magpie engine, on demand (sync center) with CPA.
   */
  modelDiscoveryScheduled: booleanSetting('MODEL_DISCOVERY_SCHEDULE', process.env.MODEL_DISCOVERY_SCHEDULE, gatewayEngine === 'magpie'),
  /** Every 30 min, one minimal chat request per chat model per service through CPA (server/modelAvailability.ts); false = off and no filtering. */
  modelAvailabilityProbe: booleanSetting('MODEL_AVAILABILITY_PROBE', process.env.MODEL_AVAILABILITY_PROBE, true),
  magpieControlPlane: choiceSetting('MAGPIE_CONTROL_PLANE', process.env.MAGPIE_CONTROL_PLANE, 'local', ['local', 'cpa'] as const),
  magpiePort: positiveInteger('MAGPIE_PORT', process.env.MAGPIE_PORT, 8790, { min: 1024, max: 65535 }),
  magpieKernelSocket: process.env.MAGPIE_KERNEL_SOCKET || path.join(dataDir, 'magpie-kernel.sock'),
  /** The launcher runs the kernel under a sandbox HOME, so its RTK view lacks this host's agents: opt-in only. */
  rtkKernelPlane: booleanSetting('RTK_KERNEL_PLANE', process.env.RTK_KERNEL_PLANE, false),
  magpieChannelsFile: process.env.MAGPIE_CHANNELS_FILE || path.join(dataDir, 'magpie-channels.json'),
  magpieTimeoutMs: positiveInteger('MAGPIE_TIMEOUT_MS', process.env.MAGPIE_TIMEOUT_MS, 600_000, { min: 1000, max: 3_600_000 }),
  magpieSourceCpaBaseUrl: internalHttpBaseUrl('MAGPIE_SOURCE_CPA_BASE_URL', process.env.MAGPIE_SOURCE_CPA_BASE_URL, false),
  magpieSourceCpaKey: fileBackedSecret('MAGPIE_SOURCE_CPA_KEY', process.env.MAGPIE_SOURCE_CPA_KEY, process.env.MAGPIE_SOURCE_CPA_KEY_FILE) || '',
  /** Sign-ins that run a vendor CLI or installer on this host (cursor, grok, devin): off unless set, and the kernel must allow them too. */
  magpieSigninHostExec: booleanSetting('MAGPIE_SIGNIN_HOST_EXEC', process.env.MAGPIE_SIGNIN_HOST_EXEC, false),
  /** Magpie account allowance reads: one per agent per this interval (never under 5 min). */
  magpieAccountQuotaTtlMs: positiveInteger('MAGPIE_ACCOUNT_QUOTA_TTL_MS', process.env.MAGPIE_ACCOUNT_QUOTA_TTL_MS, 5 * 60_000, { min: 5 * 60_000, max: 24 * 60 * 60_000 }),
  nativeResponsesPolicySource: choiceSetting('NATIVE_RESPONSES_POLICY_SOURCE', process.env.NATIVE_RESPONSES_POLICY_SOURCE, 'cpa', ['cpa', 'console'] as const),
  nativeResponsesEnabled: booleanSetting('NATIVE_RESPONSES_ENABLED', process.env.NATIVE_RESPONSES_ENABLED, false),
  nativeResponsesPort: positiveInteger('NATIVE_RESPONSES_PORT', process.env.NATIVE_RESPONSES_PORT, 8788, { min: 1, max: 65535 }),
  nativeResponsesChannel: process.env.NATIVE_RESPONSES_CHANNEL || 'zixian',
  nativeResponsesGroup: process.env.NATIVE_RESPONSES_GROUP || '',
  nativeResponsesTimeoutMs: positiveInteger('NATIVE_RESPONSES_TIMEOUT_MS', process.env.NATIVE_RESPONSES_TIMEOUT_MS, 600_000, { min: 1000, max: 3_600_000 }),
  port: Number(process.env.PORT || 8787),
  host: process.env.HOST || '127.0.0.1',
  dataDir,
  cpaBaseUrl: (process.env.CPA_BASE_URL || 'http://127.0.0.1:8317').replace(/\/$/, ''),
  cpaManagementKey: process.env.CPA_MANAGEMENT_KEY || '',
  /** 给 API Key 用户看的网关地址（如 https://ai.crosery.com/v1）；空 = 回退到本机网关地址。 */
  publicGatewayBaseUrl: internalHttpBaseUrl('PUBLIC_GATEWAY_BASE_URL', process.env.PUBLIC_GATEWAY_BASE_URL, false),
  consoleUsername: process.env.CONSOLE_USERNAME || 'admin',
  consolePassword: fileBackedSecret('CONSOLE_PASSWORD', process.env.CONSOLE_PASSWORD, process.env.CONSOLE_PASSWORD_FILE) || '',
  sessionSecret: fileBackedSecret('SESSION_SECRET', process.env.SESSION_SECRET, process.env.SESSION_SECRET_FILE) || '',
  cookieSecure: process.env.COOKIE_SECURE !== 'false',
  usageRetentionDays: Number(process.env.USAGE_RETENTION_DAYS || 90),
  reportReadWorkers: positiveInteger('REPORT_READ_WORKERS', process.env.REPORT_READ_WORKERS, 2, { min: 1, max: 4 }),
  /** 额度窗口按 console 服务器本地时区结算，并把此值返回给前端避免用户时区造成误读。 */
  quotaTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
  usageCollectIntervalMs: positiveInteger('USAGE_COLLECT_INTERVAL_MS', process.env.USAGE_COLLECT_INTERVAL_MS, 1_000, { min: 250, max: 60_000 }),
  syncIntervalMs: Number(process.env.SYNC_INTERVAL_MS || 15000),
  dataPlaneEnabled,
  dataPlaneBaseUrl,
  dataPlaneToken,
  dataPlaneDashboardReadMode,
  dataPlaneTimeoutMs: positiveInteger('DATA_PLANE_TIMEOUT_MS', process.env.DATA_PLANE_TIMEOUT_MS, 2_000, { min: 100, max: 30_000 }),
  dataPlaneSnapshotTimeoutMs: positiveInteger('DATA_PLANE_SNAPSHOT_TIMEOUT_MS', process.env.DATA_PLANE_SNAPSHOT_TIMEOUT_MS, 500, { min: 50, max: 5_000 }),
  dataPlaneSnapshotFreshMs: positiveInteger('DATA_PLANE_SNAPSHOT_FRESH_MS', process.env.DATA_PLANE_SNAPSHOT_FRESH_MS, 30_000, { min: 1_000, max: 300_000 }),
  dataPlaneSnapshotMaxStaleMs: positiveInteger('DATA_PLANE_SNAPSHOT_MAX_STALE_MS', process.env.DATA_PLANE_SNAPSHOT_MAX_STALE_MS, 5 * 60_000, { min: 30_000, max: 24 * 60 * 60 * 1000 }),
  dataPlaneSnapshotMaxLagMs: positiveInteger('DATA_PLANE_SNAPSHOT_MAX_LAG_MS', process.env.DATA_PLANE_SNAPSHOT_MAX_LAG_MS, 60_000, { min: 1_000, max: 10 * 60_000 }),
  dataPlaneBatchSize: positiveInteger('DATA_PLANE_BATCH_SIZE', process.env.DATA_PLANE_BATCH_SIZE, 200, { min: 1, max: MAX_INGEST_BATCH_SIZE }),
  dataPlaneRelayIntervalMs: positiveInteger('DATA_PLANE_RELAY_INTERVAL_MS', process.env.DATA_PLANE_RELAY_INTERVAL_MS, 5_000, { min: 250, max: 60_000 }),
  dataPlaneBackoffBaseMs: positiveInteger('DATA_PLANE_BACKOFF_BASE_MS', process.env.DATA_PLANE_BACKOFF_BASE_MS, 1_000, { min: 100, max: 60_000 }),
  dataPlaneBackoffMaxMs: positiveInteger('DATA_PLANE_BACKOFF_MAX_MS', process.env.DATA_PLANE_BACKOFF_MAX_MS, 5 * 60_000, { min: 1_000, max: 24 * 60 * 60 * 1000 }),
  cpaRequestTimeoutMs: positiveInteger('CPA_REQUEST_TIMEOUT_MS', process.env.CPA_REQUEST_TIMEOUT_MS, 10_000, { min: 500, max: 60_000 }),
  // Claude OAuth usage/profile are upstream control-plane endpoints, not live request data.
  // Keep them cached and back off aggressively after a 429 so the monitor cannot turn a
  // temporary upstream limit into a continuous retry loop.
  claudeQuotaUsageTtlMs: positiveInteger('CLAUDE_QUOTA_USAGE_TTL_MS', process.env.CLAUDE_QUOTA_USAGE_TTL_MS, 5 * 60 * 1000, { min: 1_000, max: 24 * 60 * 60 * 1000 }),
  claudeQuotaProfileTtlMs: positiveInteger('CLAUDE_QUOTA_PROFILE_TTL_MS', process.env.CLAUDE_QUOTA_PROFILE_TTL_MS, 60 * 60 * 1000, { min: 1_000, max: 7 * 24 * 60 * 60 * 1000 }),
  claudeQuotaRateLimitCooldownMs: positiveInteger('CLAUDE_QUOTA_RATE_LIMIT_COOLDOWN_MS', process.env.CLAUDE_QUOTA_RATE_LIMIT_COOLDOWN_MS, 10 * 60 * 1000, { min: 1_000, max: 24 * 60 * 60 * 1000 }),
  claudeQuotaMaxRateLimitCooldownMs: positiveInteger('CLAUDE_QUOTA_MAX_RATE_LIMIT_COOLDOWN_MS', process.env.CLAUDE_QUOTA_MAX_RATE_LIMIT_COOLDOWN_MS, 60 * 60 * 1000, { min: 1_000, max: 7 * 24 * 60 * 60 * 1000 }),
  credentialUploadMaxBytes: positiveInteger('CREDENTIAL_UPLOAD_MAX_BYTES', process.env.CREDENTIAL_UPLOAD_MAX_BYTES, 64 * 1024 * 1024, { min: 1024, max: 128 * 1024 * 1024 }),
  credentialUploadMaxEntries: positiveInteger('CREDENTIAL_UPLOAD_MAX_ENTRIES', process.env.CREDENTIAL_UPLOAD_MAX_ENTRIES, 500, { min: 1, max: 1000 }),
  credentialUploadMaxEntryBytes: positiveInteger('CREDENTIAL_UPLOAD_MAX_ENTRY_BYTES', process.env.CREDENTIAL_UPLOAD_MAX_ENTRY_BYTES, 256 * 1024, { min: 1024, max: 1024 * 1024 }),
  credentialUploadMaxExpandedBytes: positiveInteger('CREDENTIAL_UPLOAD_MAX_EXPANDED_BYTES', process.env.CREDENTIAL_UPLOAD_MAX_EXPANDED_BYTES, 32 * 1024 * 1024, { min: 1024, max: 64 * 1024 * 1024 }),
  credentialUploadConcurrency: positiveInteger('CREDENTIAL_UPLOAD_CONCURRENCY', process.env.CREDENTIAL_UPLOAD_CONCURRENCY, 4, { min: 1, max: 8 }),
  nginxUnlimitedSyncEnabled: booleanSetting('NGINX_UNLIMITED_SYNC_ENABLED', process.env.NGINX_UNLIMITED_SYNC_ENABLED, false),
  nginxUnlimitedPolicyPath: path.resolve(process.env.NGINX_UNLIMITED_POLICY_PATH || path.join(dataDir, 'nginx-unlimited-policy.json')),
  nginxUnlimitedStatusPath: path.resolve(process.env.NGINX_UNLIMITED_STATUS_PATH || path.join(dataDir, 'nginx-unlimited-status.json')),
  nginxUnlimitedSyncTimeoutMs: positiveInteger('NGINX_UNLIMITED_SYNC_TIMEOUT_MS', process.env.NGINX_UNLIMITED_SYNC_TIMEOUT_MS, 10_000, { min: 100, max: 60_000 }),
  proxyPresets: parseProxyPresets(process.env.PROXY_PRESETS),
}

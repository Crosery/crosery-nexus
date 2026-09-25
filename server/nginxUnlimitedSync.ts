import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

import {
  buildNginxUnlimitedPolicyRequest,
  nginxUnlimitedPolicyHash,
  type NginxUnlimitedPolicy,
  writeNginxUnlimitedPolicySnapshot,
} from './nginxUnlimitedPolicy.js'

export type NginxUnlimitedApplyStatus = {
  version: 1
  requestId: string
  policyHash: string
  outcome: 'ok' | 'error'
  unlimitedKeyCount: number
  appliedAt: string
  errorCode?: string
}

export class NginxUnlimitedSyncError extends Error {
  readonly code = 'NGINX_UNLIMITED_SYNC_FAILED'

  constructor(cause?: unknown) {
    super('NGINX_UNLIMITED_SYNC_FAILED: nginx 不限速策略同步失败', { cause })
    this.name = 'NginxUnlimitedSyncError'
  }
}

type ApplyResult = { changed: boolean; applied: boolean }

type NginxUnlimitedSyncOptions = {
  enabled: boolean
  policyPath: string
  statusPath: string
  timeoutMs?: number
  waitUntilApplied?: (requestId: string, policyHash: string) => Promise<NginxUnlimitedApplyStatus>
}

function readStatus(statusPath: string): NginxUnlimitedApplyStatus | null {
  try {
    const raw = JSON.parse(fs.readFileSync(statusPath, 'utf8')) as Partial<NginxUnlimitedApplyStatus>
    if (raw.version !== 1 || typeof raw.requestId !== 'string' || typeof raw.policyHash !== 'string' || !['ok', 'error'].includes(String(raw.outcome))) return null
    if (!Number.isInteger(raw.unlimitedKeyCount) || typeof raw.appliedAt !== 'string') return null
    return raw as NginxUnlimitedApplyStatus
  } catch {
    return null
  }
}

const wait = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds))

async function waitForStatus(statusPath: string, requestId: string, policyHash: string, timeoutMs: number): Promise<NginxUnlimitedApplyStatus> {
  const deadline = Date.now() + timeoutMs
  do {
    const status = readStatus(statusPath)
    if (status?.requestId === requestId && status.policyHash === policyHash) return status
    await wait(50)
  } while (Date.now() < deadline)
  throw new Error('nginx 不限速策略应用状态等待超时')
}

export class NginxUnlimitedSync {
  private readonly enabled: boolean
  private readonly policyPath: string
  private readonly statusPath: string
  private readonly waitUntilApplied: (requestId: string, policyHash: string) => Promise<NginxUnlimitedApplyStatus>
  private readonly inflight = new Map<string, Promise<ApplyResult>>()
  private queue: Promise<void> = Promise.resolve()
  private appliedHash = ''

  constructor(options: NginxUnlimitedSyncOptions) {
    if (!path.isAbsolute(options.policyPath)) throw new Error('nginx 不限速策略路径必须是绝对路径')
    if (!path.isAbsolute(options.statusPath)) throw new Error('nginx 不限速状态路径必须是绝对路径')
    const timeoutMs = options.timeoutMs ?? 10_000
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 60_000) throw new Error('nginx 不限速同步超时必须是 100 到 60000 毫秒')
    this.enabled = options.enabled
    this.policyPath = options.policyPath
    this.statusPath = options.statusPath
    this.waitUntilApplied = options.waitUntilApplied ?? ((requestId, policyHash) => waitForStatus(this.statusPath, requestId, policyHash, timeoutMs))
  }

  apply(policy: NginxUnlimitedPolicy): Promise<ApplyResult> {
    if (!this.enabled) return Promise.resolve({ changed: false, applied: false })
    const policyHash = nginxUnlimitedPolicyHash(policy)
    const current = this.inflight.get(policyHash)
    if (current) return current

    const pending = this.queue
      .then(() => policyHash === this.appliedHash
        ? { changed: false, applied: false }
        : this.applyChangedPolicy(policy, policyHash))
      .finally(() => this.inflight.delete(policyHash))
    this.queue = pending.then(() => undefined, () => undefined)
    this.inflight.set(policyHash, pending)
    return pending
  }

  private async applyChangedPolicy(policy: NginxUnlimitedPolicy, policyHash: string): Promise<ApplyResult> {
    try {
      const requestId = crypto.randomUUID()
      const request = buildNginxUnlimitedPolicyRequest(policy, requestId)
      const changed = writeNginxUnlimitedPolicySnapshot(this.policyPath, request)
      const status = await this.waitUntilApplied(requestId, policyHash)
      if (status.outcome !== 'ok') throw new Error(status.errorCode || 'nginx helper reported an error')
      this.appliedHash = policyHash
      return { changed, applied: true }
    } catch (error) {
      throw new NginxUnlimitedSyncError(error)
    }
  }
}

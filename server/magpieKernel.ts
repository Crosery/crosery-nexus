import { request } from 'node:http'

/**
 * The console's control client for the kernel's private socket (/internal/*). Unlike kernelJSON
 * (magpieEngine.ts, kept for its callers) it returns the kernel's status and JSON error body
 * ({error, code}) instead of collapsing every refusal into one message.
 */

export class KernelError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message)
    this.name = 'KernelError'
  }
}

export type KernelReply = { status: number; body: unknown }
export type KernelCall = (route: string, options?: { method?: string; body?: unknown; timeoutMs?: number }) => Promise<KernelReply>

const MAX_RESPONSE_BYTES = 4 * 1024 * 1024
const UNREACHABLE = new Set(['ENOENT', 'ECONNREFUSED', 'ENOTSOCK', 'EACCES', 'ECONNRESET', 'EPIPE'])

export const KERNEL_MESSAGES: Record<string, string> = {
  kernel_unavailable: '内核未运行',
  kernel_timeout: '内核响应超时',
  kernel_bad_response: '内核响应异常',
  kernel_outdated: '当前内核不支持账号登录，需要重新构建内核',
}

export function kernelCaller(socket: () => string): KernelCall {
  return (route, options = {}) => new Promise<KernelReply>((resolve, reject) => {
    const payload = options.body === undefined ? undefined : JSON.stringify(options.body)
    let settled = false
    const fail = (error: KernelError) => {
      if (settled) return
      settled = true
      reject(error)
    }
    const req = request({
      socketPath: socket(), path: route, method: options.method || 'GET',
      headers: { 'content-type': 'application/json', ...(payload ? { 'content-length': Buffer.byteLength(payload) } : {}) },
    }, (res) => {
      const chunks: Buffer[] = []
      let bytes = 0
      res.on('data', (chunk: Buffer) => {
        bytes += chunk.length
        if (bytes > MAX_RESPONSE_BYTES) {
          fail(new KernelError(502, 'kernel_bad_response', KERNEL_MESSAGES.kernel_bad_response))
          req.destroy()
        } else chunks.push(chunk)
      })
      res.once('end', () => {
        if (settled) return
        const text = Buffer.concat(chunks).toString('utf8')
        let body: unknown = null
        if (text.trim()) {
          try { body = JSON.parse(text) } catch {
            // the old kernel answered some refusals in plain text; keep the status, drop the text
            body = { error: '', code: '' }
          }
        }
        settled = true
        resolve({ status: res.statusCode || 500, body })
      })
      res.once('error', () => fail(new KernelError(502, 'kernel_bad_response', KERNEL_MESSAGES.kernel_bad_response)))
    })
    const timer = setTimeout(() => {
      fail(new KernelError(504, 'kernel_timeout', KERNEL_MESSAGES.kernel_timeout))
      req.destroy()
    }, options.timeoutMs ?? 10_000)
    timer.unref()
    req.once('close', () => clearTimeout(timer))
    req.once('error', (error: NodeJS.ErrnoException) => {
      fail(UNREACHABLE.has(String(error.code))
        ? new KernelError(503, 'kernel_unavailable', KERNEL_MESSAGES.kernel_unavailable)
        : new KernelError(502, 'kernel_bad_response', KERNEL_MESSAGES.kernel_bad_response))
    })
    req.end(payload)
  })
}

/** `{error, code}` of a kernel refusal; empty strings when the body has neither. */
export function kernelRefusal(body: unknown): { error: string; code: string } {
  const value = body && typeof body === 'object' && !Array.isArray(body) ? body as Record<string, unknown> : {}
  return {
    error: typeof value.error === 'string' ? value.error : '',
    code: typeof value.code === 'string' ? value.code : '',
  }
}

/* ────────────────────────── capability probe ────────────────────────── */

export type KernelHealth = {
  revision: string
  capabilities: string[]
  loginAgents: string[]
  signinDeny: string[]
}

export type KernelProbe =
  | { ok: true; health: KernelHealth }
  | { ok: false; reason: 'kernel_unavailable' | 'kernel_outdated' | 'kernel_timeout' | 'kernel_bad_response' }

/** What the accounts routes need from the kernel; an older binary lacks them and is reported as outdated. */
export const ACCOUNT_CAPABILITIES = ['signin', 'accounts', 'usage', 'codex-reset'] as const
const AGENT_ID = /^[a-z0-9][a-z0-9-]{0,39}$/

const stringList = (value: unknown, pattern?: RegExp): string[] | null =>
  Array.isArray(value) && value.length <= 200 && value.every(item => typeof item === 'string' && (!pattern || pattern.test(item))) ? value as string[] : null

/**
 * Health → capabilities. Fails closed: a kernel that does not report `keychain:false` (the overlay that keeps
 * Magpie off the macOS login keychain) or lacks a capability gets no account routes.
 */
export function parseKernelHealth(body: unknown): KernelHealth | null {
  const value = body && typeof body === 'object' && !Array.isArray(body) ? body as Record<string, unknown> : null
  if (!value || value.ok !== true || value.engine !== 'magpie' || typeof value.revision !== 'string') return null
  const capabilities = stringList(value.capabilities)
  const loginAgents = stringList(value.loginAgents, AGENT_ID)
  const signinDeny = stringList(value.signinDeny, AGENT_ID)
  if (!capabilities || !loginAgents || !signinDeny || value.keychain !== false) return null
  if (ACCOUNT_CAPABILITIES.some(capability => !capabilities.includes(capability))) return null
  return { revision: value.revision, capabilities, loginAgents, signinDeny }
}

/** One health read per 30 s while the kernel answers; failures are retried after 5 s (a kickstart recovers fast). */
export class KernelProbeCache {
  private cached: { probe: KernelProbe; until: number } | null = null
  private inflight: Promise<KernelProbe> | null = null

  constructor(private readonly call: KernelCall, private readonly now: () => number = Date.now,
    private readonly okTtlMs = 30_000, private readonly failTtlMs = 5_000) {}

  get(): Promise<KernelProbe> {
    if (this.cached && this.cached.until > this.now()) return Promise.resolve(this.cached.probe)
    if (this.inflight) return this.inflight
    const pending = this.read().then((probe) => {
      this.cached = { probe, until: this.now() + (probe.ok ? this.okTtlMs : this.failTtlMs) }
      return probe
    }).finally(() => { this.inflight = null })
    this.inflight = pending
    return pending
  }

  /** The last answer without waiting (null before the first); a stale one starts a background read. */
  peek(): KernelProbe | null {
    if (!this.cached || this.cached.until <= this.now()) void this.get().catch(() => undefined)
    return this.cached?.probe ?? null
  }

  clear(): void {
    this.cached = null
  }

  private async read(): Promise<KernelProbe> {
    try {
      const reply = await this.call('/internal/health', { timeoutMs: 3_000 })
      if (reply.status !== 200) return { ok: false, reason: 'kernel_bad_response' }
      const health = parseKernelHealth(reply.body)
      return health ? { ok: true, health } : { ok: false, reason: 'kernel_outdated' }
    } catch (error) {
      const code = error instanceof KernelError ? error.code : 'kernel_unavailable'
      return { ok: false, reason: code === 'kernel_timeout' || code === 'kernel_bad_response' ? code : 'kernel_unavailable' }
    }
  }
}

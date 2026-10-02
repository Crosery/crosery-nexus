import { execFile, spawn, type ChildProcess } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import path from 'node:path'
import { config } from './config.js'
import { locateMihomoBinary, prepareMihomoBinary, type LocatedMihomo, type MihomoBinary, type MihomoBinarySource } from './mihomoBinary.js'
import {
  buildMihomoConfig, inPortRange, isPortFree, kernelPortRange, mapMihomoError, mihomoErrorMessages, nodeSecrets, renderMihomoConfig, scrubMihomoText,
  type MihomoController, type MihomoListenerAuth, type MihomoNodeEntry, type MihomoRejected, type PortRange,
} from './mihomoConfig.js'

/**
 * The console's own mihomo process (PROXY-SPEC §4). It owns `DATA_DIR/proxy/mihomo/` and nothing else: it never reads,
 * writes, signals or reuses Clash Party's config, profiles, process, controller or ports.
 *
 * - start only when at least one entry is wanted; stop (state idle) when none remain;
 * - every config is validated with `mihomo -t` first; failing nodes are found (`proxy <i>` index, else bisect) and left out
 *   as `invalid`, so one bad node never takes the others down;
 * - reload = rename the tested file into place + `PUT /configs?force=true`, then a socks5 greeting on every port, because
 *   mihomo answers 204 even when a listener failed to bind [verified];
 * - the process is detached and, by default, outlives console restarts (CPA keeps using the ports). At boot the console
 *   adopts it only if the pid is alive, its argv carries `-d <our dir>`, and our controller answers. A pid that fails the
 *   argv check is never signalled;
 * - crashes restart with backoff (2 s → 5 min); more than 5 crashes in 10 min → `failed`.
 */

export type MihomoKernelState = 'unavailable' | 'idle' | 'starting' | 'running' | 'degraded' | 'failed' | 'stopped'

export type MihomoDesired = { entries: MihomoNodeEntry[]; listenerAuth: MihomoListenerAuth | null }

export type MihomoApplyResult = {
  state: MihomoKernelState
  /** Entries left out of the running config, with a scrubbed reason (structural rejects and `-t` failures). */
  invalid: MihomoRejected[]
  /** Entries in the running config whose port did not answer a socks5 greeting (port taken by something else, …). */
  bindFailed: string[]
  /** Entries whose port answered. */
  running: string[]
}

export type MihomoKernelStatus = {
  state: MihomoKernelState
  /** Scrubbed, user-facing reason for unavailable / degraded / failed / restart backoff. */
  reason: string | null
  version: string | null
  binarySource: MihomoBinarySource | null
  pid: number | null
  adopted: boolean
  startedAt: string | null
  entries: number
  ports: PortRange
  bindFailed: string[]
  invalid: MihomoRejected[]
  crashes: number
  nextRestartAt: string | null
  keepalive: boolean
}

export type MihomoKernelOptions = {
  /** `DATA_DIR/proxy/mihomo` (created 0700). */
  dir: string
  env?: NodeJS.ProcessEnv
  /** Test hook: replaces binary discovery + preparation (called at boot). */
  resolveBinary?: () => Promise<MihomoBinary>
  /** Test hook for the lazy path: where to look for the Clash Party bundle. */
  bundlePath?: string
  readyTimeoutMs?: number
  stopTimeoutMs?: number
  debounceMs?: number
  watchdogMs?: number
  backoff?: { baseMs: number; maxMs: number; windowMs: number; maxCrashes: number }
  /** Test hook: argv of a pid as one string (default: /proc/<pid>/cmdline on linux, `ps -o args=` elsewhere). */
  processArgs?: (pid: number) => Promise<string | null>
  log?: (line: string) => void
  now?: () => number
}

type Pidfile = { pid: number; dir: string; configSha: string | null; startedAt: number }
type TestOutcome = { ok: true; text: string } | { ok: false; entryId: string | null; index: number | null; reason: string }

const LOG_MAX_BYTES = 1024 * 1024
const RESPONSE_MAX_BYTES = 64 * 1024

const sha256 = (text: string) => crypto.createHash('sha256').update(text).digest('hex')
// Not unref'd: a stop/start in a short-lived process (CLI, test hook) must finish before the process may exit.
const sleep = (ms: number) => new Promise<void>(resolve => { setTimeout(resolve, ms) })

function pidState(pid: number): 'alive' | 'dead' | 'foreign' {
  try {
    process.kill(pid, 0)
    return 'alive'
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM' ? 'foreign' : 'dead'
  }
}

function defaultProcessArgs(pid: number): Promise<string | null> {
  if (process.platform === 'linux') {
    try {
      return Promise.resolve(fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean).join(' '))
    } catch {
      return Promise.resolve(null)
    }
  }
  return new Promise((resolve) => {
    execFile('ps', ['-ww', '-o', 'args=', '-p', String(pid)], { timeout: 2_000, env: { PATH: '/bin:/usr/bin' } }, (error, stdout) => {
      resolve(error ? null : String(stdout).trim() || null)
    })
  })
}

async function mapLimit<T, R>(items: readonly T[], limit: number, task: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length)
  let next = 0
  const worker = async () => {
    while (next < items.length) {
      const index = next++
      results[index] = await task(items[index])
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker))
  return results
}

/**
 * TCP connect + socks5 greeting. A managed listener answers `05 02` with auth, `05 00` without. Given the listener
 * credential, the RFC 1929 sub-negotiation must also succeed (`01 00`): another authenticated socks proxy on the same
 * port answers `05 02` too, but it rejects our random credential, so it is not mistaken for our listener.
 */
export function socksGreeting(port: number, auth: boolean | MihomoListenerAuth | null, timeoutMs = 1_500): Promise<boolean> {
  const withAuth = Boolean(auth)
  const credential = auth && typeof auth === 'object' ? auth : null
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port })
    let done = false
    let stage: 'method' | 'auth' = 'method'
    const finish = (ok: boolean) => {
      if (done) return
      done = true
      socket.destroy()
      resolve(ok)
    }
    socket.setTimeout(timeoutMs, () => finish(false))
    socket.once('error', () => finish(false))
    socket.once('connect', () => socket.write(Buffer.from(withAuth ? [5, 1, 2] : [5, 1, 0])))
    let buffer = Buffer.alloc(0)
    socket.on('data', (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk])
      if (buffer.length < 2) return
      if (stage === 'method') {
        const ok = buffer[0] === 5 && buffer[1] === (withAuth ? 2 : 0)
        if (!ok || !credential) { finish(ok); return }
        const user = Buffer.from(credential.username, 'utf8')
        const pass = Buffer.from(credential.password, 'utf8')
        if (user.length > 255 || pass.length > 255) { finish(false); return }
        stage = 'auth'
        buffer = buffer.subarray(2)
        socket.write(Buffer.concat([Buffer.from([1, user.length]), user, Buffer.from([pass.length]), pass]))
        if (buffer.length < 2) return
      }
      finish(buffer[0] === 1 && buffer[1] === 0)
    })
    socket.once('close', () => finish(false))
  })
}

export class MihomoKernel {
  readonly dir: string
  private readonly env: NodeJS.ProcessEnv
  private readonly options: MihomoKernelOptions
  private readonly readyTimeoutMs: number
  private readonly stopTimeoutMs: number
  private readonly debounceMs: number
  private readonly watchdogMs: number
  private readonly backoff: { baseMs: number; maxMs: number; windowMs: number; maxCrashes: number }
  private readonly log: (line: string) => void
  private readonly now: () => number
  readonly keepalive: boolean
  readonly portRange: PortRange
  private readonly kernelDns: boolean

  private bootPromise: Promise<void> | null = null
  /** Prepared (copied + `-v` checked) binary; null until a managed entry, a validation or a manual start needs it. */
  private binary: MihomoBinary | null = null
  /** Located at boot without copying or executing anything. */
  private located: LocatedMihomo | null = null
  private state: MihomoKernelState = 'idle'
  private reason: string | null = null
  private child: ChildProcess | null = null
  private readonly expectedExits = new WeakSet<ChildProcess>()
  private pid: number | null = null
  private adopted = false
  private startedAt: number | null = null
  private configSha: string | null = null
  private controllerInfo: MihomoController | null = null
  private desired: MihomoDesired | null = null
  private manualStopped = false
  private crashTimes: number[] = []
  private nextRestartAt: number | null = null
  private restartTimer: ReturnType<typeof setTimeout> | null = null
  private watchdog: ReturnType<typeof setInterval> | null = null
  private applyTimer: ReturnType<typeof setTimeout> | null = null
  private pendingApply: { promise: Promise<MihomoApplyResult>; resolve: (value: MihomoApplyResult) => void; reject: (error: unknown) => void } | null = null
  private chain: Promise<unknown> = Promise.resolve()
  private lastInvalid: MihomoRejected[] = []
  private lastBindFailed: string[] = []
  /** Listener ports handed to the running kernel while they were free (null = adopted or restarted: trust its config file). */
  private ownedPorts: Set<number> | null = null
  private runningEntries = 0
  private readonly listeners = new Set<(status: MihomoKernelStatus) => void>()
  private shuttingDown = false

  constructor(options: MihomoKernelOptions) {
    this.options = options
    this.dir = path.resolve(options.dir)
    this.env = options.env ?? process.env
    this.readyTimeoutMs = options.readyTimeoutMs ?? 3_000
    this.stopTimeoutMs = options.stopTimeoutMs ?? 3_000
    this.debounceMs = options.debounceMs ?? 500
    this.watchdogMs = options.watchdogMs ?? 15_000
    this.backoff = options.backoff ?? { baseMs: 2_000, maxMs: 5 * 60_000, windowMs: 10 * 60_000, maxCrashes: 5 }
    this.log = options.log ?? ((line) => console.log(line))
    this.now = options.now ?? Date.now
    this.keepalive = this.env.PROXY_KERNEL_KEEPALIVE !== '0'
    this.kernelDns = this.env.PROXY_KERNEL_DNS === 'on'
    this.portRange = kernelPortRange(this.env)
  }

  /* ────────────────────────── paths ────────────────────────── */

  private file(name: string) { return path.join(this.dir, name) }
  get configPath() { return this.file('config.yaml') }
  private get nextPath() { return this.file('config.next.yaml') }
  private get pidPath() { return this.file('mihomo.pid') }
  private get controllerPath() { return this.file('controller.json') }
  private get logPath() { return this.file('mihomo.log') }

  private ensureDir() {
    fs.mkdirSync(path.dirname(this.dir), { recursive: true, mode: 0o700 })
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 })
    fs.chmodSync(this.dir, 0o700)
  }

  private writePrivate(file: string, text: string) {
    const temporary = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`
    fs.writeFileSync(temporary, text, { flag: 'wx', mode: 0o600 })
    fs.renameSync(temporary, file)
  }

  private childEnv(): NodeJS.ProcessEnv {
    // Nothing else leaks in: no proxy variables, no SAFE_PATHS beyond `-d`, HOME pinned to our directory.
    return { PATH: this.env.PATH ?? process.env.PATH ?? '/usr/bin:/bin', HOME: this.dir, SAFE_PATHS: '' }
  }

  /* ────────────────────────── status ────────────────────────── */

  status(): MihomoKernelStatus {
    return {
      state: this.state,
      reason: this.reason,
      version: this.binary?.ok ? this.binary.version : null,
      binarySource: this.binary?.ok ? this.binary.source : this.located?.ok ? this.located.source : null,
      pid: this.pid,
      adopted: this.adopted,
      startedAt: this.startedAt ? new Date(this.startedAt).toISOString() : null,
      entries: this.runningEntries,
      ports: this.portRange,
      bindFailed: [...this.lastBindFailed],
      invalid: this.lastInvalid.map(item => ({ ...item })),
      crashes: this.crashTimes.filter(at => at > this.now() - this.backoff.windowMs).length,
      nextRestartAt: this.nextRestartAt ? new Date(this.nextRestartAt).toISOString() : null,
      keepalive: this.keepalive,
    }
  }

  /** The kernel serves traffic (all or some ports). */
  isRunning(): boolean {
    return this.state === 'running' || this.state === 'degraded'
  }

  onChange(listener: (status: MihomoKernelStatus) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private setState(state: MihomoKernelState, reason: string | null = null) {
    const changed = state !== this.state || reason !== this.reason
    this.state = state
    this.reason = reason
    if (!changed) return
    this.log(JSON.stringify({ category: '[PROXY]', event: 'mihomo.state', state, ...(reason ? { reason } : {}) }))
    const snapshot = this.status()
    for (const listener of this.listeners) {
      try { listener(snapshot) } catch { /* a listener must not break the kernel */ }
    }
  }

  private secrets(): string[] {
    const values: string[] = []
    for (const entry of this.desired?.entries ?? []) nodeSecrets(entry.node, values)
    if (this.desired?.listenerAuth) values.push(this.desired.listenerAuth.username, this.desired.listenerAuth.password)
    if (this.controllerInfo) values.push(this.controllerInfo.secret)
    return values
  }

  /* ────────────────────────── boot / adopt ────────────────────────── */

  boot(): Promise<MihomoKernelStatus> {
    if (!this.bootPromise) this.bootPromise = this.exclusive(() => this.doBoot())
    return this.bootPromise.then(() => this.status())
  }

  private async doBoot(): Promise<void> {
    // Read-only at boot: the directory is created only when the kernel is first needed.
    if (typeof process.getuid === 'function' && process.getuid() === 0) {
      this.located = { ok: false, reason: '控制台以 root 运行：拒绝以 root 启动 mihomo' }
      this.setState('unavailable', this.located.reason)
      return
    }
    try {
      if (this.options.resolveBinary) {
        this.binary = await this.options.resolveBinary()
        this.located = this.binary.ok ? { ok: true, source: this.binary.source, sourcePath: this.binary.sourcePath, needsCopy: this.binary.copied } : this.binary
      } else {
        // Cheap at boot: find it, but copy (54 MB from the .app) and run `-v` only once something needs the kernel.
        this.located = locateMihomoBinary({ env: this.env, bundlePath: this.options.bundlePath })
      }
    } catch {
      this.located = { ok: false, reason: '查找 mihomo 失败' }
    }
    if (!this.located.ok) {
      this.setState('unavailable', this.located.reason)
      return
    }
    const pidfile = this.readPidfile()
    if (!pidfile) {
      this.setState('idle')
      return
    }
    const liveness = pidState(pidfile.pid)
    if (liveness !== 'alive' || pidfile.dir !== this.dir || !(await this.argvIsOurs(pidfile.pid))) {
      // Dead, foreign-owned, or a recycled pid that is not our kernel: forget it, never signal it.
      fs.rmSync(this.pidPath, { force: true })
      this.setState('idle')
      return
    }
    this.controllerInfo = this.readController()
    if (this.controllerInfo && (await this.controllerAnswers())) {
      this.pid = pidfile.pid
      this.adopted = true
      this.startedAt = pidfile.startedAt
      this.configSha = pidfile.configSha
      this.startWatchdog()
      this.setState('running')
      this.log(JSON.stringify({ category: '[PROXY]', event: 'mihomo.adopt', pid: pidfile.pid }))
      return
    }
    // Our own kernel (argv verified) whose controller is gone: stop it so the next start owns the ports cleanly.
    this.pid = pidfile.pid
    await this.stopProcess()
    this.setState('idle')
  }

  private async argvIsOurs(pid: number): Promise<boolean> {
    const args = await (this.options.processArgs ?? defaultProcessArgs)(pid).catch(() => null)
    return Boolean(args && args.includes(` -d ${this.dir} -f `))
  }

  private readPidfile(): Pidfile | null {
    try {
      const value = JSON.parse(fs.readFileSync(this.pidPath, 'utf8')) as Pidfile
      return Number.isSafeInteger(value?.pid) && value.pid > 1 && typeof value.dir === 'string' ? value : null
    } catch {
      return null
    }
  }

  private writePidfile() {
    if (!this.pid) return
    this.writePrivate(this.pidPath, `${JSON.stringify({ pid: this.pid, dir: this.dir, configSha: this.configSha, startedAt: this.startedAt ?? this.now() } satisfies Pidfile)}\n`)
  }

  /* ────────────────────────── controller ────────────────────────── */

  private readController(): MihomoController | null {
    try {
      const value = JSON.parse(fs.readFileSync(this.controllerPath, 'utf8')) as MihomoController
      return Number.isSafeInteger(value?.port) && value.port > 0 && value.port < 65536 && typeof value.secret === 'string' && value.secret.length >= 16 ? value : null
    } catch {
      return null
    }
  }

  /** Reuses the stored controller port while it is free (or ours); otherwise picks an ephemeral loopback port outside the listener range. */
  private async ensureController(): Promise<MihomoController> {
    const stored = this.controllerInfo ?? this.readController()
    if (stored && (this.pid || (!inPortRange(stored.port, this.portRange) && (await isPortFree(stored.port))))) {
      this.controllerInfo = stored
      return stored
    }
    let port = 0
    for (let attempt = 0; attempt < 8 && !port; attempt++) {
      const candidate = await new Promise<number>((resolve) => {
        const server = net.createServer()
        server.unref()
        server.once('error', () => resolve(0))
        server.listen({ port: 0, host: '127.0.0.1' }, () => {
          const address = server.address()
          const value = typeof address === 'object' && address ? address.port : 0
          server.close(() => resolve(value))
        })
      })
      if (candidate && !inPortRange(candidate, this.portRange)) port = candidate
    }
    if (!port) throw new Error('无法分配内核控制端口')
    const controller = { port, secret: crypto.randomBytes(24).toString('hex') }
    this.writePrivate(this.controllerPath, `${JSON.stringify(controller)}\n`)
    this.controllerInfo = controller
    return controller
  }

  private controllerRequest(method: string, route: string, body?: unknown, timeoutMs = 3_000): Promise<{ status: number; text: string }> {
    const controller = this.controllerInfo
    if (!controller) return Promise.reject(new Error('controller unknown'))
    const payload = body === undefined ? undefined : JSON.stringify(body)
    return new Promise((resolve, reject) => {
      const req = http.request({
        host: '127.0.0.1', port: controller.port, path: route, method, agent: false,
        headers: { authorization: `Bearer ${controller.secret}`, ...(payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {}) },
      }, (res) => {
        const chunks: Buffer[] = []
        let bytes = 0
        res.on('data', (chunk: Buffer) => {
          bytes += chunk.length
          if (bytes <= RESPONSE_MAX_BYTES) chunks.push(chunk)
        })
        res.once('end', () => resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString('utf8') }))
        res.once('error', reject)
      })
      req.setTimeout(timeoutMs, () => req.destroy(new Error('controller timeout')))
      req.once('error', reject)
      req.end(payload)
    })
  }

  private async controllerAnswers(): Promise<boolean> {
    try {
      const reply = await this.controllerRequest('GET', '/version', undefined, 1_500)
      return reply.status === 200 && /"version"/.test(reply.text)
    } catch {
      return false
    }
  }

  /** Copies/version-checks the located binary on first need; on failure the kernel becomes `unavailable`. */
  private async prepareBinary(): Promise<boolean> {
    if (!this.located?.ok) return false
    this.ensureDir()
    if (this.binary?.ok) return true
    this.binary = await prepareMihomoBinary(this.located, { dir: this.dir }).catch(() => ({ ok: false as const, reason: '准备 mihomo 失败' }))
    if (!this.binary.ok) {
      this.setState('unavailable', this.binary.reason)
      return false
    }
    return true
  }

  /* ────────────────────────── validation ────────────────────────── */

  private runTest(file: string): Promise<{ ok: boolean; output: string }> {
    const binary = this.binary
    if (!binary?.ok) return Promise.resolve({ ok: false, output: '' })
    return new Promise((resolve) => {
      execFile(binary.runPath, ['-t', '-d', this.dir, '-f', file], { timeout: 10_000, maxBuffer: 1024 * 1024, env: this.childEnv(), cwd: this.dir }, (error, stdout, stderr) => {
        resolve({ ok: !error, output: `${stdout}\n${stderr}` })
      })
    })
  }

  private async testEntries(entries: readonly MihomoNodeEntry[], auth: MihomoListenerAuth | null, controller: MihomoController, file: string): Promise<TestOutcome> {
    const built = buildMihomoConfig({ entries, listenerAuth: auth, controller, kernelDns: this.kernelDns })
    const text = renderMihomoConfig(built.config)
    this.writePrivate(file, text)
    const result = await this.runTest(file)
    if (result.ok) return { ok: true, text }
    const messages = mihomoErrorMessages(result.output)
    const message = messages[messages.length - 1] ?? ''
    const secrets = this.secrets()
    for (const entry of built.entries) nodeSecrets(entry.node, secrets)
    const mapped = mapMihomoError(message, built.entries, secrets)
    return { ok: false, entryId: mapped.entryId, index: mapped.index, reason: message ? mapped.reason : '配置校验失败' }
  }

  /**
   * Splits `entries` into the ones mihomo accepts and the ones it rejects. Errors that name `proxy <i>` drop that node
   * directly (one `-t` per bad node); anything else is bisected (log₂ n runs per bad node). If even an empty config
   * fails, the problem is the kernel itself, not a node: `fatal`, nothing is marked invalid.
   */
  private async partition(entries: readonly MihomoNodeEntry[], auth: MihomoListenerAuth | null, controller: MihomoController, file: string): Promise<{ good: MihomoNodeEntry[]; bad: MihomoRejected[]; text: string | null; fatal: string | null }> {
    const bad = new Map<string, string>()
    let remaining = [...entries]
    for (let round = 0; round < 64 && remaining.length; round++) {
      const outcome = await this.testEntries(remaining, auth, controller, file)
      if (outcome.ok) return { good: remaining, bad: [...bad].map(([id, reason]) => ({ id, reason })), text: outcome.text, fatal: null }
      if (outcome.entryId === null) break
      bad.set(outcome.entryId, outcome.reason)
      remaining = remaining.filter(entry => entry.id !== outcome.entryId)
    }
    if (remaining.length) {
      const baseline = await this.testEntries([], auth, controller, file)
      if (!baseline.ok) return { good: [], bad: [...bad].map(([id, reason]) => ({ id, reason })), text: null, fatal: baseline.reason }
      const bisect = async (list: MihomoNodeEntry[]): Promise<void> => {
        if (!list.length) return
        const outcome = await this.testEntries(list, auth, controller, file)
        if (outcome.ok) return
        if (list.length === 1) {
          bad.set(list[0].id, outcome.reason)
          return
        }
        const middle = Math.ceil(list.length / 2)
        await bisect(list.slice(0, middle))
        await bisect(list.slice(middle))
      }
      await bisect(remaining)
      remaining = remaining.filter(entry => !bad.has(entry.id))
    }
    const invalid = [...bad].map(([id, reason]) => ({ id, reason }))
    if (!remaining.length) return { good: [], bad: invalid, text: null, fatal: null }
    const final = await this.testEntries(remaining, auth, controller, file)
    return final.ok ? { good: remaining, bad: invalid, text: final.text, fatal: null } : { good: [], bad: invalid, text: null, fatal: final.reason }
  }

  /**
   * Import-time check (PROXY-SPEC §2): which of these nodes would mihomo reject? Uses a throwaway file in our directory and
   * never touches the running config. Without a binary every node is reported `unverified` by the caller (empty result,
   * `available: false`).
   */
  async validate(entries: readonly MihomoNodeEntry[]): Promise<{ available: boolean; invalid: MihomoRejected[] }> {
    await this.boot()
    if (!(await this.exclusive(() => this.prepareBinary()))) return { available: false, invalid: [] }
    const controller = { port: 1, secret: 'validate-only-secret' }
    // Import-time nodes may not have a port yet; `-t` never binds, so placeholder ports are enough.
    const placeholders = entries.map((entry, index) => ({ ...entry, port: 40_000 + (index % 20_000) }))
    const built = buildMihomoConfig({ entries: placeholders, listenerAuth: null, controller })
    const file = this.file(`check-${crypto.randomBytes(6).toString('hex')}.yaml`)
    try {
      const result = built.entries.length ? await this.partition(built.entries, null, controller, file) : { bad: [], fatal: null }
      if (result.fatal) throw new Error(`mihomo 校验失败：${result.fatal}`)
      return { available: true, invalid: [...built.rejected, ...result.bad] }
    } finally {
      fs.rmSync(file, { force: true })
    }
  }

  /* ────────────────────────── apply / reconcile ────────────────────────── */

  private exclusive<T>(task: () => Promise<T>): Promise<T> {
    const run = this.chain.then(task, task)
    this.chain = run.catch(() => undefined)
    return run
  }

  /** Desired state from the pool. Debounced; resolves with the outcome of the run that included this call. */
  apply(desired: MihomoDesired): Promise<MihomoApplyResult> {
    this.desired = { entries: [...desired.entries], listenerAuth: desired.listenerAuth }
    if (!this.pendingApply) {
      let resolve!: (value: MihomoApplyResult) => void
      let reject!: (error: unknown) => void
      const promise = new Promise<MihomoApplyResult>((res, rej) => { resolve = res; reject = rej })
      this.pendingApply = { promise, resolve, reject }
      this.applyTimer = setTimeout(() => {
        const pending = this.pendingApply!
        this.pendingApply = null
        this.applyTimer = null
        this.boot().then(() => this.exclusive(() => this.reconcile({}))).then(pending.resolve, pending.reject)
      }, this.debounceMs)
      this.applyTimer.unref?.()
    }
    return this.pendingApply.promise
  }

  private result(state: MihomoKernelState, invalid: MihomoRejected[], bindFailed: string[], running: string[]): MihomoApplyResult {
    return { state, invalid, bindFailed, running }
  }

  private async reconcile(options: { forceStart?: boolean }): Promise<MihomoApplyResult> {
    if (this.shuttingDown) return this.result(this.state, this.lastInvalid, this.lastBindFailed, [])
    if (!this.located?.ok) return this.result('unavailable', [], [], [])
    const desired = this.desired ?? { entries: [], listenerAuth: null }
    if (this.manualStopped && !options.forceStart) {
      return this.result(this.state, this.lastInvalid, this.lastBindFailed, [])
    }
    if (options.forceStart) this.manualStopped = false
    if (!desired.entries.length) {
      await this.stopProcess()
      this.lastInvalid = []
      this.lastBindFailed = []
      this.runningEntries = 0
      this.setState('idle')
      return this.result('idle', [], [], [])
    }
    if (!(await this.prepareBinary())) return this.result('unavailable', [], [], [])
    let controller: MihomoController
    try {
      controller = await this.ensureController()
    } catch (error) {
      this.setState('failed', (error as Error).message)
      return this.result('failed', [], [], [])
    }
    const built = buildMihomoConfig({ entries: desired.entries, listenerAuth: desired.listenerAuth, controller, portRange: this.portRange })
    const invalid: MihomoRejected[] = [...built.rejected]
    if (!built.entries.length) {
      await this.stopProcess()
      this.lastInvalid = invalid
      this.lastBindFailed = []
      this.runningEntries = 0
      this.setState('idle')
      return this.result('idle', invalid, [], [])
    }
    const checked = await this.partition(built.entries, desired.listenerAuth, controller, this.nextPath)
    invalid.push(...checked.bad)
    this.lastInvalid = invalid
    if (checked.fatal) {
      this.setState('failed', `配置校验失败：${checked.fatal}`)
      return this.result('failed', invalid, [], [])
    }
    if (!checked.good.length || !checked.text) {
      await this.stopProcess()
      this.lastBindFailed = []
      this.runningEntries = 0
      this.setState('idle', invalid.length ? '所有加密节点配置无效' : null)
      return this.result('idle', invalid, [], [])
    }
    const sha = sha256(checked.text)
    const foreign = await this.foreignPorts(checked.good)
    try {
      if (this.pid && pidState(this.pid) === 'alive') {
        if (sha !== this.configSha) {
          fs.renameSync(this.nextPath, this.configPath)
          let reloaded = false
          try {
            const reply = await this.controllerRequest('PUT', '/configs?force=true', { path: this.configPath, payload: '' }, 10_000)
            reloaded = reply.status >= 200 && reply.status < 300
          } catch {
            reloaded = false
          }
          if (!reloaded) {
            // Controller trouble: fall back to a clean stop + start with the new file.
            await this.stopProcess()
            await this.startProcess(sha)
          } else {
            this.configSha = sha
            this.writePidfile()
          }
        }
      } else {
        this.pid = null
        fs.renameSync(this.nextPath, this.configPath)
        this.setState('starting')
        await this.startProcess(sha)
      }
    } catch (error) {
      // A crash during start already scheduled a backoff restart (state `starting`); keep that instead of `failed`.
      if (!this.restartTimer) this.setState('failed', scrubMihomoText((error as Error).message, this.secrets()))
      return this.result(this.state, invalid, [], [])
    }
    const verified = await this.verifyListeners(checked.good.filter(entry => !foreign.has(entry.port)), desired.listenerAuth)
    const failed = [...checked.good.filter(entry => foreign.has(entry.port)).map(entry => entry.id), ...verified.failed]
    // a port that was free when mihomo was asked to bind it stays ours, even if its listener came up late
    this.ownedPorts = new Set(checked.good.filter(entry => !foreign.has(entry.port)).map(entry => entry.port))
    this.lastBindFailed = failed
    this.runningEntries = checked.good.length
    if (failed.length) this.setState('degraded', `${failed.length} 个本机端口未能监听`)
    else this.setState('running')
    return this.result(this.state, invalid, failed, verified.ok)
  }

  /**
   * Listener ownership (with the credential check in `socksGreeting`): a port the running kernel does not already hold must be free before mihomo is asked to
   * bind it. Mihomo reports success (204) even when a bind fails, and without a listener credential the socks greeting
   * cannot tell mihomo from another local proxy already sitting on that port, so an occupied port is never ours.
   */
  private async foreignPorts(entries: readonly MihomoNodeEntry[]): Promise<Set<number>> {
    const alive = Boolean(this.pid && pidState(this.pid) === 'alive')
    const held = alive ? this.ownedPorts ?? this.configuredPorts() : new Set<number>()
    const fresh = entries.filter(entry => !held.has(entry.port))
    const free = await mapLimit(fresh, 16, entry => isPortFree(entry.port))
    return new Set(fresh.filter((_, index) => !free[index]).map(entry => entry.port))
  }

  /** Listener ports of the config the running kernel was started or reloaded with. */
  private configuredPorts(): Set<number> {
    try {
      const config = JSON.parse(fs.readFileSync(this.configPath, 'utf8')) as { listeners?: Array<{ port?: unknown }> }
      return new Set((config.listeners ?? []).map(listener => Number(listener.port)).filter(port => Number.isSafeInteger(port)))
    } catch {
      return new Set()
    }
  }

  private async verifyListeners(entries: readonly MihomoNodeEntry[], auth: MihomoListenerAuth | null): Promise<{ ok: string[]; failed: string[] }> {
    let pending = [...entries]
    const ok: string[] = []
    // Listeners bind asynchronously after a reload; give a failing port a few short retries before calling it failed.
    for (let attempt = 0; attempt < 4 && pending.length; attempt++) {
      if (attempt) await sleep(150 * attempt)
      const answers = await mapLimit(pending, 16, entry => socksGreeting(entry.port, auth))
      ok.push(...pending.filter((_, index) => answers[index]).map(entry => entry.id))
      pending = pending.filter((_, index) => !answers[index])
    }
    return { ok, failed: pending.map(entry => entry.id) }
  }

  /* ────────────────────────── process ────────────────────────── */

  private rotateLog() {
    try {
      const stat = fs.statSync(this.logPath)
      if (stat.size <= LOG_MAX_BYTES) return
      fs.copyFileSync(this.logPath, `${this.logPath}.1`)
      fs.chmodSync(`${this.logPath}.1`, 0o600)
      // The child appends (O_APPEND), so truncating in place is safe while it runs.
      fs.truncateSync(this.logPath, 0)
    } catch {
      // no log yet
    }
  }

  private logTail(): string | null {
    try {
      const fd = fs.openSync(this.logPath, 'r')
      try {
        const size = fs.fstatSync(fd).size
        const length = Math.min(size, 8 * 1024)
        const buffer = Buffer.alloc(length)
        fs.readSync(fd, buffer, 0, length, size - length)
        const messages = mihomoErrorMessages(buffer.toString('utf8'))
        return messages.length ? scrubMihomoText(messages[messages.length - 1], this.secrets()) : null
      } finally {
        fs.closeSync(fd)
      }
    } catch {
      return null
    }
  }

  private async startProcess(sha: string): Promise<void> {
    const binary = this.binary
    if (!binary?.ok) throw new Error('mihomo 不可用')
    this.rotateLog()
    const logFd = fs.openSync(this.logPath, 'a', 0o600)
    let child: ChildProcess
    try {
      child = spawn(binary.runPath, ['-d', this.dir, '-f', this.configPath], {
        detached: true, stdio: ['ignore', logFd, logFd], env: this.childEnv(), cwd: this.dir,
      })
    } finally {
      fs.closeSync(logFd)
    }
    await new Promise<void>((resolve, reject) => {
      child.once('spawn', resolve)
      child.once('error', () => reject(new Error('无法启动 mihomo')))
    })
    this.child = child
    this.pid = child.pid ?? null
    this.adopted = false
    this.startedAt = this.now()
    this.configSha = sha
    child.once('exit', () => this.onExit(child))
    if (this.keepalive) child.unref()
    this.writePidfile()
    const deadline = Date.now() + this.readyTimeoutMs
    while (Date.now() < deadline) {
      if (child.exitCode !== null || child.signalCode !== null) break
      if (await this.controllerAnswers()) {
        this.startWatchdog()
        this.log(JSON.stringify({ category: '[PROXY]', event: 'mihomo.start', pid: this.pid }))
        return
      }
      await sleep(50)
    }
    const tail = this.logTail()
    this.expectedExits.add(child)
    await this.stopProcess()
    throw new Error(tail ? `内核启动失败：${tail}` : '内核启动超时')
  }

  private onExit(child: ChildProcess) {
    if (this.expectedExits.has(child) || child !== this.child) return
    this.child = null
    this.pid = null
    this.configSha = null
    this.ownedPorts = null
    fs.rmSync(this.pidPath, { force: true })
    this.onCrash()
  }

  private onCrash() {
    this.stopWatchdog()
    if (this.shuttingDown) return
    const now = this.now()
    this.crashTimes = this.crashTimes.filter(at => at > now - this.backoff.windowMs)
    this.crashTimes.push(now)
    const tail = this.logTail()
    if (this.crashTimes.length > this.backoff.maxCrashes) {
      this.nextRestartAt = null
      this.setState('failed', `内核在 ${Math.round(this.backoff.windowMs / 60_000)} 分钟内崩溃超过 ${this.backoff.maxCrashes} 次，已停止自动重启${tail ? `：${tail}` : ''}`)
      return
    }
    const delay = Math.min(this.backoff.maxMs, this.backoff.baseMs * 2 ** (this.crashTimes.length - 1))
    this.nextRestartAt = now + delay
    this.setState('starting', `内核异常退出，${Math.max(1, Math.ceil(delay / 1000))} 秒后重启${tail ? `：${tail}` : ''}`)
    if (this.restartTimer) clearTimeout(this.restartTimer)
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null
      this.nextRestartAt = null
      void this.exclusive(() => this.reconcile({})).catch(() => undefined)
    }, delay)
    this.restartTimer.unref?.()
  }

  private startWatchdog() {
    this.stopWatchdog()
    this.watchdog = setInterval(() => {
      this.rotateLog()
      if (!this.pid || this.child) return // our own child reports its exit itself
      if (pidState(this.pid) !== 'alive') {
        this.pid = null
        this.configSha = null
        this.ownedPorts = null
        fs.rmSync(this.pidPath, { force: true })
        this.onCrash()
      }
    }, this.watchdogMs)
    this.watchdog.unref?.()
  }

  private stopWatchdog() {
    if (this.watchdog) clearInterval(this.watchdog)
    this.watchdog = null
  }

  /** SIGTERM then SIGKILL, only to a pid we spawned or whose argv we just re-verified. */
  private async stopProcess(): Promise<void> {
    const pid = this.pid
    const child = this.child
    this.stopWatchdog()
    if (!pid) return
    const ours = child && child.pid === pid && child.exitCode === null ? true : await this.argvIsOurs(pid)
    if (child) this.expectedExits.add(child)
    if (ours && pidState(pid) === 'alive') {
      try { process.kill(pid, 'SIGTERM') } catch { /* already gone */ }
      const deadline = Date.now() + this.stopTimeoutMs
      while (Date.now() < deadline && pidState(pid) === 'alive' && !(child && child.exitCode !== null)) await sleep(25)
      if (pidState(pid) === 'alive' && !(child && (child.exitCode !== null || child.signalCode !== null))) {
        try { process.kill(pid, 'SIGKILL') } catch { /* already gone */ }
        await sleep(50)
      }
    }
    this.child = null
    this.pid = null
    this.adopted = false
    this.startedAt = null
    this.configSha = null
    this.ownedPorts = null
    this.runningEntries = 0
    fs.rmSync(this.pidPath, { force: true })
  }

  /* ────────────────────────── manual actions (POST /kernel/:action) ────────────────────────── */

  /** Manual start (also resets the crash counter). `desired` replaces the last known desired state when given. */
  async start(desired?: MihomoDesired): Promise<MihomoApplyResult> {
    await this.boot()
    if (desired) this.desired = { entries: [...desired.entries], listenerAuth: desired.listenerAuth }
    this.crashTimes = []
    if (this.restartTimer) clearTimeout(this.restartTimer)
    this.restartTimer = null
    this.nextRestartAt = null
    return this.exclusive(() => this.reconcile({ forceStart: true }))
  }

  async stop(): Promise<MihomoKernelStatus> {
    await this.boot()
    return this.exclusive(async () => {
      if (!this.located?.ok) return this.status()
      this.manualStopped = true
      if (this.restartTimer) clearTimeout(this.restartTimer)
      this.restartTimer = null
      this.nextRestartAt = null
      await this.stopProcess()
      this.lastBindFailed = []
      this.setState('stopped')
      return this.status()
    })
  }

  async restart(desired?: MihomoDesired): Promise<MihomoApplyResult> {
    await this.boot()
    if (desired) this.desired = { entries: [...desired.entries], listenerAuth: desired.listenerAuth }
    this.crashTimes = []
    return this.exclusive(async () => {
      if (!this.located?.ok) return this.result('unavailable', [], [], [])
      await this.stopProcess()
      return this.reconcile({ forceStart: true })
    })
  }

  /**
   * Console shutdown. Default (keepalive): leave the kernel running for CPA and the next console to adopt.
   * `PROXY_KERNEL_KEEPALIVE=0`: stop it.
   */
  async shutdown(): Promise<void> {
    this.shuttingDown = true
    if (this.applyTimer) clearTimeout(this.applyTimer)
    this.applyTimer = null
    if (this.pendingApply) {
      this.pendingApply.resolve(this.result(this.state, this.lastInvalid, this.lastBindFailed, []))
      this.pendingApply = null
    }
    if (this.restartTimer) clearTimeout(this.restartTimer)
    this.restartTimer = null
    this.stopWatchdog()
    if (!this.keepalive) await this.stopProcess()
    else this.child?.unref()
  }

  /**
   * Synchronous variant for a signal handler that re-raises the signal right away: with keepalive it only drops timers;
   * with `PROXY_KERNEL_KEEPALIVE=0` it sends SIGTERM (mihomo exits on it immediately [verified]) to the pid this console
   * spawned or adopted after the argv check.
   */
  shutdownNow(): void {
    this.shuttingDown = true
    for (const timer of [this.applyTimer, this.restartTimer]) if (timer) clearTimeout(timer)
    this.applyTimer = null
    this.restartTimer = null
    this.stopWatchdog()
    if (this.keepalive || !this.pid || pidState(this.pid) !== 'alive') return
    if (this.child) this.expectedExits.add(this.child)
    try { process.kill(this.pid, 'SIGTERM') } catch { /* already gone */ }
  }
}

let shared: MihomoKernel | null = null

/** The process-wide kernel for `DATA_DIR/proxy/mihomo` (created on first use; nothing runs until `boot()` / `apply()`). */
export function getMihomoKernel(): MihomoKernel {
  if (!shared) shared = new MihomoKernel({ dir: path.join(config.dataDir, 'proxy', 'mihomo') })
  return shared
}

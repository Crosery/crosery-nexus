import net from 'node:net'

/**
 * Config generation for the console-managed mihomo (PROXY-SPEC §4). Pure functions only: the kernel
 * (mihomoKernel.ts) writes the result to a 0600 file inside its own `-d` directory.
 *
 * Invariants every generated config keeps (tested):
 * - every inbound is a `socks` listener on 127.0.0.1, one per entry, tied to exactly one node (`proxy: n-<id>`);
 * - the global inbounds (`port`, `socks-port`, `mixed-port`, redir/tproxy) are 0, `allow-lan` is false;
 * - tun and dns are off (dns only on when `kernelDns` is set), rules are `MATCH,DIRECT`;
 * - the controller listens on 127.0.0.1 with a secret;
 * - node labels never appear (names are `n-<id>` / `L-<id>`).
 *
 * The file is JSON: mihomo parses it with its YAML loader (JSON is a YAML subset) [verified with v1.19.31 `-t`].
 */

export type MihomoListenerAuth = { username: string; password: string }

/** One managed exit: a whitelisted Clash proxy object plus the stable local port the pool allocated for it. */
export type MihomoNodeEntry = { id: string; port: number; node: Record<string, unknown> }

export type MihomoController = { port: number; secret: string }

export type MihomoRejected = { id: string; reason: string }

export const MIHOMO_NODE_TYPES = ['ss', 'ssr', 'vmess', 'vless', 'trojan', 'hysteria2', 'tuic', 'wireguard', 'socks5', 'http'] as const

const ENTRY_ID = /^[A-Za-z0-9_-]{1,64}$/
/** Keys a node must never carry into our kernel: they bind interfaces, chain to names we do not define, or read files. */
const DROPPED_KEYS = new Set(['name', 'interface-name', 'routing-mark', 'dialer-proxy', 'provider', 'ip-version-prefer-file'])
/** File-path fields (client certificates, plugin binaries). wireguard's `private-key` is key material, not a path, and stays. */
const PATH_KEYS = new Set(['certificate', 'private-key', 'ca', 'ca-str', 'plugin-path', 'cert', 'key'])

export const nodeName = (id: string) => `n-${id}`
export const listenerName = (id: string) => `L-${id}`

export type PortRange = { base: number; count: number }

/** `PROXY_PORT_BASE` (default 27890) + `PROXY_PORT_COUNT` (1000): clear of Clash Party's 789x and the gateway's dropped 127.0.0.1:179xx. */
export function kernelPortRange(env: NodeJS.ProcessEnv = process.env): PortRange {
  const base = Number(env.PROXY_PORT_BASE || 27890)
  const count = Number(env.PROXY_PORT_COUNT || 1000)
  const safeBase = Number.isSafeInteger(base) && base >= 1024 && base <= 65000 ? base : 27890
  const safeCount = Number.isSafeInteger(count) && count >= 1 && count <= 10000 ? Math.min(count, 65536 - safeBase) : 1000
  return { base: safeBase, count: safeCount }
}

export const inPortRange = (port: number, range: PortRange) => Number.isSafeInteger(port) && port >= range.base && port < range.base + range.count

/** Bind probe on 127.0.0.1 (the pool allocates ports with it; the kernel uses it for the controller). */
export function isPortFree(port: number, host = '127.0.0.1'): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer()
    server.unref()
    server.once('error', () => resolve(false))
    server.listen({ port, host, exclusive: true }, () => server.close(() => resolve(true)))
  })
}

/** The URL accounts use for a managed exit. Userinfo is percent-encoded; callers must mask it before showing it anywhere. */
export function listenerProxyUrl(port: number, auth: MihomoListenerAuth | null): string {
  const userinfo = auth ? `${encodeURIComponent(auth.username)}:${encodeURIComponent(auth.password)}@` : ''
  return `socks5://${userinfo}127.0.0.1:${port}`
}

function cleanNode(node: Record<string, unknown>): Record<string, unknown> {
  const type = String(node.type ?? '')
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(node)) {
    if (DROPPED_KEYS.has(key)) continue
    if (PATH_KEYS.has(key) && !(type === 'wireguard' && key === 'private-key')) continue
    if (value === undefined) continue
    out[key] = value
  }
  // Plugins that spawn helper binaries or read local files are never allowed to point at a path.
  const opts = out['plugin-opts']
  if (opts && typeof opts === 'object' && !Array.isArray(opts)) {
    const cleaned = { ...(opts as Record<string, unknown>) }
    for (const key of Object.keys(cleaned)) if (PATH_KEYS.has(key)) delete cleaned[key]
    out['plugin-opts'] = cleaned
  }
  return out
}

/** Checks the structural minimum a node needs; mihomo `-t` does the real per-type validation. */
function entryProblem(entry: MihomoNodeEntry, range: PortRange | null, controllerPort: number | null): string | null {
  if (!ENTRY_ID.test(String(entry.id))) return '条目标识无效'
  if (!entry.node || typeof entry.node !== 'object' || Array.isArray(entry.node)) return '节点配置缺失'
  const type = String(entry.node.type ?? '')
  if (!(MIHOMO_NODE_TYPES as readonly string[]).includes(type)) return `不支持的类型 ${type.slice(0, 24) || '空'}`
  if (typeof entry.node.server !== 'string' || !entry.node.server.trim()) return '缺少服务器地址'
  const port = Number(entry.port)
  if (!Number.isSafeInteger(port) || port < 1024 || port > 65535) return '本机端口无效'
  if (range && !inPortRange(port, range)) return '本机端口不在内核端口范围内'
  if (controllerPort !== null && port === controllerPort) return '本机端口与内核控制端口冲突'
  return null
}

export type BuildMihomoConfigInput = {
  entries: readonly MihomoNodeEntry[]
  listenerAuth: MihomoListenerAuth | null
  controller: MihomoController
  /** `PROXY_KERNEL_DNS=on`: let the kernel resolve node hosts itself (works around another tool's TUN fake-IP). */
  kernelDns?: boolean
  /** When set, ports outside the range are rejected. */
  portRange?: PortRange | null
}

export type BuiltMihomoConfig = {
  config: Record<string, unknown>
  /** Entries in the order their proxies appear in `config.proxies` (mihomo errors say `proxy <index>`). */
  entries: MihomoNodeEntry[]
  rejected: MihomoRejected[]
}

export function buildMihomoConfig(input: BuildMihomoConfigInput): BuiltMihomoConfig {
  const rejected: MihomoRejected[] = []
  const accepted: MihomoNodeEntry[] = []
  const ids = new Set<string>()
  const ports = new Set<number>()
  for (const entry of input.entries) {
    const problem = entryProblem(entry, input.portRange ?? null, input.controller.port)
      ?? (ids.has(entry.id) ? '条目重复' : null)
      ?? (ports.has(Number(entry.port)) ? '本机端口重复' : null)
    if (problem) {
      rejected.push({ id: String(entry.id), reason: problem })
      continue
    }
    ids.add(entry.id)
    ports.add(Number(entry.port))
    accepted.push({ id: entry.id, port: Number(entry.port), node: entry.node })
  }
  const users = input.listenerAuth ? [{ username: input.listenerAuth.username, password: input.listenerAuth.password }] : undefined
  const config: Record<string, unknown> = {
    port: 0,
    'socks-port': 0,
    'mixed-port': 0,
    'redir-port': 0,
    'tproxy-port': 0,
    'allow-lan': false,
    'bind-address': '127.0.0.1',
    mode: 'rule',
    'log-level': 'warning',
    ipv6: false,
    'unified-delay': false,
    'find-process-mode': 'off',
    'geo-auto-update': false,
    profile: { 'store-selected': false, 'store-fake-ip': false },
    tun: { enable: false },
    dns: input.kernelDns
      ? { enable: true, listen: '', ipv6: false, 'enhanced-mode': 'normal', nameserver: ['223.5.5.5', '1.1.1.1'], 'respect-rules': false }
      : { enable: false },
    'external-controller': `127.0.0.1:${input.controller.port}`,
    secret: input.controller.secret,
    proxies: accepted.map(entry => ({ ...cleanNode(entry.node), name: nodeName(entry.id) })),
    listeners: accepted.map(entry => ({
      name: listenerName(entry.id),
      type: 'socks',
      listen: '127.0.0.1',
      port: entry.port,
      proxy: nodeName(entry.id),
      udp: false,
      ...(users ? { users } : {}),
    })),
    rules: ['MATCH,DIRECT'],
  }
  return { config, entries: accepted, rejected }
}

export const renderMihomoConfig = (config: Record<string, unknown>) => `${JSON.stringify(config, null, 1)}\n`

/* ────────────────────────── error text ────────────────────────── */

const SECRET_FIELDS = new Set(['password', 'uuid', 'token', 'private-key', 'pre-shared-key', 'public-key', 'short-id', 'obfs-password', 'auth-str', 'auth', 'psk', 'username'])

/** Every secret-looking string value inside a node (recursively), for exact-match scrubbing. Transport header values (except `Host`) count as secret. */
export function nodeSecrets(node: unknown, out: string[] = [], inHeaders = false): string[] {
  if (Array.isArray(node)) {
    for (const value of node) nodeSecrets(value, out, inHeaders)
  } else if (node && typeof node === 'object') {
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      const secret = SECRET_FIELDS.has(key) || (inHeaders && !/^host$/i.test(key))
      if (secret && (typeof value === 'string' || typeof value === 'number')) out.push(String(value))
      else if (secret && Array.isArray(value)) out.push(...value.filter(item => typeof item === 'string'))
      else if (value && typeof value === 'object') nodeSecrets(value, out, /^headers$/i.test(key))
    }
  } else if (inHeaders && typeof node === 'string') {
    out.push(node)
  }
  return out
}

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * Masks what a mihomo message may carry: URL userinfo, uuids, known secret values (node passwords, listener and controller
 * credentials), server hosts (IPv4, bracketed IPv6, domain names) and config paths. Ports and mihomo's own words stay.
 */
export function scrubMihomoText(text: unknown, secrets: readonly string[] = []): string {
  let out = String(text ?? '')
  const known = [...new Set(secrets.map(String).filter(value => value.length >= 3))].sort((a, b) => b.length - a.length)
  for (const secret of known) out = out.replace(new RegExp(escapeRegExp(secret), 'g'), '***')
  return out
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@"']*@/gi, '$1***@')
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '***')
    .replace(/(?:\/[^\s"':]+)+\.(?:ya?ml|json|pem|key|sock|db)\b/gi, '<file>')
    .replace(/\[[0-9a-f:.]+\]/gi, '***')
    .replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, '***')
    .replace(/\b(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{1,62}\b/gi, '***')
    .slice(0, 300)
}

/** `msg="..."` values of error/fatal lines in mihomo output (`-t` stdout or the log), oldest first. */
export function mihomoErrorMessages(output: string): string[] {
  const messages: string[] = []
  for (const line of String(output).split(/\r?\n/)) {
    if (!/level=(error|fatal)/.test(line)) continue
    const match = /msg="((?:[^"\\]|\\.)*)"/.exec(line)
    if (match) messages.push(match[1].replace(/\\(.)/g, '$1'))
  }
  return messages
}

export type MappedMihomoError = { index: number | null; entryId: string | null; reason: string }

/** Maps `proxy <i>: …` to the entry at that position and scrubs the rest; never echoes the raw message. */
export function mapMihomoError(message: string, entries: readonly MihomoNodeEntry[], secrets: readonly string[] = []): MappedMihomoError {
  const match = /^proxy (\d+):\s*(.*)$/s.exec(message.trim())
  const index = match ? Number(match[1]) : null
  const entry = index !== null ? entries[index] : undefined
  const raw = match ? match[2] : message
  const allSecrets = [...secrets, ...(entry ? nodeSecrets(entry.node) : [])]
  const reason = scrubMihomoText(raw, allSecrets).trim() || '配置无效'
  return { index: entry ? index : null, entryId: entry?.id ?? null, reason }
}

import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import http from 'node:http'
import https from 'node:https'
import { createHash, randomBytes } from 'node:crypto'
import { spawn } from 'node:child_process'
import { pipeline, Transform } from 'node:stream'

export const upstreamRevision = JSON.parse(await fs.readFile(new URL('./upstream/api.json', import.meta.url), 'utf8')).revision
export const defaultRuntime = path.join(os.homedir(), '.agents/crosery/magpie')
const accountIDs = ['antigravity', 'claude', 'codex', 'commandcode-plan', 'copilot', 'cursor',
  'devin', 'dimagent', 'factory', 'gemini', 'grok', 'kiro', 'mimo', 'qoder', 'workbuddy',
  'workbuddy-ai', 'zcode', 'zed']
const providerFields = ['id', 'name', 'was', 'icon', 'models', 'unlisted', 'off', 'hidden',
  'quiet', 'routing', 'affinity', 'fallback', 'contexts', 'family', 'keyName', 'keyProtocol',
  'catalog']
const settingsFields = ['theme', 'lang', 'tray', 'currency', 'textSize', 'window', 'agentOrder',
  'agentsHidden', 'agentsShown', 'visible', 'modelNames', 'modelEfforts', 'modelImages',
  'vision', 'imageGen', 'quotaLeft']
const snapshots = ['profiles.json', 'usage.jsonl', 'quotas.json']
const hopHeaders = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade', 'host', 'authorization', 'x-api-key',
  'x-goog-api-key', 'cookie', 'set-cookie', 'origin', 'referer'])

async function exists(filename) {
  try { await fs.access(filename); return true } catch (error) {
    if (error.code === 'ENOENT') return false
    throw error
  }
}

async function readJSON(filename, fallback) {
  try { return JSON.parse(await fs.readFile(filename, 'utf8')) } catch (error) {
    if (error.code === 'ENOENT' && fallback !== undefined) return fallback
    throw new Error(`Cannot read valid JSON: ${path.basename(filename)}`)
  }
}

const pick = (object, fields) => Object.fromEntries(fields.filter(k => k in object).map(k => [k, object[k]]))
const digest = buffer => createHash('sha256').update(buffer).digest('hex')

export function endpoint(raw) {
  const url = new URL(raw)
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('Endpoint must be HTTP(S), without credentials, query or fragment')
  }
  if (url.protocol === 'http:' && !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) {
    throw new Error('Unencrypted upstreams must be loopback')
  }
  return url.href.replace(/\/+$/, '')
}

export function mapCatalog(catalog) {
  if (catalog.version !== 1 || !Array.isArray(catalog.models) || !catalog.models.length) {
    throw new Error('The shared Crosery catalog is missing or empty')
  }
  const seen = new Set()
  return catalog.models.map(model => {
    if (typeof model.id !== 'string' || !model.id || seen.has(model.id)) {
      throw new Error('Invalid or duplicate model in the shared catalog')
    }
    seen.add(model.id)
    return {
      ID: model.id, Name: model.name || model.id, Provider: 'crosery',
      Efforts: model.supportsReasoning ? (model.efforts || []).filter(e => e !== 'off') : [],
      Images: model.input?.includes('image') || false,
      ImageInput: model.input?.includes('image') || false,
      Context: model.contextWindow || 0, Output: model.maxTokens || 0,
      // Unknown endpoints stay unknown; declaring all protocols per model would force bad routes.
    }
  })
}

export function migrateProviders(source, bridgeURL, models) {
  if (!Array.isArray(source.providers)) throw new Error('Invalid source providers')
  const providers = []
  const needsSignIn = []
  const warnings = []
  for (const original of source.providers) {
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(original.id) || original.id === 'crosery') {
      throw new Error('Source provider id is invalid or conflicts with crosery')
    }
    const provider = pick(original, providerFields)
    const protocols = ['chat', 'responses', 'anthropic'].filter(p => original[p])
    if (!protocols.length) {
      providers.push({ ...provider, hidden: true, off: true })
      needsSignIn.push(original.id)
      continue
    }
    for (const protocol of protocols) {
      endpoint(original[protocol])
      provider[protocol] = `${bridgeURL}/p/${original.id}/${protocol}${protocol === 'anthropic' ? '' : '/v1'}`
    }
    provider.key = 'slot-0'
    provider.keys = (original.keys || []).map((key, i) => ({
      name: key.name, key: `slot-${i + 1}`, off: key.off, protocol: key.protocol,
    }))
    provider.proxy = 'direct'
    if (original.proxy && original.proxy !== 'direct') {
      provider.off = true
      warnings.push(`${original.id}: custom proxy needs a separate connectivity review; imported off`)
    }
    if (original.preset || original.balanceURL || original.decide || original.modelsURL) {
      warnings.push(`${original.id}: preset-specific behavior, balance, decision and custom model-list endpoints are not migrated`)
    }
    providers.push(provider)
  }
  for (const id of accountIDs) {
    if (!providers.some(p => p.id === id)) providers.push({ id, name: id, key: '', hidden: true, off: true })
  }
  providers.push({
    id: 'crosery', name: 'Crosery CPA', key: 'slot-0', proxy: 'direct', catalog: 'crosery',
    chat: `${bridgeURL}/p/crosery/chat/v1`, responses: `${bridgeURL}/p/crosery/responses/v1`,
    anthropic: `${bridgeURL}/p/crosery/anthropic`, modelsURL: `${bridgeURL}/models`,
    models: models.map(m => m.ID), contexts: Object.fromEntries(models.filter(m => m.Context).map(m => [m.ID, m.Context])),
  })
  return { file: { providers, groups: source.groups || [] }, needsSignIn, warnings }
}

export async function prepare({
  runtime = defaultRuntime,
  source = path.join(os.homedir(), '.config/magpie'),
  catalogPath = path.join(os.homedir(), '.agents/crosery/catalog.json'),
  bridgePort = 3467, gatewayPort = 3465, webPort = 3466,
} = {}) {
  runtime = path.resolve(runtime)
  source = path.resolve(source)
  if ([bridgePort, gatewayPort, webPort].some(p => !Number.isInteger(p) || p < 1024 || p > 65535) ||
      new Set([bridgePort, gatewayPort, webPort]).size !== 3) throw new Error('Need three distinct unprivileged ports')
  if (await exists(runtime)) throw new Error('Runtime already exists; refusing to overwrite a migration')
  const catalog = await readJSON(catalogPath)
  const models = mapCatalog(catalog)
  const upstreamChat = endpoint(catalog.baseUrl)
  if (!upstreamChat.endsWith('/v1')) throw new Error('The Crosery catalog base URL must end in /v1')
  const sourceProviders = await readJSON(path.join(source, 'providers.json'), { providers: [] })
  const bridgeURL = `http://127.0.0.1:${bridgePort}`
  const migrated = migrateProviders(sourceProviders, bridgeURL, models)
  const settings = {
    ...pick(await readJSON(path.join(source, 'settings.json'), {}), settingsFields),
    lan: false, noStats: true, codexWarmup: '', claudeWarmup: '', workbuddyCheckin: false,
  }
  const home = path.join(runtime, 'home')
  const config = path.join(home, '.config/magpie')
  const cache = path.join(home, '.cache/magpie')
  const manifest = {
    version: 1, upstreamRevision, source, catalogPath: path.resolve(catalogPath),
    upstreamChat, upstreamAnthropic: upstreamChat.slice(0, -3), bridgePort, gatewayPort, webPort,
    createdAt: new Date().toISOString(), models: models.length,
    migratedProviders: sourceProviders.providers.length, needsSignIn: migrated.needsSignIn,
    warnings: migrated.warnings, snapshots: [],
  }
  await fs.mkdir(path.dirname(runtime), { recursive: true, mode: 0o700 })
  await fs.mkdir(runtime, { mode: 0o700 })
  try {
    for (const dir of [config, path.join(cache, 'models'), path.join(runtime, 'bin')]) {
      await fs.mkdir(dir, { recursive: true, mode: 0o700 })
    }
    const write = (file, data) => fs.writeFile(file, JSON.stringify(data, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
    await write(path.join(config, 'providers.json'), migrated.file)
    await write(path.join(config, 'settings.json'), settings)
    await write(path.join(cache, 'models/crosery.json'), {
      fetched: new Date(catalog.generatedAt || Date.now()).toISOString(), base: `${bridgeURL}/p/crosery/chat/v1`, models,
    })
    // A private models.dev-shaped cache keeps audited effort/context metadata in Magpie.
    await write(path.join(cache, 'models.json'), {
      crosery: { id: 'crosery', name: 'Crosery CPA', models: Object.fromEntries(catalog.models.map(m => [m.id, {
        id: m.id, name: m.name || m.id, modalities: { input: m.input || ['text'], output: ['text'] },
        reasoning_options: m.supportsReasoning ? [{ type: 'effort', values: (m.efforts || []).filter(e => e !== 'off') }] : [],
        limit: { context: m.contextWindow || 0, input: m.contextWindow || 0, output: m.maxTokens || 0 },
      }])) },
    })
    for (const name of snapshots) {
      const original = path.join(source, name)
      if (!await exists(original)) continue
      const stat = await fs.lstat(original)
      if (!stat.isFile() || stat.size > 64 * 1024 * 1024) {
        manifest.warnings.push(`${name}: not a regular file or exceeds the 64 MiB rehearsal limit; not copied`)
        continue
      }
      const buffer = await fs.readFile(original)
      // Profile formats can contain agent environment values; only explicitly secret-free snapshots are accepted.
      if (/sk-[a-z0-9_-]{12,}|bearer\s+\S+|"(?:[^"]*(?:api.?key|auth.?token|access.?token|refresh.?token|secret|password|authorization)|library)"\s*:/i.test(buffer.toString())) {
        manifest.warnings.push(`${name}: potentially sensitive content; not copied`)
        continue
      }
      if (name.endsWith('.json')) JSON.parse(buffer.toString())
      await fs.writeFile(path.join(config, name), buffer, { flag: 'wx', mode: 0o600 })
      manifest.snapshots.push({ name, bytes: buffer.length, sha256: digest(buffer) })
    }
    // The library can contain MCP secrets or absolute agent paths. Preserve the original, not a live copy.
    if (await exists(path.join(source, 'library.json'))) {
      manifest.warnings.push('library.json: left in the original instance; no instructions/MCP/skills are applied to agents')
    }
    await write(path.join(runtime, 'manifest.json'), manifest)
  } catch (error) {
    // A failed preparation is retained for inspection; never delete or overwrite user data.
    throw new Error(`Preparation incomplete; inspect the new runtime. ${error.message}`)
  }
  return manifest
}

export async function verifySnapshots(runtime) {
  const manifest = await readJSON(path.join(runtime, 'manifest.json'))
  const results = []
  for (const snapshot of manifest.snapshots) {
    const original = await fs.readFile(path.join(manifest.source, snapshot.name))
    const copy = await fs.readFile(path.join(runtime, 'home/.config/magpie', snapshot.name))
    results.push({ name: snapshot.name, originalUnchanged: digest(original) === snapshot.sha256,
      copyUnchanged: digest(copy) === snapshot.sha256 })
  }
  return results
}

export async function runtimeProviders(manifest, env = process.env) {
  const sourceFile = path.join(manifest.source, 'providers.json')
  if (await exists(sourceFile)) {
    const stat = await fs.lstat(sourceFile)
    if (!stat.isFile() || (stat.mode & 0o077)) throw new Error('Original providers must be a private regular file')
  }
  const source = await readJSON(sourceFile, { providers: [] })
  const providers = new Map(source.providers.map(p => [p.id, p]))
  let key = env.CROSERY_API_KEY
  if (!key) {
    const filename = env.CROSERY_API_KEY_FILE || path.join(os.homedir(), '.agents/crosery/credentials/CROSERY_API_KEY')
    const stat = await fs.lstat(filename)
    if (!stat.isFile() || stat.size > 16384 || (stat.mode & 0o077)) throw new Error('Crosery key must be a private regular file')
    key = (await fs.readFile(filename, 'utf8')).trim()
  }
  if (!key || /[\r\n]/.test(key)) throw new Error('Missing or invalid CROSERY_API_KEY')
  providers.set('crosery', {
    id: 'crosery', key, chat: endpoint(manifest.upstreamChat), responses: endpoint(manifest.upstreamChat),
    anthropic: endpoint(manifest.upstreamAnthropic),
  })
  return providers
}

function reply(res, status, code) {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
  res.end(JSON.stringify({ error: { type: 'local_bridge_error', code, message: code } }))
}

function filteredHeaders(headers) {
  const connection = String(headers.connection || '').toLowerCase().split(',').map(x => x.trim())
  return Object.fromEntries(Object.entries(headers).filter(([key]) =>
    !hopHeaders.has(key.toLowerCase()) && !connection.includes(key.toLowerCase()) && !key.startsWith('sec-')))
}

export function createBridge({ providers, models, port = 3467, webPort = 3466, webKey,
  timeoutMs = 600_000, maxBytes = 64 * 1024 * 1024 }) {
  return http.createServer((req, res) => {
    // Not a browser-accessible CORS proxy or a DNS-rebinding target.
    if (req.headers.host !== `127.0.0.1:${port}` || req.headers.origin ||
        req.headers['sec-fetch-site'] === 'cross-site') return reply(res, 403, 'local_only')
    const url = new URL(req.url, `http://127.0.0.1:${port}`)
    if (url.search) return reply(res, 400, 'query_not_allowed')
    if (req.method === 'GET' && url.pathname === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' })
      return res.end(JSON.stringify({ ok: true, models: models.length, providers: providers.size }))
    }
    if (req.method === 'GET' && url.pathname === '/open' && webKey) {
      res.writeHead(303, { location: `http://127.0.0.1:${webPort}/?k=${webKey}`, 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' })
      return res.end()
    }
    if (req.method === 'GET' && url.pathname === '/models') {
      res.writeHead(200, { 'content-type': 'application/json' })
      return res.end(JSON.stringify({ object: 'list', data: models.map(m => ({
        id: m.ID, object: 'model', owned_by: 'crosery', display_name: m.Name,
        context_length: m.Context, modalities: { input: m.Images ? ['text', 'image'] : ['text'] },
      })) }))
    }
    const match = /^\/p\/([a-z0-9-]+)\/(chat|responses|anthropic)(\/.*)$/.exec(url.pathname)
    if (!match || req.method !== 'POST') return reply(res, 404, 'route_not_found')
    const [, id, protocol, suffix] = match
    const allowed = {
      chat: ['/v1/chat/completions', '/v1/images/generations', '/v1/images/edits'],
      responses: ['/v1/responses'],
      anthropic: ['/v1/messages', '/v1/messages/count_tokens'],
    }
    const provider = providers.get(id)
    if (!provider || provider.off || !provider[protocol] || !allowed[protocol].includes(suffix)) {
      return reply(res, 404, 'route_not_found')
    }
    const slot = /^slot-(\d+)$/.exec(String(req.headers.authorization || '').replace(/^Bearer /i, '') ||
      String(req.headers['x-api-key'] || ''))
    const selected = slot && (Number(slot[1]) === 0
      ? { key: provider.key, protocol: provider.keyProtocol } : provider.keys?.[Number(slot[1]) - 1])
    if (!selected || selected.off || (selected.protocol && selected.protocol !== protocol)) {
      return reply(res, 401, 'invalid_key_slot')
    }
    let target
    try {
      target = new URL(endpoint(provider[protocol]) + (protocol === 'anthropic' ? suffix : suffix.slice(3)))
    } catch { return reply(res, 502, 'invalid_upstream') }
    const headers = filteredHeaders(req.headers)
    if (selected.key) {
      if (protocol === 'anthropic') {
        headers['x-api-key'] = selected.key
        headers['anthropic-version'] ||= '2023-06-01'
      } else headers.authorization = `Bearer ${selected.key}`
    }
    for (const [name, value] of Object.entries(provider.headers || {})) {
      const key = name.toLowerCase()
      if (!['host', 'cookie', 'connection', 'content-length', 'transfer-encoding'].includes(key)) headers[key] = value
    }
    if (Number(req.headers['content-length']) > maxBytes) return reply(res, 413, 'body_too_large')
    const upstream = (target.protocol === 'https:' ? https : http).request(target, { method: 'POST', headers }, response => {
      res.writeHead(response.statusCode, filteredHeaders(response.headers))
      pipeline(response, res, () => {})
    })
    const timer = setTimeout(() => upstream.destroy(new Error('timeout')), timeoutMs)
    timer.unref()
    res.once('close', () => { clearTimeout(timer); upstream.destroy() })
    upstream.once('error', () => {
      clearTimeout(timer)
      if (!res.headersSent) reply(res, 502, 'upstream_unavailable')
      else res.destroy()
    })
    let bytes = 0
    const limit = new Transform({
      transform(chunk, _encoding, callback) {
        bytes += chunk.length
        callback(bytes > maxBytes ? new Error('body_too_large') : null, chunk)
      },
    })
    limit.once('error', () => {
      if (!res.headersSent) reply(res, 413, 'body_too_large')
      upstream.destroy()
    })
    req.pipe(limit).pipe(upstream)
    req.once('aborted', () => upstream.destroy())
  })
}

export function childEnvironment(runtime, manifest, webKey) {
  // Allowlist avoids inheriting agent config-dir overrides or credentials into the child.
  const env = Object.fromEntries(['PATH', 'LANG', 'LC_ALL', 'TMPDIR', 'TERM'].filter(k => process.env[k]).map(k => [k, process.env[k]]))
  const home = path.join(runtime, 'home')
  return {
    ...env, HOME: home, XDG_CONFIG_HOME: path.join(home, '.config'), XDG_CACHE_HOME: path.join(home, '.cache'),
    XDG_DATA_HOME: path.join(home, '.local/share'), MAGPIE_ADDR: `127.0.0.1:${manifest.gatewayPort}`,
    MAGPIE_WEB_KEY: webKey, MAGPIE_NO_STATS: '1', DO_NOT_TRACK: '1',
  }
}

export async function start(runtime = defaultRuntime) {
  const manifest = await readJSON(path.join(runtime, 'manifest.json'))
  const models = (await readJSON(path.join(runtime, 'home/.cache/magpie/models/crosery.json'))).models
  const providers = await runtimeProviders(manifest)
  const webKey = randomBytes(32).toString('hex')
  const server = createBridge({ providers, models, port: manifest.bridgePort, webPort: manifest.webPort, webKey })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(manifest.bridgePort, '127.0.0.1', resolve)
  })
  const child = spawn(path.join(runtime, 'bin/magpie'),
    ['web', '--addr', `127.0.0.1:${manifest.webPort}`, '--no-open'],
    { env: childEnvironment(runtime, manifest, webKey), cwd: path.join(runtime, 'home'), stdio: ['ignore', 'pipe', 'pipe'] })
  child.stdout.on('data', () => {}) // Upstream prints the admin key; do not retain it.
  child.stderr.on('data', () => {}) // Upstream errors may contain private endpoint/header values.
  const stop = () => child.kill('SIGTERM')
  process.once('SIGTERM', stop)
  process.once('SIGINT', stop)
  child.once('error', () => { server.close(); console.error('Magpie failed to start; build the pinned binary first'); process.exitCode = 1 })
  child.once('exit', code => {
    server.closeAllConnections()
    server.close()
    process.exitCode = code || 0
  })
  console.log(JSON.stringify({
    gateway: `http://127.0.0.1:${manifest.gatewayPort}`,
    web: `http://127.0.0.1:${manifest.bridgePort}/open`,
    models: models.length, revision: manifest.upstreamRevision,
    note: 'Loopback only. Original Magpie, agent configs and CPA accounting are unchanged.',
  }))
}

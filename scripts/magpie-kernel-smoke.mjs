#!/usr/bin/env node
// Standalone smoke of a console kernel binary: temp HOME + temp socket, never the running kernel's.
// Usage: node scripts/magpie-kernel-smoke.mjs --binary <path> [--revision <sha40>] [--login-agents a,b] [--json]
// Checks: health (engine, revision, capabilities incl. accounts/settings/account-proxy, keychain:false, deny-list,
// login agents), a denied host-exec sign-in, settings round-trip, accounts + rtk reads, inference accounting guard,
// unknown control route → 404, clean shutdown. Exit 0 = all passed.
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { request } from 'node:http'
import { fileURLToPath } from 'node:url'

export const REQUIRED_CAPABILITIES = ['providers', 'rtk', 'signin', 'accounts', 'usage', 'codex-reset', 'settings', 'account-proxy']
/** host-exec agents the kernel keeps off by default (deploy/magpie/kernel/hostguard.go) */
export const DENIED_AGENTS = ['cursor', 'devin', 'grok']

/** One HTTP request over a unix socket; resolves { status, body } (body parsed when JSON). */
export function socketJSON(socket, route, { method = 'GET', body, headers = {}, timeoutMs = 10_000 } = {}) {
  return new Promise((resolve, reject) => {
    const req = request({ socketPath: socket, path: route, method, headers: { 'content-type': 'application/json', ...headers }, timeout: timeoutMs }, res => {
      const chunks = []
      let size = 0
      res.on('data', chunk => {
        size += chunk.length
        if (size > 4 * 1024 * 1024) req.destroy(new Error('kernel response too large'))
        else chunks.push(chunk)
      })
      res.once('end', () => {
        const text = Buffer.concat(chunks).toString('utf8')
        let parsed = null
        try { parsed = text ? JSON.parse(text) : null } catch { parsed = text }
        resolve({ status: res.statusCode || 0, body: parsed })
      })
      res.once('error', reject)
    })
    req.once('timeout', () => req.destroy(new Error('kernel request timeout')))
    req.once('error', reject)
    req.end(body === undefined ? undefined : JSON.stringify(body))
  })
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

export async function smokeKernel({ binary, revision = null, loginAgents = null, readyMs = 15_000 }) {
  const checks = []
  const check = (name, ok, detail = '') => { checks.push({ name, ok: Boolean(ok), ...(detail ? { detail: String(detail).slice(0, 300) } : {}) }); return ok }
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mks-'))
  const home = path.join(dir, 'home')
  const socket = path.join(dir, 'k.sock')
  await fs.mkdir(home, { mode: 0o700 })
  const kernel = spawn(binary, [], {
    cwd: home, stdio: ['ignore', 'ignore', 'pipe'],
    env: {
      PATH: '/usr/bin:/bin', HOME: home, XDG_CONFIG_HOME: path.join(home, '.config'), XDG_CACHE_HOME: path.join(home, '.cache'),
      MAGPIE_KERNEL_SOCKET: socket, MAGPIE_NO_STATS: '1', DO_NOT_TRACK: '1', LANG: 'C',
    },
  })
  let stderr = ''
  kernel.stderr.on('data', chunk => { if (stderr.length < 4000) stderr += chunk })
  let exited = null
  kernel.once('exit', code => { exited = code ?? -1 })
  try {
    let health = null
    const deadline = Date.now() + readyMs
    while (Date.now() < deadline && exited === null) {
      try { health = await socketJSON(socket, '/internal/health', { timeoutMs: 2_000 }); if (health.status === 200) break } catch { /* not listening yet */ }
      await sleep(100)
    }
    if (!check('starts and answers /internal/health', health?.status === 200, exited !== null ? `exited ${exited}: ${stderr.trim().split('\n').pop() || ''}` : health ? `HTTP ${health.status}` : 'no answer')) {
      return { ok: false, checks }
    }
    const h = health.body || {}
    check('engine is magpie and ok', h.ok === true && h.engine === 'magpie')
    if (revision) check('revision is the candidate', h.revision === revision, `got ${h.revision}`)
    const capabilities = Array.isArray(h.capabilities) ? h.capabilities : []
    const missing = REQUIRED_CAPABILITIES.filter(name => !capabilities.includes(name))
    check('capabilities incl. accounts/settings/account-proxy', missing.length === 0, missing.length ? `missing ${missing.join(',')}` : '')
    check('keychain is off', h.keychain === false, `keychain=${h.keychain}`)
    const deny = Array.isArray(h.signinDeny) ? h.signinDeny : []
    check('host-exec sign-ins are denied by default', DENIED_AGENTS.every(agent => deny.includes(agent)), `signinDeny=${deny.join(',')}`)
    if (loginAgents) {
      const got = Array.isArray(h.loginAgents) ? [...h.loginAgents].sort() : []
      check('login agents match the contract', JSON.stringify(got) === JSON.stringify([...loginAgents].sort()), `got ${got.join(',')}`)
    }
    const agents = Array.isArray(h.loginAgents) ? h.loginAgents : []
    const denied = DENIED_AGENTS.find(agent => agents.includes(agent))
    if (denied) {
      const reply = await socketJSON(socket, '/internal/signin', { method: 'POST', body: { agent: denied } })
      check(`deny-list refuses ${denied} before anything runs`, reply.status === 400 && reply.body?.code === 'agent_disabled', `HTTP ${reply.status} ${reply.body?.code ?? ''}`)
    }
    const unknownAgent = await socketJSON(socket, '/internal/signin', { method: 'POST', body: { agent: 'not-an-agent' } })
    check('an unknown sign-in agent is refused', unknownAgent.status === 400 && unknownAgent.body?.code === 'agent_unknown', `HTTP ${unknownAgent.status}`)

    const before = await socketJSON(socket, '/internal/settings')
    if (check('settings read', before.status === 200 && typeof before.body?.redact === 'boolean', `HTTP ${before.status}`)) {
      const flipped = !before.body.redact
      const write = await socketJSON(socket, '/internal/settings', { method: 'POST', body: { redact: flipped } })
      const after = await socketJSON(socket, '/internal/settings')
      const restore = await socketJSON(socket, '/internal/settings', { method: 'POST', body: { redact: before.body.redact } })
      const final = await socketJSON(socket, '/internal/settings')
      check('settings round-trip (write, read back, restore)', write.status < 300 && after.body?.redact === flipped && restore.status < 300 && final.body?.redact === before.body.redact,
        `write ${write.status} → ${after.body?.redact}, restore ${restore.status} → ${final.body?.redact}`)
    }
    const accounts = await socketJSON(socket, '/internal/accounts')
    check('accounts list reads', accounts.status === 200 && Array.isArray(accounts.body?.agents), `HTTP ${accounts.status}`)
    const rtk = await socketJSON(socket, '/internal/rtk')
    check('rtk view reads', rtk.status === 200, `HTTP ${rtk.status}`)
    const inference = await socketJSON(socket, '/v1/chat/completions', { method: 'POST', body: {} })
    check('inference requires a request id (accounting guard)', inference.status === 400 && inference.body?.code === 'request_id_required', `HTTP ${inference.status}`)
    const unknownGet = await socketJSON(socket, '/internal/no-such-route')
    const unknownPost = await socketJSON(socket, '/internal/no-such-route', { method: 'POST', body: {} })
    check('unknown control route is 404', unknownGet.status === 404 && unknownPost.status === 404 && unknownGet.body?.code === 'not_found', `GET ${unknownGet.status} POST ${unknownPost.status}`)
  } catch (error) {
    check('smoke ran to the end', false, error?.message || error)
  } finally {
    if (exited === null) {
      kernel.kill('SIGTERM')
      const stopBy = Date.now() + 6_000
      while (exited === null && Date.now() < stopBy) await sleep(50)
      check('stops on SIGTERM', exited !== null)
      if (exited === null) kernel.kill('SIGKILL')
    }
    await fs.rm(dir, { recursive: true, force: true })
  }
  return { ok: checks.every(item => item.ok), checks }
}

async function main() {
  const arg = name => { const at = process.argv.indexOf(name); return at < 0 ? undefined : process.argv[at + 1] }
  const binary = arg('--binary')
  if (!binary) throw new Error('Pass --binary <kernel binary>')
  const agents = arg('--login-agents')
  const result = await smokeKernel({ binary: path.resolve(binary), revision: arg('--revision') || null, loginAgents: agents ? agents.split(',').filter(Boolean) : null })
  if (process.argv.includes('--json')) console.log(JSON.stringify(result))
  else for (const item of result.checks) console.log(`${item.ok ? 'ok  ' : 'FAIL'} ${item.name}${item.detail ? ` · ${item.detail}` : ''}`)
  if (!result.ok) process.exitCode = 1
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 2 })
}

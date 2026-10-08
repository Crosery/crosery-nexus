#!/usr/bin/env node
/**
 * Keep the relay's standby Magpie kernel on the revision this Mac's own pipeline proved.
 *
 *   node scripts/magpie-standby.mjs publish [--dry-run]
 *
 * The Mac's Magpie pipeline (magpie-upstream.mjs check → magpie-autoupdate.mjs rehearse/apply) is the one that follows
 * upstream; the relay never rehearses Magpie. This publishes the revision the local kernel runs now (the baseline or
 * the auto-applied candidate, both rehearsed here): build it for linux/amd64 with the same overlay, upload it through
 * the relay's restricted gate (magpie-standby-gate.sh) and report. The relay (scripts/kernel-applier.mjs) verifies the
 * sha256, boots it once in the console's sandbox and only then makes it the standby. It serves no traffic.
 *
 * MAGPIE_STANDBY_SSH is the ssh argument list for the relay with the gate's key (only in the launchd job's environment,
 * never in the repo), e.g. "-i <key file> -o BatchMode=yes <ssh alias>"; unset = do nothing.
 */
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { execFile, spawn } from 'node:child_process'
import { createGzip } from 'node:zlib'
import { createReadStream, realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { autoPaths, readJSON, runningRevision, sha256File } from './magpie-autoupdate.mjs'
import { withUpstreamLock, candidateCheckout } from './magpie-upstream.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SHA = /^[a-f0-9]{40}$/

function sshArgs(env = process.env) {
  const raw = (env.MAGPIE_STANDBY_SSH || '').trim()
  return raw ? raw.split(/\s+/).map(part => part.replace(/^~(?=\/)/, os.homedir())) : null
}

/** Run one gate command; `input` is a stream (upload) or a string (report). */
function gate(args, command, input) {
  return new Promise((resolve, reject) => {
    const child = spawn('ssh', [...args, command], { stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', chunk => { stdout += chunk })
    child.stderr.on('data', chunk => { stderr += chunk })
    child.once('error', reject)
    child.once('close', code => (code === 0 ? resolve(stdout) : reject(new Error(`${command}: ${(stderr || stdout).trim().slice(0, 200) || `exit ${code}`}`))))
    if (input && typeof input.pipe === 'function') input.pipe(child.stdin)
    else child.stdin.end(input ?? '')
  })
}

/** build-magpie-kernel.mjs with only `go build` cross-compiling (its contract checks `go run` natively). */
async function buildLinux({ source, candidate, out }) {
  const real = await new Promise((resolve, reject) => execFile('/bin/sh', ['-c', 'command -v go'], (error, stdout) => (error ? reject(new Error('go not found')) : resolve(stdout.trim()))))
  const wrapDir = await fs.mkdtemp(path.join(os.tmpdir(), 'magpie-standby-go-'))
  try {
    await fs.writeFile(path.join(wrapDir, 'go'), `#!/bin/sh\nif [ "$1" = build ]; then GOOS=linux GOARCH=amd64 exec ${JSON.stringify(real)} "$@"; fi\nexec ${JSON.stringify(real)} "$@"\n`, { mode: 0o755 })
    const args = [path.join(root, 'scripts/build-magpie-kernel.mjs'), '--source', source, '--out', out, ...(candidate ? ['--candidate', candidate] : [])]
    await new Promise((resolve, reject) => execFile(process.execPath, args, { env: { ...process.env, PATH: `${wrapDir}:${process.env.PATH}` }, maxBuffer: 16 * 1024 * 1024, timeout: 20 * 60_000 },
      (error, stdout, stderr) => (error ? reject(new Error(`build: ${String(stderr || error.message).trim().split('\n').pop()?.slice(0, 200)}`)) : resolve(stdout))))
  } finally {
    await fs.rm(wrapDir, { recursive: true, force: true })
  }
  const binary = path.join(out, 'magpie-kernel')
  const head = Buffer.alloc(20)
  const handle = await fs.open(binary)
  try { await handle.read(head, 0, 20, 0) } finally { await handle.close() }
  // ELF, 64-bit, little endian, e_machine x86-64 (0x3e)
  if (head.readUInt32BE(0) !== 0x7f454c46 || head[4] !== 2 || head.readUInt16LE(18) !== 0x3e) throw new Error('build did not produce a linux/amd64 binary')
  return binary
}

export async function publish({ dryRun = false, env = process.env, paths = autoPaths() } = {}) {
  const ssh = sshArgs(env)
  if (!ssh) return { action: 'none', why: 'not-configured' }
  const running = await runningRevision(paths)
  if (!running) return { action: 'none', why: 'kernel-offline' }
  const baseline = JSON.parse(await fs.readFile(path.join(root, 'deploy/magpie/upstream/api.json'), 'utf8')).revision
  const status = await readJSON(paths.status)
  const upstream = { upstreamLatest: typeof status?.latestRelease === 'string' ? status.latestRelease : null, upstreamRevision: SHA.test(status?.candidateRevision ?? '') ? status.candidateRevision : null }
  const relay = JSON.parse(await gate(ssh, 'magpie-state').catch(() => '{}') || '{}')
  const report = extra => ({ version: 1, kernel: 'magpie', checkedAt: new Date().toISOString(), ...upstream, ...extra })
  if (relay.installed?.revision === running || relay.staged?.revision === running) {
    if (!dryRun) await gate(ssh, 'magpie-report', JSON.stringify(report({ status: 'up-to-date', candidate: relay.builder?.candidate ?? null })))
    return { action: 'none', why: 'up-to-date', revision: running }
  }
  // a non-baseline revision builds against its own contract; that needs the candidate artifacts the check left
  let candidate = null
  if (running !== baseline) {
    const artifact = status?.candidateRevision === running && typeof status.artifact === 'string' ? path.join(paths.runtime, status.artifact) : null
    if (!artifact || !(await readJSON(path.join(artifact, 'api.json')))) {
      if (!dryRun) await gate(ssh, 'magpie-report', JSON.stringify(report({ status: 'held', candidate: null, reasons: [{ code: 'artifacts', text: `本机运行的 ${running.slice(0, 7)} 没有候选契约可用来构建 Linux 版，等下一次检查` }] })))
      return { action: 'none', why: 'no-artifacts', revision: running }
    }
    candidate = artifact
  }
  if (dryRun) return { action: 'publish', revision: running, candidate: Boolean(candidate) }
  const out = await fs.mkdtemp(path.join(os.tmpdir(), 'magpie-standby-'))
  try {
    const binary = await withUpstreamLock(paths.runtime, async () => buildLinux({ source: await candidateCheckout(running), candidate, out }))
    const sha256 = await sha256File(binary)
    await gate(ssh, `magpie-upload ${running}`, createReadStream(binary).pipe(createGzip()))
    await gate(ssh, 'magpie-report', JSON.stringify(report({
      status: 'built',
      candidate: { revision: running, sha256, release: running === baseline ? null : upstream.upstreamLatest, checks: [{ name: 'mac-rehearsal', ok: true }, { name: 'linux-build', ok: true }] },
    })))
    return { action: 'publish', revision: running, sha256 }
  } catch (error) {
    await gate(ssh, 'magpie-report', JSON.stringify(report({ status: 'build-failed', candidate: null, reasons: [{ code: 'build', text: `Linux 版构建或上传没成功：${String(error.message).slice(0, 200)}` }] }))).catch(() => undefined)
    throw error
  } finally {
    await fs.rm(out, { recursive: true, force: true })
  }
}

// realpath: systemd runs it through /opt/crosery-api-console-current (a symlink); import.meta.url is the resolved file
if (process.argv[1] && realpathSync(path.resolve(process.argv[1])) === fileURLToPath(import.meta.url)) {
  if (process.argv[2] !== 'publish') { console.error('Use publish [--dry-run]'); process.exit(2) }
  publish({ dryRun: process.argv.includes('--dry-run') })
    .then(result => console.log(JSON.stringify(result, null, 2)))
    .catch(error => { console.error(error.message); process.exitCode = 1 })
}

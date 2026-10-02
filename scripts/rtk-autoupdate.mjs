#!/usr/bin/env node
/**
 * Safe auto-upgrade of the local `rtk` binary.
 *
 *   node scripts/rtk-autoupdate.mjs status                       install method, versions, last result (no network)
 *   node scripts/rtk-autoupdate.mjs plan                         dry-run: resolve, download and verify into a temp dir; no swap
 *   node scripts/rtk-autoupdate.mjs upgrade --confirm [--accept-breaking]   manual upgrade now
 *   node scripts/rtk-autoupdate.mjs auto                         what the scheduled job runs (config, once per release, backoff)
 *
 * The latest tag comes from the upstream check's status.json (no extra polling). Release details are one GitHub API
 * request per new tag (cached with its ETag); the archive and checksums.txt come from the release download host.
 * The archive must match the published sha256 (checksums.txt and/or the API digest; neither published → refuse; a
 * published signature this script cannot verify → refuse). The extracted binary must report the release's version
 * before the swap: backup → atomic rename → `rtk --version` → otherwise restore the backup. A Homebrew install is
 * upgraded with `brew upgrade rtk` instead. A release range that declares BREAKING CHANGES is held for review.
 */
import fs from 'node:fs/promises'
import { constants as fsConstants } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash, randomBytes } from 'node:crypto'
import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { nextAttemptDelay, rateLimitDelay, upstreamRuntime } from './magpie-upstream.mjs'
import { compareVersions, normalizeConfig } from './magpie-autoupdate-policy.mjs'

export const RELEASES_API = 'https://api.github.com/repos/rtk-ai/rtk/releases?per_page=30'
export const DOWNLOAD_HOSTS = ['github.com', 'objects.githubusercontent.com', 'release-assets.githubusercontent.com']
const MAX_ASSET_BYTES = 64 * 1024 * 1024
const MAX_API_BYTES = 4 * 1024 * 1024
const KEEP_BACKUPS = 3
const SIGNATURE = /\.(sig|asc|minisig|sigstore|sigstore\.json|pem|bundle)$/i
const iso = ms => new Date(ms).toISOString()
const json = value => `${JSON.stringify(value, null, 2)}\n`

export function rtkPaths(runtime = upstreamRuntime) {
  return {
    runtime, config: path.join(runtime, 'autoupdate.json'), status: path.join(runtime, 'status.json'),
    state: path.join(runtime, 'autoupdate-rtk.json'), cache: path.join(runtime, 'rtk-releases.json'),
    backups: path.join(runtime, 'rtk-backups'), lock: path.join(runtime, 'rtk-upgrade.lock'),
  }
}

async function readJSON(file) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')) } catch { return null }
}

async function writeAtomic(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 })
  const temporary = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
  await fs.writeFile(temporary, json(value), { flag: 'wx', mode: 0o600 })
  try { await fs.rename(temporary, file) } finally { await fs.rm(temporary, { force: true }) }
}

const sha256 = buffer => createHash('sha256').update(buffer).digest('hex')

/** `rtk --version` → `0.50.0`; null when it does not run or says something else. */
export function runVersion(binary) {
  return new Promise(resolve => {
    execFile(binary, ['--version'], { timeout: 10_000, env: { PATH: '/usr/bin:/bin', HOME: os.homedir() } }, (error, stdout) => {
      const match = /\brtk\s+v?(\d+\.\d+\.\d+)/.exec(String(stdout || ''))
      resolve(error || !match ? null : match[1])
    })
  })
}

/** Same candidates, same order as server/rtkPlane.ts findRTKBinary(); RTK_BIN set = only that path. */
export function binaryCandidates(env = process.env, home = os.homedir()) {
  if (env.RTK_BIN) return [env.RTK_BIN]
  return [path.join(home, '.local/bin/rtk'), path.join(home, '.cargo/bin/rtk'), '/usr/local/bin/rtk', '/opt/homebrew/bin/rtk']
}

export async function detectInstall({ env = process.env, home = os.homedir(), version = runVersion } = {}) {
  for (const candidate of binaryCandidates(env, home)) {
    const stat = await fs.stat(candidate).catch(() => null)
    if (!stat?.isFile()) continue
    const realPath = await fs.realpath(candidate)
    const homebrew = /\/Cellar\/rtk\//.test(realPath)
    const writable = await fs.access(path.dirname(realPath), fsConstants.W_OK).then(() => true, () => false)
    const real = await fs.lstat(realPath)
    return {
      method: homebrew ? 'homebrew' : writable ? 'direct' : 'unwritable', path: candidate, realPath,
      cargo: realPath.startsWith(path.join(home, '.cargo/bin')), version: await version(realPath),
      ino: real.ino, dev: real.dev,
    }
  }
  return { method: 'missing', path: null, realPath: null, cargo: false, version: null }
}

export function assetName(platform = process.platform, arch = process.arch) {
  const cpu = arch === 'arm64' ? 'aarch64' : arch === 'x64' ? 'x86_64' : null
  if (!cpu) return null
  if (platform === 'darwin') return `rtk-${cpu}-apple-darwin.tar.gz`
  if (platform === 'linux') return cpu === 'x86_64' ? 'rtk-x86_64-unknown-linux-musl.tar.gz' : 'rtk-aarch64-unknown-linux-gnu.tar.gz'
  return null
}

export function parseChecksums(text) {
  const sums = new Map()
  for (const line of String(text).split('\n')) {
    const match = /^([a-f0-9]{64})\s+\*?(\S+)\s*$/i.exec(line.trim())
    if (match) sums.set(path.basename(match[2]), match[1].toLowerCase())
  }
  return sums
}

/** Stable releases after `local` up to and including `latest` that declare breaking changes, with their first note. */
export function breakingNotes(releases, local, latest) {
  const out = []
  for (const release of releases) {
    if (release.draft || release.prerelease) continue
    if (compareVersions(release.tag, local) <= 0 || compareVersions(release.tag, latest) > 0) continue
    const body = String(release.body || '')
    if (!/BREAKING CHANGE/i.test(body)) continue
    const after = body.split(/BREAKING CHANGES?/i)[1] || ''
    const bullet = /^\s*[*-]\s+(.+)$/m.exec(after)?.[1] ?? ''
    const note = bullet.replace(/\*\*/g, '').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').trim()
    out.push({ tag: release.tag, note: note.length > 200 ? `${note.slice(0, 199)}…` : note })
  }
  return out.sort((a, b) => compareVersions(a.tag, b.tag))
}

class RtkError extends Error {
  constructor(code, message, extra = {}) { super(message); this.code = code; Object.assign(this, extra) }
}

const trimRelease = release => ({
  tag: String(release.tag_name || ''), draft: Boolean(release.draft), prerelease: Boolean(release.prerelease),
  publishedAt: release.published_at ?? null, body: String(release.body || '').slice(0, 20_000),
  assets: (Array.isArray(release.assets) ? release.assets : []).map(asset => ({
    name: String(asset.name || ''), size: Number(asset.size) || 0, digest: typeof asset.digest === 'string' ? asset.digest : null,
    url: String(asset.browser_download_url || ''),
  })),
})

/** Releases list, from the cache while it already knows `latest`; otherwise one conditional request. */
export async function fetchReleases({ latest, cacheFile, fetchImpl = fetch, api = RELEASES_API, now = Date.now() }) {
  const cache = await readJSON(cacheFile)
  if (cache?.api === api && Array.isArray(cache.releases) && cache.releases.some(release => release.tag === latest)) {
    return { releases: cache.releases, fromCache: true }
  }
  const response = await fetchImpl(api, {
    headers: { accept: 'application/vnd.github+json', 'user-agent': 'Crosery-RTK-Autoupdate', ...(cache?.api === api && cache?.etag ? { 'if-none-match': cache.etag } : {}) },
    redirect: 'error', signal: AbortSignal.timeout(20_000),
  })
  if (response.status === 304 && cache?.releases) {
    await response.body?.cancel()
    return { releases: cache.releases, fromCache: true }
  }
  if (!response.ok) {
    await response.body?.cancel()
    const delay = rateLimitDelay(response.headers, now)
    throw new RtkError(delay !== null || response.status === 403 || response.status === 429 ? 'rate-limited' : 'api', `GitHub releases HTTP ${response.status}`,
      { retryAt: delay !== null ? now + delay : null })
  }
  const text = await response.text()
  if (text.length > MAX_API_BYTES) throw new RtkError('api', 'GitHub releases response is too large')
  const releases = JSON.parse(text).map(trimRelease)
  await writeAtomic(cacheFile, { api, etag: response.headers.get('etag'), fetchedAt: iso(now), releases }).catch(() => undefined)
  return { releases, fromCache: false }
}

async function download(url, { fetchImpl, allowHosts, maxBytes = MAX_ASSET_BYTES }) {
  const host = value => { try { return new URL(value).hostname } catch { return '' } }
  if (!allowHosts.includes(host(url))) throw new RtkError('download', `download host not allowed: ${host(url)}`)
  const response = await fetchImpl(url, { headers: { 'user-agent': 'Crosery-RTK-Autoupdate' }, redirect: 'follow', signal: AbortSignal.timeout(120_000) })
  if (!response.ok) { await response.body?.cancel(); throw new RtkError('download', `${path.basename(new URL(url).pathname)}: HTTP ${response.status}`) }
  if (response.url && !allowHosts.includes(host(response.url))) { await response.body?.cancel(); throw new RtkError('download', `redirected to a host not allowed: ${host(response.url)}`) }
  const parts = []
  let size = 0
  for await (const chunk of response.body) {
    size += chunk.length
    if (size > maxBytes) throw new RtkError('download', 'asset is larger than allowed')
    parts.push(chunk)
  }
  return Buffer.concat(parts)
}

function tar(args) {
  return new Promise((resolve, reject) => {
    execFile('/usr/bin/tar', args, { timeout: 60_000, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => (error ? reject(new RtkError('extract', `tar: ${String(stderr || error.message).trim().slice(0, 160)}`)) : resolve(String(stdout))))
  })
}

async function findBinary(directory, depth = 0) {
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name)
    if (entry.isFile() && entry.name === 'rtk') return full
    if (entry.isDirectory() && depth < 3) { const found = await findBinary(full, depth + 1); if (found) return found }
  }
  return null
}

/** Download + verify + extract + version check, all inside `work`; nothing outside it is touched. */
export async function prepareUpgrade({ release, platform = process.platform, arch = process.arch, fetchImpl = fetch, allowHosts = DOWNLOAD_HOSTS, work, version = runVersion }) {
  const name = assetName(platform, arch)
  if (!name) throw new RtkError('no-asset', `no rtk build for ${platform}/${arch}`)
  const asset = release.assets.find(item => item.name === name)
  if (!asset) throw new RtkError('no-asset', `${release.tag} has no ${name}`)
  const signatures = release.assets.filter(item => SIGNATURE.test(item.name) && (item.name.startsWith(name) || item.name.startsWith('checksums')))
  if (signatures.length) throw new RtkError('signature', `${release.tag} publishes a signature (${signatures.map(item => item.name).join(', ')}) this upgrader cannot verify; refusing`)
  const expected = []
  const listing = release.assets.find(item => /^(checksums|sha256sums)(\.txt)?$/i.test(item.name))
  if (listing) {
    const sum = parseChecksums((await download(listing.url, { fetchImpl, allowHosts, maxBytes: 1024 * 1024 })).toString('utf8')).get(name)
    if (sum) expected.push({ source: listing.name, sha256: sum })
  }
  const digest = /^sha256:([a-f0-9]{64})$/i.exec(asset.digest || '')?.[1]?.toLowerCase()
  if (digest) expected.push({ source: 'GitHub asset digest', sha256: digest })
  if (!expected.length) throw new RtkError('no-checksum', `${release.tag} publishes no sha256 for ${name}; refusing an unverifiable binary`)
  const archive = await download(asset.url, { fetchImpl, allowHosts })
  const actual = sha256(archive)
  const wrong = expected.filter(item => item.sha256 !== actual)
  if (wrong.length) throw new RtkError('checksum-mismatch', `${name} sha256 ${actual.slice(0, 12)}… does not match ${wrong.map(item => item.source).join(' + ')}`)
  const file = path.join(work, name)
  await fs.writeFile(file, archive, { mode: 0o600 })
  const entries = (await tar(['-tzf', file])).split('\n').filter(Boolean)
  if (entries.some(entry => path.isAbsolute(entry) || entry.split('/').includes('..'))) throw new RtkError('extract', 'archive has unsafe paths')
  const unpacked = path.join(work, 'unpacked')
  await fs.mkdir(unpacked, { mode: 0o700 })
  await tar(['-xzf', file, '-C', unpacked])
  const binary = await findBinary(unpacked)
  if (!binary || !(await fs.lstat(binary)).isFile()) throw new RtkError('extract', 'archive has no rtk binary')
  await fs.chmod(binary, 0o755)
  const want = release.tag.replace(/^v/, '')
  const got = await version(binary)
  if (got !== want) throw new RtkError('version', `extracted binary reports ${got ?? 'nothing'}, expected ${want}`)
  return { asset: name, size: archive.length, sha256: actual, verifiedBy: expected.map(item => item.source), signature: 'none published', binary, version: want }
}

async function pruneBackups(directory) {
  const names = (await fs.readdir(directory).catch(() => [])).filter(name => name.startsWith('rtk-')).sort()
  for (const name of names.slice(0, Math.max(0, names.length - KEEP_BACKUPS))) await fs.rm(path.join(directory, name), { force: true })
}

/** The binary about to be replaced is still the file detectInstall saw: same link target, same regular file (dev+inode). */
export async function sameInstall(install) {
  try {
    if (await fs.realpath(install.path) !== install.realPath) return false
    const stat = await fs.lstat(install.realPath)
    return stat.isFile() && stat.ino === install.ino && stat.dev === install.dev
  } catch {
    return false
  }
}

/** Backup → atomic rename → `--version`; anything else restores the backup the same way. */
export async function swapBinary({ target, staged, from, to, backups, version = runVersion, now = Date.now() }) {
  await fs.mkdir(backups, { recursive: true, mode: 0o700 })
  const backup = path.join(backups, `rtk-${iso(now).replace(/[:.]/g, '-')}-${from ?? 'unknown'}`)
  await fs.copyFile(target, backup)
  await fs.chmod(backup, 0o755)
  const place = async (source, tag) => {
    const incoming = path.join(path.dirname(target), `.rtk.${tag}-${process.pid}`)
    await fs.copyFile(source, incoming)
    try { await fs.chmod(incoming, 0o755); await fs.rename(incoming, target) } finally { await fs.rm(incoming, { force: true }) }
  }
  await place(staged, 'incoming')
  const got = await version(target)
  if (got === to) { await pruneBackups(backups); return { ok: true, backup } }
  await place(backup, 'rollback')
  const restored = await version(target)
  return { ok: false, backup, rolledBack: restored === from, error: `installed rtk reports ${got ?? 'nothing'}, expected ${to}; ${restored === from ? `restored ${from}` : 'restore did not verify'}` }
}

async function withLock(file, action) {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 })
  let handle
  try { handle = await fs.open(file, 'wx', 0o600) } catch (error) {
    if (error.code !== 'EEXIST') throw error
    const owner = await readJSON(file)
    const alive = Number.isInteger(owner?.pid) && (() => { try { process.kill(owner.pid, 0); return true } catch (e) { return e.code === 'EPERM' } })()
    if (alive) throw new RtkError('locked', 'another rtk upgrade is running')
    await fs.rm(file, { force: true })
    handle = await fs.open(file, 'wx', 0o600)
  }
  try {
    await handle.writeFile(JSON.stringify({ pid: process.pid, startedAt: iso(Date.now()) }))
    return await action()
  } finally {
    await handle.close()
    await fs.rm(file, { force: true })
  }
}

const emptyState = () => ({ version: 1, result: null, why: null, reasons: [], local: null, latest: null, method: null, binary: null,
  attempts: {}, lastUpgrade: null, failures: 0, nextAttemptAt: null, retryNotBefore: null, checkedAt: null })

export async function readRtkState(file) {
  const raw = await readJSON(file)
  return raw?.version === 1 ? { ...emptyState(), ...raw, attempts: raw.attempts && typeof raw.attempts === 'object' ? raw.attempts : {} } : emptyState()
}

const REASON = {
  missing: () => '本机没有安装 rtk',
  unwritable: install => `${install.realPath} 所在目录不可写`,
  'no-latest': () => '上游检查还没取到 rtk 最新版本',
  'up-to-date': (install, latest) => `已是最新 ${latest ?? install.version}`,
}

/**
 * mode: plan (download + verify only) · upgrade (manual, now) · auto (scheduled: config, once per release, backoff).
 * Returns { action, why, ... } and, except for plan, records the outcome in autoupdate-rtk.json.
 */
export async function upgradeRtk({ mode = 'plan', acceptBreaking = false, paths = rtkPaths(), deps = {} } = {}) {
  const now = (deps.now ?? Date.now)()
  const version = deps.version ?? runVersion
  const config = normalizeConfig(await readJSON(paths.config))
  let state = await readRtkState(paths.state)
  const record = async patch => {
    if (mode === 'plan') return
    state = { ...state, ...patch, checkedAt: iso(now) }
    await writeAtomic(paths.state, state)
  }
  const finish = async (result, extra = {}) => {
    const reasons = extra.reasons ?? []
    await record({ result: result.result ?? result.why, why: result.why, reasons, local: result.local ?? state.local, latest: result.latest ?? state.latest, method: result.method ?? state.method, binary: result.binary ?? state.binary, ...extra.state })
    return { ...result, reasons }
  }
  if (mode === 'auto' && !config.rtk.enabled) return finish({ action: 'none', why: 'disabled', result: 'disabled' })
  const install = await (deps.detect ?? detectInstall)({ env: deps.env ?? process.env, home: deps.home ?? os.homedir(), version })
  const status = await readJSON(paths.status)
  const latest = typeof status?.rtkRelease === 'string' && /^v?\d+\.\d+\.\d+/.test(status.rtkRelease) ? status.rtkRelease : null
  const facts = { method: install.method, binary: install.realPath, local: install.version, latest }
  if (install.method === 'missing') return finish({ action: 'none', why: 'missing', ...facts }, { reasons: [{ code: 'missing', text: REASON.missing() }] })
  if (!latest) return finish({ action: 'none', why: 'no-latest', ...facts }, { reasons: [{ code: 'no-latest', text: REASON['no-latest']() }] })
  if (install.version && compareVersions(latest, install.version) <= 0) return finish({ action: 'none', why: 'up-to-date', ...facts })
  if (mode === 'auto') {
    // before the brew branch too: a formula that lags the GitHub release must not run `brew upgrade` every 30 minutes
    const notBefore = Math.max(Date.parse(state.nextAttemptAt || '') || 0, Date.parse(state.retryNotBefore || '') || 0)
    if (notBefore > now) return { action: 'none', why: 'backoff', retryAt: iso(notBefore), ...facts, reasons: state.reasons }
    if (install.method !== 'homebrew' && (state.attempts[latest] || 0) >= 1) return { action: 'none', why: 'attempted', last: state.lastUpgrade, ...facts, reasons: state.reasons }
  }
  if (install.method === 'homebrew') {
    if (mode === 'plan') return { action: 'brew', why: 'homebrew', command: 'brew upgrade rtk', ...facts, reasons: [] }
    const brewed = await (deps.brew ?? (() => new Promise(resolve => execFile('brew', ['upgrade', 'rtk'], { timeout: 15 * 60_000 }, error => resolve(!error)))))()
    const after = await version(install.path) // brew moves the Cellar path; the linked path stays
    const ok = brewed && after && compareVersions(after, install.version ?? '0.0.0') > 0
    // brew verifies its own bottles; a failed or not-yet-available formula is retried after a growing backoff
    const failures = ok ? 0 : (Number(state.failures) || 0) + 1
    return finish({ action: 'brew', why: ok ? 'upgraded' : 'error', result: ok ? 'upgraded' : 'error', ...facts, local: after ?? install.version },
      { reasons: ok ? [] : [{ code: 'brew', text: 'brew upgrade rtk 没有升级成功' }],
        state: ok
          ? { lastUpgrade: { from: install.version, to: after, at: iso(now), via: 'brew', result: 'upgraded' }, failures: 0, nextAttemptAt: null }
          : { failures, nextAttemptAt: iso(now + Math.max(30 * 60_000, nextAttemptDelay(failures))) } })
  }
  if (install.method === 'unwritable') return finish({ action: 'none', why: 'unwritable', ...facts }, { reasons: [{ code: 'unwritable', text: REASON.unwritable(install) }] })
  let releases
  try {
    releases = (await fetchReleases({ latest, cacheFile: paths.cache, fetchImpl: deps.fetch ?? fetch, api: deps.api ?? RELEASES_API, now })).releases
  } catch (error) {
    const retry = error.retryAt ?? now + 30 * 60_000
    return finish({ action: 'none', why: error.code === 'rate-limited' ? 'rate-limited' : 'error', result: 'error', ...facts },
      { reasons: [{ code: error.code ?? 'api', text: `读不到 rtk 的发布信息：${error.message}` }], state: { retryNotBefore: iso(retry) } })
  }
  const release = releases.find(item => item.tag === latest && !item.draft)
  if (!release) return finish({ action: 'none', why: 'no-release', result: 'error', ...facts }, { reasons: [{ code: 'no-release', text: `发布列表里没有 ${latest}` }] })
  const breaking = breakingNotes(releases, install.version ?? '0.0.0', latest)
  const hold = breaking.length && !acceptBreaking
    // the line stays short (Console row); the release notes go in items for the CLI / state file
    ? [{ code: 'breaking', text: `${breaking.map(item => item.tag).join('、')} 声明了破坏性变更 · 看过发布说明再用 cradmin rtk upgrade --accept-breaking`, items: breaking.map(item => `${item.tag}: ${item.note}`) }]
    : []
  if (hold.length && mode === 'auto') return finish({ action: 'none', why: 'breaking', result: 'held', ...facts }, { reasons: hold })
  const work = await fs.mkdtemp(path.join(os.tmpdir(), 'rtk-upgrade-'))
  try {
    let prepared
    try {
      prepared = await prepareUpgrade({ release, fetchImpl: deps.fetch ?? fetch, allowHosts: deps.allowHosts ?? DOWNLOAD_HOSTS, work, version, platform: deps.platform, arch: deps.arch })
    } catch (error) {
      // a network hiccup is retried after a backoff; a release that fails verification is not retried automatically
      const transient = !error.code || ['download', 'api', 'rate-limited'].includes(error.code)
      const failures = (Number(state.failures) || 0) + 1
      const next = transient
        ? { failures, nextAttemptAt: iso(now + Math.max(30 * 60_000, nextAttemptDelay(failures))) }
        : { attempts: mode === 'auto' ? { ...state.attempts, [latest]: (state.attempts[latest] || 0) + 1 } : state.attempts }
      return finish({ action: 'none', why: transient ? 'error' : 'verify-failed', result: 'error', ...facts },
        { reasons: [{ code: error.code ?? 'download', text: `${latest} ${transient ? '下载失败' : '没通过校验'}：${error.message}` }], state: next })
    }
    const plan = { from: install.version, to: prepared.version, target: install.realPath, asset: prepared.asset, size: prepared.size, sha256: prepared.sha256, verifiedBy: prepared.verifiedBy, signature: prepared.signature, backupDir: paths.backups }
    if (mode === 'plan') return { action: hold.length ? 'hold' : 'upgrade', why: hold.length ? 'breaking' : 'ready', ...facts, plan, reasons: hold }
    if (hold.length) return finish({ action: 'none', why: 'breaking', result: 'held', ...facts }, { reasons: hold })
    const unspent = state.attempts
    const attempts = { ...state.attempts, [latest]: (state.attempts[latest] || 0) + 1 }
    await record({ attempts })
    const swapped = await withLock(paths.lock, async () => {
      // the download took a while: the target must still be the file that was detected, not a swapped link or file
      if (!(await sameInstall(install))) return { ok: false, untouched: true, error: `${install.path} 在准备升级期间被换掉了，这次没有替换` }
      return swapBinary({ target: install.realPath, staged: prepared.binary, from: install.version, to: prepared.version, backups: paths.backups, version, now })
    })
    if (swapped.untouched) {
      // nothing replaced: the attempt is given back and the next run detects the install again (after a backoff)
      const failures = (Number(state.failures) || 0) + 1
      return finish({ action: 'none', why: 'error', result: 'error', ...facts },
        { reasons: [{ code: 'changed', text: swapped.error }], state: { attempts: unspent, failures, nextAttemptAt: iso(now + Math.max(30 * 60_000, nextAttemptDelay(failures))) } })
    }
    const lastUpgrade = { from: install.version, to: prepared.version, at: iso(now), backup: swapped.backup, result: swapped.ok ? 'upgraded' : swapped.rolledBack ? 'rolled-back' : 'rollback-failed', sha256: prepared.sha256, verifiedBy: prepared.verifiedBy }
    if (swapped.ok) return finish({ action: 'upgrade', why: 'upgraded', result: 'upgraded', ...facts, local: prepared.version, plan }, { state: { lastUpgrade, failures: 0, nextAttemptAt: null } })
    const failures = (Number(state.failures) || 0) + 1
    return finish({ action: 'upgrade', why: 'rolled-back', result: lastUpgrade.result, ...facts, plan },
      { reasons: [{ code: 'post-swap', text: swapped.error }], state: { lastUpgrade, failures, nextAttemptAt: iso(now + Math.max(30 * 60_000, nextAttemptDelay(failures))) } })
  } finally {
    await fs.rm(work, { recursive: true, force: true })
  }
}

export const runRtkAuto = () => upgradeRtk({ mode: 'auto' })

async function main() {
  const action = process.argv[2]
  const paths = rtkPaths()
  if (action === 'status') {
    const install = await detectInstall()
    console.log(json({ install, latest: (await readJSON(paths.status))?.rtkRelease ?? null, state: await readRtkState(paths.state) }))
  } else if (action === 'plan') {
    console.log(json(await upgradeRtk({ mode: 'plan', paths })))
  } else if (action === 'upgrade') {
    if (!process.argv.includes('--confirm')) throw new Error('upgrade replaces the rtk binary; pass --confirm (or use plan to see what it would do)')
    const result = await upgradeRtk({ mode: 'upgrade', acceptBreaking: process.argv.includes('--accept-breaking'), paths })
    console.log(json(result))
    if (!['upgraded', 'up-to-date'].includes(result.why)) process.exitCode = 1
  } else if (action === 'auto') {
    console.log(json(await upgradeRtk({ mode: 'auto', paths })))
  } else {
    throw new Error('Use status, plan, upgrade --confirm [--accept-breaking], or auto')
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1 })
}

#!/usr/bin/env node
/**
 * Safe auto-upgrade of the local `rtk` binary.
 *
 *   node scripts/rtk-autoupdate.mjs status                       install method, versions, last result (no network)
 *   node scripts/rtk-autoupdate.mjs plan                         dry-run: resolve, download and verify into a temp dir; no swap
 *   node scripts/rtk-autoupdate.mjs upgrade --confirm [--accept-breaking]   manual upgrade now
 *   node scripts/rtk-autoupdate.mjs auto                         what the scheduled job runs (config, once per release, backoff)
 *
 * AUTOUPDATE_ROLE (servers: /etc/crosery/autoupdate.env) decides what may be installed:
 * - preview: the latest release, then a trial — `rtk --version` and a tiny functional check right after the swap and on
 *   every later run; ≥ AUTOUPDATE_SOAK_HOURS of passing checks accepts it (state `accepted`, which the build machine's
 *   coordinator forwards to production). One trial at a time; a failing check restores the previous binary.
 * - production (also any Linux host without the env file): only the version (and archive sha256) preview accepted, from
 *   <state>/promotion.json, while that record is younger than AUTOUPDATE_RECORD_MAX_AGE_DAYS.
 * - standalone (a Mac without the env file): the latest release.
 * The latest tag comes from the GitHub releases list (one conditional request per run, cached). The archive must match the published sha256
 * (checksums.txt and/or the API digest; neither published → refuse; a published signature this script cannot verify →
 * refuse). The extracted binary must report the release's version before the swap: backup → atomic rename →
 * `rtk --version` + functional check → otherwise restore the backup. A Homebrew install is upgraded with
 * `brew upgrade rtk` instead. A release range that declares BREAKING CHANGES is held for review.
 * State lives in RTK_STATE_DIR (default ~/.agents/crosery/rtk).
 */
import fs from 'node:fs/promises'
import { constants as fsConstants, realpathSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash, randomBytes } from 'node:crypto'
import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { compareVersions, hostEnv, nextAttemptDelay, promotionPolicy, rateLimitDelay } from './autoupdate-common.mjs'

export const RELEASES_API = 'https://api.github.com/repos/rtk-ai/rtk/releases?per_page=30'
export const DOWNLOAD_HOSTS = ['github.com', 'objects.githubusercontent.com', 'release-assets.githubusercontent.com']
const MAX_ASSET_BYTES = 64 * 1024 * 1024
const MAX_API_BYTES = 4 * 1024 * 1024
const KEEP_BACKUPS = 3
const SIGNATURE = /\.(sig|asc|minisig|sigstore|sigstore\.json|pem|bundle)$/i
const iso = ms => new Date(ms).toISOString()
const json = value => `${JSON.stringify(value, null, 2)}\n`

const CACHE_MAX_AGE_AUTO_MS = 6 * 3_600_000
const CACHE_MAX_AGE_MANUAL_MS = 10 * 60_000
const CLOCK_SKEW_MS = 5 * 60_000
const KEEP_CHECKS = 10

export function rtkRuntime(env = process.env, home = os.homedir()) {
  return path.resolve(env.RTK_STATE_DIR || path.join(home, '.agents/crosery/rtk'))
}

/** An explicit AUTOUPDATE_ROLE wins; a Mac without one keeps the old standalone behaviour; any other host is production. */
export function rtkRole(env = process.env, platform = process.platform) {
  if (env.AUTOUPDATE_ROLE === 'preview') return 'preview'
  if (env.AUTOUPDATE_ROLE === 'production' || platform !== 'darwin') return 'production'
  return 'standalone'
}

export function rtkPaths(runtime = rtkRuntime()) {
  return {
    runtime, config: path.join(runtime, 'autoupdate.json'),
    state: path.join(runtime, 'autoupdate-rtk.json'), cache: path.join(runtime, 'rtk-releases.json'),
    backups: path.join(runtime, 'rtk-backups'), lock: path.join(runtime, 'rtk-upgrade.lock'),
    promotion: path.join(runtime, 'promotion.json'),
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

/**
 * Releases list, from the cache while it already knows `latest` or is younger than `maxAgeMs`; otherwise one
 * conditional request.
 */
export async function fetchReleases({ latest = null, cacheFile, fetchImpl = fetch, api = RELEASES_API, now = Date.now(), maxAgeMs = 0 }) {
  const cache = await readJSON(cacheFile)
  const usable = cache?.api === api && Array.isArray(cache.releases)
  if (usable && ((latest && cache.releases.some(release => release.tag === latest)) || now - (Date.parse(cache.fetchedAt) || 0) < maxAgeMs)) {
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

/** The newest stable tag in a releases list; null when it has none. */
export function latestStable(releases) {
  return releases.filter(release => !release.draft && !release.prerelease && /^v?\d+\.\d+\.\d+$/.test(release.tag))
    .map(release => release.tag).sort(compareVersions).at(-1) ?? null
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
  const length = Number(response.headers?.get?.('content-length'))
  const encoded = (response.headers?.get?.('content-encoding') ?? 'identity') !== 'identity'
  if (!encoded && Number.isInteger(length) && length > 0 && size !== length) throw new RtkError('download', `${path.basename(new URL(url).pathname)}: got ${size} of ${length} bytes`)
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
  // a short body (a proxy or CDN cutting the transfer) is the network, retried later; only a full-size archive with the
  // wrong sha256 is a release that fails verification
  if (Number.isInteger(asset.size) && asset.size > 0 && archive.length !== asset.size) {
    throw new RtkError('download', `${name}: got ${archive.length} bytes, the release lists ${asset.size}`)
  }
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

/**
 * The smallest real use of rtk: compact a JSON file in a throwaway HOME. It must exit 0 and print the values back.
 * Returns { ok, detail }.
 */
export async function functionalCheck(binary) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'rtk-check-'))
  try {
    const file = path.join(home, 'probe.json')
    await fs.writeFile(file, JSON.stringify({ crosery: 'rtk-probe', build: 4217 }))
    return await new Promise(resolve => {
      execFile(binary, ['json', file], { timeout: 10_000, env: { PATH: '/usr/bin:/bin', HOME: home, XDG_CONFIG_HOME: path.join(home, '.config'), XDG_DATA_HOME: path.join(home, '.local/share') } }, (error, stdout, stderr) => {
        const out = String(stdout || '')
        if (error) return resolve({ ok: false, detail: `rtk json 失败：${String(stderr || error.message).trim().slice(0, 120)}` })
        resolve(out.includes('4217') && out.includes('rtk-probe') ? { ok: true, detail: 'rtk json 正常' } : { ok: false, detail: `rtk json 输出不对：${out.trim().slice(0, 80)}` })
      })
    })
  } finally {
    await fs.rm(home, { recursive: true, force: true })
  }
}

/** `--version` says the expected version and the functional check passes. */
async function checkBinary(binary, want, { version, functional }) {
  const got = await version(binary)
  if (got !== want) return { ok: false, version: got, detail: `rtk --version 报 ${got ?? '无'}，应为 ${want}` }
  const used = functional ? await functional(binary) : { ok: true, detail: '' }
  return { ok: used.ok, version: got, detail: used.detail }
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

/** Copy next to the target, then one atomic rename over it. */
async function place(target, source, tag) {
  const incoming = path.join(path.dirname(target), `.rtk.${tag}-${process.pid}`)
  await fs.copyFile(source, incoming)
  try { await fs.chmod(incoming, 0o755); await fs.rename(incoming, target) } finally { await fs.rm(incoming, { force: true }) }
}

/** Put a backup back and say whether it answers as `want`. */
export async function restoreBinary({ target, backup, want, version = runVersion }) {
  await place(target, backup, 'rollback')
  return (await version(target)) === want
}

/** Backup → atomic rename → `--version` (+ the functional check); anything else restores the backup the same way. */
export async function swapBinary({ target, staged, from, to, backups, version = runVersion, functional = null, now = Date.now() }) {
  await fs.mkdir(backups, { recursive: true, mode: 0o700 })
  const backup = path.join(backups, `rtk-${iso(now).replace(/[:.]/g, '-')}-${from ?? 'unknown'}`)
  await fs.copyFile(target, backup)
  await fs.chmod(backup, 0o755)
  await place(target, staged, 'incoming')
  const got = await version(target)
  const used = got === to && functional ? await functional(target) : { ok: got === to, detail: '' }
  if (got === to && used.ok) { await pruneBackups(backups); return { ok: true, backup, check: { at: iso(Date.now()), ok: true, version: got, detail: used.detail } } }
  const rolledBack = await restoreBinary({ target, backup, want: from, version })
  const why = got !== to ? `installed rtk reports ${got ?? 'nothing'}, expected ${to}` : `functional check failed (${used.detail})`
  return { ok: false, backup, rolledBack, error: `${why}; ${rolledBack ? `restored ${from}` : 'restore did not verify'}` }
}

/* ── promotion (production installs only what preview accepted) ─────── */

const TAG3 = /^v\d+\.\d+\.\d+$/
const when = value => (typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : null)

/** The coordinator's copy of preview's accepted trial (<state>/promotion.json, written through the production gate). */
export function parseRtkPromotion(raw) {
  if (!raw || typeof raw !== 'object' || raw.version !== 1 || raw.kind !== 'rtk-promotion') return null
  const c = raw.candidate
  if (!c || !TAG3.test(String(c.tag)) || c.version !== String(c.tag).slice(1) || !/^[a-f0-9]{64}$/.test(String(c.sha256)) || !/^rtk-[\w.-]+\.tar\.gz$/.test(String(c.asset))) return null
  const checks = Array.isArray(raw.checks) ? raw.checks.filter(item => item && when(item.at) && typeof item.ok === 'boolean').slice(-50).map(item => ({ at: item.at, ok: item.ok })) : []
  if (!when(raw.installedAt) || !when(raw.acceptedAt) || !checks.length) return null
  return { version: 1, kind: 'rtk-promotion', candidate: { version: c.version, tag: c.tag, sha256: c.sha256, asset: c.asset }, installedAt: raw.installedAt, checks, acceptedAt: raw.acceptedAt }
}

/** Why production must not install this record's version ([] = it may). Soak is measured from the checks, with production's policy. */
export function rtkPromotionProblems({ record, asset, now, policy }) {
  const problems = []
  const add = (code, text) => problems.push({ code, text })
  if (!record) { add('no-record', '预发布还没有验收过的 rtk 版本'); return problems }
  if (record.candidate.asset !== asset) add('asset', `预发布验收的是 ${record.candidate.asset}，这台机器要 ${asset}`)
  const installed = Date.parse(record.installedAt)
  if (record.checks.some(item => !item.ok)) add('checks', '预发布的检查有没过的')
  if (record.checks.some(item => Date.parse(item.at) < installed)) add('order', '预发布记录的时间顺序不对')
  const soaked = Math.max(...record.checks.map(item => Date.parse(item.at))) - installed
  if (!(soaked >= policy.soakMs)) add('soak', `预发布只跑了 ${Math.max(0, Math.floor(soaked / 3_600_000))} 小时，要满 ${Math.round(policy.soakMs / 3_600_000)} 小时`)
  const accepted = Date.parse(record.acceptedAt)
  if (accepted > now + CLOCK_SKEW_MS) add('future', '预发布记录的验收时间在未来')
  else if (now - accepted > policy.maxAgeMs) add('stale', `预发布记录已超过 ${Math.round(policy.maxAgeMs / 86_400_000)} 天`)
  return problems
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
  attempts: {}, lastUpgrade: null, failures: 0, nextAttemptAt: null, retryNotBefore: null, checkedAt: null,
  role: null, target: null, trial: null, accepted: null, promotion: null })

export async function readRtkState(file) {
  const raw = await readJSON(file)
  return raw?.version === 1 ? { ...emptyState(), ...raw, attempts: raw.attempts && typeof raw.attempts === 'object' ? raw.attempts : {} } : emptyState()
}

const REASON = {
  missing: () => '本机没有安装 rtk',
  unwritable: install => `${install.realPath} 所在目录不可写`,
  'no-latest': () => '还没取到 rtk 最新版本',
  'up-to-date': (install, latest) => `已是最新 ${latest ?? install.version}`,
}

const rtkEnabled = raw => !(raw && typeof raw === 'object' && raw.rtk && typeof raw.rtk === 'object' && raw.rtk.enabled === false)
const retryLater = (state, now) => {
  const failures = (Number(state.failures) || 0) + 1
  return { failures, nextAttemptAt: iso(now + Math.max(30 * 60_000, nextAttemptDelay(failures))) }
}

/**
 * mode: plan (download + verify only) · upgrade (manual, now) · auto (scheduled: config, once per release, backoff).
 * Returns { action, why, ... } and, except for plan, records the outcome in autoupdate-rtk.json.
 */
export async function upgradeRtk({ mode = 'plan', acceptBreaking = false, paths = rtkPaths(), deps = {} } = {}) {
  const now = (deps.now ?? Date.now)()
  const env = deps.env ?? process.env
  const platform = deps.platform ?? process.platform
  const arch = deps.arch ?? process.arch
  const role = deps.role ?? rtkRole(env, platform)
  const policy = deps.policy ?? promotionPolicy(env)
  const version = deps.version ?? runVersion
  // the servers (preview, production) also prove the swapped binary works; a standalone Mac keeps the version check
  const functional = role === 'standalone' ? null : deps.functional ?? functionalCheck
  const enabled = rtkEnabled(await readJSON(paths.config))
  let state = await readRtkState(paths.state)
  const record = async patch => {
    if (mode === 'plan') return
    state = { ...state, ...patch, role, checkedAt: iso(now) }
    await writeAtomic(paths.state, state)
  }
  const finish = async (result, extra = {}) => {
    const reasons = extra.reasons ?? []
    await record({ result: result.result ?? result.why, why: result.why, reasons, local: result.local ?? state.local, latest: result.latest ?? state.latest, method: result.method ?? state.method, binary: result.binary ?? state.binary, target: result.target ?? null, ...extra.state })
    return { ...result, role, reasons }
  }
  if (mode === 'auto' && !enabled) return finish({ action: 'none', why: 'disabled', result: 'disabled' })
  const install = await (deps.detect ?? detectInstall)({ env, home: deps.home ?? os.homedir(), version })
  const base = { method: install.method, binary: install.realPath, local: install.version }
  if (install.method === 'missing') return finish({ action: 'none', why: 'missing', ...base }, { reasons: [{ code: 'missing', text: REASON.missing() }] })

  /* preview: the running trial is checked on every run, before anything new is considered */
  if (role === 'preview' && state.trial?.status === 'soaking' && mode !== 'plan') {
    const trial = state.trial
    if (install.version !== trial.version) {
      await record({ trial: { ...trial, status: 'rejected', rejected: { at: iso(now), code: 'replaced', reason: `运行中的是 ${install.version ?? '未知'}，不是试运行的 ${trial.version}`, restored: false } } })
    } else {
      const check = await checkBinary(install.realPath, trial.version, { version, functional })
      const checks = [...(trial.checks ?? []), { ...check, at: iso(now) }].slice(-KEEP_CHECKS)
      if (!check.ok) {
        const last = state.lastUpgrade
        const backup = last?.to === trial.version && last.backup && await fs.access(last.backup).then(() => true, () => false) ? last.backup : null
        const restored = backup ? await withLock(paths.lock, () => restoreBinary({ target: install.realPath, backup, want: last.from, version })) : false
        const rejected = { at: iso(now), code: 'check', reason: check.detail, restored }
        return finish({ action: 'restore', why: 'trial-failed', result: restored ? 'rolled-back' : 'rollback-failed', ...base, local: restored ? last.from : install.version },
          { reasons: [{ code: 'trial', text: `${trial.version} 在预发布试运行时检查没过：${check.detail}${restored ? `，已换回 ${last.from}` : '，没有可换回的备份 · 需要人工处理'}` }],
            state: { trial: { ...trial, checks, status: 'rejected', rejected } } })
      }
      const soakUntil = iso(Date.parse(trial.installedAt) + policy.soakMs)
      if (now >= Date.parse(soakUntil)) {
        const accepted = { ...trial, checks, status: 'accepted', acceptedAt: iso(now) }
        return finish({ action: 'none', why: 'accepted', result: 'accepted', ...base, target: trial.tag }, { state: { trial: accepted, accepted } })
      }
      return finish({ action: 'none', why: 'soaking', result: 'soaking', soakUntil, ...base, target: trial.tag }, { state: { trial: { ...trial, checks, soakUntil } } })
    }
  }

  if (mode === 'auto') {
    // before any network and before the brew branch: a formula that lags the release must not run `brew upgrade` every round
    const notBefore = Math.max(Date.parse(state.nextAttemptAt || '') || 0, Date.parse(state.retryNotBefore || '') || 0)
    if (notBefore > now) return { action: 'none', why: 'backoff', retryAt: iso(notBefore), role, ...base, latest: state.latest, reasons: state.reasons }
  }

  /* the latest release: the releases list itself */
  let releases
  try {
    releases = (await fetchReleases({ cacheFile: paths.cache, fetchImpl: deps.fetch ?? fetch, api: deps.api ?? RELEASES_API, now, maxAgeMs: mode === 'auto' ? CACHE_MAX_AGE_AUTO_MS : CACHE_MAX_AGE_MANUAL_MS })).releases
  } catch (error) {
    const retry = error.retryAt ?? now + 30 * 60_000
    return finish({ action: 'none', why: error.code === 'rate-limited' ? 'rate-limited' : 'error', result: 'error', ...base },
      { reasons: [{ code: error.code ?? 'api', text: `读不到 rtk 的发布信息：${error.message}` }], state: { retryNotBefore: iso(retry) } })
  }
  const latest = latestStable(releases)
  const facts = { ...base, latest }
  if (!latest) return finish({ action: 'none', why: 'no-latest', ...facts }, { reasons: [{ code: 'no-latest', text: REASON['no-latest']() }] })

  /* production: the target is what preview accepted, never just the latest */
  let target = latest
  let promotion = null
  if (role === 'production') {
    promotion = parseRtkPromotion(await readJSON(paths.promotion))
    const problems = rtkPromotionProblems({ record: promotion, asset: assetName(platform, arch), now, policy })
    const promoted = promotion && !problems.length ? promotion.candidate.tag : null
    if (!promoted || (install.version && compareVersions(promoted, install.version) <= 0)) {
      if (install.version && compareVersions(latest, install.version) <= 0) return finish({ action: 'none', why: 'up-to-date', ...facts }, { state: { promotion } })
      return finish({ action: 'none', why: 'not-promoted', result: 'waiting', ...facts, target: promoted },
        { reasons: problems.length && promotion ? problems : [{ code: 'not-promoted', text: `${latest} 还没在预发布跑满 ${Math.round(policy.soakMs / 3_600_000)} 小时` }], state: { promotion } })
    }
    target = promoted
  }
  if (install.version && compareVersions(target, install.version) <= 0) return finish({ action: 'none', why: 'up-to-date', ...facts })
  if (mode === 'auto' && install.method !== 'homebrew' && (state.attempts[target] || 0) >= 1) {
    return { action: 'none', why: 'attempted', last: state.lastUpgrade, role, ...facts, target, reasons: state.reasons }
  }
  if (install.method === 'homebrew' && role !== 'standalone') {
    return finish({ action: 'none', why: 'unsupported', result: 'error', ...facts }, { reasons: [{ code: 'homebrew', text: 'Homebrew 装的 rtk 不能按预发布验收过的版本升级；服务器请直接装在 RTK_BIN' }] })
  }
  if (install.method === 'homebrew') {
    if (mode === 'plan') return { action: 'brew', why: 'homebrew', command: 'brew upgrade rtk', role, ...facts, reasons: [] }
    const brewed = await (deps.brew ?? (() => new Promise(resolve => execFile('brew', ['upgrade', 'rtk'], { timeout: 15 * 60_000 }, error => resolve(!error)))))()
    const after = await version(install.path) // brew moves the Cellar path; the linked path stays
    const ok = brewed && after && compareVersions(after, install.version ?? '0.0.0') > 0
    // brew verifies its own bottles; a failed or not-yet-available formula is retried after a growing backoff
    return finish({ action: 'brew', why: ok ? 'upgraded' : 'error', result: ok ? 'upgraded' : 'error', ...facts, local: after ?? install.version },
      { reasons: ok ? [] : [{ code: 'brew', text: 'brew upgrade rtk 没有升级成功' }],
        state: ok ? { lastUpgrade: { from: install.version, to: after, at: iso(now), via: 'brew', result: 'upgraded' }, failures: 0, nextAttemptAt: null } : retryLater(state, now) })
  }
  if (install.method === 'unwritable') return finish({ action: 'none', why: 'unwritable', ...facts }, { reasons: [{ code: 'unwritable', text: REASON.unwritable(install) }] })
  const release = releases.find(item => item.tag === target && !item.draft)
  if (!release) return finish({ action: 'none', why: 'no-release', result: 'error', ...facts }, { reasons: [{ code: 'no-release', text: `发布列表里没有 ${target}` }] })
  const breaking = breakingNotes(releases, install.version ?? '0.0.0', target)
  const hold = breaking.length && !acceptBreaking
    // the line stays short (Console row); the release notes go in items for the CLI / state file
    ? [{ code: 'breaking', text: `${breaking.map(item => item.tag).join('、')} 声明了破坏性变更 · 看过发布说明再用 cradmin rtk upgrade --accept-breaking`, items: breaking.map(item => `${item.tag}: ${item.note}`) }]
    : []
  if (hold.length && mode === 'auto') return finish({ action: 'none', why: 'breaking', result: 'held', ...facts, target }, { reasons: hold })
  const spend = () => (mode === 'auto' ? { ...state.attempts, [target]: (state.attempts[target] || 0) + 1 } : state.attempts)
  const work = await fs.mkdtemp(path.join(os.tmpdir(), 'rtk-upgrade-'))
  try {
    let prepared
    try {
      prepared = await prepareUpgrade({ release, fetchImpl: deps.fetch ?? fetch, allowHosts: deps.allowHosts ?? DOWNLOAD_HOSTS, work, version, platform, arch })
      if (promotion && (prepared.sha256 !== promotion.candidate.sha256 || prepared.asset !== promotion.candidate.asset)) {
        throw new RtkError('promotion-mismatch', `${prepared.asset} sha256 ${prepared.sha256.slice(0, 12)}… 不是预发布验收过的 ${promotion.candidate.sha256.slice(0, 12)}…`)
      }
    } catch (error) {
      // a network hiccup is retried after a backoff; a release that fails verification is not retried automatically
      const transient = !error.code || ['download', 'api', 'rate-limited'].includes(error.code)
      return finish({ action: 'none', why: transient ? 'error' : 'verify-failed', result: 'error', ...facts, target },
        { reasons: [{ code: error.code ?? 'download', text: `${target} ${transient ? '下载失败' : '没通过校验'}：${error.message}` }], state: transient ? retryLater(state, now) : { attempts: spend() } })
    }
    const plan = { from: install.version, to: prepared.version, target: install.realPath, asset: prepared.asset, size: prepared.size, sha256: prepared.sha256, verifiedBy: prepared.verifiedBy, signature: prepared.signature, backupDir: paths.backups }
    if (mode === 'plan') return { action: hold.length ? 'hold' : 'upgrade', why: hold.length ? 'breaking' : 'ready', role, ...facts, target, plan, reasons: hold }
    if (hold.length) return finish({ action: 'none', why: 'breaking', result: 'held', ...facts, target }, { reasons: hold })
    const unspent = state.attempts
    await record({ attempts: { ...state.attempts, [target]: (state.attempts[target] || 0) + 1 } })
    const swapped = await withLock(paths.lock, async () => {
      // the download took a while: the target must still be the file that was detected, not a swapped link or file
      if (!(await sameInstall(install))) return { ok: false, untouched: true, error: `${install.path} 在准备升级期间被换掉了，这次没有替换` }
      return swapBinary({ target: install.realPath, staged: prepared.binary, from: install.version, to: prepared.version, backups: paths.backups, version, functional, now })
    })
    if (swapped.untouched) {
      // nothing replaced: the attempt is given back and the next run detects the install again (after a backoff)
      return finish({ action: 'none', why: 'error', result: 'error', ...facts, target }, { reasons: [{ code: 'changed', text: swapped.error }], state: { attempts: unspent, ...retryLater(state, now) } })
    }
    const lastUpgrade = { from: install.version, to: prepared.version, at: iso(now), backup: swapped.backup, result: swapped.ok ? 'upgraded' : swapped.rolledBack ? 'rolled-back' : 'rollback-failed', sha256: prepared.sha256, verifiedBy: prepared.verifiedBy, ...(promotion ? { promotedAt: promotion.acceptedAt } : {}) }
    if (swapped.ok) {
      const trial = role === 'preview'
        ? { version: prepared.version, tag: target, sha256: prepared.sha256, asset: prepared.asset, installedAt: iso(now), soakUntil: iso(now + policy.soakMs), checks: [{ ...swapped.check, at: iso(now) }], status: 'soaking', acceptedAt: null, rejected: null }
        : undefined
      return finish({ action: 'upgrade', why: 'upgraded', result: 'upgraded', ...facts, local: prepared.version, target, plan },
        { state: { lastUpgrade, failures: 0, nextAttemptAt: null, ...(trial ? { trial } : {}) } })
    }
    return finish({ action: 'upgrade', why: 'rolled-back', result: lastUpgrade.result, ...facts, target, plan },
      { reasons: [{ code: 'post-swap', text: swapped.error }], state: { lastUpgrade, ...retryLater(state, now) } })
  } finally {
    await fs.rm(work, { recursive: true, force: true })
  }
}

export const runRtkAuto = () => upgradeRtk({ mode: 'auto' })

async function main() {
  const action = process.argv[2]
  // by hand from a root shell: the host's role file, as the unit loads it
  const env = hostEnv(process.env)
  const paths = rtkPaths(rtkRuntime(env))
  const deps = { env }
  if (action === 'status') {
    const install = await detectInstall({ env })
    const state = await readRtkState(paths.state)
    console.log(json({ role: rtkRole(env), install, latest: state.latest ?? null, state }))
  } else if (action === 'plan') {
    console.log(json(await upgradeRtk({ mode: 'plan', paths, deps })))
  } else if (action === 'upgrade') {
    if (!process.argv.includes('--confirm')) throw new Error('upgrade replaces the rtk binary; pass --confirm (or use plan to see what it would do)')
    const result = await upgradeRtk({ mode: 'upgrade', acceptBreaking: process.argv.includes('--accept-breaking'), paths, deps })
    console.log(json(result))
    if (!['upgraded', 'up-to-date'].includes(result.why)) process.exitCode = 1
  } else if (action === 'auto') {
    console.log(json(await upgradeRtk({ mode: 'auto', paths, deps })))
  } else {
    throw new Error('Use status, plan, upgrade --confirm [--accept-breaking], or auto')
  }
}

// realpath: systemd runs it through /opt/crosery-api-console-current (a symlink); import.meta.url is the resolved file
if (process.argv[1] && realpathSync(path.resolve(process.argv[1])) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1 })
}

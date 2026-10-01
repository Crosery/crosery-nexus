#!/usr/bin/env node
/**
 * magpie 内核的安全更新器（task-78 ④）。
 *
 * 需求原话："支持自动更新上游最新的 magpie …… 检测版本 → 下载/构建 → 校验 → 备份 → 原子替换 → 失败回滚"。
 *
 * 设计取舍（为什么是这样）：
 * - **不重复造轮子**：上游版本检测与契约校验已经在 `scripts/magpie-upstream.mjs`（`check` / `verify` /
 *   `publishCandidate`），构建在 `deploy/magpie/build.sh`。本脚本只做**编排 + 状态机 + 安全闸门**。
 * - **默认只读**：`status` / `check` 不改任何东西；`rehearse` 在临时目录里跑完整流程；
 *   **真替换只有 `apply --confirm-apply` 才会发生**（用户在任务里明确要求"未经确认不要替换正在跑的内核"）。
 * - **失败一律回滚**：下载/构建产物先落到临时目录 → 校验（sha256 + 版本回读）→ 备份旧文件 →
 *   `rename` 原子替换 → 任何一步失败都把备份放回去并如实报错（非 0 退出）。
 * - **幂等**：版本相同 ⇒ 什么都不做，退出 0。
 *
 * 发布源（release source）抽象成"一个目录/URL + manifest.json"，便于演练：
 *   manifest.json = { "version": "crosery-3fe2ff9", "revision": "<40 hex>", "files": [ { "name": "magpie-kernel", "sha256": "..." } ] }
 * 真实生产用 `--from-build`（调用 deploy/magpie/build.sh 从干净的上游 checkout 构建并回读内嵌版本）。
 */
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'

const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
const DEFAULT_ROOT = path.join(os.homedir(), '.agents/crosery/magpie-console/bin')
const DEFAULT_BINARY = 'magpie-kernel'
const STATUS_FILE = 'magpie-update-status.json'

const argv = process.argv.slice(2)
const action = argv[0]
const flag = (name) => argv.includes(name)
const arg = (name, fallback = undefined) => {
  const at = argv.indexOf(name)
  return at < 0 ? fallback : argv[at + 1]
}
const out = (value) => process.stdout.write(`${JSON.stringify(value)}\n`)

const sha256 = (buffer) => createHash('sha256').update(buffer).digest('hex')

/** 版本回读：二进制里内嵌的 `crosery-<rev7>`（build.sh 用 `-X main.version=` 写入）。 */
export function embeddedVersion(buffer) {
  const text = buffer.toString('latin1')
  const match = text.match(/crosery-[0-9a-f]{7,40}/)
  return match ? match[0] : null
}

export function readStatus(root) {
  try {
    return JSON.parse(fs.readFileSync(path.join(root, STATUS_FILE), 'utf8'))
  } catch {
    return null
  }
}

function writeStatus(root, status) {
  const file = path.join(root, STATUS_FILE)
  const temporary = `${file}.tmp-${process.pid}`
  fs.mkdirSync(root, { recursive: true, mode: 0o700 })
  fs.writeFileSync(temporary, `${JSON.stringify(status, null, 2)}\n`, { mode: 0o600 })
  fs.renameSync(temporary, file) // 状态文件同样原子替换
}

/** 当前版本：优先状态文件，其次运行实例的 manifest.revision，最后回读二进制内嵌版本。 */
export function currentVersion(root, binary = DEFAULT_BINARY) {
  const status = readStatus(root)
  if (status?.currentVersion) return status.currentVersion
  for (const candidate of [path.join(path.dirname(root), 'console-manifest.json')]) {
    try {
      const revision = JSON.parse(fs.readFileSync(candidate, 'utf8')).revision
      if (typeof revision === 'string' && revision) return `crosery-${revision.slice(0, 7)}`
    } catch { /* 没有 manifest 就走回读 */ }
  }
  try {
    return embeddedVersion(fs.readFileSync(path.join(root, binary)))
  } catch {
    return null
  }
}

/** 发布源：本地目录或 `file://`/`http(s)://` 下的 manifest.json（演练用本地目录，生产可用 URL）。 */
export async function readRelease(source) {
  const url = source.startsWith('http://') || source.startsWith('https://') ? `${source.replace(/\/$/, '')}/manifest.json` : null
  const raw = url
    ? await (async () => {
      const response = await fetch(url, { signal: AbortSignal.timeout(20_000) })
      if (!response.ok) throw new Error(`release manifest: HTTP ${response.status}`)
      return await response.text()
    })()
    : fs.readFileSync(path.join(source, 'manifest.json'), 'utf8')
  const manifest = JSON.parse(raw)
  if (!manifest || typeof manifest.version !== 'string' || !Array.isArray(manifest.files) || manifest.files.length === 0) {
    throw new Error('release manifest 结构不认识（需要 version + files[]）')
  }
  return manifest
}

async function fetchFile(source, name) {
  const url = source.startsWith('http://') || source.startsWith('https://') ? `${source.replace(/\/$/, '')}/${name}` : null
  if (url) {
    const response = await fetch(url, { signal: AbortSignal.timeout(120_000) })
    if (!response.ok) throw new Error(`${name}: HTTP ${response.status}`)
    return Buffer.from(await response.arrayBuffer())
  }
  return fs.readFileSync(path.join(source, name))
}

/**
 * 下载/构建 → 校验 → 备份 → 原子替换；失败回滚。
 * `verify` 可被注入（测试里用它做"去掉校验必须变红"的负向验证）。
 */
export function swapIn({ root, binary, staged, backupSuffix, verify = true, expectedSha, expectedVersion, verifyPostSwap }) {
  const target = path.join(root, binary)
  fs.mkdirSync(root, { recursive: true, mode: 0o700 })
  const backup = fs.existsSync(target) ? `${target}.before-${backupSuffix}` : null
  const temporary = `${target}.incoming-${process.pid}`
  fs.copyFileSync(staged, temporary)
  fs.chmodSync(temporary, 0o755)
  try {
    if (verify) {
      const digest = sha256(fs.readFileSync(temporary))
      if (expectedSha && digest !== expectedSha) throw new Error(`sha256 不匹配：期望 ${expectedSha}，实际 ${digest}`)
      if (expectedVersion) {
        const actual = embeddedVersion(fs.readFileSync(temporary))
        if (actual !== expectedVersion) throw new Error(`版本回读不匹配：期望 ${expectedVersion}，实际 ${actual}`)
      }
    }
    if (backup) fs.copyFileSync(target, backup)
    fs.renameSync(temporary, target) // 原子替换
    // 替换**之后再校验一次**：只有这里失败才需要"回滚"（前面的校验失败时旧文件还没被碰过）
    const check = verifyPostSwap || ((installed) => {
      const digest = sha256(fs.readFileSync(installed))
      if (expectedSha && digest !== expectedSha) throw new Error(`替换后 sha256 不匹配：期望 ${expectedSha}，实际 ${digest}`)
      if (expectedVersion) {
        const actual = embeddedVersion(fs.readFileSync(installed))
        if (actual !== expectedVersion) throw new Error(`替换后版本回读不匹配：期望 ${expectedVersion}，实际 ${actual}`)
      }
    })
    check(target)
    return { ok: true, backup, sha256: sha256(fs.readFileSync(target)) }
  } catch (error) {
    fs.rmSync(temporary, { force: true })
    if (backup && fs.existsSync(backup)) fs.copyFileSync(backup, target) // 回滚
    return { ok: false, rolledBack: Boolean(backup), backup, error: String(error?.message || error) }
  }
}

async function downloadTo(source, manifest, stage) {
  fs.mkdirSync(stage, { recursive: true, mode: 0o700 })
  const staged = new Map()
  for (const file of manifest.files) {
    if (!file || typeof file.name !== 'string') throw new Error('manifest.files 项缺少 name')
    const buffer = await fetchFile(source, file.name)
    const digest = sha256(buffer)
    if (file.sha256 && digest !== file.sha256) throw new Error(`${file.name} 下载后 sha256 不匹配（期望 ${file.sha256}）`)
    const destination = path.join(stage, path.basename(file.name))
    fs.writeFileSync(destination, buffer, { mode: 0o755 })
    staged.set(path.basename(file.name), destination)
  }
  return staged
}

/** 构建路径（生产）：从干净的上游 checkout 构建 + 契约校验（`magpie-upstream.mjs verify`）。 */
function buildFromUpstream({ source, stage, binary }) {
  const out = path.join(stage, binary)
  execFileSync('bash', [path.join(REPO, 'deploy/magpie/build.sh'), out], {
    cwd: REPO, stdio: 'inherit', env: { ...process.env, MAGPIE_SOURCE: source },
  })
  return out
}

async function main() {
  const root = path.resolve(arg('--root', DEFAULT_ROOT))
  const binary = arg('--binary', DEFAULT_BINARY)
  const source = arg('--from', process.env.MAGPIE_RELEASE_SOURCE || null)
  const fromBuild = arg('--from-build', process.env.MAGPIE_SOURCE || null)

  if (action === 'status') {
    const status = readStatus(root)
    return out({
      action: 'status',
      root,
      binary,
      currentVersion: currentVersion(root, binary),
      lastCheckedAt: status?.lastCheckedAt ?? null,
      lastResult: status?.lastResult ?? null,
      latestVersion: status?.latestVersion ?? null,
      backupPath: status?.backupPath ?? null,
      error: status?.error ?? null,
    })
  }

  if (action === 'check' || action === 'rehearse' || action === 'apply') {
    if (action === 'apply' && !flag('--confirm-apply')) {
      process.stderr.write('拒绝执行：apply 需要显式 --confirm-apply（未经确认不得替换正在运行的内核）\n')
      process.exitCode = 2
      return
    }
    if (!source && !fromBuild) {
      process.stderr.write('缺少发布源：用 --from <dir|URL>（演练）或 --from-build <上游 checkout>（生产）\n')
      process.exitCode = 2
      return
    }
    const startedAt = new Date().toISOString()
    const current = currentVersion(root, binary)
    const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'magpie-update-'))
    let manifest
    let staged
    let buildStaged = null
    try {
      const upstreamVersion = fromBuild
        ? `crosery-${execFileSync('git', ['-C', fromBuild, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim().slice(0, 7)}`
        : null
      manifest = fromBuild ? { version: upstreamVersion, files: [] } : await readRelease(source)
      const latest = manifest.version
      if (action === 'check') {
        const next = { lastCheckedAt: startedAt, latestVersion: latest, currentVersion: current, lastResult: latest === current ? 'up-to-date' : 'update-available', backupPath: null, error: null }
        writeStatus(root, { ...(readStatus(root) || {}), ...next })
        return out({ action: 'check', currentVersion: current, latestVersion: latest, status: next.lastResult, executable: false })
      }
      if (latest === current) {
        writeStatus(root, { ...(readStatus(root) || {}), lastCheckedAt: startedAt, latestVersion: latest, currentVersion: current, lastResult: 'up-to-date', backupPath: null, error: null })
        return out({ action, currentVersion: current, latestVersion: latest, status: 'up-to-date', changed: false, note: '版本相同，什么都不做（幂等）' })
      }
      staged = fromBuild ? null : await downloadTo(source, manifest, stage)
      if (fromBuild) buildStaged = buildFromUpstream({ source: fromBuild, stage, binary })
      const stagedBinary = fromBuild ? buildStaged : staged.get(binary)
      if (!stagedBinary) throw new Error(`发布源里没有 ${binary}`)
      const targetRoot = action === 'rehearse' ? path.join(stage, 'root') : root
      if (action === 'rehearse') {
        // 演练：临时 root 里先放一份带**旧版本号**的"当前产物"，备份/替换/回滚都会真的发生
        fs.mkdirSync(targetRoot, { recursive: true, mode: 0o700 })
        const currentBinary = path.join(targetRoot, binary)
        if (!fs.existsSync(currentBinary)) {
          fs.writeFileSync(currentBinary, Buffer.from('rehearsal-current crosery-0000000\n'), { mode: 0o755 })
        }
      }
      const expectedVersion = manifest.version || embeddedVersion(fs.readFileSync(stagedBinary)) || undefined
      const swapped = swapIn({
        root: targetRoot,
        binary,
        staged: stagedBinary,
        backupSuffix: `${current || 'unknown'}-${Date.now()}`,
        verify: true,
        expectedSha: manifest.sha256 || sha256(fs.readFileSync(stagedBinary)),
        // 构建路径的期望版本就是内嵌版本（build.sh 写入 crosery-<rev7>），仍会做版本回读比对
        expectedVersion,
      })
      const result = swapped.ok ? (action === 'rehearse' ? 'rehearsed' : 'updated') : 'rolled-back'
      writeStatus(root, {
        lastCheckedAt: startedAt, latestVersion: manifest.version || expectedVersion, currentVersion: swapped.ok && action === 'apply' ? (manifest.version || expectedVersion) : current,
        lastResult: result, backupPath: swapped.backup || null, error: swapped.error || null, stage,
      })
      if (!swapped.ok) {
        process.stderr.write(`更新失败并已回滚：${swapped.error}\n`)
        process.exitCode = 1
      }
      return out({ action, currentVersion: current, latestVersion: manifest.version || expectedVersion, status: result, changed: swapped.ok, backup: swapped.backup || null, sha256: swapped.sha256 || null, stage, ...(swapped.error ? { error: swapped.error } : {}) })
    } catch (error) {
      // 下载/构建阶段失败：旧版本**没有被碰过**（替换发生在校验之后），如实报错并留下状态
      writeStatus(root, { ...(readStatus(root) || {}), lastCheckedAt: startedAt, currentVersion: current, lastResult: 'failed-before-swap', backupPath: null, error: String(error?.message || error) })
      process.stderr.write(`更新失败（旧版本未被改动）：${error?.message || error}\n`)
      process.exitCode = 1
      return
    } finally {
      if (action !== 'rehearse') fs.rmSync(stage, { recursive: true, force: true })
    }
  }

  process.stderr.write('用法：magpie-update.mjs status|check|rehearse|apply --confirm-apply [--root DIR] [--from DIR|URL | --from-build CHECKOUT]\n')
  process.exitCode = 2
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  main().catch((error) => { process.stderr.write(`${error?.stack || error}\n`); process.exitCode = 1 })
}

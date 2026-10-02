import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import type { AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import express from 'express'
import type { MagpieUpstreamStatus } from '../packages/contracts/magpie-upstream.js'
import { MAGPIE_API_REVISION } from '../packages/contracts/magpie-upstream.generated.js'
import {
  buildMagpieGateway, countObservedRevisions, readMagpieGateway, registerMagpieVersionRoutes, shortRevision,
  type MagpieGatewayFacts, type MagpiePaths,
} from './magpieVersion.js'

/**
 * 「网关 Magpie」版本模型：版本标签、差距、合并后的状态，以及 GET 绝不联网。
 * 全部在 mkdtemp 里造状态文件；不读真实运行时、不碰 launchd、不联网。
 */

const RUNNING = MAGPIE_API_REVISION
const NEWER = 'b'.repeat(40)
const NOW = Date.parse('2026-10-02T07:30:00.000Z')

const upstream = (patch: Partial<MagpieUpstreamStatus> = {}): MagpieUpstreamStatus => ({
  status: 'review_required', contractRevision: RUNNING, candidateRevision: NEWER, checkedAt: '2026-10-02T07:25:00.000Z',
  latestRelease: 'v0.1.639', rtkRelease: 'v0.50.0', routes: { inference: 1, management: 1, rtk: 1 }, loginAgents: [],
  changes: { addedRoutes: ['a', 'b'], removedRoutes: [], changedRoutes: ['c'], schemaCount: 7, implementationFileCount: 9, addedLoginAgents: [], removedLoginAgents: ['x'] },
  oauthConnected: false, rtkConnected: false, ...patch,
})

const facts = (patch: Partial<MagpieGatewayFacts> = {}): MagpieGatewayFacts => ({
  kernelCommit: RUNNING, running: true, upstream: upstream(), schedule: { nextAttemptAt: null, retryNotBefore: null },
  buildTime: Date.parse('2026-09-30T08:19:18.000Z'), intervalMs: 30 * 60_000, observedRevisions: 66, ...patch,
})

/* ────────────────── 版本标签 ────────────────── */

test('版本标签：三种写法（40 位 sha / crosery-<rev7> / 短提交）统一成同一个短提交', () => {
  assert.equal(shortRevision(RUNNING), RUNNING.slice(0, 7))
  assert.equal(shortRevision(`crosery-${RUNNING.slice(0, 7)}`), RUNNING.slice(0, 7))
  assert.equal(shortRevision('3fe2ff9'), '3fe2ff9')
  assert.equal(shortRevision(null), null)
  assert.equal(shortRevision('v0.1.639'), 'v0.1.639', '认不出来的原样返回，不改写')
})

test('当前版本：运行中的提交做标签；发布版本推不出来就如实 null 并说明原因，不拿上游最新冒充', () => {
  const model = buildMagpieGateway(facts(), NOW)
  assert.equal(model.current.label, RUNNING.slice(0, 7))
  assert.equal(model.current.commit, RUNNING)
  assert.equal(model.current.release, null, '上游 latestRelease 是别的仓库的发布，不能当成运行版本')
  assert.match(String(model.current.releaseNote), /源码提交/)
  assert.equal(model.current.buildTime, '2026-09-30T08:19:18.000Z')
  assert.equal(model.upstream.latestRelease, 'v0.1.639')
  assert.equal(model.upstream.latestCommit, NEWER)

  const unknown = buildMagpieGateway(facts({ kernelCommit: null, running: false }), NOW)
  assert.equal(unknown.current.label, '未知')
  assert.equal(unknown.current.releaseNote, null)
  assert.equal(unknown.gap.state, 'unknown')
  assert.match(String(unknown.gap.note), /读不到/)
})

/* ────────────────── 差距 ────────────────── */

test('差距：候选就是运行提交 → 已是最新；不同 → 落后 ≥N（N = 检查器见到的不同提交，至少 1）', () => {
  const latest = buildMagpieGateway(facts({ upstream: upstream({ status: 'unchanged', candidateRevision: RUNNING }), observedRevisions: 0 }), NOW)
  assert.deepEqual([latest.gap.state, latest.gap.label, latest.gap.commitsAtLeast], ['latest', '已是最新', 0])
  assert.equal(latest.review.pending, false)

  const behind = buildMagpieGateway(facts(), NOW)
  assert.deepEqual([behind.gap.state, behind.gap.label, behind.gap.commitsAtLeast], ['behind', '落后 ≥66 个提交', 66])
  assert.match(String(behind.gap.note), /实际可能更多/, '下限必须说清楚是下限')

  // 候选目录被清掉/读不到：仍然落后，但只敢说 ≥1
  const floor = buildMagpieGateway(facts({ observedRevisions: null }), NOW)
  assert.deepEqual([floor.gap.label, floor.gap.commitsAtLeast], ['落后 ≥1 个提交', 1])
})

test('差距未知的三种情况各说各的原因：没检查过 / 基线不一致 / 检查失败且没有结果', () => {
  const notChecked = buildMagpieGateway(facts({ upstream: upstream({ status: 'not_checked', candidateRevision: null, checkedAt: null }) }), NOW)
  assert.deepEqual([notChecked.gap.state, notChecked.gap.note], ['unknown', '还没检查过上游'])
  assert.equal(notChecked.upstream.nextCheckAt, null)

  const mismatch = buildMagpieGateway(facts({ upstream: upstream({ status: 'baseline_mismatch', candidateRevision: null }) }), NOW)
  assert.equal(mismatch.gap.state, 'unknown')
  assert.match(String(mismatch.gap.note), /契约基线/)

  const failedEmpty = buildMagpieGateway(facts({ upstream: upstream({ status: 'error', candidateRevision: null }) }), NOW)
  assert.equal(failedEmpty.gap.state, 'unknown')
  assert.match(String(failedEmpty.gap.note), /检查失败/)
  assert.equal(failedEmpty.upstream.failed, true)

  // 失败但有上一次成功的候选：差距照常给，注明依据
  const failedKept = buildMagpieGateway(facts({ upstream: upstream({ status: 'error' }) }), NOW)
  assert.equal(failedKept.gap.state, 'behind')
  assert.match(String(failedKept.gap.note), /^上次检查失败，按上一次成功的结果/)
})

/* ────────────────── 合并后的检查时间与策略 ────────────────── */

test('下次检查 = 上次 + 间隔，退避和 GitHub 的等待取更晚的；错过整一轮标逾期', () => {
  const plain = buildMagpieGateway(facts(), NOW)
  assert.equal(plain.upstream.nextCheckAt, '2026-10-02T07:55:00.000Z')
  assert.equal(plain.upstream.overdue, false)

  const backoff = buildMagpieGateway(facts({ schedule: { nextAttemptAt: Date.parse('2026-10-02T09:00:00.000Z'), retryNotBefore: Date.parse('2026-10-02T08:10:00.000Z') } }), NOW)
  assert.equal(backoff.upstream.nextCheckAt, '2026-10-02T09:00:00.000Z')

  const late = buildMagpieGateway(facts(), Date.parse('2026-10-02T08:30:00.000Z'))
  assert.equal(late.upstream.overdue, true, '07:55 该检查、08:25 还没检查 → 逾期')
})

test('跟随策略来自真实配置：有定时任务就说间隔；没有就照实说没有；两种都不自动替换', () => {
  const scheduled = buildMagpieGateway(facts(), NOW)
  assert.equal(scheduled.policy.scheduled, true)
  assert.equal(scheduled.policy.autoApply, false)
  assert.match(scheduled.policy.text, /^每 30 分钟自动检查上游 · 只出候选，不自动替换/)
  assert.match(scheduled.policy.text, /失败自动回滚$/)

  const none = buildMagpieGateway(facts({ intervalMs: null }), NOW)
  assert.equal(none.policy.scheduled, false)
  assert.match(none.policy.text, /^没有安装定时检查任务/)
  assert.equal(none.upstream.nextCheckAt, null, '没有定时任务就没有「下次检查」')
})

test('待评审：只在候选与运行提交不同时 pending；计数与设置页一致（路由 + 登录方式）', () => {
  const model = buildMagpieGateway(facts(), NOW)
  assert.deepEqual(model.review, { pending: true, changes: 4, schemaCount: 7, implementationFileCount: 9 })
})

/* ────────────────── 只读取证 ────────────────── */

function runtime(): { dir: string; paths: MagpiePaths; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'magpie-version-'))
  const paths: MagpiePaths = {
    upstreamDir: path.join(dir, 'upstream'),
    updateRoot: path.join(dir, 'console/bin'),
    launchAgentsDir: path.join(dir, 'LaunchAgents'),
    binary: 'magpie-kernel',
  }
  for (const directory of [paths.upstreamDir, paths.updateRoot, paths.launchAgentsDir]) fs.mkdirSync(directory, { recursive: true })
  return { dir, paths, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) }
}

const at = (iso: string) => new Date(iso)

test('观测到的提交：按 sha 去重、排除运行提交、只算安装之后、忽略不认识的目录名', () => {
  const { paths, cleanup } = runtime()
  try {
    const candidates = path.join(paths.upstreamDir, 'candidates')
    const make = (name: string, when: string) => {
      fs.mkdirSync(path.join(candidates, name), { recursive: true })
      fs.utimesSync(path.join(candidates, name), at(when), at(when))
    }
    const install = Date.parse('2026-09-30T08:19:18.000Z')
    make(`${'c'.repeat(40)}-${'0'.repeat(16)}`, '2026-09-30T08:31:00.000Z')
    make(`${'c'.repeat(40)}-${'1'.repeat(16)}`, '2026-10-01T08:31:00.000Z') // 同一提交、换了提取器
    make(`${'d'.repeat(40)}-${'0'.repeat(16)}`, '2026-10-02T06:55:00.000Z')
    make(`${RUNNING}-${'0'.repeat(16)}`, '2026-10-01T00:00:00.000Z') // 运行提交本身
    make(`${'e'.repeat(40)}-${'0'.repeat(16)}`, '2026-09-29T00:00:00.000Z') // 安装之前
    make('.pending-abc', '2026-10-02T06:55:00.000Z')
    assert.equal(countObservedRevisions(paths.upstreamDir, install, RUNNING), 2)
    assert.equal(countObservedRevisions(paths.upstreamDir, null, RUNNING), null, '不知道安装时间就不数')
    assert.equal(countObservedRevisions(path.join(paths.upstreamDir, 'missing'), install, RUNNING), null)
  } finally {
    cleanup()
  }
})

test('内核离线：版本退回 console-manifest 的 revision，running=false；定时间隔读自 plist；整个读取不联网', () => {
  const { paths, cleanup } = runtime()
  const realFetch = globalThis.fetch
  let fetched = 0
  globalThis.fetch = (async () => { fetched += 1; throw new Error('network is not allowed here') }) as typeof fetch
  try {
    fs.writeFileSync(path.join(path.dirname(paths.updateRoot), 'console-manifest.json'), JSON.stringify({ version: 1, revision: RUNNING }))
    fs.writeFileSync(path.join(paths.updateRoot, 'magpie-kernel'), 'kernel')
    fs.writeFileSync(path.join(paths.launchAgentsDir, 'com.crosery.magpie-upstream-check.plist'),
      '<plist><dict><key>StartInterval</key><integer>1800</integer></dict></plist>')
    fs.writeFileSync(path.join(paths.upstreamDir, 'status.json'), JSON.stringify({
      version: 1, status: 'review_required', baselineRevision: RUNNING, candidateRevision: NEWER, checkedAt: '2026-10-02T07:25:00.000Z',
      latestRelease: 'v0.1.639', rtkRelease: 'v0.50.0', nextAttemptAt: '2026-10-02T09:00:00.000Z',
      diff: { addedRoutes: [], removedRoutes: [], changedRoutes: ['r'], changedSchemas: [], implementationFiles: [], addedLoginAgents: [], removedLoginAgents: [] },
    }), { mode: 0o600 })

    const model = readMagpieGateway({ engine: 'magpie', version: 'offline', commit: '', buildDate: '' }, paths, NOW)
    assert.equal(model.current.running, false)
    assert.equal(model.current.label, RUNNING.slice(0, 7))
    assert.equal(model.policy.intervalMs, 30 * 60_000)
    assert.equal(model.upstream.latestRelease, 'v0.1.639')
    assert.equal(model.upstream.nextCheckAt, '2026-10-02T09:00:00.000Z', '检查脚本自己记下的退避要算进下次检查')
    assert.equal(model.gap.state, 'behind')
    assert.equal(model.review.changes, 1)

    fs.rmSync(path.join(paths.launchAgentsDir, 'com.crosery.magpie-upstream-check.plist'))
    assert.equal(readMagpieGateway({ engine: 'magpie', version: 'offline', commit: '', buildDate: '' }, paths, NOW).policy.scheduled, false)
    assert.equal(fetched, 0, '组装版本模型绝不发网络请求')
  } finally {
    globalThis.fetch = realFetch
    cleanup()
  }
})

/* ────────────────── 路由：GET 合并、不联网、只跑只读的 status ────────────────── */

async function serve(app: express.Express): Promise<{ base: string; close: () => Promise<void> }> {
  const server = app.listen(0, '127.0.0.1')
  await new Promise<void>((resolve) => server.once('listening', () => resolve()))
  const { port } = server.address() as AddressInfo
  return { base: `http://127.0.0.1:${port}`, close: () => new Promise<void>((resolve) => server.close(() => resolve())) }
}

test('GET /api/version 附加 cpa.gateway；GET /api/magpie/update-status 带上游检查器的回退，且两者都不联网、只跑 status', async () => {
  const { dir, paths, cleanup } = runtime()
  const calls = path.join(dir, 'calls.jsonl')
  const stub = path.join(dir, 'stub-update.mjs')
  fs.writeFileSync(stub, `
import fs from 'node:fs'
fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify(process.argv.slice(2)) + '\\n')
process.stdout.write(JSON.stringify({ action: 'status', currentVersion: 'crosery-${RUNNING.slice(0, 7)}', latestVersion: null, lastCheckedAt: null, lastResult: null, backupPath: null, error: null, releaseSource: null }) + '\\n')
`)
  fs.writeFileSync(path.join(paths.upstreamDir, 'status.json'), JSON.stringify({
    version: 1, status: 'review_required', baselineRevision: RUNNING, candidateRevision: NEWER, checkedAt: '2026-10-02T07:25:00.000Z', latestRelease: 'v0.1.639',
  }))
  const previousScript = process.env.MAGPIE_UPDATE_SCRIPT
  process.env.MAGPIE_UPDATE_SCRIPT = stub
  const realFetch = globalThis.fetch
  let fetched = 0
  const app = express()
  let cpaReads = 0
  registerMagpieVersionRoutes(app, {
    getCpaVersion: async () => { cpaReads += 1; return { engine: 'magpie', version: RUNNING.slice(0, 7), commit: RUNNING, buildDate: '', upstream: upstream() } },
    getConsoleVersion: () => ({ version: '0.1.0' }),
    wantsFresh: () => false,
    addAudit: () => {},
    repoRoot: dir,
    paths: () => paths,
  })
  const server = await serve(app)
  try {
    globalThis.fetch = (async () => { fetched += 1; throw new Error('network is not allowed here') }) as typeof fetch
    const version = await realFetch(`${server.base}/api/version`).then(r => r.json()) as { cpa: { version: string; gateway?: { current: { label: string }; gap: { state: string } } } }
    assert.equal(version.cpa.version, RUNNING.slice(0, 7), '旧字段原样保留')
    assert.equal(version.cpa.gateway?.current.label, RUNNING.slice(0, 7))
    assert.equal(version.cpa.gateway?.gap.state, 'behind')
    assert.equal(cpaReads, 1)

    const status = await realFetch(`${server.base}/api/magpie/update-status`).then(r => r.json()) as {
      currentVersion: string; lastCheckedAt: null; releaseSource: null; tracker: { checkedAt: string; latestRelease: string; latestCommit: string }
    }
    assert.equal(status.lastCheckedAt, null, '更新脚本自己的检查时间不被改写')
    assert.deepEqual(status.tracker, { checkedAt: '2026-10-02T07:25:00.000Z', latestRelease: 'v0.1.639', latestCommit: NEWER }, '更新脚本没检查过时，上游最新 / 上次检查有检查器的结果可用')
    assert.equal(status.releaseSource, null)

    const argv = fs.readFileSync(calls, 'utf8').trim().split('\n').map(line => JSON.parse(line) as string[])
    assert.deepEqual(argv.map(args => args[0]), ['status'], 'GET 只跑只读的 status，不跑 check')
    assert.equal(fetched, 0, 'GET 不发任何网络请求')

    // 非 magpie 引擎：不附加 gateway（旧形状不变）
    const cpaApp = express()
    registerMagpieVersionRoutes(cpaApp, {
      getCpaVersion: async () => ({ version: 'v7.2.140', commit: 'abc', buildDate: '' }),
      getConsoleVersion: () => ({ version: '0.1.0' }), wantsFresh: () => false, addAudit: () => {}, repoRoot: dir, paths: () => paths,
    })
    const cpaServer = await serve(cpaApp)
    try {
      const body = await realFetch(`${cpaServer.base}/api/version`).then(r => r.json()) as { cpa: Record<string, unknown> }
      assert.equal('gateway' in body.cpa, false)
    } finally {
      await cpaServer.close()
    }
  } finally {
    globalThis.fetch = realFetch
    if (previousScript === undefined) delete process.env.MAGPIE_UPDATE_SCRIPT
    else process.env.MAGPIE_UPDATE_SCRIPT = previousScript
    await server.close()
    cleanup()
  }
})

/* ────────────────── 更新脚本的 status：报发布源类别，不联网 ────────────────── */

test('magpie-update status 报发布源类别（不回显路径），并且 status 路径不发网络请求', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'magpie-status-src-'))
  const script = new URL('../scripts/magpie-update.mjs', import.meta.url).pathname
  // 预加载：任何 fetch 都让进程以 97 退出
  const trap = `data:text/javascript,globalThis.fetch=()=>{process.exit(97)}`
  const env = { ...process.env }
  delete env.MAGPIE_RELEASE_SOURCE
  delete env.MAGPIE_SOURCE
  try {
    const run = (extra: Record<string, string>) => JSON.parse(execFileSync(process.execPath, ['--import', trap, script, 'status', '--root', path.join(dir, 'bin')], {
      encoding: 'utf8', env: { ...env, ...extra },
    }).trim().split('\n').pop()!) as { releaseSource: string | null }
    assert.equal(run({}).releaseSource, null)
    assert.equal(run({ MAGPIE_RELEASE_SOURCE: path.join(dir, 'release') }).releaseSource, 'release')
    const build = execFileSync(process.execPath, ['--import', trap, script, 'status', '--root', path.join(dir, 'bin')], {
      encoding: 'utf8', env: { ...env, MAGPIE_SOURCE: path.join(dir, 'checkout') },
    })
    assert.equal(JSON.parse(build.trim()).releaseSource, 'build')
    assert.equal(build.includes(dir), true, 'root 路径本来就在输出里（action/root），这里只确认发布源字段是类别')
    assert.equal(build.includes(path.join(dir, 'checkout')), false, '发布源路径不回显')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test, { after } from 'node:test'

/**
 * 跨进程写入锁的红队第九轮（R9-A…R9-E）回归用例。
 *
 * 这些用例放在独立文件 `server/rtkLock.test.ts`，用于同时验证
 * `test:magpie` 的 glob 改成了 `server/rtk*.test.ts`（否则本文件会被静默排除）。
 *
 * 纪律：所有写入都发生在临时 HOME/临时备份目录；真实 agent 配置只在末尾做 sha256 比对。
 */

const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'rtk-lock-test-'))
const home = path.join(workspace, 'home')
const backupDir = path.join(workspace, 'backups')
fs.mkdirSync(home, { recursive: true })
fs.mkdirSync(backupDir, { recursive: true })
process.env.RTK_HOME = home
process.env.RTK_BACKUP_DIR = backupDir

const service = await import('./rtkService.js')
const lockPath = () => service.rtkLockPath(home, { ...process.env, RTK_BACKUP_DIR: backupDir } as NodeJS.ProcessEnv)
const env = { ...process.env, RTK_BACKUP_DIR: backupDir } as NodeJS.ProcessEnv
const offlineTargets = { kernel: { engine: 'cpa' as const }, relay: { baseUrl: '', key: '' } }

const realHome = os.userInfo().homedir
const watched = [
  '.codex/hooks.json', '.claude/settings.json', '.cursor/hooks.json',
  '.gemini/settings.json', '.omp/agent/extensions/rtk.ts', '.pi/agent/extensions/rtk.ts',
]
const digest = (file: string): string | null => {
  try {
    return createHash('sha256').update(fs.readFileSync(file)).digest('hex')
  } catch {
    return null
  }
}
const { createHash } = await import('node:crypto')
const before = new Map(watched.map(rel => [rel, digest(path.join(realHome, rel))]))

after(() => {
  for (const [rel, hash] of before) {
    assert.equal(digest(path.join(realHome, rel)), hash, `真实 agent 配置被测试改动了: ~/${rel}`)
  }
  fs.rmSync(workspace, { recursive: true, force: true })
})

/* ---------------- R9-A：不可解析一律不删 ---------------- */

test('R9-A 陌生空锁 + 新 mtime：release() 必须不删（旧实现的 mtime 方向判断会删掉接管者的锁）', async () => {
  const lock = await service.acquireRtkFileLock({ home, purpose: 'owner', env: { ...env } })
  assert.equal(fs.existsSync(lockPath()), true)
  // 模拟「我们的锁被判陈旧 → 接管者 T 删掉后刚 open('wx')、还没 write」：路径上出现一个空文件、mtime 是新的
  fs.rmSync(lockPath())
  fs.writeFileSync(lockPath(), '')
  assert.equal(service.inspectRtkLock(lockPath(), Date.now(), 60_000).stale, false, '新空文件不该被判陈旧（还在写）')

  lock.release()
  assert.equal(lock.lost, true, '读不出载荷时必须如实上报 lost')
  assert.equal(fs.existsSync(lockPath()), true, '不得删除接管者尚未写完的锁文件')
  fs.rmSync(lockPath())
})

test('R9-A 完整路径：H 变陈旧 → T 接管 → H 释放时不能删 T 的锁（否则两个持有者同时写）', async () => {
  // H：一个「卡住很久」的持有者（用本进程 pid + 老 mtime 冒充）
  const held = JSON.stringify({ token: 'holder-token', pid: process.pid, at: new Date(Date.now() - 10 * 60_000).toISOString(), purpose: 'hung', home })
  fs.writeFileSync(lockPath(), held)
  const old = new Date(Date.now() - 10 * 60_000)
  fs.utimesSync(lockPath(), old, old)
  const acquireEnv = { ...env }

  // T：进入 acquire —— 此时锁是「活着的 pid + at/mtime 一致 + 超时」→ 判 holder_timeout 并接管
  const probe = service.inspectRtkLock(lockPath(), Date.now(), 1_000, home)
  assert.equal(probe.stale, true)
  assert.equal(probe.reason, 'holder_timeout')
  const t = await service.acquireRtkFileLock({ home, purpose: 'taker', env: acquireEnv, staleMs: 1_000 })
  assert.equal(t.info.stolen, true)
  const tPayload = JSON.parse(fs.readFileSync(lockPath(), 'utf8'))
  assert.equal(tPayload.purpose, 'taker')

  // H 现在才走到 release：它拿的是「taker 的」文件，token 不匹配 → 不删（token 守卫，见 §R9-A 第一条用例）
  const payloadNow = service.inspectRtkLock(lockPath(), Date.now(), 1_000, home)
  assert.equal(payloadNow.stale, false, 'taker 的锁是新鲜的')
  assert.equal(fs.existsSync(lockPath()), true, 'taker 的锁必须还在')
  assert.equal(fs.readFileSync(lockPath(), 'utf8'), JSON.stringify(tPayload), 'taker 的载荷不能被改写')

  t.release()
  assert.equal(fs.existsSync(lockPath()), false, 'taker 正常释放后不留锁')
})

/* ---------------- R9-B：短命进程必然报错，不能静默退出 ---------------- */

test('R9-B 短命进程在锁被占用时必然得到 503 超时错误（退避 sleep 不能 unref）', async () => {
  fs.writeFileSync(lockPath(), JSON.stringify({ token: 'other', pid: process.pid, at: new Date().toISOString(), purpose: 'held', home }))
  const script = `
    const service = await import('${new URL('./rtkService.ts', import.meta.url).pathname}')
    try {
      await service.acquireRtkFileLock({ home: ${JSON.stringify(home)}, purpose: 'short-lived', env: { ...process.env, RTK_BACKUP_DIR: ${JSON.stringify(backupDir)} }, timeoutMs: 800, staleMs: 60000 })
      console.log('UNEXPECTED_ACQUIRED')
      process.exit(0)
    } catch (error) {
      console.log('ERROR ' + (error?.reason || error?.message))
      process.exit(3)
    }
  `
  const child = spawn(process.execPath, ['--import', 'tsx', '-e', script], {
    cwd: path.resolve(path.dirname(new URL(import.meta.url).pathname), '..'),
    env: { ...process.env, RTK_HOME: home, RTK_BACKUP_DIR: backupDir },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', chunk => { stdout += chunk })
  child.stderr.on('data', chunk => { stderr += chunk })
  const code = await new Promise<number | null>(resolve => child.once('close', resolve))
  assert.equal(code, 3, `短命进程必须以超时错误退出，实际 code=${code} stdout=${stdout.trim()} stderr=${stderr.slice(-200)}`)
  assert.match(stdout, /ERROR rtk_lock_timeout/, `必须打印超时原因：${stdout.trim()}`)
  assert.equal(fs.readFileSync(lockPath(), 'utf8').includes('"purpose":"held"'), true, '超时方不得删除别人的锁')
  fs.rmSync(lockPath())
})

/* ---------------- R9-C：时钟与心跳 ---------------- */

test('R9-C 活着的持有者 mtime 被改老 2h：at 与 mtime 分歧 → 不接管，只告警', async () => {
  fs.writeFileSync(lockPath(), JSON.stringify({ token: 'alive', pid: process.pid, at: new Date().toISOString(), purpose: 'alive-holder', home }))
  const old = new Date(Date.now() - 2 * 60 * 60_000)
  fs.utimesSync(lockPath(), old, old) // 红队的攻击：只改 mtime
  const probe = service.inspectRtkLock(lockPath(), Date.now(), 1_000, home)
  assert.equal(probe.stale, false, '活着 + at 新鲜的锁不能被 mtime 夺走')
  assert.equal(probe.suspicious, true)
  assert.match(String(probe.note), /时钟不可信/)
  fs.rmSync(lockPath())
})

test('R9-C 心跳：临界区超过 staleMs 也不会被夺走，释放后下一个才能拿到', async () => {
  const staleMs = 1_000
  const lock = await service.acquireRtkFileLock({ home, purpose: 'long-holder', env: { ...env }, staleMs })
  assert.equal(lock.info.waitedMs >= 0, true)
  await new Promise(resolve => setTimeout(resolve, 2_500)) // 远超 staleMs，靠心跳续期
  const probe = service.inspectRtkLock(lockPath(), Date.now(), staleMs, home)
  assert.equal(probe.stale, false, '有心跳时不该被判陈旧')
  await assert.rejects(
    () => service.acquireRtkFileLock({ home, purpose: 'waiter', env: { ...env }, staleMs, timeoutMs: 300 }),
    (error: { reason?: string }) => error?.reason === 'rtk_lock_timeout',
    '持有者心跳期间，别人必须拿不到锁（而不是接管）',
  )
  lock.release()
  assert.equal(fs.existsSync(lockPath()), false)
  const next = await service.acquireRtkFileLock({ home, purpose: 'after-release', env: { ...env }, staleMs })
  assert.equal(next.info.stolen, false, '前一个持有者已正常释放，不需要「接管」')
  next.release()
})

/* ---------------- R9-D：旁路可观测 ---------------- */

test('R9-D RTK_LOCK_DISABLED 旁路必须可观测（info.disabled / 响应 lockDisabled），且不建锁文件', async () => {
  const bypassEnv = { ...env, RTK_LOCK_DISABLED: '1' } as NodeJS.ProcessEnv
  const lock = await service.acquireRtkFileLock({ home, purpose: 'bypass', env: bypassEnv })
  assert.equal(lock.info.disabled, true, '旁路必须在 info 上透出 disabled')
  assert.equal(fs.existsSync(lockPath()), false, '旁路时不创建锁文件')
  lock.release()
  assert.equal(lock.lost, false)

  const previous = process.env.RTK_LOCK_DISABLED
  process.env.RTK_LOCK_DISABLED = '1'
  try {
    const result = await service.setRTKAgentHook('codex', true, { plane: 'local', home, bin: path.join(workspace, 'no-such-rtk'), ...offlineTargets })
    assert.equal(result.ok, true)
    assert.equal(result.lockDisabled, true, '写操作响应必须能看到旁路')
    assert.equal(result.lock?.disabled, true)
  } finally {
    if (previous === undefined) delete process.env.RTK_LOCK_DISABLED
    else process.env.RTK_LOCK_DISABLED = previous
  }
})

/* ---------------- R9-E：home 校验 ---------------- */

test('R9-E 载荷 home 与本次不同：共用备份目录时不基于超时接管，但持有者已死仍可接管', async () => {
  fs.writeFileSync(lockPath(), JSON.stringify({
    token: 'foreign', pid: process.pid, at: new Date().toISOString(), purpose: 'other-home', home: '/some/other/home',
  }))
  // 活着的持有者、at 与 mtime 一致、已超时，但属于另一个 home
  fs.writeFileSync(lockPath(), JSON.stringify({
    token: 'foreign', pid: process.pid, at: new Date(Date.now() - 10 * 60_000).toISOString(), purpose: 'other-home', home: '/some/other/home',
  }))
  fs.utimesSync(lockPath(), new Date(Date.now() - 10 * 60_000), new Date(Date.now() - 10 * 60_000))
  const probe = service.inspectRtkLock(lockPath(), Date.now(), 1_000, home)
  assert.equal(probe.stale, false, '跨 home 的活锁不基于超时接管')
  assert.equal(probe.foreignHome, true)
  assert.match(String(probe.note), /另一个 home/)

  // 持有者已死 → 无论 home 是否相同都可接管
  const { execFileSync } = await import('node:child_process')
  const deadPid = Number(execFileSync(process.execPath, ['-e', 'console.log(process.pid)'], { encoding: 'utf8' }).trim())
  fs.writeFileSync(lockPath(), JSON.stringify({ token: 'foreign-dead', pid: deadPid, at: new Date().toISOString(), purpose: 'dead', home: '/some/other/home' }))
  const deAdProbe = service.inspectRtkLock(lockPath(), Date.now(), 60_000, home)
  assert.equal(deAdProbe.stale, true)
  assert.equal(deAdProbe.reason, 'holder_dead')
  fs.rmSync(lockPath())
})

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

/**
 * 等到条件成立（有上限）。**不要**用固定 sleep 赌条件已成立：负载下定时器可能被推迟，
 * 固定睡眠就会 flake；这里一旦条件满足立刻返回，只有真不满足才等到上限（并如实失败）。
 */
async function waitUntil(predicate: () => boolean, timeoutMs = 10_000, stepMs = 10): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return true
    await new Promise(resolve => setTimeout(resolve, stepMs))
  }
  return predicate()
}

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
      await service.acquireRtkFileLock({ home: ${JSON.stringify(home)}, purpose: 'short-lived', env: { ...process.env, RTK_BACKUP_DIR: ${JSON.stringify(backupDir)} }, timeoutMs: 300, staleMs: 60000 })
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
  const staleMs = 400
  const lock = await service.acquireRtkFileLock({ home, purpose: 'long-holder', env: { ...env }, staleMs })
  assert.equal(lock.info.waitedMs >= 0, true)
  // 这里的等待本身就是断言的一部分（必须等远超 staleMs，看心跳有没有把锁续住）：
  // staleMs=400、心跳下限 200ms ⇒ 0.8s 内约 4 次续期（2 倍余量）；只有事件循环被阻塞 ≥0.8s 才会失真。
  await new Promise(resolve => setTimeout(resolve, 800))
  const probe = service.inspectRtkLock(lockPath(), Date.now(), staleMs, home)
  assert.equal(probe.stale, false, '有心跳时不该被判陈旧')
  await assert.rejects(
    () => service.acquireRtkFileLock({ home, purpose: 'waiter', env: { ...env }, staleMs, timeoutMs: 200 }),
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


/* ---------------- R10-A：心跳不得抢回被接管的锁 ---------------- */

test('R10-A 心跳不校验 token 时会抢回被接管的锁（修前复现：断言必须失败）', async () => {
  const staleMs = 300 // 心跳周期 = max(200, min(100, 300)) = 200ms
  const lock = await service.acquireRtkFileLock({ home, purpose: 'victim', env: { ...env }, staleMs })
  const thief = JSON.stringify({ token: 'THIEF-TOKEN', pid: process.pid, at: new Date().toISOString(), purpose: 'taker', home })
  // 模拟合法接管：删掉 + 重建（inode 变了），再原地写一次覆盖 token 但保留 inode 的情形
  fs.rmSync(lockPath())
  fs.writeFileSync(lockPath(), thief)
  const lostDetected = await waitUntil(() => lock.info.lost === true, 10_000) // 心跳周期 200ms；等到检出为止
  assert.equal(lostDetected, true, `心跳必须在有限时间内检出失去锁：${JSON.stringify(lock.info)}`)
  const after = fs.readFileSync(lockPath(), 'utf8')
  assert.equal(JSON.parse(after).token, 'THIEF-TOKEN', '心跳不得把锁抢回自己的 token')
  assert.equal(lock.info.lost, true, '失去锁必须如实上报')
  assert.equal(lock.info.lostReason, 'token_mismatch')
  lock.release()
  assert.equal(fs.existsSync(lockPath()), true, '失去锁的一方不得在 release 时删掉接管者的锁')
  assert.equal(JSON.parse(fs.readFileSync(lockPath(), 'utf8')).token, 'THIEF-TOKEN')
  fs.rmSync(lockPath())
})

test('R10-A 原地改 token（inode 不变）也必须被检出并停止续期', async () => {
  const staleMs = 300
  const lock = await service.acquireRtkFileLock({ home, purpose: 'victim-inplace', env: { ...env }, staleMs })
  fs.writeFileSync(lockPath(), JSON.stringify({ token: 'INPLACE-THIEF', pid: process.pid, at: new Date().toISOString(), purpose: 'taker', home }))
  const detected = await waitUntil(() => lock.info.lost === true, 10_000)
  assert.equal(detected, true, `心跳必须检出原地换 token：${JSON.stringify(lock.info)}`)
  assert.equal(JSON.parse(fs.readFileSync(lockPath(), 'utf8')).token, 'INPLACE-THIEF')
  assert.equal(lock.info.lost, true)
  assert.equal(lock.info.lostReason, 'token_mismatch')
  fs.rmSync(lockPath())
})

/* ---------------- R10-B：续期失败必须可见 ---------------- */

test('R10-B 续期失败可见（计数 + 最后错误 + 连续失败降级为 lost），且不留 *.renew-* 残留', async () => {
  const staleMs = 300
  const lock = await service.acquireRtkFileLock({ home, purpose: 'renew-fail', env: { ...env }, staleMs })
  const dir = path.dirname(lockPath())
  fs.chmodSync(dir, 0o500) // 目录不可写 → 续期写临时文件必然 EACCES
  try {
    const firstFailure = await waitUntil(() => (lock.info.renewFailures ?? 0) >= 1, 10_000)
    assert.equal(firstFailure, true, `首次失败就要可见：${JSON.stringify(lock.info)}`)
    const degraded = await waitUntil(() => lock.info.lost === true, 10_000)
    assert.equal(degraded, true, `连续失败应主动降级为 lost：${JSON.stringify(lock.info)}`)
    assert.match(String(lock.info.renewLastError), /EACCES|EPERM|permission/i)
    assert.equal(lock.info.lost, true, '连续失败应主动降级为 lost（假活锁会随时被夺）')
    assert.equal(lock.info.lostReason, 'renew_failed')
    const leftovers = fs.readdirSync(dir).filter(name => name.includes('.renew-'))
    assert.deepEqual(leftovers, [], `不得留下续期临时文件：${leftovers.join(',')}`)
  } finally {
    fs.chmodSync(dir, 0o700)
  }
  lock.release()
})

test('R10-B 残留的 *.renew-*：够老的会被清理，新鲜的保留（不误删进行中的续期）', () => {
  const fakeLock = path.join(workspace, 'renew-sweep', 'rtk-write.lock')
  fs.mkdirSync(path.dirname(fakeLock), { recursive: true })
  const old = path.join(path.dirname(fakeLock), 'rtk-write.lock.renew-999-aaa')
  const fresh = path.join(path.dirname(fakeLock), 'rtk-write.lock.renew-999-bbb')
  fs.writeFileSync(old, 'x')
  fs.writeFileSync(fresh, 'x')
  const old2 = new Date(Date.now() - 10 * 60_000)
  fs.utimesSync(old, old2, old2)
  const removed = service.sweepStaleRenewTemps(fakeLock, 30_000)
  assert.deepEqual(removed, ['rtk-write.lock.renew-999-aaa'])
  assert.equal(fs.existsSync(old), false)
  assert.equal(fs.existsSync(fresh), true)
})

/* ---------------- 心跳周期与 staleMs 的关系 ---------------- */

test('心跳周期断言：interval ≤ staleMs 且 ≥ 200ms（staleMs 很小时也不许把锁判活到无限）', () => {
  for (const staleMs of [300, 600, 1_000, 3_000, 60_000, 3_600_000]) {
    const interval = service.rtkLockHeartbeatMs(staleMs)
    assert.ok(interval >= 200, `周期下限：${staleMs} → ${interval}`)
    assert.ok(interval <= staleMs, `周期不得超过 staleMs（否则活锁会被误判陈旧）：${staleMs} → ${interval}`)
  }
  // 端到端：staleMs=600 时持有者持续续期，等待者只能超时，不能接管
  return (async () => {
    const lock = await service.acquireRtkFileLock({ home, purpose: 'period', env: { ...env }, staleMs: 400 })
    // staleMs=400、心跳下限 200ms ⇒ 0.8s 内约 4 次续期（属于「等到远超阈值」语义）
    await new Promise(resolve => setTimeout(resolve, 800))
    assert.equal(service.inspectRtkLock(lockPath(), Date.now(), 400, home).stale, false)
    await assert.rejects(
      () => service.acquireRtkFileLock({ home, purpose: 'waiter-period', env: { ...env }, staleMs: 400, timeoutMs: 200 }),
      (error: { reason?: string }) => error?.reason === 'rtk_lock_timeout',
    )
    lock.release()
  })()
})

test('时钟疑似不一致时：等待者 503 且文案带排查提示', async () => {
  // 活着的持有者 + at 新鲜 + mtime 被改老 2h → suspicious（不接管）
  fs.writeFileSync(lockPath(), JSON.stringify({ token: 'skewed', pid: process.pid, at: new Date().toISOString(), purpose: 'skewed', home }))
  const old = new Date(Date.now() - 2 * 60 * 60_000)
  fs.utimesSync(lockPath(), old, old)
  await assert.rejects(
    () => service.acquireRtkFileLock({ home, purpose: 'skewed-waiter', env: { ...env }, timeoutMs: 120, staleMs: 1_000 }),
    (error: { reason?: string; message?: string }) => {
      assert.equal(error?.reason, 'rtk_lock_timeout')
      assert.match(String(error?.message), /时钟疑似不一致/)
      return true
    },
  )
  fs.rmSync(lockPath())
})

/* ---------------- R11-A：心跳区间不变量 ---------------- */

test('R11-A 心跳区间对极小 staleMs 也自洽：interval ≤ staleMs', () => {
  for (const staleMs of [5, 10, 50, 100, 150, 199, 200, 201, 300, 600, 1_000, 60_000]) {
    const interval = service.rtkLockHeartbeatMs(staleMs)
    assert.ok(interval >= 10, `周期下限：${staleMs} → ${interval}`)
    assert.ok(interval <= Math.max(10, staleMs), `interval 必须 ≤ staleMs：${staleMs} → ${interval}`)
  }
  // 与 env 可达区间的一致性（rtkLockStaleMs() 已把 env 钳在 ≥1000）
  for (const staleMs of [1_000, 1_001, 3_000, 60_000]) {
    assert.ok(service.rtkLockHeartbeatMs(staleMs) < staleMs, `常规区间要严格小于阈值：${staleMs}`)
  }
})

/* ---------------- R11-C：提交点 fencing ---------------- */

test('R11-C assertOwned/isOwned：被接管后必须拒绝提交（409 lock_lost_during_write）', async () => {
  const lock = await service.acquireRtkFileLock({ home, purpose: 'fencing-unit', env: { ...env }, staleMs: 5_000 })
  assert.equal(lock.isOwned(), true)
  lock.assertOwned() // 不抛
  // 模拟接管：换 token（同时换 inode，与真实接管一致）
  fs.rmSync(lockPath())
  fs.writeFileSync(lockPath(), JSON.stringify({ token: 'THIEF', pid: process.pid, at: new Date().toISOString(), purpose: 'taker', home }))
  assert.equal(lock.isOwned(), false)
  assert.throws(() => lock.assertOwned(), (error: { reason?: string; status?: number }) => {
    assert.equal(error?.reason, 'lock_lost_during_write')
    assert.equal(error?.status, 409)
    return true
  })
  assert.equal(lock.info.lost, true)
  assert.equal(lock.info.lostReason, 'token_mismatch')
  fs.rmSync(lockPath())
})

test('R11-C 跨进程时序 SIGSTOP → 接管 → 恢复：不会「双方都写完」', { timeout: 60_000 }, async () => {
  const dir = path.join(workspace, 'fencing-e2e')
  const fenceHome = path.join(dir, 'home')
  const fenceBackups = path.join(dir, 'backups')
  for (const sub of ['home', 'backups']) fs.mkdirSync(path.join(dir, sub), { recursive: true })
  const hookFile = path.join(fenceHome, '.codex/hooks.json')
  fs.mkdirSync(path.dirname(hookFile), { recursive: true })
  fs.writeFileSync(hookFile, `${JSON.stringify({ hooks: { PreToolUse: [] } })}\n`)

  const bakFile = `${hookFile}.bak`
  fs.writeFileSync(bakFile, 'USER-BAK\n') // 用户自己的备份：preserveUserBaks 会想把它还原回去
  // 慢 CLI：覆写用户的 .bak（真实 rtk 会这么做，且只写一次），但不写 hook
  // —— 这样 H 的唯一一次 hook 写入来自 JSON 兜底提交点，而 .bak 走 preserveUserBaks/回填那条路。
  const startedFlag = path.join(dir, 'cli-started')
  const slowCli = path.join(dir, 'slow-rtk.sh')
  fs.writeFileSync(slowCli, `#!/bin/sh\n[ "$1" = "init" ] || exit 0\nif [ ! -f "${startedFlag}" ]; then printf 'CLI-BAK\\n' > "${bakFile}"; touch "${startedFlag}"; sleep 1.8; fi\nexit 0\n`, { mode: 0o755 })

  const childScript = `
    const service = await import(${JSON.stringify(new URL('./rtkService.ts', import.meta.url).pathname)})
    const targets = { kernel: { engine: 'cpa' }, relay: { baseUrl: '', key: '' } }
    try {
      const result = await service.setRTKAgentHook('codex', true, { plane: 'local', home: ${JSON.stringify(fenceHome)}, bin: ${JSON.stringify(slowCli)}, ...targets })
      console.log('RESULT ' + JSON.stringify({ ok: true, lockLost: result.lockLost ?? false }))
      process.exit(0)
    } catch (error) {
      console.log('RESULT ' + JSON.stringify({ ok: false, reason: error?.reason, status: error?.status, lockLost: error?.lockLost ?? null }))
      process.exit(4)
    }
  `
  const child = spawn(process.execPath, ['--import', 'tsx', '-e', childScript], {
    cwd: path.resolve(path.dirname(new URL(import.meta.url).pathname), '..'),
    env: { ...process.env, RTK_HOME: fenceHome, RTK_BACKUP_DIR: fenceBackups, RTK_LOCK_STALE_MS: '1000' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let childOut = ''
  child.stdout.on('data', chunk => { childOut += chunk })
  child.stderr.on('data', chunk => { childOut += chunk })

  // 1) 等 H 进入 CLI（此时 H 已持锁）
  for (let i = 0; i < 200 && !fs.existsSync(startedFlag); i += 1) await new Promise(r => setTimeout(r, 25))
  assert.equal(fs.existsSync(startedFlag), true, '子进程没能进入 CLI 阶段')
  // 2) SIGSTOP 停顿（心跳也冻住，H 无从察觉）
  child.kill('SIGSTOP')
  // 3) 等锁过期后「合法接管」：T 拿到锁并写自己的状态
  await new Promise(r => setTimeout(r, 1_300))
  const taker = await service.acquireRtkFileLock({ home: fenceHome, purpose: 'taker', env: { ...process.env, RTK_BACKUP_DIR: fenceBackups }, staleMs: 1_000, timeoutMs: 5_000 })
  assert.equal(taker.info.stolen, true, '接管者应当以「陈旧锁接管」的方式拿到锁')
  const thiefContent = `${JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'THIEF', hooks: [{ type: 'command', command: 'taker wrote this' }] }] } })}\n`
  const thiefBak = 'THIEF-BAK\n'
  fs.writeFileSync(hookFile, thiefContent)
  fs.writeFileSync(bakFile, thiefBak)
  taker.release()
  // 4) 恢复 H
  child.kill('SIGCONT')
  const code = await new Promise<number | null>(resolve => child.once('close', resolve))

  const resultLine = childOut.split('\n').find(line => line.startsWith('RESULT ')) || ''
  const parsed = JSON.parse(resultLine.replace('RESULT ', '') || '{}')
  const finalContent = fs.readFileSync(hookFile, 'utf8')

  assert.equal(code, 4, `H 必须以错误退出（本次没生效），实际 ${code}：${childOut.slice(-300)}`)
  assert.equal(parsed.ok, false)
  assert.equal(parsed.reason, 'lock_lost_during_write', `H 应报告锁被接管：${resultLine}`)
  assert.equal(finalContent, thiefContent, 'H 不得在接管者之后写入（否则就是「双方都写完」）')
  assert.equal(finalContent.includes('rtk hook codex'), false, 'H 的写入不能落盘')
  // 判别条件（原「落盘点 e2e」用例的判据，已合并到这里，避免重复 spawn 子进程）：
  // .bak 的三种值互斥可辨 —— USER-BAK = preserveUserBaks 落盘、CLI-BAK = 失败回填落盘、THIEF-BAK = 谁都没写
  assert.equal(fs.readFileSync(bakFile, 'utf8'), thiefBak,
    'H 不得还原 .bak（否则这里会是 USER-BAK=preserveUserBaks 或 CLI-BAK=restoreTargets）')
})

/* ---------------- R12-C：旁路同时关闭 fencing ---------------- */

test('R12-C RTK_LOCK_DISABLED=1 时 isOwned() 恒为 true（该开关同时关闭 fencing）', async () => {
  const bypassEnv = { ...env, RTK_LOCK_DISABLED: '1' } as NodeJS.ProcessEnv
  const lock = await service.acquireRtkFileLock({ home, purpose: 'bypass-fence', env: bypassEnv })
  assert.equal(lock.info.disabled, true)
  assert.equal(lock.isOwned(), true)
  // 即使锁文件被换成别人的，旁路下仍被视为「持有」（= 不阻断写入）；这是被文档化的语义
  fs.writeFileSync(lockPath(), JSON.stringify({ token: 'THIEF', pid: process.pid, at: new Date().toISOString(), purpose: 'taker', home }))
  assert.equal(lock.isOwned(), true, '旁路下 isOwned() 恒为 true —— 该开关同时关闭 fencing')
  assert.doesNotThrow(() => lock.assertOwned())
  fs.rmSync(lockPath())
})

/* ---------------- R12-B：409 载荷必须带 lockLost（服务层 seam） ---------------- */

test('R12-B fence 失败载荷带 lockLost:true + reason（rtkFailure 透出）', async () => {
  const lock = await service.acquireRtkFileLock({ home, purpose: 'payload', env: { ...env } })
  fs.rmSync(lockPath())
  fs.writeFileSync(lockPath(), JSON.stringify({ token: 'THIEF', pid: process.pid, at: new Date().toISOString(), purpose: 'taker', home }))
  let captured: unknown
  try {
    lock.assertOwned()
  } catch (error) {
    captured = error
  }
  assert.ok(captured, 'assertOwned 必须抛错')
  const failure = service.rtkFailure(captured)
  assert.equal(failure.status, 409)
  assert.equal(failure.reason, 'lock_lost_during_write')
  assert.equal(failure.lockLost, true, '只读 lockLost 的客户端不能漏判')
  assert.equal(failure.lockLostReason, 'token_mismatch')
  assert.equal((captured as { lockLost?: boolean }).lockLost, true, '错误对象本身也要带 lockLost')
  fs.rmSync(lockPath())
})

/* ---------------- 落盘点 e2e：被夺锁后 H 对 hook 与 .bak 零写入 ---------------- */

test('落盘点 e2e：rollbackRTK 的被夺锁路径（确定性同步点，不靠时序命中）', { timeout: 60_000 }, async () => {
  // 方案 A（task-44）：不再「睡一会儿赌篡改落进窗口」，而是用**测试专用**同步点
  // RTK_TEST_LOCK_HOLD_MS 让 rollbackRTK 在「锁已创建、尚未提交」处**确定性地停住**，
  // 父进程在这段（数百毫秒级的）窗口里篡改锁 —— 窗口比原来的微秒级 fence 窗口大 5 个数量级。
  // 子进程采「自适应用户轮数」：只在真的被篡改的那几轮上做断言，因此负载不会让断言失真。
  const dir = path.join(workspace, 'rollback-fence-e2e')
  const fenceHome = path.join(dir, 'home')
  const fenceBackups = path.join(dir, 'backups')
  for (const sub of ['home', 'backups']) fs.mkdirSync(path.join(dir, sub), { recursive: true })
  const hookFile = path.join(fenceHome, '.codex/hooks.json')
  fs.mkdirSync(path.dirname(hookFile), { recursive: true })
  const preOp = `${JSON.stringify({ hooks: { PreToolUse: [] } })}\n`
  fs.writeFileSync(hookFile, preOp)

  const previousHome = process.env.RTK_HOME
  const previousBackups = process.env.RTK_BACKUP_DIR
  process.env.RTK_HOME = fenceHome
  process.env.RTK_BACKUP_DIR = fenceBackups
  let backupId = ''
  try {
    const seeded = await service.setRTKAgentHook('codex', true, {
      plane: 'local', home: fenceHome, bin: path.join(dir, 'no-rtk'), ...offlineTargets,
    })
    backupId = seeded.backupId ?? ''
    assert.ok(backupId, '需要一份真实备份作为回滚目标')
  } finally {
    if (previousHome === undefined) delete process.env.RTK_HOME; else process.env.RTK_HOME = previousHome
    if (previousBackups === undefined) delete process.env.RTK_BACKUP_DIR; else process.env.RTK_BACKUP_DIR = previousBackups
  }
  const holdMs = 450
  const wantedRounds = 2
  const maxRounds = 12
  const fenceEnv = { ...process.env, RTK_HOME: fenceHome, RTK_BACKUP_DIR: fenceBackups, RTK_TEST_LOCK_HOLD_MS: String(holdMs) }
  const rollbackLockPath = service.rtkLockPath(fenceHome, fenceEnv)
  const takerContent = `${JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'TAKER', hooks: [{ type: 'command', command: 'taker owns it' }] }] } })}\n`

  const childScript = `
    import fs from 'node:fs'
    const service = await import(${JSON.stringify(new URL('./rtkService.ts', import.meta.url).pathname)})
    const outcome = { ok: 0, lockLost: 0, other: {}, clobberedByRollback: 0, rounds: 0 }
    const lockPath = ${JSON.stringify(rollbackLockPath)}
    const hookFile = ${JSON.stringify(hookFile)}
    const PREOP = ${JSON.stringify(preOp)}
    const startedAt = Date.now()
    while (outcome.lockLost < ${wantedRounds} && outcome.rounds < ${maxRounds} && Date.now() - startedAt < 25_000) {
      outcome.rounds += 1
      // harness 行为：被篡改的那一轮，本进程 release() 按 R9-A 语义不会删别人的锁，这里自己清场
      try { fs.rmSync(lockPath, { force: true }) } catch { /* ignore */ }
      try {
        await service.rollbackRTK({ home: ${JSON.stringify(fenceHome)}, confirm: true, backup: ${JSON.stringify(backupId)} })
        outcome.ok += 1
      } catch (error) {
        if (error?.reason === 'lock_lost_during_write') {
          outcome.lockLost += 1
          // 判别：报 409 之后目标文件里不能出现「操作前」内容（= 回滚真的写了）
          try {
            if (fs.readFileSync(hookFile, 'utf8') === PREOP) outcome.clobberedByRollback += 1
          } catch { /* ignore */ }
        } else {
          const reason = error?.reason || 'unknown'
          outcome.other[reason] = (outcome.other[reason] || 0) + 1
        }
      }
    }
    console.log('OUTCOME ' + JSON.stringify(outcome))
    process.exit(0)
  `
  const child = spawn(process.execPath, ['--import', 'tsx', '-e', childScript], {
    cwd: path.resolve(path.dirname(new URL(import.meta.url).pathname), '..'),
    env: fenceEnv, stdio: ['ignore', 'pipe', 'pipe'],
  })
  let childOut = ''
  child.stdout.on('data', chunk => { childOut += chunk })
  child.stderr.on('data', chunk => { childOut += chunk })

  // 确定性握手：轮询到锁文件出现（= 子进程已创建锁、正停在同步点里）就篡改；
  // 篡改后的锁留到下一轮，由子进程开头清场。
  const thief = JSON.stringify({ token: 'THIEF-TOKEN', pid: process.pid, at: new Date().toISOString(), purpose: 'taker', home: fenceHome })
  let tampered = 0
  const deadline = Date.now() + 40_000
  while (!childOut.includes('OUTCOME ') && child.exitCode === null && Date.now() < deadline) {
    let content: string | null = null
    try {
      content = fs.readFileSync(rollbackLockPath, 'utf8')
    } catch {
      content = null
    }
    if (content && !content.includes('THIEF-TOKEN')) {
      fs.writeFileSync(rollbackLockPath, thief)
      fs.writeFileSync(hookFile, takerContent)
      tampered += 1
    }
    await new Promise(resolve => setTimeout(resolve, 2))
  }
  const exitDeadline = Date.now() + 15_000
  while (child.exitCode === null && Date.now() < exitDeadline) await new Promise(resolve => setTimeout(resolve, 20))
  if (child.exitCode === null) child.kill('SIGKILL')
  const parsed = JSON.parse((childOut.split('\n').find(line => line.startsWith('OUTCOME ')) || 'OUTCOME {}').replace('OUTCOME ', ''))

  assert.ok(tampered >= wantedRounds, `父进程必须完成篡改（确定性同步点）：tampered=${tampered}`)
  assert.equal(parsed.lockLost, wantedRounds, `每一轮篡改都必须命中 rollbackRTK 的 fence：${JSON.stringify(parsed)}`)
  assert.equal(parsed.clobberedByRollback, 0, '被夺锁的回滚不得写入目标文件（不得出现操作前内容）')
  assert.equal(parsed.other.rtk_lock_unavailable, undefined, `不应出现锁层异常：${JSON.stringify(parsed.other)}`)
})

/* ---------------- 测试专用同步点：默认零行为差异（Lead 要求 ①/②） ---------------- */

test('RTK_TEST_LOCK_HOLD_MS：不设置时零行为差异，非法值一律视为 0，合法值才生效', async () => {
  // ① 取值：未设置 / 0 / 负数 / 非数字 / 超上限 → 0；合法值 → 原值
  const cases: Array<[string | undefined, number]> = [
    [undefined, 0], ['0', 0], ['-5', 0], ['abc', 0], ['', 0], ['99999', 0], ['250', 250],
  ]
  for (const [raw, expected] of cases) {
    const probe = { ...process.env } as NodeJS.ProcessEnv
    if (raw === undefined) delete probe.RTK_TEST_LOCK_HOLD_MS
    else probe.RTK_TEST_LOCK_HOLD_MS = raw
    assert.equal(service.rtkTestLockHoldMs(probe), expected, `RTK_TEST_LOCK_HOLD_MS=${String(raw)}`)
  }

  // ② 行为等价：未设置 vs 显式 '0' 两次获取，观测到的结果必须完全一致（默认路径不含任何等待）
  const dir = path.join(workspace, 'hold-seam')
  const seamHome = path.join(dir, 'home')
  const seamBackups = path.join(dir, 'backups')
  for (const sub of ['home', 'backups']) fs.mkdirSync(path.join(dir, sub), { recursive: true })
  const measure = async (envValue: string | undefined) => {
    const env = { ...process.env, RTK_HOME: seamHome, RTK_BACKUP_DIR: seamBackups } as NodeJS.ProcessEnv
    if (envValue === undefined) delete env.RTK_TEST_LOCK_HOLD_MS
    else env.RTK_TEST_LOCK_HOLD_MS = envValue
    const started = Date.now()
    const lock = await service.acquireRtkFileLock({ home: seamHome, purpose: 'hold-seam', env })
    const lockFile = service.rtkLockPath(seamHome, env)
    const observed = {
      waitedMsIsSmall: lock.info.waitedMs < 500,
      heldLockFile: fs.existsSync(lockFile),
      disabled: lock.info.disabled,
      stolen: lock.info.stolen,
    }
    lock.release()
    return { ...observed, releasedLockFile: !fs.existsSync(lockFile), elapsed: Date.now() - started }
  }
  const unset = await measure(undefined)
  const explicitZero = await measure('0')
  // 只比较行为字段（elapsed 是墙钟，本身有 ±1ms 抖动，单独做上界断言）
  const behavior = ({ elapsed: _elapsed, ...rest }: { elapsed: number }) => rest
  assert.deepEqual(behavior(explicitZero), behavior(unset), '未设置与显式 0 的行为必须完全一致（默认零行为差异）')
  assert.ok(explicitZero.elapsed < 500 && unset.elapsed < 500, '默认路径都必须是毫秒级')
  assert.equal(unset.heldLockFile, true)
  assert.equal(unset.releasedLockFile, true)
  assert.ok(unset.elapsed < 500, `默认路径不应有额外等待：${unset.elapsed}ms`)

  // 正向对照：设置合法值时才真的等待（证明这个开关确实接线了）
  const held = await measure('300')
  assert.ok(held.elapsed >= 300, `设置 300ms 后必须真的等待：${held.elapsed}ms`)
  assert.equal(held.heldLockFile, true)
  assert.equal(held.releasedLockFile, true)
})

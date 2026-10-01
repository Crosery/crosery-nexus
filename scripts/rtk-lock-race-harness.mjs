#!/usr/bin/env node
/**
 * RTK 写入锁：**概率性/重时序**竞态 harness（默认不进套件，按需手动跑）。
 *
 * 为什么放在 scripts/ 而不是测试里：它靠「父进程不停地篡改锁」去撞一个微秒级的窗口，
 * 命中率约 10%~85%（取决于篡改节奏），**不适合做门禁**——门禁必须按退出码判定，
 * 概率性用例会让团队学会「重跑一遍就好」。因此：
 *   - 默认套件里只留确定性断言（server/rtkLock.test.ts，见 docs/qa/blue/rtk-flake-fix.md）；
 *   - 本 harness 作为**补充证据**手动运行，命中的每一次都会断言「被夺锁方一个字节都没写」。
 *
 * 用法：
 *   node --import tsx scripts/rtk-lock-race-harness.mjs                # 有 fence（默认）
 *   RTK_LOCK_DISABLED=1 node --import tsx scripts/rtk-lock-race-harness.mjs   # 对照：fence 关
 *   ITERATIONS=300 MODE=targeted node --import tsx scripts/rtk-lock-race-harness.mjs
 *
 * 退出码：0 = 观察到的结果与预期一致（有 fence：命中时零写入；无 fence：写入发生了）；
 *         1 = 结果与预期不符（例如有 fence 却被夺锁方写了文件）。
 *
 * 只用临时 RTK_HOME/RTK_BACKUP_DIR，绝不碰真实 agent 配置。
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import os from 'node:os'
import path from 'node:path'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const ITERATIONS = Number(process.env.ITERATIONS || 300)
const MODE = process.env.MODE === 'targeted' ? 'targeted' : 'spin'
const LOCK_DISABLED = process.env.RTK_LOCK_DISABLED === '1'

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'rtk-race-'))
const home = path.join(base, 'home')
const backups = path.join(base, 'backups')
fs.mkdirSync(home, { recursive: true })
fs.mkdirSync(backups, { recursive: true })
process.env.RTK_HOME = home
process.env.RTK_BACKUP_DIR = backups
const env = { ...process.env, RTK_HOME: home, RTK_BACKUP_DIR: backups }
const service = await import(path.join(ROOT, 'server/rtkService.ts'))
const targets = { kernel: { engine: 'cpa' }, relay: { baseUrl: '', key: '' } }
const hookFile = path.join(home, '.codex/hooks.json')
fs.mkdirSync(path.dirname(hookFile), { recursive: true })
fs.writeFileSync(hookFile, '{"hooks":{"PreToolUse":[]}}\n')
const PREOP = '{"hooks":{"PreToolUse":[]}}'
const TAKER = `${JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'TAKER', hooks: [{ type: 'command', command: 'taker' }] }] } })}\n`

const seeded = await service.setRTKAgentHook('codex', true, { plane: 'local', home, bin: path.join(base, 'no-rtk'), ...targets })
const lockPath = service.rtkLockPath(home, env)
const thief = JSON.stringify({ token: 'THIEF-TOKEN', pid: process.pid, at: new Date().toISOString(), purpose: 'taker', home })

const childScript = `
  import fs from 'node:fs'
  const service = await import(${JSON.stringify(path.join(ROOT, 'server/rtkService.ts'))})
  const outcome = { ok: 0, lockLost: 0, other: {}, clobberedByRollback: 0 }
  for (let i = 0; i < ${ITERATIONS}; i += 1) {
    try {
      await service.rollbackRTK({ home: ${JSON.stringify(home)}, confirm: true, backup: ${JSON.stringify(seeded.backupId)} })
      outcome.ok += 1
    } catch (error) {
      if (error?.reason === 'lock_lost_during_write') {
        outcome.lockLost += 1
        try { if (fs.readFileSync(${JSON.stringify(hookFile)}, 'utf8').includes(${JSON.stringify(PREOP)})) outcome.clobberedByRollback += 1 } catch {}
      } else {
        const r = error?.reason || 'unknown'
        outcome.other[r] = (outcome.other[r] || 0) + 1
      }
    }
  }
  console.log('OUTCOME ' + JSON.stringify(outcome))
  process.exit(0)
`
const child = spawn(process.execPath, ['--import', 'tsx', '-e', childScript], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] })
let out = ''
child.stdout.on('data', c => { out += c })
child.stderr.on('data', c => { out += c })

const started = Date.now()
let tampered = 0
// 子进程打出 OUTCOME 就收工；循环里用 await 让出事件循环，避免把子进程饿死（否则要等满 watchdog）
while (!out.includes('OUTCOME ') && Date.now() - started < 120_000) {
  try {
    const content = fs.readFileSync(lockPath, 'utf8')
    const isThief = content.includes('THIEF-TOKEN')
    if (MODE === 'spin') {
      if (content && !isThief) { fs.writeFileSync(lockPath, thief); fs.writeFileSync(hookFile, TAKER); tampered += 1 }
      try { fs.rmSync(lockPath, { force: true }) } catch {}
    } else {
      // targeted：只在锁刚出现的瞬间篡改，命中率高得多
      if (content && !isThief) { fs.writeFileSync(lockPath, thief); fs.writeFileSync(hookFile, TAKER); tampered += 1 }
      else if (isThief && Date.now() - fs.statSync(lockPath).mtimeMs > 50) fs.rmSync(lockPath, { force: true })
    }
  } catch {
    // 锁不存在：正常
  }
  await new Promise(resolve => setTimeout(resolve, MODE === 'targeted' ? 0 : 1))
}
// 等子进程自己收尾（最多 20s），再取结果
const exitDeadline = Date.now() + 20_000
while (child.exitCode === null && Date.now() < exitDeadline) await new Promise(resolve => setTimeout(resolve, 20))
if (child.exitCode === null) child.kill('SIGKILL')
const outcome = JSON.parse((out.split('\n').find(line => line.startsWith('OUTCOME ')) || 'OUTCOME {}').replace('OUTCOME ', ''))
const expected = LOCK_DISABLED
  ? { desc: 'fence 关：必须观察到「被夺锁后仍然写入」（ok > 0 或 clobbered > 0）', ok: outcome.ok > 0 || outcome.clobberedByRollback > 0 }
  : { desc: 'fence 开：命中必须零写入（clobberedByRollback === 0），且至少命中一次', ok: outcome.clobberedByRollback === 0 && outcome.lockLost > 0 }
console.log(JSON.stringify({
  mode: MODE, lockDisabled: LOCK_DISABLED, iterations: ITERATIONS, tampered, elapsedMs: Date.now() - started,
  outcome, hitRate: Number((outcome.lockLost / ITERATIONS).toFixed(4)), expectation: expected.desc, verdict: expected.ok ? 'PASS' : 'FAIL',
}, null, 1))
fs.rmSync(base, { recursive: true, force: true })
process.exit(expected.ok ? 0 : 1)

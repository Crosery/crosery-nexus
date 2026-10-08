import './testDataDir.js'

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { ProxyChecker, ProxyHealthStore } from './proxyCheck.js'
import { planProxyHealth, probeCandidateFor, PROXY_HEALTH_POLICY, registerProxyHealthJob, type ProxyHealthCandidate } from './proxyCheckJob.js'
import { createLimiter, SyncRegistry } from './syncRegistry.js'

const HOUR = 60 * 60_000
const T0 = Date.parse('2026-10-02T00:00:00Z')

function harness(candidates: () => ProxyHealthCandidate[], options: { kernelRunning?: () => boolean; status?: number; fail?: boolean } = {}) {
  const clock = { now: T0 }
  const store = new ProxyHealthStore(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'proxy-job-')), 'proxy', 'health.json'))
  const calls: string[] = []
  let active = 0
  let maxActive = 0
  const checker = new ProxyChecker({
    store,
    limiter: createLimiter(4),
    now: () => clock.now,
    request: async (_proxy, url) => {
      calls.push(url)
      active += 1
      maxActive = Math.max(maxActive, active)
      await new Promise(resolve => setTimeout(resolve, 2))
      active -= 1
      if (options.fail) throw new Error('boom socks5://u:SECRETPW@198.51.100.4:1080')
      return { status: options.status ?? 401, headers: {}, body: url.includes('cdn-cgi/trace') ? 'ip=198.51.100.9\nloc=JP\n' : '', ms: 3 }
    },
  })
  const registry = new SyncRegistry({ file: null, now: () => clock.now, random: () => 0.5, setTimer: () => 0 as unknown as ReturnType<typeof setTimeout>, clearTimer: () => undefined, log: () => undefined })
  registerProxyHealthJob(registry, {
    checker,
    inUse: candidates,
    kernelRunning: options.kernelRunning ?? (() => true),
    secrets: () => ['SECRETPW'],
    random: () => 0.5,
  })
  return { clock, store, registry, calls, checker, stats: () => ({ maxActive }) }
}

const url = (id: string): ProxyHealthCandidate => ({ id, kind: 'url', proxyUrl: `socks5://127.0.0.1:1/${id}` })

test('registered as 「代理巡检」: 6 h interval, 15 min tick, 10 min manual cooldown', async () => {
  const { registry } = harness(() => [])
  const view = (await registry.status()).jobs.find(job => job.id === 'proxy-health')!
  assert.equal(view.label, '代理巡检')
  assert.equal(view.intervalMs, 6 * HOUR)
  assert.equal(PROXY_HEALTH_POLICY.tickMs, 15 * 60_000)
  assert.equal(registry.requestRun('proxy-health').status, 202)
  await new Promise(resolve => setImmediate(resolve))
  const again = registry.requestRun('proxy-health')
  assert.equal(again.status === 409 || again.status === 429, true)
})

test('timer: only in-use entries, never-checked first, at most 8 per tick, then due 6 h ± 10 % later', async () => {
  const entries = Array.from({ length: 11 }, (_, index) => url(`px_${index}`))
  const { registry, clock, calls, store, stats } = harness(() => entries)
  const first = await registry.run('proxy-health', 'timer')
  assert.equal(first.outcome.result, 'ok')
  assert.match(String(first.outcome.summary), /检测 8 个 · 正常 8/)
  assert.equal(calls.length, 8 * 8)
  assert.ok(stats().maxActive <= 4)
  const status = await registry.status()
  assert.equal(status.jobs.find(job => job.id === 'proxy-health')!.requests24h, 64)

  clock.now += 15 * 60_000
  const second = await registry.run('proxy-health', 'timer')
  assert.match(String(second.outcome.summary), /检测 3 个/)
  assert.equal(Object.keys(store.all()).length, 11)

  clock.now += 15 * 60_000
  const idle = await registry.run('proxy-health', 'timer')
  assert.equal(idle.outcome.silent, true, 'nothing due → silent tick, no history')

  clock.now = T0 + 6 * HOUR + 1
  const later = await registry.run('proxy-health', 'timer')
  assert.match(String(later.outcome.summary), /检测 8 个/, 'random 0.5 → exactly 6 h; the first 8 are due again')
})

test('plan: jitter bounds, mihomo skipped while the kernel is down, skip reasons, manual freshness', () => {
  const candidates: ProxyHealthCandidate[] = [
    url('px_url'),
    { id: 'px_mh', kind: 'mihomo', proxyUrl: 'socks5://u:p@127.0.0.1:27890' },
    { id: 'px_ext', kind: 'url', proxyUrl: 'socks5://127.0.0.1:7890', skip: '此处无法检测' },
  ]
  const down = planProxyHealth({ candidates, next: {}, lastAt: () => null, now: T0, manual: false, kernelRunning: false })
  assert.deepEqual(down.due.map(item => item.id), ['px_url'])
  assert.deepEqual([down.skippedKernel, down.skippedOther], [1, 1])
  const notDue = planProxyHealth({ candidates, next: { px_url: T0 + 1 }, lastAt: () => T0 - 1, now: T0, manual: false, kernelRunning: true })
  assert.deepEqual(notDue.due.map(item => item.id), [], 'px_mh: last check 1 ms ago → due in 6 h')
  const manual = planProxyHealth({ candidates, next: { px_url: T0 + HOUR }, lastAt: id => (id === 'px_url' ? T0 - 60_000 : T0 - 11 * 60_000), now: T0, manual: true, kernelRunning: true })
  assert.deepEqual(manual.due.map(item => item.id), ['px_mh'], 'manual ignores the schedule but skips results younger than 10 min')
  assert.equal(manual.fresh, 1)
})

test('manual run: re-checks stale in-use entries, reports when everything is fresh', async () => {
  const { registry, clock, calls } = harness(() => [url('px_a'), url('px_b')])
  await registry.run('proxy-health', 'timer')
  assert.equal(calls.length, 16)
  clock.now += 5 * 60_000
  const fresh = await registry.run('proxy-health', 'manual')
  assert.equal(fresh.outcome.result, 'skipped')
  assert.match(String(fresh.outcome.summary), /10 分钟内检测过/)
  assert.equal(calls.length, 16)
  clock.now += 6 * 60_000
  const rerun = await registry.run('proxy-health', 'manual')
  assert.match(String(rerun.outcome.summary), /检测 2 个/)
  assert.equal(calls.length, 32)
})

test('failures are data: partial result, no task-level backoff; inUse errors are scrubbed', async () => {
  const { registry } = harness(() => [url('px_a')], { status: 403 })
  const blocked = await registry.run('proxy-health', 'timer')
  assert.equal(blocked.outcome.result, 'partial')
  assert.match(String(blocked.outcome.summary), /异常 1/)
  const view = (await registry.status()).jobs.find(job => job.id === 'proxy-health')!
  assert.equal(view.backoffUntil, null)

  const broken = harness(() => { throw new Error('pool read failed for socks5://u:SECRETPW@192.0.2.1:1080') })
  const outcome = await broken.registry.run('proxy-health', 'timer')
  assert.equal(outcome.outcome.result, 'error')
  assert.ok(!String(outcome.outcome.error).includes('SECRETPW'))
  const failing = harness(() => [url('px_a')], { fail: true })
  const failed = await failing.registry.run('proxy-health', 'timer')
  assert.equal(failed.outcome.result, 'partial', 'a thrown request is classified, not a job error')
  assert.equal(failing.calls.length, 8)
})

test('probeCandidateFor: url, managed listener, external, disabled, invalid', () => {
  const auth = { username: 'lu', password: 'lp' }
  assert.deepEqual(probeCandidateFor({ id: 'a', kind: 'url', url: 'http://u:p@h.example.com:8080' }, { listenerAuth: auth, coResident: false }), { id: 'a', kind: 'url', proxyUrl: 'http://u:p@h.example.com:8080' })
  assert.deepEqual(probeCandidateFor({ id: 'b', kind: 'mihomo', port: 27891 }, { listenerAuth: auth, coResident: false }), { id: 'b', kind: 'mihomo', proxyUrl: 'socks5://lu:lp@127.0.0.1:27891' })
  assert.equal(probeCandidateFor({ id: 'c', kind: 'url', url: 'socks5://127.0.0.1:7890', external: true }, { listenerAuth: null, coResident: false }).skip, '此处无法检测')
  assert.equal(probeCandidateFor({ id: 'c', kind: 'url', url: 'socks5://127.0.0.1:7890', external: true }, { listenerAuth: null, coResident: true }).skip, undefined)
  assert.equal(probeCandidateFor({ id: 'd', kind: 'url', url: 'http://h:1', enabled: false }, { listenerAuth: null, coResident: true }).skip, '已停用')
  assert.equal(probeCandidateFor({ id: 'e', kind: 'mihomo', port: 27892, validity: 'invalid' }, { listenerAuth: null, coResident: true }).skip, '配置无效')
  assert.equal(probeCandidateFor({ id: 'f', kind: 'mihomo' }, { listenerAuth: null, coResident: true }).skip, '未分配本机端口')
})

test('sanitizeData drops garbage and clamps far-future schedules', async () => {
  const registry = new SyncRegistry({ file: null, now: () => T0, log: () => undefined })
  const data = registry.jobData('proxy-health')
  Object.assign(data, { next: { px_ok: T0 + HOUR, px_far: T0 + 1000 * HOUR, 'bad id': 1, px_nan: 'x' }, junk: true })
  registerProxyHealthJob(registry, { checker: new ProxyChecker({ store: new ProxyHealthStore(path.join(os.tmpdir(), 'unused-health.json')), limiter: createLimiter(4) }), inUse: () => [], kernelRunning: () => true })
  assert.deepEqual(Object.keys(data), ['next'])
  const next = data.next as Record<string, number>
  assert.deepEqual(Object.keys(next).sort(), ['px_far', 'px_ok'])
  assert.ok(next.px_far <= T0 + 6 * HOUR * 1.2)
})

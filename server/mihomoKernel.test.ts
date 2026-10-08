import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { MihomoKernel, socksGreeting, type MihomoKernelOptions } from './mihomoKernel.js'
import type { MihomoNodeEntry } from './mihomoConfig.js'
import { writeFakeMihomo } from './testing/fakeMihomo.js'


const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mihomo-kernel-'))
const fakeBin = writeFakeMihomo(root)
const kernels: MihomoKernel[] = []
const spawned: number[] = []

test.after(async () => {
  for (const kernel of kernels) await kernel.stop().catch(() => undefined)
  for (const pid of spawned) { try { process.kill(pid, 'SIGKILL') } catch { /* gone */ } }
})

let rangeBase = 31_000 + Math.floor(Math.random() * 8_000)
async function freeRange(count: number): Promise<number> {
  for (let attempt = 0; attempt < 50; attempt++) {
    const base = rangeBase
    rangeBase += count + 7
    let free = true
    for (let port = base; port < base + count && free; port++) {
      free = await new Promise<boolean>((resolve) => {
        const server = net.createServer()
        server.once('error', () => resolve(false))
        server.listen(port, '127.0.0.1', () => server.close(() => resolve(true)))
      })
    }
    if (free) return base
  }
  throw new Error('no free port range')
}

async function makeKernel(input: Partial<MihomoKernelOptions> & { base?: number } = {}) {
  const { env, base: fixedBase, ...options } = input
  const base = fixedBase ?? await freeRange(10)
  const dir = options.dir ?? path.join(fs.mkdtempSync(path.join(root, 'k-')), 'proxy', 'mihomo')
  const logs: string[] = []
  const kernel = new MihomoKernel({
    dir,
    env: { PATH: process.env.PATH, PROXY_PORT_BASE: String(base), PROXY_PORT_COUNT: '10', ...(env ?? {}) },
    resolveBinary: async () => ({ ok: true, source: 'env', sourcePath: fakeBin, runPath: fakeBin, copied: false, version: '1.19.31' }),
    debounceMs: 5,
    readyTimeoutMs: 3_000,
    stopTimeoutMs: 1_000,
    watchdogMs: 50,
    log: (line) => logs.push(line),
    ...options,
  })
  kernels.push(kernel)
  return { kernel, dir, base, logs }
}

const auth = { username: 'lu', password: 'listener-pass-xyz' }
const node = (id: string, port: number, extra: Record<string, unknown> = {}): MihomoNodeEntry => ({
  id, port, node: { name: '日本 节点', type: 'ss', server: 'jp.example.com', port: 8388, cipher: 'aes-128-gcm', password: `secret-${id}`, ...extra },
})
const alive = (pid: number | null) => { if (!pid) return false; try { process.kill(pid, 0); return true } catch { return false } }
const until = async (predicate: () => boolean, ms = 4_000) => {
  const deadline = Date.now() + ms
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('timed out waiting')
    await new Promise(resolve => setTimeout(resolve, 20))
  }
}
const mode = (dir: string, value: Record<string, unknown>) => fs.writeFileSync(path.join(dir, 'fake-mode.json'), JSON.stringify(value))
const starts = (dir: string) => { try { return fs.readFileSync(path.join(dir, 'fake-starts.log'), 'utf8').trim().split('\n').filter(Boolean).length } catch { return 0 } }

test('no binary → unavailable; apply and validate are no-ops', async () => {
  const { kernel } = await makeKernel({ resolveBinary: async () => ({ ok: false, reason: '未找到 mihomo（设置 MIHOMO_BIN 后重启控制台）' }) })
  const status = await kernel.boot()
  assert.equal(status.state, 'unavailable')
  assert.match(String(status.reason), /MIHOMO_BIN/)
  const result = await kernel.apply({ entries: [node('px_a', 27890)], listenerAuth: auth })
  assert.equal(result.state, 'unavailable')
  assert.deepEqual(await kernel.validate([node('px_a', 27890)]), { available: false, invalid: [] })
})

test('start, reload (add/remove/change), verify listeners, stop when empty; files private', async () => {
  const { kernel, dir, base } = await makeKernel()
  const first = await kernel.apply({ entries: [node('px_a', base), node('px_b', base + 1)], listenerAuth: auth })
  assert.equal(first.state, 'running')
  assert.deepEqual(first.running.sort(), ['px_a', 'px_b'])
  const pid = kernel.status().pid
  assert.ok(alive(pid))
  assert.equal(await socksGreeting(base, true), true)
  assert.equal(fs.statSync(dir).mode & 0o777, 0o700)
  for (const name of ['config.yaml', 'mihomo.pid', 'controller.json', 'mihomo.log']) assert.equal(fs.statSync(path.join(dir, name)).mode & 0o777, 0o600, name)
  const text = fs.readFileSync(path.join(dir, 'config.yaml'), 'utf8')
  assert.ok(!text.includes('日本'), 'labels never reach the config')
  const pidfile = JSON.parse(fs.readFileSync(path.join(dir, 'mihomo.pid'), 'utf8'))
  assert.equal(pidfile.pid, pid)
  assert.equal(pidfile.dir, dir)

  const second = await kernel.apply({ entries: [node('px_b', base + 1, { password: 'changed' }), node('px_c', base + 2)], listenerAuth: auth })
  assert.equal(second.state, 'running')
  assert.equal(kernel.status().pid, pid, 'reload, not restart')
  assert.equal(starts(dir), 1)
  assert.equal(await socksGreeting(base, true), false, 'removed listener is gone')
  assert.equal(await socksGreeting(base + 2, true), true, 'added listener answers')

  const same = await kernel.apply({ entries: [node('px_b', base + 1, { password: 'changed' }), node('px_c', base + 2)], listenerAuth: auth })
  assert.equal(same.state, 'running')

  const empty = await kernel.apply({ entries: [], listenerAuth: auth })
  assert.equal(empty.state, 'idle')
  await until(() => !alive(pid))
  assert.equal(fs.existsSync(path.join(dir, 'mihomo.pid')), false)
})

test('bad nodes are left out (indexed error and bisect) while the rest run; reasons and logs are scrubbed', async () => {
  const { kernel, base, logs } = await makeKernel()
  const result = await kernel.apply({
    entries: [node('px_good', base), node('px_idx', base + 1, { cipher: 'bogus' }), node('px_noidx', base + 2, { cipher: 'bogus-noindex' }), node('px_good2', base + 3)],
    listenerAuth: auth,
  })
  assert.equal(result.state, 'running')
  assert.deepEqual(result.running.sort(), ['px_good', 'px_good2'])
  const invalid = Object.fromEntries(result.invalid.map(item => [item.id, item.reason]))
  assert.deepEqual(Object.keys(invalid).sort(), ['px_idx', 'px_noidx'])
  for (const reason of Object.values(invalid)) {
    assert.ok(!reason.includes('jp.example.com'), reason)
    assert.ok(!reason.includes('secret-px_'), reason)
  }
  assert.match(invalid.px_idx, /unknown method: bogus/)
  assert.equal(await socksGreeting(base + 1, true), false)
  assert.deepEqual(kernel.status().invalid.map(item => item.id).sort(), ['px_idx', 'px_noidx'])
  const logged = logs.join('\n') + JSON.stringify(kernel.status())
  for (const leak of ['jp.example.com', 'secret-px_', auth.password, auth.username + ':']) assert.ok(!logged.includes(leak), leak)

  const checked = await kernel.validate([node('v_ok', 0), node('v_bad', 0, { cipher: 'bogus' })])
  assert.equal(checked.available, true)
  assert.deepEqual(checked.invalid.map(item => item.id), ['v_bad'])
})

test('silent bind failure (204 without a listener) → degraded with the entry marked', async () => {
  const { kernel, dir, base } = await makeKernel()
  await kernel.apply({ entries: [node('px_a', base)], listenerAuth: auth })
  mode(dir, { skipBind: [base + 1] })
  const result = await kernel.apply({ entries: [node('px_a', base), node('px_b', base + 1)], listenerAuth: auth })
  assert.equal(result.state, 'degraded')
  assert.deepEqual(result.bindFailed, ['px_b'])
  assert.equal(kernel.status().state, 'degraded')
  assert.deepEqual(kernel.status().bindFailed, ['px_b'])
})

test('another authenticated socks proxy on a listener port is not mistaken for ours → degraded', async () => {
  const { kernel, dir, base } = await makeKernel()
  // a foreign socks5 server that wants user/pass (answers 05 02) but rejects every credential it does not know
  const foreign = net.createServer((socket) => {
    socket.on('error', () => {})
    socket.once('data', () => {
      socket.write(Buffer.from([5, 2]))
      socket.once('data', () => socket.end(Buffer.from([1, 1])))
    })
  })
  await new Promise<void>(resolve => foreign.listen(base + 1, '127.0.0.1', resolve))
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
    mode(dir, { skipBind: [base + 1] })
    const result = await kernel.apply({ entries: [node('px_a', base), node('px_b', base + 1)], listenerAuth: auth })
    assert.equal(await socksGreeting(base + 1, true), true, 'a bare greeting cannot tell the two apart')
    assert.equal(await socksGreeting(base + 1, auth), false, 'the credential check can')
    assert.equal(await socksGreeting(base, auth), true)
    assert.equal(result.state, 'degraded')
    assert.deepEqual(result.bindFailed, ['px_b'])
  } finally {
    await new Promise(resolve => foreign.close(resolve))
  }
})

test('without a listener credential, a port another socks proxy already held is not counted as ours; our own ports stay ours across reloads', async () => {
  const { kernel, dir, base } = await makeKernel()
  // a foreign no-auth socks5 server: answers 05 00 exactly like a credential-less mihomo listener
  const foreign = net.createServer((socket) => {
    socket.on('error', () => {})
    socket.once('data', () => socket.write(Buffer.from([5, 0])))
  })
  await new Promise<void>(resolve => foreign.listen(base + 1, '127.0.0.1', resolve))
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
    mode(dir, { skipBind: [base + 1] })
    const first = await kernel.apply({ entries: [node('px_a', base), node('px_b', base + 1)], listenerAuth: null })
    assert.equal(await socksGreeting(base + 1, false), true, 'the greeting alone cannot tell the two apart')
    assert.equal(first.state, 'degraded')
    assert.deepEqual(first.bindFailed, ['px_b'])
    assert.deepEqual(first.running, ['px_a'])
    const pid = kernel.status().pid
    // a reload: px_a's port is held by our kernel (occupied, but ours); px_b's is still someone else's
    const second = await kernel.apply({ entries: [node('px_a', base), node('px_b', base + 1), node('px_c', base + 2)], listenerAuth: null })
    assert.equal(kernel.status().pid, pid, 'reload, not restart')
    assert.deepEqual(second.bindFailed, ['px_b'])
    assert.deepEqual(second.running.sort(), ['px_a', 'px_c'])
  } finally {
    await new Promise(resolve => foreign.close(resolve))
  }
})

test('controller rejects reload → falls back to stop + start', async () => {
  const { kernel, dir, base } = await makeKernel()
  await kernel.apply({ entries: [node('px_a', base)], listenerAuth: auth })
  const pid = kernel.status().pid
  mode(dir, { rejectReload: true })
  const result = await kernel.apply({ entries: [node('px_a', base), node('px_b', base + 1)], listenerAuth: auth })
  assert.equal(result.state, 'running')
  assert.notEqual(kernel.status().pid, pid)
  assert.equal(starts(dir), 2)
})

test('a pidfile pointing at a foreign process is never signalled', async () => {
  const { kernel, dir } = await makeKernel()
  const sleeper = spawn('sleep', ['30'], { stdio: 'ignore' })
  spawned.push(sleeper.pid!)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'mihomo.pid'), JSON.stringify({ pid: sleeper.pid, dir, configSha: null, startedAt: Date.now() }))
  const status = await kernel.boot()
  assert.equal(status.state, 'idle')
  assert.equal(status.pid, null)
  assert.ok(alive(sleeper.pid!), 'foreign pid untouched')
  assert.equal(fs.existsSync(path.join(dir, 'mihomo.pid')), false)
  await kernel.stop()
  assert.ok(alive(sleeper.pid!), 'stop never touches it either')
  sleeper.kill('SIGKILL')
})

test('keepalive: a new console adopts the running kernel without restarting it', async () => {
  const { kernel, dir, base } = await makeKernel()
  const desired = { entries: [node('px_a', base)], listenerAuth: auth }
  await kernel.apply(desired)
  const pid = kernel.status().pid
  await kernel.shutdown()
  assert.ok(alive(pid), 'kernel outlives the console by default')

  const { kernel: next } = await makeKernel({ dir, base })
  const status = await next.boot()
  assert.equal(status.state, 'running')
  assert.equal(status.adopted, true)
  assert.equal(status.pid, pid)
  const result = await next.apply(desired)
  assert.equal(result.state, 'running')
  assert.equal(next.status().pid, pid)
  assert.equal(starts(dir), 1, 'same config → no restart, no reload')
  await next.stop()
  await until(() => !alive(pid))
  assert.equal(next.status().state, 'stopped')
})

test('PROXY_KERNEL_KEEPALIVE=0 stops the kernel on console shutdown', async () => {
  const { kernel, base } = await makeKernel({ env: { PROXY_KERNEL_KEEPALIVE: '0' } })
  const result = await kernel.apply({ entries: [node('px_a', base)], listenerAuth: null })
  assert.equal(result.state, 'running', JSON.stringify(kernel.status()))
  const pid = kernel.status().pid
  assert.equal(await socksGreeting(base, false), true)
  await kernel.shutdown()
  await until(() => !alive(pid))
})

test('manual stop holds until start; crashes back off and end in failed', async () => {
  const { kernel, dir, base } = await makeKernel({ backoff: { baseMs: 20, maxMs: 80, windowMs: 60_000, maxCrashes: 2 } })
  const desired = { entries: [node('px_a', base)], listenerAuth: auth }
  await kernel.apply(desired)
  await kernel.stop()
  assert.equal(kernel.status().state, 'stopped')
  const held = await kernel.apply(desired)
  assert.equal(held.state, 'stopped')
  assert.equal(starts(dir), 1)
  assert.equal((await kernel.start()).state, 'running')
  assert.equal(starts(dir), 2)

  // 崩溃必须落在「启动已确认」之后才走退避重启；并行跑测试时就绪探测可能超过 150ms，留足余量。
  mode(dir, { crash: true, crashAfterMs: 600 })
  await kernel.restart()
  await until(() => kernel.status().state === 'failed', 6_000)
  assert.equal(starts(dir), 2 + 3, 'first start + 2 backoff restarts, then failed')
  assert.match(String(kernel.status().reason), /崩溃超过 2 次/)
  assert.equal(kernel.status().pid, null)
})

test('lazy binary: boot only locates; the .app copy happens when the first managed entry needs it', { skip: process.platform !== 'darwin' && 'bundle lookup is darwin-only' }, async () => {
  const bundle = path.join(root, 'Fake Party.app', 'Contents', 'Resources', 'sidecar', 'mihomo')
  fs.mkdirSync(path.dirname(bundle), { recursive: true })
  fs.copyFileSync(fakeBin, bundle)
  fs.chmodSync(bundle, 0o755)
  const { kernel, dir, base } = await makeKernel({ resolveBinary: undefined, bundlePath: bundle })
  const booted = await kernel.boot()
  assert.equal(booted.state, 'idle')
  assert.equal(booted.binarySource, 'bundle')
  assert.equal(booted.version, null)
  assert.equal(fs.existsSync(path.join(dir, 'bin', 'mihomo')), false, 'no copy at boot')
  assert.equal((await kernel.apply({ entries: [], listenerAuth: auth })).state, 'idle')
  assert.equal(fs.existsSync(path.join(dir, 'bin', 'mihomo')), false, 'no copy without managed entries')
  const result = await kernel.apply({ entries: [node('px_a', base)], listenerAuth: auth })
  assert.equal(result.state, 'running')
  assert.equal(fs.statSync(path.join(dir, 'bin', 'mihomo')).mode & 0o7777, 0o700)
  assert.equal(kernel.status().version, '1.19.31')
})

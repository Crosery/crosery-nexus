import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { compareContracts, generateTypes, generateReference, withUpstreamLock, publishCandidate, checkServiceEnvironment, processStartTime } from './magpie-upstream.mjs'

const route = (path = '/api/signin') => ({
  surface: 'management', method: 'POST', path, handler: 'inline', source: 'internal/gui/providers.go',
  request: { kind: 'object', fields: [{ name: 'Agent', optional: false, type: { kind: 'string' } }] },
  responseTypes: ['provider.SignInState'], actions: [], queryParameters: [], handlerHash: 'a',
})
const baseline = () => ({
  version: 1, revision: 'a'.repeat(40), routes: [route()], loginAgents: ['codex'],
  schemas: { 'provider.SignInState': { kind: 'object', fields: [
    { name: 'id', optional: false, type: { kind: 'string' } },
    { name: 'code', optional: true, type: { kind: 'string' } },
  ] } }, sourceFiles: { 'internal/gui/providers.go': 'a' }, diagnostics: [],
})

test('detects route, schema and login changes rather than only a version number', () => {
  const before = baseline()
  const after = baseline()
  after.routes.push(route('/api/library/rtk'))
  after.routes[0].request.fields[0].type.kind = 'number'
  after.schemas['provider.SignInState'].fields.pop()
  after.loginAgents = ['copilot']
  const diff = compareContracts(before, after)
  assert.deepEqual(diff.addedRoutes, ['management POST /api/library/rtk'])
  assert.deepEqual(diff.changedRoutes, ['management POST /api/signin'])
  assert.deepEqual(diff.changedSchemas, ['provider.SignInState'])
  assert.deepEqual(diff.addedLoginAgents, ['copilot'])
  assert.deepEqual(diff.removedLoginAgents, ['codex'])
})

test('body-only fixes are reported even if every route and schema stays the same', () => {
  const before = baseline()
  const after = baseline()
  after.routes[0].handlerHash = 'b'
  after.sourceFiles['internal/gui/providers.go'] = 'b'
  const diff = compareContracts(before, after)
  assert.deepEqual(diff.changedRoutes, [])
  assert.deepEqual(diff.implementationFiles, ['internal/gui/providers.go'])
})

test('generated types change with upstream JSON tags and exclude conditional routes', () => {
  const contract = baseline()
  contract.routes.push({ ...route('/api/dev'), buildConstraint: 'dev' })
  const types = generateTypes(contract)
  assert.ok(types.includes('"code"?: string'))
  assert.ok(types.includes('"Agent": string'))
  assert.ok(!types.includes('/api/dev'))
  assert.ok(types.includes('Magpie_provider_SignInState'))
  const reference = generateReference(contract)
  assert.ok(reference.includes('/api/dev'))
  assert.ok(reference.includes('not a claim that Crosery exposes'))
})

test('unsupported wire data remains unknown instead of a fabricated schema', () => {
  const contract = baseline()
  contract.routes[0].request = { kind: 'unknown', goType: 'dynamic JSON' }
  contract.schemas['provider.SignInState'] = { kind: 'unknown', goType: 'custom MarshalJSON' }
  assert.ok(generateTypes(contract).includes('"management POST /api/signin": unknown'))
  assert.ok(generateTypes(contract).includes('Magpie_provider_SignInState = unknown'))
  assert.throws(() => compareContracts({ ...contract, version: 2 }, contract), /Unsupported/)
})

test('overlapping checks cannot overwrite a candidate and failures release the lock', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'magpie-check-lock-'))
  t.after(() => fs.rm(directory, { recursive: true, force: true }))
  await withUpstreamLock(directory, async () => {
    const stat = await fs.stat(path.join(directory, 'check.lock'))
    assert.equal(stat.mode & 0o777, 0o600)
    await assert.rejects(withUpstreamLock(directory, () => assert.fail('must not enter')), /locked/)
  })
  await assert.rejects(withUpstreamLock(directory, () => { throw new Error('fixture failure') }), /fixture failure/)
  assert.equal(await withUpstreamLock(directory, () => 'next check'), 'next check')
})

test('candidate publication is grouped, immutable and deduplicated across checks', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'magpie-candidates-'))
  t.after(() => fs.rm(directory, { recursive: true, force: true }))
  const before = baseline()
  const first = await publishCandidate(before, directory)
  assert.equal(await publishCandidate(before, directory), first)
  const after = baseline()
  after.routes[0].request = { kind: 'unknown' }
  const second = await publishCandidate(after, directory)
  assert.notEqual(first, second)
  assert.equal(JSON.parse(await fs.readFile(path.join(directory, first, 'api.json'), 'utf8')).routes[0].request.kind, 'object')
  assert.deepEqual((await fs.readdir(directory)).sort(), [first, second].sort())
  await fs.writeFile(path.join(directory, second, 'API.md'), 'corrupt fixture')
  await assert.rejects(publishCandidate(after, directory), /artifacts changed/)
  assert.equal(JSON.parse(await fs.readFile(path.join(directory, first, 'api.json'), 'utf8')).revision, before.revision)
})

test('scheduled checks inherit public proxy configuration but never credentials', () => {
  const env = checkServiceEnvironment({
    PATH: '/usr/bin:/bin', HTTPS_PROXY: 'http://127.0.0.1:7890', https_proxy: 'http://127.0.0.1:7890',
    NO_PROXY: 'localhost,127.0.0.1', CROSERY_API_KEY: 'fixture-not-for-service', CONSOLE_PASSWORD: 'fixture-not-for-service',
  })
  assert.equal(env.HTTPS_PROXY, 'http://127.0.0.1:7890/')
  assert.equal(env.https_proxy, env.HTTPS_PROXY)
  assert.equal(env.NO_PROXY, 'localhost,127.0.0.1')
  assert.equal('CROSERY_API_KEY' in env, false)
  assert.equal('CONSOLE_PASSWORD' in env, false)
  assert.throws(() => checkServiceEnvironment({ HTTPS_PROXY: 'http://user:password@proxy.invalid' }), /credential-free/)
  assert.throws(() => checkServiceEnvironment({ HTTPS_PROXY: 'http://proxy.invalid?token=fixture' }), /credential-free/)
})

/* ────────────────────────── review-sync-balance ────────────────────────── */

test('SB-08 abandoned check.lock is recovered when its owner is gone or its pid was reused; a live owner is never robbed', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'magpie-check-stale-'))
  t.after(() => fs.rm(directory, { recursive: true, force: true }))
  const lockFile = path.join(directory, 'check.lock')
  const writeLock = (owner) => fs.writeFile(lockFile, typeof owner === 'string' ? owner : JSON.stringify(owner), { mode: 0o600 })

  // 被 SIGKILL 的检查：pid 已不存在
  await writeLock({ pid: 2147483646, startedAt: new Date().toISOString() })
  assert.equal(await withUpstreamLock(directory, () => 'recovered'), 'recovered')
  await assert.rejects(fs.access(lockFile), 'lock released after the recovered run')

  // 活着的持有者（父进程）且锁龄正常：不抢
  await writeLock({ pid: process.ppid, startedAt: new Date().toISOString() })
  await assert.rejects(withUpstreamLock(directory, () => assert.fail('must not enter')), /locked by a live process/)

  // pid 还在，但那个进程比锁还晚启动（父进程几分钟前才起，锁写于 3 小时前）：pid 被复用，原持有者早已不在
  await writeLock({ pid: process.ppid, startedAt: new Date(Date.now() - 3 * 60 * 60_000).toISOString() })
  assert.equal(await withUpstreamLock(directory, () => 'old lock recovered'), 'old lock recovered')

  // 写内容之前就崩溃的空锁：新鲜的不动，过了 10 分钟按残留处理
  await writeLock('')
  await assert.rejects(withUpstreamLock(directory, () => assert.fail('must not enter')), /locked/)
  const old = new Date(Date.now() - 11 * 60_000)
  await fs.utimes(lockFile, old, old)
  assert.equal(await withUpstreamLock(directory, () => 'empty lock recovered'), 'empty lock recovered')

  // 另一个回收者正持有回收互斥：本轮按已上锁退出，不并发回收
  await writeLock({ pid: 2147483646, startedAt: new Date().toISOString() })
  await fs.writeFile(path.join(directory, 'check.lock.recover'), '')
  await assert.rejects(withUpstreamLock(directory, () => assert.fail('must not enter')), /locked/)
  await fs.rm(path.join(directory, 'check.lock.recover'))
  assert.equal(await withUpstreamLock(directory, () => 'next round'), 'next round')
})

test('SB-08 活着的持有者不管锁多老都不抢（机器睡眠/进程挂起后它还会回来）；活着但身份确认不了也不抢', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'magpie-check-live-'))
  t.after(() => fs.rm(directory, { recursive: true, force: true }))
  const lockFile = path.join(directory, 'check.lock')
  const startedAt = Date.now() - 3 * 60 * 60_000
  await fs.writeFile(lockFile, JSON.stringify({ pid: process.ppid, startedAt: new Date(startedAt).toISOString() }), { mode: 0o600 })
  // 父进程活着，且启动得比锁早：就是写锁的那个进程
  const sameProcess = { processStartTime: () => startedAt - 60_000 }
  await assert.rejects(withUpstreamLock(directory, () => assert.fail('must not enter'), sameProcess), /locked by a live process/)
  assert.ok(JSON.parse(await fs.readFile(lockFile, 'utf8')).pid === process.ppid, '锁原样保留')
  // 拿不到启动时间：确认不了是不是 pid 复用，宁可本轮按已上锁退出
  await assert.rejects(withUpstreamLock(directory, () => assert.fail('must not enter'), { processStartTime: () => null }), /locked by a live process/)
  assert.ok(JSON.parse(await fs.readFile(lockFile, 'utf8')).pid === process.ppid)
  assert.ok(typeof processStartTime(process.pid) === 'number' && processStartTime(process.pid) <= Date.now(), '本机能读到进程启动时间')
})

test('SB-08 结束时只删自己的锁：期间锁被换成了别人的，不能把别人的删掉', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'magpie-check-own-'))
  t.after(() => fs.rm(directory, { recursive: true, force: true }))
  const lockFile = path.join(directory, 'check.lock')
  const successor = JSON.stringify({ pid: process.ppid, startedAt: new Date().toISOString() })
  await withUpstreamLock(directory, async () => {
    await fs.rm(lockFile)
    await fs.writeFile(lockFile, successor, { mode: 0o600 })
  })
  assert.equal(await fs.readFile(lockFile, 'utf8'), successor)
})

test('SB-08 回收互斥：活着的回收者不管停了多久都不被清掉；持有者已死的互斥被清掉，下一轮照常回收', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'magpie-check-guard-'))
  t.after(() => fs.rm(directory, { recursive: true, force: true }))
  const lockFile = path.join(directory, 'check.lock')
  const guardFile = path.join(directory, 'check.lock.recover')
  await fs.writeFile(lockFile, JSON.stringify({ pid: 2147483646, startedAt: new Date().toISOString() }), { mode: 0o600 })
  const old = new Date(Date.now() - 10 * 60_000)

  await fs.writeFile(guardFile, JSON.stringify({ pid: process.ppid, startedAt: new Date().toISOString() }))
  await fs.utimes(guardFile, old, old)
  await assert.rejects(withUpstreamLock(directory, () => assert.fail('must not enter')), /locked/)
  await fs.access(guardFile) // 活着的回收者（停了 10 分钟）仍持有互斥
  await assert.rejects(withUpstreamLock(directory, () => assert.fail('must not enter'), { processStartTime: () => null }), /locked/)
  await fs.access(guardFile) // 活着但拿不到启动时间：同样不清

  await fs.writeFile(guardFile, JSON.stringify({ pid: 2147483646, startedAt: new Date().toISOString() }))
  await assert.rejects(withUpstreamLock(directory, () => assert.fail('must not enter')), /locked/, '本轮只清互斥，按已上锁退出')
  await assert.rejects(fs.access(guardFile), '持有者已死的互斥被清掉')
  assert.equal(await withUpstreamLock(directory, () => 'recovered'), 'recovered')
})

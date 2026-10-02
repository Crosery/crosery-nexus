import './testDataDir.js'

import assert from 'node:assert/strict'
import path from 'node:path'
import test from 'node:test'
import { testDataDir } from './testDataDir.js'

// 版本读取会先读 RTK 状态：指向不存在的二进制、远端平面不配置，避免起子进程或打真实主机。
process.env.RTK_BIN = path.join(testDataDir, 'no-rtk')
process.env.RTK_HOME = testDataDir
delete process.env.MAGPIE_SOURCE_CPA_BASE_URL
delete process.env.MAGPIE_SOURCE_CPA_KEY

const { config } = await import('./config.js')
const { getCpaVersion, resetCpaVersionCache } = await import('./cpa.js')

test('/api/version 不再每次强刷：60s 缓存；fresh 也至少隔 15s；失败结果缓存 30s', async () => {
  const original = { fetch: globalThis.fetch, now: Date.now, engine: config.gatewayEngine, key: config.cpaManagementKey, base: config.cpaBaseUrl }
  let clock = 5_000_000
  let calls = 0
  let healthy = true
  config.gatewayEngine = 'cpa'
  config.cpaManagementKey = 'fixture-management-key'
  config.cpaBaseUrl = 'https://cpa.example.test'
  Date.now = () => clock
  globalThis.fetch = (async (input: string | URL | Request) => {
    calls += 1
    if (!healthy) throw new Error('connect ECONNREFUSED')
    if (String(input).endsWith('/latest-version')) return new Response(JSON.stringify({ 'latest-version': 'v7.3.0' }), { status: 200 })
    return new Response('{}', { status: 200, headers: { 'x-cpa-version': 'v7.2.0' } })
  }) as typeof fetch
  resetCpaVersionCache()
  try {
    const first = await getCpaVersion()
    assert.equal(first.version, 'v7.2.0')
    assert.ok('rtk' in first, '首次读取也要带 rtk 摘要')
    assert.equal(calls, 2)

    clock += 5_000
    await getCpaVersion(true)
    assert.equal(calls, 2, 'fresh 在 15s 内仍走缓存')
    clock += 11_000
    await getCpaVersion(true)
    assert.equal(calls, 4, '超过 15s 的 fresh 才真正刷新')
    clock += 30_000
    await getCpaVersion()
    assert.equal(calls, 4, '普通读取 60s 内走缓存')

    healthy = false
    clock += 61_000
    assert.equal((await getCpaVersion()).version, 'offline')
    const afterFailure = calls
    clock += 10_000
    assert.equal((await getCpaVersion()).version, 'offline')
    assert.equal(calls, afterFailure, '失败也缓存，不在 CPA 挂掉时每次加载都再等一次超时')
  } finally {
    globalThis.fetch = original.fetch
    Date.now = original.now
    config.gatewayEngine = original.engine
    config.cpaManagementKey = original.key
    config.cpaBaseUrl = original.base
    resetCpaVersionCache()
  }
})

test('SB-20 冷读单飞：并发首次读取只发一次 get-auth-status + latest-version；reset 之前发出的慢读取不能回写缓存', async () => {
  const original = { fetch: globalThis.fetch, engine: config.gatewayEngine, key: config.cpaManagementKey, base: config.cpaBaseUrl }
  let calls = 0
  let release: () => void = () => undefined
  let gate = new Promise<void>((resolve) => { release = resolve })
  let version = 'v7.2.0'
  config.gatewayEngine = 'cpa'
  config.cpaManagementKey = 'fixture-management-key'
  config.cpaBaseUrl = 'https://cpa.example.test'
  globalThis.fetch = (async (input: string | URL | Request) => {
    calls += 1
    const reported = version
    await gate
    if (String(input).endsWith('/latest-version')) return new Response(JSON.stringify({ 'latest-version': 'v7.3.0' }), { status: 200 })
    return new Response('{}', { status: 200, headers: { 'x-cpa-version': reported } })
  }) as typeof fetch
  resetCpaVersionCache()
  try {
    const pending = Promise.all([getCpaVersion(), getCpaVersion(), getCpaVersion(true)])
    await new Promise(resolve => setTimeout(resolve, 5))
    release()
    const results = await pending
    assert.deepEqual(results.map(result => result.version), ['v7.2.0', 'v7.2.0', 'v7.2.0'])
    assert.equal(calls, 2, '三个并发冷读共用一次刷新')

    // reset 期间还在途的旧读取（v-old）回来时不能盖掉 reset 之后的新结果
    resetCpaVersionCache()
    gate = new Promise<void>((resolve) => { release = resolve })
    version = 'v-old'
    const stale = getCpaVersion()
    await new Promise(resolve => setTimeout(resolve, 5))
    resetCpaVersionCache()
    const releaseOld = release
    gate = Promise.resolve()
    version = 'v7.4.0'
    const fresh = await getCpaVersion()
    assert.equal(fresh.version, 'v7.4.0')
    releaseOld()
    assert.equal((await stale).version, 'v-old', '旧读取本身照常返回给它的调用方')
    assert.equal((await getCpaVersion()).version, 'v7.4.0', '旧读取晚到也不回写')
  } finally {
    globalThis.fetch = original.fetch
    config.gatewayEngine = original.engine
    config.cpaManagementKey = original.key
    config.cpaBaseUrl = original.base
    resetCpaVersionCache()
  }
})

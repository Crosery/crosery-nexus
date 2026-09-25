import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

/**
 * CPA v7.2.140（2026-08-22 构建，本机 2026-08-23 01:12 自动升级）把
 * /v0/management/api-key-model-access 和 /v0/management/available-models
 * 从上游删掉了，命中时是 gin NoRoute 的空响应体 404。
 *
 * 后果分两层，这里都要钉住：
 *   1. 控制台读写这两个路由的地方必须降级，不能把「网关没这个能力」报成「操作失败」——
 *      渠道/账号/模型开关的主操作在抛错前就已经在网关生效了，报错只会让 UI 和真实状态分裂。
 *   2. 网关侧已经没有 Key 级模型隔离，必须把降级事实如实透出去，
 *      而不是继续假装分组白名单仍然生效。
 */

const CPA = 'https://cpa.example.test'
const REMOVED_IN_V72140 = ['/api-key-model-access', '/available-models']

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'console-degrade-'))
process.env.DATA_DIR = dataDir
process.env.CPA_BASE_URL = CPA
process.env.CPA_MANAGEMENT_KEY = 'management-key'

const originalFetch = globalThis.fetch

type GatewayOptions = {
  keys?: string[]
  authFiles?: Array<Record<string, unknown>>
  authFileModels?: string[]
  compatChannels?: Array<Record<string, unknown>>
  chatStatus?: number
}

/** 复刻 7.2.140 的真实形态：两个路由空体 404，其余管理路由照常工作。 */
function mockGatewayAfterV72140(options: GatewayOptions = {}) {
  const {
    keys = ['sk-alpha', 'sk-beta'],
    authFiles = [{ name: 'claude-crosery.json', type: 'claude', disabled: false, status: 'active' }],
    authFileModels = ['claude-opus-5'],
    compatChannels = [{ name: 'minimax', 'base-url': 'https://api.minimaxi.com/v1', models: [{ name: 'minimax-m2.5' }] }],
    chatStatus = 200,
  } = options

  const calls: string[] = []
  const json = (body: unknown) =>
    new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input))
    const method = String(init?.method || 'GET')

    if (url.pathname === '/v1/chat/completions') {
      calls.push(`${method} /v1/chat/completions`)
      return new Response(JSON.stringify({ choices: [{ message: { content: 'pong' } }] }), {
        status: chatStatus,
        headers: { 'Content-Type': 'application/json' },
      })
    }

    const route = url.pathname.replace('/v0/management', '')
    calls.push(`${method} ${route}`)

    if (REMOVED_IN_V72140.includes(route)) return new Response('', { status: 404 })

    if (route === '/api-keys') return json({ 'api-keys': keys })
    if (route === '/auth-files') return json({ files: authFiles })
    if (route === '/auth-files/models') return json({ models: authFileModels.map((id) => ({ id })) })
    if (route === '/openai-compatibility') return json({ 'openai-compatibility': compatChannels })
    if (route === '/oauth-excluded-models') return json({ 'oauth-excluded-models': {} })
    if (route === '/proxy-url') return json({ 'proxy-url': '' })
    if (route.endsWith('-api-key')) return json({ [route.slice(1)]: [] })
    return json({})
  }) as typeof fetch

  return calls
}

const restoreFetch = () => { globalThis.fetch = originalFetch }

// 每个用例独立加载，避免模块级缓存（例如 sync 的降级标记）跨用例串味。
const freshImport = <T>(module: string): Promise<T> =>
  import(`${module}?degrade=${Date.now()}-${Math.random()}`) as Promise<T>

test('账号开关不再因为网关缺少 api-key-model-access 而整体失败', async () => {
  mockGatewayAfterV72140()
  try {
    const { reconcileKeyModelAccess } = await freshImport<typeof import('./sync.js')>('./sync.ts')
    // 抛出就说明 PATCH /api/channels、/api/credentials、/api/keys 等 10 条写路由会继续 400
    await assert.doesNotReject(() => reconcileKeyModelAccess())
  } finally {
    restoreFetch()
  }
})

test('网关真的故障时仍然抛错，不能被降级吞掉', async () => {
  mockGatewayAfterV72140()
  const gatewayDown = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).includes('/api-key-model-access')) return new Response('upstream unavailable', { status: 503 })
    return gatewayDown(input, init)
  }) as typeof fetch
  try {
    const { reconcileKeyModelAccess } = await freshImport<typeof import('./sync.js')>('./sync.ts')
    await assert.rejects(() => reconcileKeyModelAccess(), /CPA 503/)
  } finally {
    restoreFetch()
  }
})

test('渠道权限接口缺失必须报错，不能把独立候选池隔离静默降级', async () => {
  mockGatewayAfterV72140()
  const base = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).includes('/api-key-channel-access')) return new Response('', { status: 404 })
    return base(input, init)
  }) as typeof fetch
  try {
    const { reconcileKeyModelAccess } = await freshImport<typeof import('./sync.js')>('./sync.ts')
    await assert.rejects(() => reconcileKeyModelAccess(), /CPA 404/)
  } finally {
    restoreFetch()
  }
})

test('还没和网关对账过时不预设网关支持', async () => {
  const capability = await freshImport<typeof import('./managementCapability.js')>('./managementCapability.ts')
  assert.equal(capability.getKeyModelAccessState(), 'unknown')
})

test('对账后如实记录网关侧模型隔离已不可用，供 bootstrap 透出', async () => {
  mockGatewayAfterV72140()
  try {
    const { reconcileKeyModelAccess } = await freshImport<typeof import('./sync.js')>('./sync.ts')
    await reconcileKeyModelAccess()
    // 走 sync 用的同一个模块说明符，读到的必须是同一份运行时事实
    const { getKeyModelAccessState } = await import('./managementCapability.js')
    assert.equal(getKeyModelAccessState(), 'unavailable')
  } finally {
    restoreFetch()
  }
})

test('网关支持该能力时记录为可用，不会一直挂着降级标记', async () => {
  mockGatewayAfterV72140()
  const base = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).includes('/api-key-model-access')) {
      return new Response(JSON.stringify({ 'api-key-model-access': {} }), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      })
    }
    return base(input, init)
  }) as typeof fetch
  try {
    const { reconcileKeyModelAccess } = await freshImport<typeof import('./sync.js')>('./sync.ts')
    await reconcileKeyModelAccess()
    const { getKeyModelAccessState } = await import('./managementCapability.js')
    assert.equal(getKeyModelAccessState(), 'available')
  } finally {
    restoreFetch()
  }
})

test.after(() => {
  globalThis.fetch = originalFetch
  fs.rmSync(dataDir, { recursive: true, force: true })
})

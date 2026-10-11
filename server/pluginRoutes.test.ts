import './testDataDir.js'
import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import test from 'node:test'
import express from 'express'
import { config } from './config.js'
import { createPluginRoutes, deletePlugin, installPlugin, listPlugins, listPluginStore } from './cpa.js'

const originalFetch = globalThis.fetch
const cpaBaseUrl = 'https://cpa.plugins.example.test'

test('cpa 插件封装：URL、HTTP 方法、查询参数与 v8 → v0 回退', async () => {
  const prevBase = config.cpaBaseUrl
  const prevKey = config.cpaManagementKey
  config.cpaBaseUrl = cpaBaseUrl
  config.cpaManagementKey = 'plugin-mgmt-key'
  const calls: Array<{ url: string; method: string; auth: string }> = []
  let v8Plugins404 = false

  globalThis.fetch = async (input, init) => {
    const url = String(input)
    const method = String(init?.method || 'GET')
    const headers = (init?.headers ?? {}) as Record<string, string>
    calls.push({ url, method, auth: String(headers.Authorization || '') })
    if (url.endsWith('/v8/management/plugins') && v8Plugins404) {
      return new Response('not found', { status: 404 })
    }
    return new Response(JSON.stringify({ ok: true, url, method }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  try {
    await listPlugins()
    v8Plugins404 = true
    await listPlugins()
    await listPluginStore()
    await installPlugin('session-mapper')
    await installPlugin('session-mapper', 'official-store')
    await deletePlugin('session-mapper')

    assert.deepEqual(
      calls.map((c) => [c.method, c.url, c.auth]),
      [
        ['GET', `${cpaBaseUrl}/v8/management/plugins`, 'Bearer plugin-mgmt-key'],
        ['GET', `${cpaBaseUrl}/v8/management/plugins`, 'Bearer plugin-mgmt-key'],
        ['GET', `${cpaBaseUrl}/v0/management/plugins`, 'Bearer plugin-mgmt-key'],
        ['GET', `${cpaBaseUrl}/v8/management/plugins/store`, 'Bearer plugin-mgmt-key'],
        ['POST', `${cpaBaseUrl}/v8/management/plugins/store/session-mapper/install`, 'Bearer plugin-mgmt-key'],
        ['POST', `${cpaBaseUrl}/v8/management/plugins/store/session-mapper/install?source=official-store`, 'Bearer plugin-mgmt-key'],
        ['DELETE', `${cpaBaseUrl}/v8/management/plugins/session-mapper`, 'Bearer plugin-mgmt-key'],
      ],
    )
  } finally {
    globalThis.fetch = originalFetch
    config.cpaBaseUrl = prevBase
    config.cpaManagementKey = prevKey
  }
})

test('/api/plugins* 路由：透传 JSON、记录审计、上游 400 plugin_store_source_required 映射为 502 带原文', async () => {
  const prevBase = config.cpaBaseUrl
  const prevKey = config.cpaManagementKey
  config.cpaBaseUrl = cpaBaseUrl
  config.cpaManagementKey = 'plugin-mgmt-key'

  const audits: Array<[string, string, string]> = []
  const app = express()
  app.use(express.json())
  const pluginRoutes = createPluginRoutes({
    addAudit: (action, target, detail = '') => {
      audits.push([action, target, detail])
    },
  })
  app.get('/api/plugins', pluginRoutes.list)
  app.get('/api/plugins/store', pluginRoutes.store)
  app.post('/api/plugins/store/:id/install', pluginRoutes.install)
  app.delete('/api/plugins/:id', pluginRoutes.remove)

  const server: Server = createServer(app)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  const localBase = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`

  const upstreamCalls: Array<{ method: string; url: string }> = []
  globalThis.fetch = async (input, init) => {
    const url = String(input)
    if (url.startsWith(localBase)) {
      return originalFetch(input, init)
    }
    const method = String(init?.method || 'GET')
    upstreamCalls.push({ method, url })
    if (method === 'GET' && url === `${cpaBaseUrl}/v8/management/plugins`) {
      return new Response(
        JSON.stringify({ plugins_enabled: true, plugins_dir: 'plugins', plugins: [{ id: 'p1', registered: true, effective_enabled: true }] }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      )
    }
    if (method === 'GET' && url === `${cpaBaseUrl}/v8/management/plugins/store`) {
      return new Response(
        JSON.stringify({ plugins_enabled: true, sources: [{ id: 'official', name: 'Official', url: 'https://example.test/reg.json' }], plugins: [{ id: 'p1', installed: true }] }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      )
    }
    if (method === 'POST' && url === `${cpaBaseUrl}/v8/management/plugins/store/multi-src/install`) {
      return new Response(
        JSON.stringify({ error: 'plugin_store_source_required', message: 'multiple sources provide multi-src' }),
        { status: 400, headers: { 'Content-Type': 'application/json' } },
      )
    }
    if (method === 'POST' && url === `${cpaBaseUrl}/v8/management/plugins/store/multi-src/install?source=official`) {
      return new Response(
        JSON.stringify({ status: 'installed', id: 'multi-src', source_id: 'official' }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      )
    }
    if (method === 'DELETE' && url === `${cpaBaseUrl}/v8/management/plugins/multi-src`) {
      return new Response(
        JSON.stringify({ status: 'deleted', id: 'multi-src' }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      )
    }
    return new Response('unexpected upstream request', { status: 500 })
  }

  try {
    const listRes = await originalFetch(`${localBase}/api/plugins`)
    assert.equal(listRes.status, 200)
    const listBody = (await listRes.json()) as Record<string, unknown>
    assert.equal(listBody.plugins_enabled, true)

    const storeRes = await originalFetch(`${localBase}/api/plugins/store`)
    assert.equal(storeRes.status, 200)
    const storeBody = (await storeRes.json()) as Record<string, unknown>
    assert.equal(Array.isArray(storeBody.sources), true)

    const badInstall = await originalFetch(`${localBase}/api/plugins/store/multi-src/install`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    })
    assert.equal(badInstall.status, 502)
    const badBody = (await badInstall.json()) as { error?: string }
    assert.match(String(badBody.error || ''), /plugin_store_source_required/)
    assert.equal(audits.length, 0, '失败的安装不应写审计')

    const okInstall = await originalFetch(`${localBase}/api/plugins/store/multi-src/install`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source: 'official' }),
    })
    assert.equal(okInstall.status, 200)
    const okInstallBody = (await okInstall.json()) as Record<string, unknown>
    assert.equal(okInstallBody.status, 'installed')
    assert.equal(okInstallBody.source_id, 'official')

    const rmRes = await originalFetch(`${localBase}/api/plugins/multi-src`, { method: 'DELETE' })
    assert.equal(rmRes.status, 200)
    const rmBody = (await rmRes.json()) as Record<string, unknown>
    assert.equal(rmBody.status, 'deleted')

    assert.deepEqual(audits, [
      ['plugin-install', 'multi-src', 'official'],
      ['plugin-remove', 'multi-src', ''],
    ])
  } finally {
    globalThis.fetch = originalFetch
    config.cpaBaseUrl = prevBase
    config.cpaManagementKey = prevKey
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})

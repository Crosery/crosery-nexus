import './testDataDir.js'
import assert from 'node:assert/strict'
import type { AddressInfo } from 'node:net'
import test from 'node:test'
import express from 'express'

const { config } = await import('./config.js')
const { gatewayBaseUrl } = await import('./meRoutes.js')
const { connectInfo, registerConnectRoutes } = await import('./connectRoutes.js')

function withGateway(url: string, engine: typeof config.gatewayEngine, run: () => void | Promise<void>) {
  const original = { url: config.publicGatewayBaseUrl, engine: config.gatewayEngine }
  config.publicGatewayBaseUrl = url
  config.gatewayEngine = engine
  const restore = () => {
    config.publicGatewayBaseUrl = original.url
    config.gatewayEngine = original.engine
  }
  try {
    const result = run()
    if (result instanceof Promise) return result.finally(restore)
    restore()
    return undefined
  } catch (error) {
    restore()
    throw error
  }
}

test('connect: configured public base → same URL the key user sees, Anthropic base without /v1', () => {
  withGateway('https://gateway.example.test', 'magpie', () => {
    assert.deepEqual(connectInfo(), {
      baseUrl: 'https://gateway.example.test/v1',
      anthropicBaseUrl: 'https://gateway.example.test',
      configured: true,
    })
    assert.equal(connectInfo().baseUrl, gatewayBaseUrl())
  })
})

test('connect: unset public base → local gateway fallback, flagged as not configured', () => {
  withGateway('', 'magpie', () => {
    const info = connectInfo()
    assert.equal(info.baseUrl, `http://127.0.0.1:${config.magpiePort}/v1`)
    assert.equal(info.anthropicBaseUrl, `http://127.0.0.1:${config.magpiePort}`)
    assert.equal(info.configured, false)
  })
  withGateway('', 'cpa', () => {
    assert.equal(connectInfo().baseUrl, `${config.cpaBaseUrl}/v1`)
    assert.equal(connectInfo().configured, false)
  })
})

test('connect: a non-/v1 base has no Anthropic base (never guessed)', () => {
  withGateway('https://gateway.example.test/v2', 'magpie', () => {
    assert.equal(connectInfo().baseUrl, 'https://gateway.example.test/v2')
    assert.equal(connectInfo().anthropicBaseUrl, null)
  })
})

test('GET /api/connect: JSON body, no-store, nothing but the three fields', async () => {
  const app = express()
  registerConnectRoutes(app)
  const server = app.listen(0, '127.0.0.1')
  await new Promise((resolve) => server.once('listening', resolve))
  try {
    await withGateway('https://gateway.example.test/v1', 'magpie', async () => {
      const { port } = server.address() as AddressInfo
      const response = await fetch(`http://127.0.0.1:${port}/api/connect`)
      assert.equal(response.status, 200)
      assert.equal(response.headers.get('cache-control'), 'no-store')
      const body = (await response.json()) as Record<string, unknown>
      assert.deepEqual(Object.keys(body).sort(), ['anthropicBaseUrl', 'baseUrl', 'configured'])
      assert.equal(body.baseUrl, 'https://gateway.example.test/v1')
    })
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
})

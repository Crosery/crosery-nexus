import './testDataDir.js'
import assert from 'node:assert/strict'
import type { AddressInfo } from 'node:net'
import test from 'node:test'
import express from 'express'

const { config } = await import('./config.js')
const { gatewayBaseUrl } = await import('./meRoutes.js')
const { connectInfo, registerConnectRoutes } = await import('./connectRoutes.js')

function withGateway(url: string, run: () => void | Promise<void>) {
  const original = config.publicGatewayBaseUrl
  config.publicGatewayBaseUrl = url
  const restore = () => {
    config.publicGatewayBaseUrl = original
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
  withGateway('https://gateway.example.test', () => {
    assert.deepEqual(connectInfo(), {
      baseUrl: 'https://gateway.example.test/v1',
      anthropicBaseUrl: 'https://gateway.example.test',
      configured: true,
    })
    assert.equal(connectInfo().baseUrl, gatewayBaseUrl())
  })
})

test('connect: unset public base → local gateway fallback, flagged as not configured', () => {
  withGateway('', () => {
    const info = connectInfo()
    assert.equal(info.baseUrl, `${config.cpaBaseUrl}/v1`)
    assert.equal(info.anthropicBaseUrl, config.cpaBaseUrl)
    assert.equal(info.configured, false)
  })
})

test('connect: a non-/v1 base has no Anthropic base (never guessed)', () => {
  withGateway('https://gateway.example.test/v2', () => {
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
    await withGateway('https://gateway.example.test/v1', async () => {
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

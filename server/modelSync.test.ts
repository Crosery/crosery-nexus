import assert from 'node:assert/strict'
import test from 'node:test'
import { readSharedCatalog, sharedCatalogPath, syncUpstreamModels } from './modelSync.js'

test('shared catalog reader correctly accesses ~/.agents/crosery/catalog.json if present', () => {
  const p = sharedCatalogPath()
  assert.ok(p.includes('catalog.json'))

  const catalog = readSharedCatalog()
  if (catalog) {
    assert.equal(catalog.version, 1)
    assert.equal(catalog.provider, 'crosery')
    assert.ok(Array.isArray(catalog.models))
    assert.ok(catalog.models.length > 0)
    assert.ok(catalog.models.some(m => m.id.includes('claude') || m.id.includes('gpt')))
  }
})

test('syncUpstreamModels runs and returns structured sync result', async () => {
  const result = await syncUpstreamModels({ force: true })
  assert.ok(result)
  assert.ok(Array.isArray(result.addedModels))
  assert.ok(typeof result.totalModels === 'number')
  assert.ok(typeof result.channelCount === 'number')
  assert.ok(typeof result.syncedAt === 'string')
})

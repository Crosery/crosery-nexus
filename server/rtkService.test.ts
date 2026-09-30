import assert from 'node:assert/strict'
import test from 'node:test'
import { detectAgentHooks, findRTKBinary, readRTKStatus } from './rtkService.js'

test('detects rtk binary when installed on system', () => {
  const bin = findRTKBinary()
  // rtk is installed at /Users/crosery/.local/bin/rtk
  assert.ok(bin)
  assert.match(bin, /rtk$/)
})

test('detects installed agent hooks correctly', () => {
  const agents = detectAgentHooks()
  assert.ok(Array.isArray(agents))
  const codex = agents.find(a => a.id === 'codex')
  assert.ok(codex)
  assert.equal(codex.name, 'Codex')
  // On this system, Codex has RTK initialized
  assert.equal(codex.on, true)

  const claude = agents.find(a => a.id === 'claude')
  assert.ok(claude)
  assert.equal(claude.name, 'Claude Code')
})

test('readRTKStatus reports connection, version and agent hooks', async () => {
  const status = await readRTKStatus()
  assert.equal(status.connected, true)
  assert.ok(status.path)
  assert.ok(status.version)
  assert.ok(Array.isArray(status.agents))
  assert.equal(status.url, 'https://www.rtk-ai.app')
})

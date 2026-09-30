import test, { type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { MAGPIE_API_REVISION, MAGPIE_API_ROUTES, MAGPIE_LOGIN_AGENTS } from '../packages/contracts/magpie-upstream.generated.js'
import { readMagpieUpstreamStatus } from './magpieUpstream.js'

const status = () => ({
  version: 1, status: 'review_required', baselineRevision: MAGPIE_API_REVISION, candidateRevision: 'a'.repeat(40),
  checkedAt: '2026-09-30T07:34:12Z', latestRelease: 'v0.1.469', rtkRelease: 'v0.50.0',
  diff: { addedRoutes: ['management GET /api/agent-models/{id}'], removedRoutes: [], changedRoutes: [],
    changedSchemas: ['provider.Login'], implementationFiles: ['internal/provider/logins.go'],
    addedLoginAgents: [], removedLoginAgents: [], diagnostics: [] },
})

function file(t: TestContext, value: unknown) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'magpie-upstream-status-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const filename = path.join(dir, 'status.json')
  fs.writeFileSync(filename, JSON.stringify(value), { mode: 0o600 })
  return filename
}

test('version status consumes generated upstream routes and supported login IDs', () => {
  const result = readMagpieUpstreamStatus(MAGPIE_API_REVISION, '/nonexistent-magpie-status')
  assert.equal(result.status, 'not_checked')
  assert.equal(result.routes.inference, MAGPIE_API_ROUTES.filter(route => route.surface === 'inference').length)
  assert.deepEqual(result.loginAgents, [...MAGPIE_LOGIN_AGENTS])
  assert.equal(result.routes.rtk, 4)
  assert.equal(result.oauthConnected, false)
  assert.equal(result.rtkConnected, false)
})

test('reports a parsed candidate without implying it was installed or enabled', t => {
  const result = readMagpieUpstreamStatus(MAGPIE_API_REVISION, file(t, status()))
  assert.equal(result.status, 'review_required')
  assert.equal(result.candidateRevision, 'a'.repeat(40))
  assert.equal(result.changes.schemaCount, 1)
  assert.deepEqual(result.changes.addedRoutes, ['management GET /api/agent-models/{id}'])
})

test('a different running revision cannot reuse a diff from another baseline', () => {
  const result = readMagpieUpstreamStatus('b'.repeat(40), '/nonexistent-magpie-status')
  assert.equal(result.status, 'baseline_mismatch')
  assert.equal(result.candidateRevision, null)
})

test('corrupt, oversized and public status files fail closed without file details', t => {
  for (const value of [{}, { ...status(), version: 2 }, { ...status(), candidateRevision: 'not-a-commit' }, { ...status(), diff: null }]) {
    assert.equal(readMagpieUpstreamStatus(MAGPIE_API_REVISION, file(t, value)).status, 'error')
  }
  const filename = file(t, status())
  fs.chmodSync(filename, 0o644)
  assert.equal(readMagpieUpstreamStatus(MAGPIE_API_REVISION, filename).status, 'error')
  fs.chmodSync(filename, 0o600)
  fs.writeFileSync(filename, 'x'.repeat(1024 * 1024 + 1))
  assert.equal(readMagpieUpstreamStatus(MAGPIE_API_REVISION, filename).status, 'error')
})

test('remote failure preserves known candidate information but explicitly reports error', t => {
  const result = readMagpieUpstreamStatus(MAGPIE_API_REVISION, file(t, { ...status(), status: 'error' }))
  assert.equal(result.status, 'error')
  assert.equal(result.candidateRevision, 'a'.repeat(40))
})

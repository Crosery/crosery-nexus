import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { compareContracts, generateTypes, generateReference, withUpstreamLock, publishCandidate, checkServiceEnvironment } from './magpie-upstream.mjs'

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

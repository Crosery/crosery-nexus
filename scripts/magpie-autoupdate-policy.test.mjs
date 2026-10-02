import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { compareContracts } from './magpie-upstream.mjs'
import {
  CONSOLE_ROUTES, classifyCandidate, compareVersions, normalizeConfig, parseWindow, schemaClosure, windowState,
} from './magpie-autoupdate-policy.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const baseline = JSON.parse(fs.readFileSync(path.join(root, 'deploy/magpie/upstream/api.json'), 'utf8'))
const clone = value => JSON.parse(JSON.stringify(value))
const id = route => `${route.surface} ${route.method} ${route.path}`
const noDrift = { addedSettings: [], removedSettings: [], changedSettings: [] }
const quietCatalog = { addedAgents: [], removedAgents: [], riskChanged: [], signinChanged: [], changedAgents: [], copyChanged: [], settingsCopyChanged: [] }
const classify = (candidate, extra = {}, catalogDrift = quietCatalog) =>
  classifyCandidate({ baseline, candidate, diff: { ...compareContracts(baseline, candidate), ...noDrift, ...extra }, catalogDrift })
const codes = result => result.reasons.map(reason => reason.code)

test('every console route is a real route of the pinned contract', () => {
  const ids = new Set(baseline.routes.map(id))
  assert.deepEqual(CONSOLE_ROUTES.filter(route => !ids.has(route)), [])
})

test('the inference routes match the admission adapter in server/magpieEngine.ts', () => {
  const source = fs.readFileSync(path.join(root, 'server/magpieEngine.ts'), 'utf8')
  const block = /const admissionRoutes = \[([\s\S]*?)\] as const/.exec(source)?.[1] ?? ''
  const admission = [...block.matchAll(/'([^']+)'/g)].map(match => match[1]).sort()
  assert.ok(admission.length >= 5)
  assert.deepEqual(CONSOLE_ROUTES.filter(route => route.startsWith('inference ')).sort(), admission)
})

test('the same contract is eligible; an added route is still eligible', () => {
  assert.deepEqual(classify(clone(baseline)), { eligible: true, reasons: [] })
  const candidate = clone(baseline)
  candidate.revision = 'b'.repeat(40)
  candidate.routes.push({ ...clone(candidate.routes[0]), surface: 'inference', method: 'POST', path: '/v1/videos' })
  const result = classify(candidate)
  assert.equal(result.eligible, true, JSON.stringify(result.reasons))
})

test('a removed or changed console route stops; the same change on an unused route does not', () => {
  const removed = clone(baseline)
  removed.routes = removed.routes.filter(route => id(route) !== 'inference POST /v1/responses')
  assert.deepEqual(codes(classify(removed)), ['route-removed'])

  const changed = clone(baseline)
  const signin = changed.routes.find(route => id(route) === 'management POST /api/signin')
  signin.queryParameters = [...(signin.queryParameters || []), 'mode']
  assert.deepEqual(codes(classify(changed)), ['route-changed'])

  const unused = clone(baseline)
  const window = unused.routes.find(route => route.surface === 'management' && !CONSOLE_ROUTES.includes(id(route)))
  window.queryParameters = [...(window.queryParameters || []), 'x']
  assert.equal(classify(unused).eligible, true)
})

test('a schema the console reads stops; an unrelated schema does not', () => {
  const closure = schemaClosure(baseline)
  assert.ok(closure.has('provider.SignInState') && closure.has('library.RTKView'))
  const used = clone(baseline)
  used.schemas['provider.SignInState'] = { ...used.schemas['provider.SignInState'], fields: [...used.schemas['provider.SignInState'].fields, { name: 'extra', optional: true, type: { kind: 'string' } }] }
  assert.deepEqual(codes(classify(used)), ['schema-changed'])

  const unrelatedName = Object.keys(baseline.schemas).find(name => !closure.has(name))
  assert.ok(unrelatedName, 'the pinned contract has schemas the console never reads')
  const unrelated = clone(baseline)
  unrelated.schemas[unrelatedName] = { kind: 'object', fields: [] }
  assert.equal(classify(unrelated).eligible, true)
})

test('login-agent, catalog and settings drift all fail closed, each with its own reason', () => {
  const candidate = clone(baseline)
  candidate.loginAgents = candidate.loginAgents.filter(agent => agent !== 'dimagent')
  const result = classify(candidate, { addedSettings: ['otel'], changedSettings: ['imageGen'] }, { ...quietCatalog, removedAgents: ['dimagent'], addedAgents: ['qoder-cn'] })
  assert.deepEqual(codes(result), ['login-agents', 'catalog-drift', 'settings-drift'])
  assert.match(result.reasons[0].text, /移除 dimagent/)
  assert.match(result.reasons[1].text, /账号目录有变化：新增 qoder-cn/)
  assert.match(result.reasons[2].text, /新增 1 项/)
  assert.deepEqual(codes(classify(clone(baseline), {}, { error: 'Unknown sign-in agent zz' })), ['catalog-drift'])
})

test('new extraction diagnostics and an unknown contract version stop', () => {
  const candidate = clone(baseline)
  candidate.diagnostics = [...(candidate.diagnostics || []), { route: 'x', note: 'dynamic dispatch' }]
  assert.deepEqual(codes(classify(candidate)), ['diagnostics'])
  assert.deepEqual(codes(classifyCandidate({ baseline, candidate: { ...candidate, version: 2 }, diff: {}, catalogDrift: null })), ['contract-version'])
})

test('window: inside, before, after and across midnight (local time)', () => {
  const at = (h, m = 0) => new Date(2026, 9, 3, h, m).getTime()
  assert.equal(windowState(at(4), { start: '03:00', end: '06:00' }).inside, true)
  const before = windowState(at(2, 14), { start: '03:00', end: '06:00' })
  assert.equal(before.inside, false)
  assert.equal(before.nextStart, at(3))
  const after = windowState(at(7), { start: '03:00', end: '06:00' })
  assert.equal(after.nextStart, new Date(2026, 9, 4, 3, 0).getTime())
  assert.equal(windowState(at(1), { start: '23:00', end: '02:00' }).inside, true)
  assert.equal(windowState(at(6), { start: '03:00', end: '06:00' }).inside, false, 'the end minute is outside')
})

test('config: missing means ON with the default window; bad windows fall back', () => {
  assert.deepEqual(normalizeConfig(null), { version: 1, magpie: { enabled: true, window: { start: '03:00', end: '06:00' } }, rtk: { enabled: true } })
  const off = normalizeConfig({ magpie: { enabled: false, window: { start: '01:30', end: '04:00' } }, rtk: { enabled: false } })
  assert.equal(off.magpie.enabled, false)
  assert.deepEqual(off.magpie.window, { start: '01:30', end: '04:00' })
  assert.equal(off.rtk.enabled, false)
  assert.equal(parseWindow({ start: '25:00', end: '06:00' }), null)
  assert.equal(parseWindow({ start: '03:00', end: '03:00' }), null)
  assert.deepEqual(normalizeConfig({ magpie: { window: { start: 'x' } } }).magpie.window, { start: '03:00', end: '06:00' })
})

test('versions compare numerically', () => {
  assert.ok(compareVersions('v0.51.0', '0.50.0') > 0)
  assert.ok(compareVersions('0.10.0', '0.9.9') > 0)
  assert.equal(compareVersions('v1.2.3', '1.2.3'), 0)
})

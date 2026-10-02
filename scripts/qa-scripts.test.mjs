import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'

/**
 * The browser QA scripts run as `cat scripts/qa-*.mjs | ego-browser nodejs`, so they cannot share a module and
 * cannot be imported here (they drive a browser on load). These checks read their source: no personal fixture
 * name or machine path in tracked code, and a key session is only reused once it is proven to be the fixture's.
 */
const SCRIPTS = ['qa-smoke.mjs', 'qa-contrast.mjs', 'qa-viewports.mjs', 'qa-a11y.mjs']
const read = (name) => fs.readFileSync(new URL(`./${name}`, import.meta.url), 'utf8')

/** The two one-line helpers every script declares, evaluated so their behaviour is tested, not their text. */
function helpers(src, name) {
  const mask = /^\s*const maskKey = (.+);$/m.exec(src)?.[1]
  const same = /^\s*const isFixtureSession = (.+);$/m.exec(src)?.[1]
  assert.ok(mask && same, `${name}: maskKey + isFixtureSession declared on one line each`)
  const maskKey = new Function(`return ${mask}`)()
  const isFixtureSession = new Function('maskKey', `return ${same}`)(maskKey)
  return { maskKey, isFixtureSession }
}

test('RR-12: QA scripts carry no key holder name, machine path or /tmp handoff note; the fixture comes from env', () => {
  for (const name of SCRIPTS) {
    const src = read(name)
    // the fixture name only ever comes from QA_KEY_NAME (no default below); this file names nobody either
    assert.doesNotMatch(src, /\/Users\//, name)
    assert.doesNotMatch(src, /\/tmp\/console-v3/, name)
    assert.match(src, /process\.env\.QA_KEY_NAME/, name)
    assert.match(src, /process\.env\.QA_KEY_DB/, name)
    assert.doesNotMatch(src, /QA_KEY_NAME\s*\|\|\s*["'`][^"'`]/, `${name}: QA_KEY_NAME has no default`)
    assert.doesNotMatch(src, /QA_KEY_NAME\s*\?\?\s*["'`][^"'`]/, `${name}: QA_KEY_NAME has no default`)
    assert.match(src, /SELECT key_value FROM api_keys WHERE name = '\$\{KEY_NAME\.replace/, `${name}: the lookup uses the env fixture`)
  }
})

test('RR-12: usage lines put env vars on the ego-browser side of the pipe (on `cat` the script never sees them)', () => {
  for (const name of SCRIPTS) {
    const usage = read(name).split('\n').filter((line) => /^\s\*\s+.*ego-browser nodejs/.test(line))
    assert.ok(usage.length > 0, `${name}: has usage lines`)
    for (const line of usage) {
      assert.doesNotMatch(line, /\b[A-Z][A-Z0-9_]*=\S*\s+(?:[A-Z][A-Z0-9_]*=\S*\s+)*cat\s/, `${name}: ${line.trim()}`)
      assert.match(line, /QA_KEY_NAME=\S+.*ego-browser nodejs/, `${name}: key role needs QA_KEY_NAME · ${line.trim()}`)
    }
  }
})

test('RR-6: a key session counts as the fixture only when name and masked key both match', () => {
  const apiKey = 'sk-abcdefghijklmnopqrstuvwxyz1234'
  const fixture = { authenticated: true, role: 'key', key: { name: 'qa-fixture', masked: 'sk-ab…1234' } }
  for (const name of SCRIPTS) {
    const src = read(name)
    assert.doesNotMatch(src, /if \(role === "key"\) return apiKey/, `${name}: no blind reuse of whatever key session is open`)
    const { maskKey, isFixtureSession } = helpers(src, name)
    // same rule as server/keySession.ts maskApiKey: first 5 … last 4 (shorter keys show less)
    assert.equal(maskKey(apiKey), 'sk-ab…1234')
    assert.equal(maskKey('sk-1234567'), 'sk…67')
    assert.equal(isFixtureSession(fixture, apiKey, 'qa-fixture'), true, name)
    assert.equal(isFixtureSession({ ...fixture, key: { name: 'owner', masked: 'sk-zz…9999' } }, apiKey, 'qa-fixture'), false, `${name}: another key's session`)
    assert.equal(isFixtureSession({ ...fixture, key: { name: 'qa-fixture', masked: 'sk-ab…9999' } }, apiKey, 'qa-fixture'), false, `${name}: same name, other key`)
    assert.equal(isFixtureSession({ authenticated: true, role: 'admin', user: { name: 'admin' } }, apiKey, 'qa-fixture'), false, name)
    assert.equal(isFixtureSession({ authenticated: false }, apiKey, 'qa-fixture'), false, name)
    assert.equal(isFixtureSession(null, apiKey, 'qa-fixture'), false, name)
  }
})

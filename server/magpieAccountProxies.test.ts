import './testDataDir.js'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'magpie-account-proxies-'))
const registry = path.join(dir, 'magpie-channels.json')
process.env.MAGPIE_CHANNELS_FILE = registry

const {
  accountKey, accountPicks, accountProxySupport, accountProxyWriter, magpieAccountRef, parseMagpieAccountRef, readAccountProxy,
  readAccountProxySection, resetAccountProxySupportForTests, validAccountProxy, writeAccountProxy,
} = await import('./magpieAccountProxies.js')
const { readMagpieChannels, writeChannels } = await import('./magpieControl.js')

const CHANNEL = { name: 'example', 'base-url': 'https://upstream.example/v1', protocol: 'responses', 'api-key-entries': [{ 'api-key': 'env:EXAMPLE_UPSTREAM_KEY' }], models: [{ name: 'm1' }] }
const EXIT = 'socks5://lu:LISTENER-SECRET@127.0.0.1:27891'

function reset(content?: unknown) {
  fs.rmSync(registry, { force: true })
  if (content !== undefined) fs.writeFileSync(registry, JSON.stringify(content), { mode: 0o600 })
}

test('refs: agent + lower-cased user, the way the kernel keys accountProxies', () => {
  assert.equal(accountKey('  A@Example.TEST '), 'a@example.test')
  assert.equal(magpieAccountRef('codex', 'A@Example.test'), 'magpie:codex:a@example.test')
  assert.deepEqual(parseMagpieAccountRef('magpie:codex:A@Example.test'), { agent: 'codex', user: 'a@example.test' })
  assert.equal(parseMagpieAccountRef('magpie:codex'), null, 'service-level refs are not accounts')
  assert.equal(parseMagpieAccountRef('magpie:Bad Agent:x'), null)
  assert.equal(parseMagpieAccountRef('magpie:codex:\u0001x'), null)
})

test('values: what settings.CheckProxy accepts', () => {
  for (const ok of ['', 'direct', 'http://h:1', 'https://u:p@h:443', 'socks5://127.0.0.1:27890', 'socks5h://h:1080']) assert.equal(validAccountProxy(ok), true, ok)
  for (const bad of ['ftp://h:21', 'socks4://h:1', 'not a url', 'http://', 'http://h:1/ x']) assert.equal(validAccountProxy(bad), false, bad)
})

test('write: keeps channels and every other key, 0600, clears back to nothing', () => {
  reset({ version: 1, channels: [CHANNEL], accounts: { claude: { routing: 'first', models: ['x'] } }, extra: { keep: true } })
  assert.deepEqual(writeAccountProxy('codex', 'A@example.test', EXIT), { prev: '', changed: true })
  assert.deepEqual(writeAccountProxy('codex', 'a@example.test', EXIT), { prev: EXIT, changed: false }, 'same value: no write')
  const state = JSON.parse(fs.readFileSync(registry, 'utf8'))
  assert.deepEqual(state.channels, [CHANNEL])
  assert.deepEqual(state.extra, { keep: true })
  assert.deepEqual(state.accounts.claude, { routing: 'first', models: ['x'] }, 'another agent\'s settings survive')
  assert.deepEqual(state.accounts.codex, { accountProxies: { 'a@example.test': EXIT } })
  assert.equal(fs.statSync(registry).mode & 0o777, 0o600)
  assert.equal(readAccountProxy('codex', 'A@EXAMPLE.test'), EXIT)
  assert.deepEqual(writeAccountProxy('codex', 'a@example.test', ''), { prev: EXIT, changed: true })
  const after = JSON.parse(fs.readFileSync(registry, 'utf8'))
  assert.equal('codex' in after.accounts, false, 'an agent with nothing left is dropped')
  assert.deepEqual(readMagpieChannels().map(channel => channel.name), ['example'])
  assert.throws(() => writeAccountProxy('codex', 'a@example.test', 'ftp://nope'))
  assert.throws(() => writeAccountProxy('../x', 'a@example.test', 'direct'))
})

test('a missing registry is created with no channels; an unknown version is never written', () => {
  reset()
  writeAccountProxy('claude', 'b@example.test', 'direct')
  assert.deepEqual(readMagpieChannels(), [])
  assert.equal(readAccountProxy('claude', 'b@example.test'), 'direct')
  reset({ version: 2, channels: [] })
  assert.throws(() => writeAccountProxy('claude', 'b@example.test', 'direct'))
  assert.equal(JSON.parse(fs.readFileSync(registry, 'utf8')).version, 2)
  assert.deepEqual(readAccountProxySection(), {})
})

test('writeChannels keeps the accounts section (the two writers never drop each other)', () => {
  reset({ version: 1, channels: [CHANNEL] })
  writeAccountProxy('codex', 'a@example.test', EXIT)
  writeChannels([{ ...CHANNEL, name: 'renamed' } as never])
  const state = JSON.parse(fs.readFileSync(registry, 'utf8'))
  assert.deepEqual(state.channels.map((channel: { name: string }) => channel.name), ['renamed'])
  assert.deepEqual(state.accounts, { codex: { accountProxies: { 'a@example.test': EXIT } } })
  reset({ version: 1, channels: [CHANNEL] })
  writeChannels([CHANNEL as never])
  assert.equal('accounts' in JSON.parse(fs.readFileSync(registry, 'utf8')), false, 'no section appears out of nothing')
})

test('picks: one endpoint-less provider per agent, invalid stored values never pushed', () => {
  reset({ version: 1, channels: [], accounts: { codex: { accountProxies: { 'A@x.test': EXIT, 'b@x.test': 'direct' } }, claude: { proxy: 'http://h:1' }, bad: { accountProxies: { 'c@x.test': 'ftp://x' } } } })
  assert.deepEqual(accountPicks(), [
    { id: 'codex', name: '', key: '', accountProxies: { 'a@x.test': EXIT, 'b@x.test': 'direct' } },
    { id: 'claude', name: '', key: '', proxy: 'http://h:1' },
  ])
})

test('writer: stored then pushed; a failed push puts the old value back', async () => {
  reset({ version: 1, channels: [] })
  const pushed: string[] = []
  await accountProxyWriter(async () => { pushed.push(readAccountProxy('codex', 'a@x.test')) })('codex', 'a@x.test', EXIT)
  assert.deepEqual(pushed, [EXIT], 'the push sees the new value')
  await assert.rejects(accountProxyWriter(async () => { throw new Error('kernel down') })('codex', 'a@x.test', 'direct'), /kernel down/)
  assert.equal(readAccountProxy('codex', 'a@x.test'), EXIT, 'rolled back')
  let calls = 0
  await accountProxyWriter(async () => { calls++ })('codex', 'a@x.test', EXIT)
  assert.equal(calls, 0, 'nothing changed: no push')
})

test('support: only a kernel reporting account-proxy', async () => {
  const health = (capabilities: string[]) => async () => ({ status: 200, body: { ok: true, engine: 'magpie', revision: 'r', capabilities, loginAgents: ['codex'], signinDeny: [], keychain: false } })
  resetAccountProxySupportForTests()
  assert.deepEqual(await accountProxySupport(health(['signin', 'accounts', 'usage', 'codex-reset', 'account-proxy'])), { supported: true, reason: null })
  resetAccountProxySupportForTests()
  const old = await accountProxySupport(health(['signin', 'accounts', 'usage', 'codex-reset']))
  assert.equal(old.supported, false)
  assert.match(old.reason ?? '', /重新构建内核/)
  resetAccountProxySupportForTests()
  const down = await accountProxySupport(async () => { throw Object.assign(new Error('x'), { code: 'kernel_unavailable' }) })
  assert.equal(down.supported, false)
  resetAccountProxySupportForTests()
})

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { createCredentialSource, loadDotenv, parseDotenv, pickSecret, readKeychain, readSecretFile } from './lib/credentials.mjs'
import { loadProfiles, resolveTarget } from './lib/profile.mjs'

const SECRET = 'test-only-value'
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cradmin-cred-'))

const target = (base = 'http://127.0.0.1:8791') => resolveTarget({ base }, {}, loadProfiles({ env: { CRADMIN_HOME: '/nonexistent-cradmin-home' } }))

function source(overrides = {}) {
  const calls = []
  const deps = {
    env: {},
    values: {},
    target: target(),
    cwd: tmp(),
    platform: 'darwin',
    interactive: false,
    execute: (file, args) => {
      calls.push(args)
      const error = new Error('not found')
      error.status = 44
      throw error
    },
    promptSecret: async () => { throw new Error('不应提示') },
    ...overrides,
  }
  return { creds: createCredentialSource(deps), calls }
}

test('档位顺序：环境变量 > .env > 钥匙串 > 终端输入', async () => {
  const dir = tmp()
  fs.writeFileSync(path.join(dir, '.env'), 'PORT=8791\nCONSOLE_PASSWORD=from-dotenv\n')
  const keychain = (file, args) => (args.includes('-w') ? 'from-keychain\n' : '')

  let { creds } = source({ env: { CONSOLE_PASSWORD: 'from-env' }, values: { 'env-file': path.join(dir, '.env') }, execute: keychain })
  assert.deepEqual(await creds.password(), { password: 'from-env', tier: 'env' })

  ;({ creds } = source({ values: { 'env-file': path.join(dir, '.env') }, execute: keychain }))
  assert.deepEqual(await creds.password(), { password: 'from-dotenv', tier: 'dotenv' })

  ;({ creds } = source({ execute: keychain }))
  assert.deepEqual(await creds.password(), { password: 'from-keychain', tier: 'keychain' })

  ;({ creds } = source({ interactive: true, promptSecret: async () => 'from-prompt' }))
  assert.deepEqual(await creds.password(), { password: 'from-prompt', tier: 'prompt' })
})

test('钥匙串 account = 用户名，service 来自 profile；CRADMIN_KEYCHAIN=off 跳过', async () => {
  const { creds, calls } = source({ values: { user: 'ops' }, interactive: true, promptSecret: async () => 'typed' })
  await creds.password()
  assert.deepEqual(calls[0], ['find-generic-password', '-s', 'com.crosery.console-magpie.local', '-a', 'ops', '-w'])
  const off = source({ env: { CRADMIN_KEYCHAIN: 'off' }, interactive: true, promptSecret: async () => 'typed' })
  await off.creds.password()
  assert.equal(off.calls.length, 0)
})

test('同一档 CONSOLE_PASSWORD 与 _FILE 同时设置 → 报冲突（退出 3）', async () => {
  const { creds } = source({ env: { CONSOLE_PASSWORD: 'x', CONSOLE_PASSWORD_FILE: '/tmp/whatever' } })
  await assert.rejects(creds.password(), error => error.exitCode === 3 && error.message === 'CONSOLE_PASSWORD 与 CONSOLE_PASSWORD_FILE 不能同时设置')
})

test('_FILE：私有普通文件、≤16 KiB、只去尾部换行；其它一律统一文案', () => {
  const dir = tmp()
  const good = path.join(dir, 'good')
  fs.writeFileSync(good, `${SECRET}\r\n\n`, { mode: 0o600 })
  assert.equal(readSecretFile('CONSOLE_PASSWORD', good), SECRET)
  const message = 'CONSOLE_PASSWORD_FILE 必须是私有、可读且不超过 16 KiB 的普通文件'
  const open = path.join(dir, 'open')
  fs.writeFileSync(open, SECRET, { mode: 0o644 })
  fs.chmodSync(open, 0o644)
  const big = path.join(dir, 'big')
  fs.writeFileSync(big, 'x'.repeat(16 * 1024 + 1), { mode: 0o600 })
  const empty = path.join(dir, 'empty')
  fs.writeFileSync(empty, '\n', { mode: 0o600 })
  for (const bad of [open, big, empty, dir, path.join(dir, 'missing')]) {
    assert.throws(() => readSecretFile('CONSOLE_PASSWORD', bad), error => error.message === message && error.exitCode === 3 && !error.message.includes(SECRET), bad)
  }
})

test('replace-with- 占位符与空串视为未设置', () => {
  assert.equal(pickSecret('CONSOLE_PASSWORD', 'replace-with-a-strong-password', ''), null)
  assert.equal(pickSecret('CONSOLE_PASSWORD', '', ''), null)
  assert.equal(pickSecret('CONSOLE_PASSWORD', '   ', undefined), null)
})

test('.env：只取五个键；端口不匹配（或非回环地址）时不用', () => {
  const values = parseDotenv('export CONSOLE_PASSWORD="quoted"\nSESSION_SECRET=nope\nPORT=8787 # comment\n# CONSOLE_USERNAME=x\n')
  assert.deepEqual(values, { CONSOLE_PASSWORD: 'quoted', PORT: '8787' })
  const dir = tmp()
  fs.writeFileSync(path.join(dir, '.env'), 'PORT=8787\nCONSOLE_PASSWORD=dev-pass\n')
  const mismatch = loadDotenv({ envFile: '.env', cwd: dir, target: target() })
  assert.equal(mismatch.applies, false)
  assert.equal(loadDotenv({ envFile: '.env', cwd: dir, target: target('http://127.0.0.1:8787') }).applies, true)
  assert.equal(loadDotenv({ envFile: '.env', cwd: dir, target: target('https://console.example.com:8787') }).applies, false)
})

test('.env 端口不匹配时跳到下一档，不拿 dev 密码撞 8791', async () => {
  const dir = tmp()
  fs.writeFileSync(path.join(dir, '.env'), 'PORT=8787\nCONSOLE_PASSWORD=dev-pass\n')
  const { creds } = source({ values: { 'env-file': path.join(dir, '.env') } })
  await assert.rejects(creds.password(), error => error.exitCode === 3 && /端口不匹配/.test(error.message) && !error.message.includes('dev-pass'))
})

test('钥匙串读取失败：固定文案、无 cause、stack 不含秘密；条目不存在返回 null', () => {
  const leaky = () => {
    const error = new Error(`security failed: ${SECRET}`)
    error.status = 51
    error.stdout = SECRET
    throw error
  }
  assert.throws(() => readKeychain('svc', 'admin', { platform: 'darwin', execute: leaky }), error => {
    assert.equal(error.message, '无法从钥匙串读取管理员密码')
    assert.equal(error.cause, undefined)
    assert.ok(!String(error.stack).includes(SECRET))
    return true
  })
  const missing = () => { const error = new Error('x'); error.status = 44; throw error }
  assert.equal(readKeychain('svc', 'admin', { platform: 'darwin', execute: missing }), null)
  assert.equal(readKeychain('svc', 'admin', { platform: 'linux', execute: leaky }), null)
  assert.throws(() => readKeychain('svc', 'admin', { platform: 'darwin', execute: () => 'a\0b' }), error => error.exitCode === 3)
})

test('空密码被拒；非交互拿不到凭据退出 3 且只列档位名', async () => {
  const blank = source({ interactive: true, promptSecret: async () => '' })
  await assert.rejects(blank.creds.password(), error => error.exitCode === 3 && error.message === '密码不能为空')
  const none = source()
  await assert.rejects(none.creds.password(), error => error.exitCode === 3 && /已尝试：环境变量、钥匙串/.test(error.message))
})

test('终端输入最多 3 次', async () => {
  let asked = 0
  const { creds } = source({ interactive: true, promptSecret: async () => { asked += 1; return `try-${asked}` } })
  assert.equal((await creds.password()).password, 'try-1')
  assert.equal((await creds.password({ retry: true })).password, 'try-2')
  assert.equal((await creds.password({ retry: true })).password, 'try-3')
  assert.equal(await creds.password({ retry: true }), null)
  assert.equal(asked, 3)
})

test('用户名：--user > CONSOLE_USERNAME > profile > admin', () => {
  assert.equal(source({ values: { user: 'ops' }, env: { CONSOLE_USERNAME: 'env' } }).creds.username, 'ops')
  assert.equal(source({ env: { CONSOLE_USERNAME: 'env' } }).creds.username, 'env')
  assert.equal(source({ env: { CONSOLE_USERNAME: '' } }).creds.username, 'admin')
})

test('配置文件：不存在用内置 profile；出现秘密键或未知键直接退出 2', () => {
  const home = tmp()
  assert.equal(loadProfiles({ env: { CRADMIN_HOME: home } }).exists, false)
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ profiles: { local: { base: 'http://127.0.0.1:9999' } } }))
  const loaded = loadProfiles({ env: { CRADMIN_HOME: home } })
  assert.equal(loaded.profiles.local.base, 'http://127.0.0.1:9999')
  assert.equal(loaded.profiles.local.keychainService, 'com.crosery.console-magpie.local')
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ profiles: { local: { password: SECRET } } }))
  assert.throws(() => loadProfiles({ env: { CRADMIN_HOME: home } }), error => error.exitCode === 2 && /不能放凭据/.test(error.message) && !error.message.includes(SECRET))
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ profiles: { local: { color: 'x' } } }))
  assert.throws(() => loadProfiles({ env: { CRADMIN_HOME: home } }), error => error.exitCode === 2)
})

test('目标：默认本地沙盒 8791；生产要显式 --profile prod；非回环即远程', () => {
  const profiles = loadProfiles({ env: { CRADMIN_HOME: '/nonexistent-cradmin-home' } })
  const local = resolveTarget({}, {}, profiles)
  assert.equal(local.base, 'http://127.0.0.1:8791')
  assert.equal(local.remote, false)
  const prod = resolveTarget({ profile: 'prod' }, {}, profiles)
  assert.equal(prod.remote, true)
  assert.equal(prod.keychainService, 'com.crosery.cradmin.prod')
  assert.equal(resolveTarget({}, { CRADMIN_BASE: 'http://localhost:1234/' }, profiles).base, 'http://localhost:1234')
  assert.throws(() => resolveTarget({ base: 'ftp://x' }, {}, profiles), error => error.exitCode === 2)
  assert.throws(() => resolveTarget({ base: 'http://u:p@127.0.0.1' }, {}, profiles), error => error.exitCode === 2)
})

test('.env 语法与 Node util.parseEnv 一致：引号值后的行内注释、多行引号值', () => {
  const values = parseDotenv('CONSOLE_PASSWORD="p#ss word" # 注释\nCONSOLE_USERNAME=\'ops\'\nPORT="8791"\n')
  assert.deepEqual(values, { CONSOLE_PASSWORD: 'p#ss word', CONSOLE_USERNAME: 'ops', PORT: '8791' })
  assert.equal(parseDotenv('CONSOLE_PASSWORD="line1\nline2"\n').CONSOLE_PASSWORD, 'line1\nline2')
})

test('CONSOLE_USERNAME 显式设为空 → admin（与服务端 || 一致），不落到 profile 的用户名', () => {
  const base = target()
  assert.equal(source({ env: { CONSOLE_USERNAME: '' }, target: { ...base, profileUsername: 'ops' } }).creds.username, 'admin')
  assert.equal(source({ target: { ...base, profileUsername: 'ops' } }).creds.username, 'ops')
})

test('钥匙串密码只发给 profile 自己的地址：--base 指向别处时跳过钥匙串，显式 --keychain-service 才用', async () => {
  const profiles = loadProfiles({ env: { CRADMIN_HOME: '/nonexistent-cradmin-home' } })
  assert.equal(resolveTarget({ base: 'http://203.0.113.5:8791' }, {}, profiles).keychainService, null)
  assert.equal(resolveTarget({}, { CRADMIN_BASE: 'http://localhost:8791' }, profiles).keychainService, 'com.crosery.console-magpie.local')
  assert.equal(resolveTarget({ base: 'http://203.0.113.5:8791', 'keychain-service': 'svc.x' }, {}, profiles).keychainService, 'svc.x')
  const elsewhere = resolveTarget({ base: 'http://127.0.0.1:9999' }, {}, profiles)
  const { creds, calls } = source({ target: elsewhere, execute: () => 'local-sandbox-pass\n' })
  await assert.rejects(creds.password(), error => error.exitCode === 3 && /钥匙串（目标不是 profile 地址或没配 service，已跳过）/.test(error.message))
  assert.equal(calls.length, 0)
})

test('控制台地址无效时错误文本不带 userinfo 里的密码', () => {
  const profiles = loadProfiles({ env: { CRADMIN_HOME: '/nonexistent-cradmin-home' } })
  for (const base of ['http://u:hunter2-secret@[bad', 'ftp://u:hunter2-secret@x']) {
    assert.throws(() => resolveTarget({ base }, {}, profiles), error => error.exitCode === 2 && !error.message.includes('hunter2-secret'))
  }
})

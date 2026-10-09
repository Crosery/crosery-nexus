// e2e：一次性控制台实例（子进程 + 临时数据 + 假 CPA）上跑 CLI 的每条写路径。测试不碰真实钥匙串，也不连 8791。
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { Readable } from 'node:stream'
import { after, before, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { main } from './cradmin.mjs'
import { adminCall, startThrowawayServer } from './helpers/throwawayServer.mjs'
import { cookieFromHeaders } from './lib/session.mjs'

const PASSWORD = 'cradmin-e2e-pass-7f3a'
const CLI = fileURLToPath(new URL('./cradmin.mjs', import.meta.url))
let server
let home
let cwd
const outputs = []
const issuedTokens = new Set()
const shownKeys = []

const sink = () => {
  const chunks = []
  return { isTTY: false, columns: 0, write: chunk => { chunks.push(String(chunk)); return true }, text: () => chunks.join('') }
}

async function cli(argv, { env = {}, platform = 'linux', execute, stdin = '', interactive = false, label, onResponse } = {}) {
  const stdout = sink()
  const stderr = sink()
  const recordingFetch = async (url, init) => {
    const response = await fetch(url, init)
    if (onResponse) await onResponse(String(url), response.clone())
    if (String(url).endsWith('/api/login')) {
      const token = cookieFromHeaders(response.headers)
      if (token) issuedTokens.add(token)
    }
    return response
  }
  const code = await main(argv, {
    env: {
      PATH: process.env.PATH, CONSOLE_PASSWORD: PASSWORD, CRADMIN_SESSION_CACHE: 'off', CRADMIN_KEYCHAIN: 'off',
      CRADMIN_BASE: server.base, CRADMIN_HOME: home, NO_COLOR: '1', ...env,
    },
    stdin: Readable.from(stdin ? [stdin] : []), stdout, stderr, interactive, cwd, home,
    fetch: recordingFetch, installSignals: false, pollMs: 50, platform, ...(execute ? { execute } : {}),
  })
  const result = { argv: label ?? argv, code, stdout: stdout.text(), stderr: stderr.text() }
  outputs.push(result)
  return result
}

const fullKeys = text => text.match(/sk-[a-z0-9-]+-[0-9a-f]{32}/g) || []
const nonLoginAudit = async () => (await adminCall(server, 'GET', '/api/audit')).body.items.filter(item => item.action !== 'login').length
const bootstrap = async () => (await adminCall(server, 'GET', '/api/bootstrap')).body
const keyNamed = async name => (await bootstrap()).keys.find(key => key.name === name)
const UPSTREAM_KEY = 'upstream-e2e-secret-5d2c'
const usageWith = async key => (await fetch(`${server.base}/v1/usage`, { headers: { authorization: `Bearer ${key}` } })).status

before(async () => {
  // 账号池凭据：假 CPA 里先放一个 codex 账号
  server = await startThrowawayServer({
    password: PASSWORD,
    prepare: ({ cpa }) => cpa.credentials.set('codex-fixture.json', { name: 'codex-fixture.json', type: 'codex', email: 'fixture@example.test' }),
  })
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'cradmin-home-'))
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'cradmin-cwd-'))
})

after(async () => {
  await server?.stop()
  for (const dir of [home, cwd]) if (dir) fs.rmSync(dir, { recursive: true, force: true })
})

test('login / whoami / logout（不缓存会话）', async () => {
  const login = await cli(['login'])
  assert.equal(login.code, 0, login.stderr)
  assert.match(login.stdout, /已登录 admin@127\.0\.0\.1:\d+/)
  const whoami = await cli(['whoami', '--json'])
  assert.equal(whoami.code, 0)
  const data = JSON.parse(whoami.stdout)
  assert.equal(data.role, 'admin')
  assert.equal(data.credentialSource, '环境变量 CONSOLE_PASSWORD')
  const logout = await cli(['logout'])
  assert.equal(logout.code, 0)
  assert.match(logout.stdout, /当前没有缓存会话/)
})

test('doctor 全部通过；status --json 可解析', async () => {
  const doctor = await cli(['doctor'])
  assert.equal(doctor.code, 0, doctor.stdout + doctor.stderr)
  assert.doesNotMatch(doctor.stdout, /✗/)
  const status = await cli(['status', '--json'])
  assert.equal(status.code, 0, status.stderr)
  const parsed = JSON.parse(status.stdout)
  assert.ok(parsed.keys && parsed.channels && parsed.sync && parsed.usageToday)
})

test('401：密码不对 → 退出 3，写明凭据来源；不自动重试', async () => {
  const before = issuedTokens.size
  const result = await cli(['keys', 'ls'], { env: { CONSOLE_PASSWORD: 'definitely-wrong-pass' } })
  assert.equal(result.code, 3)
  assert.match(result.stderr, /管理员密码不对或会话过期（凭据来源：环境变量 CONSOLE_PASSWORD）/)
  assert.equal(issuedTokens.size, before)
  assert.ok(!result.stderr.includes('definitely-wrong-pass'))
})

test('channels add（Key 从 stdin 读）→ models --only → GET 验证；--enable 恢复', async () => {
  const add = await cli(['channels', 'add', 'tch', '--base-url', 'http://127.0.0.1:9/v1', '--api-key-stdin', '--models', 'm1,m2,gpt-x'], { stdin: UPSTREAM_KEY })
  assert.equal(add.code, 0, add.stderr)
  assert.equal(server.cpa.compat.find(item => item.name === 'tch')['api-key-entries'][0]['api-key'], UPSTREAM_KEY)
  const raw = await cli(['channels', 'add', 'raw', '--base-url', 'http://127.0.0.1:9/v1', '--models', 'm1'])
  assert.equal(raw.code, 2, '不给 --api-key-stdin 时拒绝')
  const only = await cli(['channels', 'models', 'tch', '--only', 'm*', '--yes'])
  assert.equal(only.code, 0, only.stderr)
  const models = async () => Object.fromEntries((await adminCall(server, 'GET', '/api/channels')).body.channels.find(item => item.name === 'tch').models.map(model => [model.id, model.enabled]))
  assert.deepEqual(await models(), { 'gpt-x': false, m1: true, m2: true })
  const again = await cli(['channels', 'models', 'tch', '--only', 'm*', '--yes'])
  assert.match(again.stdout, /没有需要改动的模型/)
  const enable = await cli(['channels', 'models', 'tch', '--enable', 'gpt-x'])
  assert.equal(enable.code, 0, '本地目标只启用（A 级）不需要 --yes')
  assert.deepEqual(await models(), { 'gpt-x': true, m1: true, m2: true })
  const nomatch = await cli(['channels', 'models', 'tch', '--disable', 'zz*', '--yes'])
  assert.equal(nomatch.code, 2)
  const list = await cli(['channels', 'ls', '--json'])
  assert.deepEqual(JSON.parse(list.stdout).map(row => row.name).sort(), ['codex', 'tch'])
  assert.ok(JSON.parse(list.stdout).every(row => typeof row.enabled === 'boolean' && typeof row.stale === 'boolean'))
})

test('账号池 provider 的模型开关（依赖服务端缺陷 S1 的修复）', async () => {
  const sourceEnabled = async id => (await adminCall(server, 'GET', '/api/model-index')).body.models.find(model => model.id === id)
    ?.sources.find(source => source.channel === 'codex' && source.kind === 'oauth')?.enabled
  const listing = await cli(['channels', 'models', 'codex', '--json'])
  const target = JSON.parse(listing.stdout).models[0].id
  const off = await cli(['channels', 'models', 'codex', '--disable', target, '--yes'])
  assert.equal(off.code, 0, off.stderr)
  assert.equal(await sourceEnabled(target), false)
  const on = await cli(['channels', 'models', 'codex', '--enable', target])
  assert.equal(on.code, 0, on.stderr)
  assert.equal(await sourceEnabled(target), true)
})

test('keys create：完整 Key 只在 stdout 出现一次；新 Key 可用；未知分组退出 2 且零写入', async () => {
  const writes = await nonLoginAudit()
  const bad = await cli(['keys', 'create', '--name', 'e2e-bad', '--groups', 'nope'])
  assert.equal(bad.code, 2)
  assert.match(bad.stderr, /未知分组：nope/)
  assert.equal(await nonLoginAudit(), writes, '未知分组不能发出任何写请求')

  const created = await cli(['keys', 'create', '--name', 'e2e-key', '--groups', 'tch', '--daily-usd', '5'])
  assert.equal(created.code, 0, created.stderr)
  const keys = fullKeys(created.stdout)
  assert.equal(keys.length, 1, created.stdout)
  assert.equal(fullKeys(created.stderr).length, 0)
  assert.match(created.stderr, /唯一一次显示完整 Key/)
  shownKeys.push(keys[0])
  assert.equal(await usageWith(keys[0]), 200)
  const item = await keyNamed('e2e-key')
  assert.equal(item.quota.dailyUsd, 5)
  assert.deepEqual(item.groups, ['tch'])

  const json = await cli(['keys', 'create', '--name', 'e2e-json', '--groups', 'all', '--json'])
  assert.equal(json.code, 0, json.stderr)
  const parsed = JSON.parse(json.stdout)
  assert.match(parsed.key, /^sk-e2e-json-[0-9a-f]{32}$/)
  assert.equal(parsed.item.name, 'e2e-json')
  shownKeys.push(parsed.key)
})

test('非交互写命令不带 --yes 退出 2；--dry-run 不写；两者服务端零写入', async () => {
  const writes = await nonLoginAudit()
  for (const argv of [['keys', 'disable', 'e2e-key'], ['channels', 'disable', 'tch'], ['keys', 'delete', 'e2e-key'], ['rtk', 'off'], ['channels', 'models', 'tch', '--disable', 'm1']]) {
    const result = await cli(argv)
    assert.equal(result.code, 2, argv.join(' '))
    assert.match(result.stderr, /非交互环境执行此操作需要 --yes/)
  }
  for (const argv of [['keys', 'disable', 'e2e-key', '--dry-run'], ['keys', 'delete', 'e2e-key', '--dry-run'], ['channels', 'disable', 'tch', '--dry-run'], ['keys', 'update', 'e2e-key', '--concurrency', '3', '--group-concurrency', 'tch=1', '--dry-run'], ['sync', 'run', 'pricing', '--dry-run']]) {
    const result = await cli(argv)
    assert.equal(result.code, 0, `${argv.join(' ')}\n${result.stderr}`)
    assert.match(result.stdout, /--dry-run/)
  }
  assert.equal(await nonLoginAudit(), writes)
  assert.equal((await keyNamed('e2e-key')).enabled, true)
})

test('keys update / disable / enable / copy / rotate / delete', async () => {
  const update = await cli(['keys', 'update', 'e2e-key', '--add-groups', 'codex', '--concurrency', '4', '--group-concurrency', 'tch=2,codex=1', '--weekly-usd', '20', '--note', '备注', '--yes'])
  assert.equal(update.code, 0, update.stderr)
  let item = await keyNamed('e2e-key')
  assert.deepEqual([...item.groups].sort(), ['codex', 'tch'])
  assert.equal(item.totalConcurrency, 4)
  assert.deepEqual(item.groupConcurrency, { codex: 1, tch: 2 })
  assert.equal(item.quota.weeklyUsd, 20)
  assert.equal(item.note, '备注')
  const missingLimit = await cli(['keys', 'update', 'e2e-key', '--add-groups', 'e2e-nope', '--yes'])
  assert.equal(missingLimit.code, 2)

  assert.equal((await cli(['keys', 'disable', 'e2e-key', '--yes'])).code, 0)
  assert.equal((await keyNamed('e2e-key')).enabled, false)
  assert.equal((await cli(['keys', 'enable', 'e2e-key'])).code, 0)
  assert.equal((await keyNamed('e2e-key')).enabled, true)

  let copied = null
  const execute = (file, args, options) => {
    if (file === '/usr/bin/pbcopy') { copied = options.input; return '' }
    const error = new Error('not found')
    error.status = 44
    throw error
  }
  const copy = await cli(['keys', 'copy', 'e2e-key'], { platform: 'darwin', execute })
  assert.equal(copy.code, 0, copy.stderr)
  assert.equal(copied, shownKeys[0])
  assert.equal(fullKeys(copy.stdout + copy.stderr).length, 0, 'copy 从不打印 Key')
  assert.equal((await cli(['keys', 'copy', 'e2e-key'])).code, 2, '非 macOS 退出 2')

  const oldId = (await keyNamed('e2e-key')).id
  const rotate = await cli(['keys', 'rotate', 'e2e-key', '--yes'])
  assert.equal(rotate.code, 0, rotate.stderr)
  const [fresh] = fullKeys(rotate.stdout)
  assert.ok(fresh && fresh !== shownKeys[0])
  shownKeys.push(fresh)
  const keys = (await bootstrap()).keys
  const old = keys.find(key => key.id === oldId)
  assert.equal(old.enabled, false)
  assert.match(old.name, /^e2e-key（已轮换 \d{4}-\d{2}-\d{2}）$/)
  item = keys.find(key => key.name === 'e2e-key')
  assert.notEqual(item.id, oldId)
  assert.deepEqual([...item.groups].sort(), ['codex', 'tch'])
  assert.equal(item.totalConcurrency, 4)
  assert.equal(item.quota.dailyUsd, 5)
  assert.equal(await usageWith(fresh), 200)
  assert.notEqual(await usageWith(shownKeys[0]), 200)

  const del = await cli(['keys', 'delete', oldId.slice(0, 12), '--yes'])
  assert.equal(del.code, 0, del.stderr)
  assert.equal((await bootstrap()).keys.some(key => key.id === oldId), false)
})

test('sync run pricing 连续两次：第二次冷却中退出 4 并给出秒数', async () => {
  const first = await cli(['sync', 'run', 'pricing'])
  assert.equal(first.code, 0, first.stderr)
  const second = await cli(['sync', 'run', 'pricing'])
  assert.equal(second.code, 4)
  assert.match(second.stderr, /冷却中，还需 \d+ 秒/)
  const external = await cli(['sync', 'run', 'catalog-sync'])
  assert.equal(external.code, 2)
})

test('rtk on 遇到 409 no_supported_agents → 退出 1', async () => {
  const status = await cli(['rtk', 'status', '--json'])
  assert.equal(status.code, 0)
  const on = await cli(['rtk', 'on', '--yes'])
  assert.equal(on.code, 1)
  assert.match(on.stderr, /409/)
})

test('额度封禁的 Key：keys disable 显式发 enabled:false，清掉封禁标记（对账不会再自动恢复）', async () => {
  const created = await cli(['keys', 'create', '--name', 'e2e-blocked', '--groups', 'tch'])
  assert.equal(created.code, 0, created.stderr)
  shownKeys.push(...fullKeys(created.stdout))
  const db = new DatabaseSync(path.join(server.dataDir, 'console.db'))
  try {
    db.prepare("UPDATE api_keys SET enabled = 0, quota_blocked_reason = 'total' WHERE name = 'e2e-blocked'").run()
  } finally { db.close() }
  assert.equal((await keyNamed('e2e-blocked')).blockedReason, 'total')
  const preview = await cli(['keys', 'disable', 'e2e-blocked', '--dry-run', '--json'])
  assert.equal(preview.code, 0, preview.stderr)
  assert.deepEqual(JSON.parse(preview.stdout).plan.map(item => [item.from, item.to]), [['额度封禁', '停用']])
  const disabled = await cli(['keys', 'disable', 'e2e-blocked', '--yes'])
  assert.equal(disabled.code, 0, disabled.stderr)
  const item = await keyNamed('e2e-blocked')
  assert.equal(item.enabled, false)
  assert.equal(item.blockedReason, '')
  assert.equal((await cli(['keys', 'delete', 'e2e-blocked', '--yes'])).code, 0)
})

test('accounts：pause / resume / proxy', async () => {
  const credential = () => adminCall(server, 'GET', '/api/channels').then(result => result.body.credentials[0])
  // CPA 的凭据列表不带 proxy_url；单条读取（编辑用）才给完整值
  const proxyOf = async () => (await adminCall(server, 'GET', `/api/credentials/${encodeURIComponent((await credential()).name)}/proxy`)).body.proxyUrl
  assert.equal((await cli(['accounts', 'pause', 'codex', '--yes'])).code, 0)
  assert.equal((await credential()).disabled, true)
  assert.equal((await cli(['accounts', 'resume', 'codex'])).code, 0)
  assert.equal((await credential()).disabled, false)
  assert.equal((await cli(['accounts', 'proxy', 'codex', 'direct', '--yes'])).code, 0)
  assert.equal(await proxyOf(), 'direct')
  const secretProxy = await cli(['accounts', 'proxy', 'codex', 'socks5h://bob:proxy-secret-9@127.0.0.1:1080', '--yes', '--json'])
  assert.equal(secretProxy.code, 0, secretProxy.stderr)
  assert.equal(await proxyOf(), 'socks5h://bob:proxy-secret-9@127.0.0.1:1080')
  const shown = await cli(['accounts', 'ls', '--json'])
  const exported = await cli(['config', 'export'])
  assert.equal(exported.code, 0, exported.stderr)
  fs.writeFileSync(path.join(cwd, 'proxy-roundtrip.json'), exported.stdout)
  const roundtrip = await cli(['config', 'apply', 'proxy-roundtrip.json', '--dry-run'])
  assert.equal(roundtrip.code, 0, roundtrip.stderr)
  assert.match(roundtrip.stdout, /没有需要改动的配置/)
  for (const result of [secretProxy, shown, exported, roundtrip]) assert.doesNotMatch(result.stdout + result.stderr, /proxy-secret-9/)
  assert.equal((await cli(['accounts', 'proxy', 'codex', 'direct', '--yes'])).code, 0)
  const ls = await cli(['accounts', 'ls', '--quota', '--json'])
  assert.equal(ls.code, 0)
  assert.doesNotMatch(ls.stdout, /access_token|refresh_token/)
})

test('config export → apply --dry-run 无改动 → 改文件 apply --yes → 状态一致 → 重跑无改动', async () => {
  const exported = await cli(['config', 'export', '--out', 'crosery.json'])
  assert.equal(exported.code, 0, exported.stderr)
  const file = path.join(cwd, 'crosery.json')
  assert.equal(fs.statSync(file).mode & 0o777, 0o600)
  const config = JSON.parse(fs.readFileSync(file, 'utf8'))
  assert.equal(fullKeys(JSON.stringify(config)).length, 0)
  assert.ok(!JSON.stringify(config).includes(PASSWORD))

  const dry = await cli(['config', 'apply', 'crosery.json', '--dry-run'])
  assert.equal(dry.code, 0, dry.stderr)
  assert.match(dry.stdout, /没有需要改动的配置/)

  config.channels.tch.models.m2 = false
  config.accounts[Object.keys(config.accounts)[0]].proxyUrl = ''
  config.keys.find(key => key.name === 'e2e-key').quota.dailyUsd = 3
  config.keys.push({ name: 'e2e-from-file', groups: ['tch'] })
  fs.writeFileSync(file, JSON.stringify(config))
  const writes = await nonLoginAudit()
  const preview = await cli(['config', 'apply', 'crosery.json', '--dry-run'])
  assert.equal(preview.code, 0)
  assert.match(preview.stderr, /e2e-from-file 在服务端匹配不到/)
  assert.equal(await nonLoginAudit(), writes)
  const noYes = await cli(['config', 'apply', 'crosery.json'])
  assert.equal(noYes.code, 2)
  assert.equal(await nonLoginAudit(), writes)

  const applied = await cli(['config', 'apply', 'crosery.json', '--yes', '--create-keys'])
  assert.equal(applied.code, 0, applied.stderr)
  const created = fullKeys(applied.stdout)
  assert.equal(created.length, 1)
  shownKeys.push(created[0])
  const channels = (await adminCall(server, 'GET', '/api/channels')).body
  assert.equal(channels.channels.find(item => item.name === 'tch').models.find(model => model.id === 'm2').enabled, false)
  assert.equal(channels.credentials[0].proxyUrl, '')
  assert.equal((await keyNamed('e2e-key')).quota.dailyUsd, 3)
  assert.ok(await keyNamed('e2e-from-file'))

  const rerun = await cli(['config', 'apply', 'crosery.json', '--yes'])
  assert.equal(rerun.code, 0, rerun.stderr)
  assert.match(rerun.stdout, /没有需要改动的配置/)
})

test('403 forbidden_role：Key 会话不能当管理员用', async () => {
  const login = await fetch(`${server.base}/api/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ apiKey: shownKeys.at(-1) }),
  })
  assert.equal(login.status, 200)
  const keyToken = cookieFromHeaders(login.headers)
  issuedTokens.add(keyToken)
  const execute = (file, args) => {
    if (args[0] === 'find-generic-password' && args.includes('com.crosery.cradmin.session')) return `${keyToken}\n`
    if (args[0] === '-i' || args[0] === 'delete-generic-password') return ''
    const error = new Error('not found')
    error.status = 44
    throw error
  }
  const result = await cli(['keys', 'ls'], { platform: 'darwin', execute, env: { CRADMIN_SESSION_CACHE: '', CRADMIN_KEYCHAIN: '' } })
  assert.equal(result.code, 3)
  assert.match(result.stderr, /这是 Key 会话，不是管理员/)
})

test('无参数交互菜单：开 Key、开关渠道模型（确认）、导出配置', async () => {
  const before = (await adminCall(server, 'GET', '/api/channels')).body.channels.find(item => item.name === 'tch').models.find(model => model.id === 'gpt-x').enabled
  assert.equal(before, true)
  const lines = [
    '3', '2', 'menu-key', '1,2', '', '', 'y', '',   // API Key → 开通 → 名称 → 分组（多选）→ 并发默认 → 日额度不限 → 确认（菜单里永远确认）→ 回车返回
    '2', '2', '1', '-1', 'y', '',              // 渠道与模型 → 模型开关 → tch → 停用第 1 个（gpt-x）→ 确认 → 回车返回
    '10', '1', 'menu.json', '',                // 导出/应用配置 → 导出 → 文件名 → 回车返回
    '0',
  ]
  const result = await cli([], { interactive: true, stdin: `${lines.join('\n')}\n`, label: ['menu', 'keys', 'create'] })
  assert.equal(result.code, 0, result.stderr)
  const created = fullKeys(result.stdout)
  assert.equal(created.length, 1, result.stdout)
  shownKeys.push(created[0])
  assert.deepEqual([...(await keyNamed('menu-key')).groups].sort(), ['codex', 'tch'])
  assert.equal(result.stderr.match(/确认执行？ \[y\/N\]/g)?.length, 2, '开 Key（本地 A 级）在菜单里也要确认')
  const after = (await adminCall(server, 'GET', '/api/channels')).body.channels.find(item => item.name === 'tch').models.find(model => model.id === 'gpt-x').enabled
  assert.equal(after, false)
  assert.equal(JSON.parse(fs.readFileSync(path.join(cwd, 'menu.json'), 'utf8')).cradmin, 1)
})

test('交互菜单：确认时回答否 → 不写', async () => {
  const writes = await nonLoginAudit()
  const result = await cli([], { interactive: true, stdin: ['2', '2', '1', '-2', 'n', '', '0'].join('\n') + '\n' })
  assert.equal(result.code, 0, result.stderr)
  assert.match(result.stderr, /已取消/)
  assert.equal(await nonLoginAudit(), writes)
})

test('cradmin --dry-run 进菜单：开 Key 只预览，不发写请求', async () => {
  const writes = await nonLoginAudit()
  const lines = ['3', '2', 'menu-dry', '1', '', '', '', '0']
  const result = await cli(['--dry-run'], { interactive: true, stdin: `${lines.join('\n')}\n` })
  assert.equal(result.code, 0, result.stderr)
  assert.match(result.stdout, /--dry-run：只预览/)
  assert.match(result.stdout, /预览（--dry-run，不会发出写请求）/)
  assert.equal(fullKeys(result.stdout).length, 0)
  assert.equal(await nonLoginAudit(), writes)
  assert.equal(await keyNamed('menu-dry'), undefined)
})

test('菜单里密码不对：只发一次登录就退出 3，不会每个动作再撞一次登录限流', async () => {
  let logins = 0
  const onResponse = async url => { if (url.endsWith('/api/login')) logins += 1 }
  const result = await cli([], { interactive: true, env: { CONSOLE_PASSWORD: 'definitely-wrong-pass' }, stdin: ['1', '', '1', '', '0'].join('\n') + '\n', onResponse })
  assert.equal(result.code, 3, result.stderr)
  assert.equal(logins, 1)
})

test('accounts add：CPA 授权（轮询到 ok / 两步回调 / 过期 state）；rm 删除凭据；reset 经 CPA 代发', async () => {
  const credentials = async () => (await adminCall(server, 'GET', '/api/channels')).body.credentials
  const before = (await credentials()).length
  const polled = await cli(['accounts', 'add', 'claude'])
  assert.equal(polled.code, 0, polled.stderr)
  assert.match(polled.stdout + polled.stderr, /https:\/\/auth\.example\.test\/authorize/)
  const state = (polled.stdout + polled.stderr).match(/fake-state-\d+/)[0]
  const twoStep = await cli(['accounts', 'add', 'claude', '--callback-url', `https://example.com/cb?code=def&state=${state}`, '--state', state])
  assert.equal(twoStep.code, 0, twoStep.stderr)
  const expired = await cli(['accounts', 'add', 'claude', '--callback-url', 'https://example.com/cb?code=def', '--state', 'gone-state'])
  assert.equal(expired.code, 1)
  assert.match(expired.stderr, /不属于当前授权或已过期/)
  assert.equal((await cli(['accounts', 'add', 'nope'])).code, 2)
  assert.equal((await cli(['accounts', 'add', 'antigravity'])).code, 0)
  assert.equal((await credentials()).length, before + 2)

  const claude = (await credentials()).find(item => item.type === 'claude').name
  assert.equal((await cli(['accounts', 'rm', claude])).code, 2, '不可撤销操作非交互缺 --yes')
  const removed = await cli(['accounts', 'rm', claude, '--yes'])
  assert.equal(removed.code, 0, removed.stderr)
  assert.equal(server.cpa.credentials.has(claude), false)
  assert.equal((await credentials()).length, before + 1)
  const antigravity = (await credentials()).find(item => item.type === 'antigravity').name
  assert.equal((await cli(['accounts', 'reset', antigravity, '--yes'])).code, 2, '与服务端一致：只有 codex / claude 类型能重置')
  const reset = await cli(['accounts', 'reset', 'codex', '--yes'])
  assert.equal(reset.code, 0, reset.stderr)
  const consumed = server.cpa.requests.filter(item => item.method === 'POST' && item.path.endsWith('/api-call')).map(item => JSON.parse(item.body))
    .find(body => body.url.endsWith('/rate-limit-reset-credits/consume'))
  assert.equal(consumed?.auth_index, 'codex-fixture.json')
})

test('channels rm / prune、models sync 在一次性实例上的结果', async () => {
  assert.equal((await cli(['channels', 'add', 'tmp-ch', '--base-url', 'http://127.0.0.1:9/v1', '--api-key-stdin', '--models', 'z1'], { stdin: UPSTREAM_KEY })).code, 0)
  const rm = await cli(['channels', 'rm', 'tmp-ch', '--yes'])
  assert.equal(rm.code, 0, rm.stderr)
  assert.equal((await adminCall(server, 'GET', '/api/channels')).body.channels.some(item => item.name === 'tmp-ch'), false)
  assert.equal((await cli(['channels', 'rm', 'tmp-ch', '--yes'])).code, 2)
  const prune = await cli(['channels', 'prune', '--yes'])
  assert.equal(prune.code, 0)
  assert.match(prune.stdout, /没有失效渠道/)
  const sync = await cli(['models', 'sync'])
  assert.ok([0, 1, 4].includes(sync.code), `${sync.code} ${sync.stderr}`)
})

// 假 CPA 跑在本进程里：同步等子进程会卡住事件循环，控制台就等不到 CPA 应答
const subprocess = (args, env) => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, [CLI, ...args], { env, cwd, stdio: ['ignore', 'pipe', 'pipe'] })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', chunk => { stdout += chunk })
  child.stderr.on('data', chunk => { stderr += chunk })
  child.once('error', reject)
  child.once('close', status => resolve({ status, stdout, stderr }))
})

test('真实子进程：非 TTY 写命令缺 --yes 退出 2；读命令 --json 可解析', async () => {
  const env = { ...process.env, CONSOLE_PASSWORD: PASSWORD, CRADMIN_SESSION_CACHE: 'off', CRADMIN_KEYCHAIN: 'off', CRADMIN_BASE: server.base, CRADMIN_HOME: home }
  delete env.CONSOLE_PASSWORD_FILE
  delete env.CI
  const write = await subprocess(['channels', 'disable', 'tch'], env)
  assert.equal(write.status, 2, write.stderr)
  assert.match(write.stderr, /非交互环境执行此操作需要 --yes/)
  const read = await subprocess(['keys', 'ls', '--json'], env)
  assert.equal(read.status, 0, read.stderr)
  assert.ok(Array.isArray(JSON.parse(read.stdout)))
  outputs.push({ argv: ['subprocess'], stdout: write.stdout + read.stdout, stderr: write.stderr + read.stderr })
})

test('输出扫描：密码、会话 token 从不出现；完整 Key 只在 create / rotate / apply --create-keys 的 stdout 出现一次', async () => {
  assert.ok(issuedTokens.size > 5)
  const all = outputs.map(entry => entry.stdout + entry.stderr).join('\n')
  assert.ok(!all.includes(PASSWORD), '密码泄露')
  assert.ok(!all.includes(UPSTREAM_KEY), '上游 Key 泄露')
  for (const token of issuedTokens) assert.ok(!all.includes(token), '会话 token 泄露')
  for (const key of shownKeys) {
    const hits = outputs.filter(entry => (entry.stdout + entry.stderr).includes(key))
    assert.equal(hits.length, 1, `Key 出现在 ${hits.length} 条输出里`)
    assert.ok(hits[0].stdout.includes(key) && !hits[0].stderr.includes(key))
    assert.ok(['create', 'rotate', 'apply'].some(word => hits[0].argv.includes(word)), hits[0].argv.join(' '))
  }
  // 服务端现存的每一把 Key：明文只允许出现在上面那几条输出里
  for (const key of (await bootstrap()).keys) {
    const handle = await adminCall(server, 'POST', `/api/keys/${key.id}/reveal-token`)
    const plain = (await adminCall(server, 'GET', `/api/keys/${key.id}/reveal?token=${handle.body.token}`)).body.key
    const hits = outputs.filter(entry => (entry.stdout + entry.stderr).includes(plain))
    assert.ok(hits.length <= 1, `${key.name} 明文出现 ${hits.length} 次`)
  }
})

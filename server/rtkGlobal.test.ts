import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test, { after } from 'node:test'

/**
 * RTK 全局开关（CONTRACTS C4）与本机 CLI 统计缓存。
 * 所有写入都发生在 mkdtemp 的 HOME 里；文件末尾断言真实 agent 配置逐字节不变。
 */

for (const name of ['MAGPIE_SOURCE_CPA_BASE_URL', 'MAGPIE_SOURCE_CPA_KEY', 'MAGPIE_SOURCE_CPA_KEY_FILE', 'MAGPIE_KERNEL_SOCKET', 'GATEWAY_ENGINE',
  'RTK_WRITE_MODE', 'RTK_ALLOW_REMOTE_WRITE', 'RTK_ALLOW_KERNEL_WRITE', 'RTK_ALLOW_REAL_AGENT_WRITE']) delete process.env[name]

const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'rtk-global-test-'))
process.env.RTK_HOME = path.join(workspace, 'default-home')
process.env.RTK_BACKUP_DIR = path.join(workspace, 'backups')
fs.mkdirSync(process.env.RTK_HOME, { recursive: true })

const counter = path.join(workspace, 'invocations.log')
const cli = path.join(workspace, 'fake-rtk.sh')
fs.writeFileSync(cli, `#!/bin/sh
echo "$*" >> ${JSON.stringify(counter)}
case "$1" in
  --version) echo "rtk 0.50.0"; exit 0 ;;
  gain) echo '{"summary":{"total_commands":3,"total_input":100,"total_saved":40,"avg_savings_pct":40},"daily":[]}'; exit 0 ;;
esac
case "$*" in
  *--codex*--uninstall*) rm -f "$HOME/.codex/hooks.json"; exit 0 ;;
  *--codex*) mkdir -p "$HOME/.codex"; printf %s '{"hooks":{"PreToolUse":[{"matcher":"Bash","hooks":[{"type":"command","command":"rtk hook codex"}]}]}}' > "$HOME/.codex/hooks.json"; exit 0 ;;
  *vibe*) echo "vibe boom" >&2; exit 1 ;;
  *"--agent cursor"*) mkdir -p "$HOME/.claude" "$HOME/.cursor"; printf %s 'not json at all' > "$HOME/.claude/settings.json"; printf %s '{"version":1,"hooks":{"preToolUse":[{"command":"rtk hook cursor","matcher":"Shell"}]}}' > "$HOME/.cursor/hooks.json"; exit 0 ;;
  *"--agent claude"*) mkdir -p "$HOME/.claude"; printf %s '{"hooks":{"PreToolUse":[{"matcher":"Bash","hooks":[{"type":"command","command":"rtk hook claude"}]}]}}' > "$HOME/.claude/settings.json"; exit 0 ;;
esac
exit 0
`, { mode: 0o755 })
process.env.RTK_BIN = cli

const realHome = os.userInfo().homedir
const watched = ['.codex/hooks.json', '.claude/settings.json', '.vibe/hooks.toml', '.cursor/hooks.json']
const digest = (file: string) => { try { return createHash('sha256').update(fs.readFileSync(file)).digest('hex') } catch { return null } }
const realBefore = new Map(watched.map(rel => [rel, digest(path.join(realHome, rel))]))

const service = await import('./rtkService.js')
const offline = { kernel: { engine: 'cpa' as const }, relay: { baseUrl: '', key: '' } }

const home = (name: string, agents: string[]) => {
  const dir = path.join(workspace, `home-${name}`)
  for (const agent of agents) fs.mkdirSync(path.join(dir, agent), { recursive: true })
  return dir
}

after(() => {
  for (const rel of watched) assert.equal(digest(path.join(realHome, rel)), realBefore.get(rel), `真实 ${rel} 不得被测试改动`)
  fs.rmSync(workspace, { recursive: true, force: true })
})

test('全局视图：只统计权威平面上已安装且支持全局钩子的 agent；混合状态为 null', async () => {
  const dir = home('view', ['.codex', '.vibe'])
  fs.writeFileSync(path.join(dir, '.codex/hooks.json'), JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'rtk hook codex' }] }] } }))
  const view = await service.readRTKGlobal({ home: dir, fresh: true, ...offline })
  assert.equal(view.plane, 'local')
  assert.deepEqual(view.agents, { supported: 2, on: 1 })
  assert.equal(view.on, null)
  assert.equal(view.writable, true)
  assert.deepEqual(view.savings, { pct: 40, tokens: 40 })
  assert.ok(!fs.existsSync(path.join(dir, '.claude')), '只读不建目录')
})

test('全局开关必须显式确认；RTK_WRITE_MODE=off 时拒绝且不动文件', async () => {
  const dir = home('gates', ['.codex'])
  await assert.rejects(service.setRTKGlobal(true, { home: dir, ...offline }), (error: unknown) => {
    const failure = service.rtkFailure(error)
    return failure.status === 403 && failure.reason === 'confirmation_required'
  })
  process.env.RTK_WRITE_MODE = 'off'
  try {
    await assert.rejects(service.setRTKGlobal(true, { home: dir, confirm: true, ...offline }), (error: unknown) => service.rtkFailure(error).reason === 'write_disabled')
    assert.equal((await service.readRTKGlobal({ home: dir, fresh: true, ...offline })).writable, false)
  } finally {
    delete process.env.RTK_WRITE_MODE
  }
  assert.ok(!fs.existsSync(path.join(dir, '.codex/hooks.json')))
})

test('全局开关逐个套用现有开关：成功的生效，失败的逐条如实返回，没装的 agent 不碰', async () => {
  const dir = home('bulk', ['.codex', '.vibe'])
  const on = await service.setRTKGlobal(true, { home: dir, confirm: true, ...offline })
  assert.equal(on.plane, 'local')
  assert.equal(on.ok, false)
  assert.deepEqual(on.results.map(result => [result.agent, result.ok]), [['codex', true], ['vibe', false]])
  assert.ok(on.results.find(result => result.agent === 'vibe')?.error)
  assert.equal(on.on, null, '部分失败 → 混合状态')
  assert.match(fs.readFileSync(path.join(dir, '.codex/hooks.json'), 'utf8'), /rtk hook codex/)
  assert.ok(!fs.existsSync(path.join(dir, '.claude')) && !fs.existsSync(path.join(dir, '.cursor')), '没安装的 agent 不建配置')

  const off = await service.setRTKGlobal(false, { home: dir, confirm: true, ...offline })
  assert.deepEqual(off.results.map(result => [result.agent, result.ok, Boolean(result.unchanged)]), [['codex', true, false], ['vibe', true, true]])
  assert.equal(off.ok, true)
  assert.equal(off.on, false)
  assert.ok(!fs.existsSync(path.join(dir, '.codex/hooks.json')))
})

test('全局开关：CLI 连带写坏别的 agent 文件 → 逐条带回 collateralSkipped；复核不是目标状态 → ok=false + offTarget（review RR-3）', async () => {
  const dir = home('collateral', ['.claude', '.cursor'])
  fs.writeFileSync(path.join(dir, '.claude/settings.json'), JSON.stringify({ hooks: { PreToolUse: [] } }))
  const result = await service.setRTKGlobal(true, { home: dir, confirm: true, ...offline })
  assert.deepEqual(result.results.map(item => [item.agent, item.ok]), [['claude', true], ['cursor', true]])
  assert.equal(result.on, null, '复核：claude 的文件被 cursor 的 CLI 写坏 → 混合')
  assert.equal(result.ok, false, '每个写入都成功但复核不是目标状态，不能报 ok')
  assert.deepEqual(result.offTarget, ['claude'])
  const cursor = result.results.find(item => item.agent === 'cursor')
  assert.deepEqual(cursor?.collateralSkipped?.map(item => [item.agent, item.file]), [['claude', '.claude/settings.json']])
  assert.ok(cursor?.backupId, '每个写入的备份 id 一并带回，回退时能对上')
  assert.equal(fs.readFileSync(path.join(dir, '.claude/settings.json'), 'utf8'), 'not json at all', '不认识的结构不覆盖用户文件')
})

test('找不到 rtk 时全局视图带手动安装命令；可写时不带（review RR-9）', async () => {
  const dir = home('missing-bin', ['.codex'])
  const saved = process.env.RTK_BIN
  process.env.RTK_BIN = path.join(workspace, 'no-such-rtk')
  try {
    const view = await service.readRTKGlobal({ home: dir, fresh: true, ...offline })
    assert.equal(view.writable, false)
    assert.equal(view.reason, 'rtk_binary_missing')
    assert.match(view.installHint ?? '', /^curl -fsSL https:\/\/\S+\/install\.sh \| sh$/)
  } finally {
    process.env.RTK_BIN = saved
  }
  const ok = await service.readRTKGlobal({ home: dir, fresh: true, ...offline })
  assert.equal(ok.writable, true)
  assert.equal(ok.installHint ?? null, null)
})

test('本机 rtk --version / gain 结果缓存 30s；fresh 读取跳过缓存', async () => {
  const dir = home('stats', [])
  service.resetRtkStatsCache()
  fs.writeFileSync(counter, '')
  const count = () => fs.readFileSync(counter, 'utf8').split('\n').filter(Boolean).length
  await service.readRTKStatus({ home: dir, ...offline })
  await service.readRTKStatus({ home: dir, ...offline })
  await Promise.all([service.readRTKStatus({ home: dir, ...offline }), service.readLocalPayload(cli, dir)])
  assert.equal(count(), 2, '一次 --version + 一次 gain')
  await service.readRTKStatus({ home: dir, fresh: true, ...offline })
  assert.equal(count(), 4)
})

/* ────────────────────────── review-sync-balance ────────────────────────── */

test('SB-10 RTK_WRITE_MODE=off 是全只读：远端/内核开关打开了也不可写', async () => {
  const plane = await import('./rtkPlane.js')
  const policy = { mode: 'off' as const, remoteWriteEnabled: true, kernelWriteEnabled: true, installEnabled: false, source: 'env' as const }
  assert.throws(() => plane.assertRemoteWrite(true, 'kernel', policy), (error: Error & { reason?: string }) => error.reason === 'write_disabled')
  assert.throws(() => plane.assertRemoteWrite(true, 'relay', policy), (error: Error & { reason?: string }) => error.reason === 'write_disabled')
  const kernelStatus = {
    plane: 'kernel', agents: [{ id: 'codex', supported: true, blocked: false, on: false, installed: true }], localAgents: [],
    local: { connected: true }, gain: null,
  } as unknown as Parameters<typeof service.rtkGlobalView>[0]
  const view = service.rtkGlobalView(kernelStatus, policy)
  assert.equal(view.writable, false)
  assert.equal(view.reason, 'write_disabled')
  assert.equal(service.rtkGlobalView(kernelStatus, { ...policy, mode: 'local' }).writable, true, '只有 mode 不同时可写')
})

test('SB-18 内核写入后复核读不到内核（回落到本机）：on=null + degraded，不拿本机状态冒充内核结果', async () => {
  const http = await import('node:http')
  const socket = path.join(workspace, `kernel-${Math.random().toString(16).slice(2)}.sock`)
  let writes = 0
  const server = http.createServer((req, res) => {
    if (req.method === 'POST') {
      writes += 1
      req.resume()
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{}')
      return
    }
    if (writes > 0) {
      res.writeHead(500)
      res.end('kernel crashed')
      return
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ path: '/srv/rtk', version: '0.50.0', agents: [{ id: 'codex', name: 'Codex', icon: 'openai', on: false }] }))
  })
  await new Promise<void>(resolve => server.listen(socket, resolve))
  const dir = home('verify-plane', ['.codex'])
  process.env.RTK_ALLOW_KERNEL_WRITE = '1'
  process.env.RTK_ALLOW_REMOTE_WRITE = '1'
  try {
    const result = await service.setRTKGlobal(true, { home: dir, confirm: true, kernel: { engine: 'magpie', socket }, relay: { baseUrl: '', key: '' } })
    assert.equal(writes, 1)
    assert.equal(result.plane, 'kernel')
    assert.equal(result.readPlane, 'local')
    assert.equal(result.on, null)
    assert.equal(result.degraded, 'verify_plane_unavailable')
    assert.equal(result.ok, false)
    assert.deepEqual(result.results.map(item => [item.agent, item.ok]), [['codex', true]], '逐 agent 的写入结果照实保留')
  } finally {
    delete process.env.RTK_ALLOW_KERNEL_WRITE
    delete process.env.RTK_ALLOW_REMOTE_WRITE
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
})

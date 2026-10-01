import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFile, execFileSync } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import type { AddressInfo } from 'node:net'
import test, { after, before } from 'node:test'

/**
 * RTK 控制面测试（含红队 task-1 反例清单 T1-T13 的可自动化部分）。
 *
 * 纪律（COORDINATION.md）：
 * - 绝不读写真实 ~/.codex、~/.claude 等 agent 配置：写入的 HOME 全是 mkdtemp 出来的；
 * - 文件末尾用 sha256 断言真实 agent 配置在整轮测试前后逐字节不变（T5）；
 * - rtkService 在 NODE_TEST_CONTEXT 下对真实 home 有硬闸门（专门用例覆盖）。
 */

// 必须在动态 import 服务模块之前清干净，避免环境里的真实中转站配置被带进测试。
delete process.env.MAGPIE_SOURCE_CPA_BASE_URL
delete process.env.MAGPIE_SOURCE_CPA_KEY
delete process.env.MAGPIE_SOURCE_CPA_KEY_FILE
delete process.env.MAGPIE_KERNEL_SOCKET
delete process.env.GATEWAY_ENGINE
delete process.env.RTK_BIN
delete process.env.RTK_WRITE_MODE
delete process.env.RTK_ALLOW_REMOTE_WRITE
delete process.env.RTK_ALLOW_INSTALL

const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'rtk-plane-test-'))
process.env.RTK_HOME = path.join(workspace, 'home')
process.env.RTK_BACKUP_DIR = path.join(workspace, 'backups')
fs.mkdirSync(process.env.RTK_HOME, { recursive: true })

const realHome = os.userInfo().homedir
const watchedRealFiles = [
  '.codex/hooks.json', '.codex/AGENTS.md', '.claude/settings.json', '.claude/CLAUDE.md',
  '.cursor/hooks.json', '.gemini/hooks/rtk-hook-gemini.sh', '.omp/agent/extensions/rtk.ts',
  '.pi/agent/extensions/rtk.ts', '.factory/hooks.json', '.copilot/hooks/rtk-rewrite.json',
]
const digest = (filePath: string): string | null => {
  try {
    return createHash('sha256').update(fs.readFileSync(filePath)).digest('hex')
  } catch {
    return null
  }
}
const realDigests = new Map(watchedRealFiles.map(rel => [rel, digest(path.join(realHome, rel))]))

const service = await import('./rtkService.js')
const plane = await import('./rtkPlane.js')
const { RtkPlaneError } = plane

const rtkBinary = service.findRTKBinary()
const execFileAsync = promisify(execFile)
const offlineTargets = { kernel: { engine: 'cpa' }, relay: { baseUrl: '', key: '' } }
const missingBinary = path.join(workspace, 'no-such-rtk')
const tempHome = (name: string): string => {
  const dir = path.join(workspace, `home-${name}`)
  fs.mkdirSync(dir, { recursive: true })
  return dir
}
const readJson = (filePath: string): Record<string, unknown> => JSON.parse(fs.readFileSync(filePath, 'utf8'))

type FakeServer = { server: http.Server; url: string; requests: Array<{ method: string; url: string; auth?: string; body: string }> }

async function startHttp(handler: (req: http.IncomingMessage, res: http.ServerResponse) => void): Promise<FakeServer> {
  const requests: FakeServer['requests'] = []
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', chunk => chunks.push(Buffer.from(chunk)))
    req.on('end', () => {
      requests.push({ method: req.method || '', url: req.url || '', auth: req.headers.authorization, body: Buffer.concat(chunks).toString('utf8') })
      handler(req, res)
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  return { server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, requests }
}

async function startSocket(handler: (req: http.IncomingMessage, res: http.ServerResponse) => void): Promise<{ server: http.Server; socket: string }> {
  const socket = path.join(workspace, `kernel-${Math.random().toString(16).slice(2)}.sock`)
  const server = http.createServer(handler)
  await new Promise<void>(resolve => server.listen(socket, resolve))
  return { server, socket }
}

const closeAll = async (servers: http.Server[]) => {
  for (const server of servers) await new Promise<void>(resolve => server.close(() => resolve()))
}

const json = (res: http.ServerResponse, status: number, payload: unknown) => {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(payload))
}

const kernelView = {
  path: '/srv/rtk/bin/rtk', version: '0.50.0',
  gain: { commands: 12, input: 900, saved: 300, pct: 33.3 },
  days: [{ date: '2026-09-30', commands: 12, input: 900, saved: 300, pct: 33.3 }],
  latest: 'v0.50.0', url: 'https://www.rtk-ai.app',
  agents: [{ id: 'codex', name: 'Codex', icon: 'openai', on: true }],
}

type PlaneFailure = Error & { status: number; reason: string; backup?: string; plane?: string }

const expectPlaneError = async (run: () => Promise<unknown>, status: number, reason: string): Promise<PlaneFailure> => {
  try {
    await run()
    assert.fail(`期望抛出 ${status}/${reason}`)
  } catch (error) {
    assert.ok(error instanceof RtkPlaneError, `期望 RtkPlaneError，实际 ${String(error)}`)
    assert.equal((error as PlaneFailure).status, status)
    assert.equal((error as PlaneFailure).reason, reason)
    return error as PlaneFailure
  }
}

/* ------------------------------------------------------------------ */
/* 1. 平面探测                                                         */
/* ------------------------------------------------------------------ */

test('T1 内核平面：非 magpie 引擎 / socket 不存在都如实报未配置', async () => {
  const byEngine = await plane.probeKernelPlane({ engine: 'cpa', socket: '/tmp/does-not-exist.sock' })
  assert.equal(byEngine.available, false)
  assert.equal(byEngine.configured, false)
  assert.equal(byEngine.state, 'not_configured')
  assert.equal(byEngine.reason, 'gateway_engine_not_magpie')

  const bySocket = await plane.probeKernelPlane({ engine: 'magpie', socket: path.join(workspace, 'missing.sock') })
  assert.equal(bySocket.available, false)
  assert.equal(bySocket.state, 'not_configured')
  assert.equal(bySocket.reason, 'kernel_socket_missing')
})

test('T1/T2 内核 socket 不可用时 status 仍可用，plane=local 且数据来自本机', async () => {
  const status = await service.readRTKStatus({
    home: tempHome('t1-local'),
    fresh: true,
    kernel: { engine: 'magpie', socket: path.join(workspace, 'definitely-missing.sock') },
    relay: { baseUrl: '', key: '' },
  })
  assert.equal(status.plane, 'local')
  assert.equal(status.planes[0].state, 'not_configured')
  // 不允许把「内核不可用」表述成「RTK 未安装」
  assert.equal(status.planes[0].reason, 'kernel_socket_missing')
  assert.equal(status.local.connected, Boolean(rtkBinary))
})

test('内核平面：/internal/rtk 正常应答时可用', async () => {
  const fake = await startSocket((_req, res) => json(res, 200, kernelView))
  try {
    const probe = await plane.probeKernelPlane({ engine: 'magpie', socket: fake.socket })
    assert.equal(probe.available, true)
    assert.equal(probe.state, 'available')
  } finally {
    await closeAll([fake.server])
  }
})

test('T2 内核平面：旧构建没有 /internal/rtk 缝时报 not_supported 并带状态码', async () => {
  // 运行中的内核是旧构建：请求落到推理 handler 的兜底分支，返回 400。
  const fake = await startSocket((_req, res) => { res.writeHead(400); res.end('request id required') })
  try {
    const probe = await plane.probeKernelPlane({ engine: 'magpie', socket: fake.socket })
    assert.equal(probe.available, false)
    assert.equal(probe.configured, true)
    assert.equal(probe.state, 'not_supported')
    assert.equal(probe.reason, 'kernel_rtk_seam_missing')
    assert.match(String(probe.detail), /HTTP 400/)
  } finally {
    await closeAll([fake.server])
  }
})

test('中转站平面：未配置 / 缺密钥分开上报', async () => {
  const none = await plane.probeRelayPlane({ baseUrl: '', key: '' })
  assert.equal(none.state, 'not_configured')
  assert.equal(none.reason, 'relay_base_url_missing')
  const noKey = await plane.probeRelayPlane({ baseUrl: 'https://relay.example', key: '' })
  assert.equal(noKey.state, 'not_configured')
  assert.equal(noKey.reason, 'relay_credential_missing')
})

test('中转站平面：404 与 401 分别上报为「路由不存在」和「未授权」', async () => {
  const fake404 = await startHttp((_req, res) => { res.writeHead(404); res.end('') })
  const fake401 = await startHttp((_req, res) => json(res, 401, { error: 'unauthorized' }))
  try {
    const missing = await plane.probeRelayPlane({ baseUrl: fake404.url, key: 'test-key' })
    assert.equal(missing.state, 'not_supported')
    assert.equal(missing.reason, 'relay_route_missing')
    assert.equal(missing.configured, true)

    const denied = await plane.probeRelayPlane({ baseUrl: fake401.url, key: 'test-key' })
    assert.equal(denied.state, 'unauthorized')
    assert.equal(denied.reason, 'relay_http_401')
    assert.equal(fake401.requests[0].auth, 'Bearer test-key')
  } finally {
    await closeAll([fake404.server, fake401.server])
  }
})

test('中转站平面：远端错误正文里的密钥被脱敏', async () => {
  const fake = await startHttp((_req, res) => { res.writeHead(500); res.end('upstream said Bearer super-secret-key is invalid') })
  try {
    const probe = await plane.probeRelayPlane({ baseUrl: fake.url, key: 'super-secret-key' })
    assert.equal(probe.available, false)
    assert.ok(!JSON.stringify(probe).includes('super-secret-key'), `detail 泄露了密钥: ${JSON.stringify(probe)}`)
  } finally {
    await closeAll([fake.server])
  }
})

/* ------------------------------------------------------------------ */
/* 2. 平面解析与回退                                                   */
/* ------------------------------------------------------------------ */

test('权威平面：内核可用时走内核', async () => {
  const fake = await startSocket((_req, res) => json(res, 200, kernelView))
  try {
    const resolution = await plane.resolveRtkPlane({ kernel: { engine: 'magpie', socket: fake.socket }, relay: { baseUrl: '', key: '' } })
    assert.equal(resolution.plane, 'kernel')
    assert.equal(resolution.fellBack, false)
    assert.deepEqual(resolution.planes.map(item => item.id), ['kernel', 'relay', 'local'])
  } finally {
    await closeAll([fake.server])
  }
})

test('权威平面：内核旧构建 + 中转站可用时回退到中转站并保留内核原因', async () => {
  const stale = await startSocket((_req, res) => { res.writeHead(400); res.end('request id required') })
  const relay = await startHttp((_req, res) => json(res, 200, kernelView))
  try {
    const resolution = await plane.resolveRtkPlane({
      kernel: { engine: 'magpie', socket: stale.socket },
      relay: { baseUrl: relay.url, key: 'test-key' },
    })
    assert.equal(resolution.plane, 'relay')
    assert.equal(resolution.fellBack, true)
    assert.equal(resolution.planes[0].reason, 'kernel_rtk_seam_missing')
    assert.equal(resolution.planes[1].available, true)
  } finally {
    await closeAll([stale.server, relay.server])
  }
})

test('权威平面：都不可用时回退 local，且不假装已同步', async () => {
  const stale = await startSocket((_req, res) => { res.writeHead(400); res.end('request id required') })
  const relay404 = await startHttp((_req, res) => { res.writeHead(404); res.end('') })
  try {
    const resolution = await plane.resolveRtkPlane({
      kernel: { engine: 'magpie', socket: stale.socket },
      relay: { baseUrl: relay404.url, key: 'test-key' },
    })
    assert.equal(resolution.plane, 'local')
    assert.equal(resolution.fellBack, true)
    assert.equal(resolution.planes[2].available, true)
  } finally {
    await closeAll([stale.server, relay404.server])
  }
})

test('readRTKStatus：权威平面取内核视图，本机开关数据单独给 localAgents', async () => {
  const fake = await startSocket((_req, res) => json(res, 200, kernelView))
  try {
    const status = await service.readRTKStatus({
      home: tempHome('status-home'),
      fresh: true,
      kernel: { engine: 'magpie', socket: fake.socket },
      relay: { baseUrl: '', key: '' },
    })
    assert.equal(status.plane, 'kernel')
    assert.equal(status.path, '/srv/rtk/bin/rtk')
    assert.equal(status.gain?.saved, 300)
    assert.deepEqual(status.agents.map(agent => agent.id), ['codex'])
    assert.equal(status.agents[0].plane, 'kernel')
    // 权威平面与本机平面必须分开：内核说 codex 已挂载，本机临时 home 里并没有。
    assert.equal(status.localAgents.length, plane.RTK_AGENT_SPECS.length)
    assert.equal(status.localAgents.find(agent => agent.id === 'codex')?.on, false)
    assert.equal(status.localAgents.find(agent => agent.id === 'codex')?.plane, 'local')
  } finally {
    await closeAll([fake.server])
  }
})

/* ------------------------------------------------------------------ */
/* 3. 写入闸门与「平面不支持」                                         */
/* ------------------------------------------------------------------ */

test('T3 rtk 未安装时拒绝写入并给安装指引，绝不返回成功', async () => {
  process.env.RTK_BIN = missingBinary
  try {
    assert.equal(service.findRTKBinary(), null, 'RTK_BIN 显式指向不存在的路径时必须返回 null，不得回落到别的候选')
    const error = await expectPlaneError(
      () => service.setRTKAgentHook('codex', true, { plane: 'local', home: tempHome('t3'), ...offlineTargets }),
      503, 'rtk_binary_missing',
    )
    assert.match(error.message, /install\.sh/)
    const status = await service.readRTKStatus({ home: tempHome('t3'), fresh: true, ...offlineTargets })
    assert.equal(status.connected, false)
    assert.equal(status.install?.includes('install.sh'), true)
  } finally {
    delete process.env.RTK_BIN
  }
})

test('install/upgrade：三个平面都不支持时返回 501，不静默成功', async () => {
  await expectPlaneError(() => service.installRTK({ plane: 'kernel' }), 501, 'kernel_install_not_supported')
  await expectPlaneError(() => service.installRTK({ plane: 'local' }), 501, 'local_install_not_supported')
  await expectPlaneError(() => service.installRTK({ plane: 'relay' }), 501, 'relay_install_not_supported')
  await expectPlaneError(() => service.upgradeRTK({ plane: 'kernel' }), 501, 'kernel_upgrade_not_supported')
  await expectPlaneError(() => service.upgradeRTK({ plane: 'local' }), 501, 'local_upgrade_not_supported')
  await expectPlaneError(() => service.upgradeRTK({ plane: 'relay' }), 501, 'relay_upgrade_not_supported')
})

test('T13 中转站：没有 RTK 管理面 → 501，有面但未开远程写 → 403，两种情况都不发写请求', async () => {
  const noRoute = await startHttp((_req, res) => { res.writeHead(404); res.end('') })
  const withRoute = await startHttp((_req, res) => json(res, 200, kernelView))
  const home = tempHome('t13')
  try {
    // 1) 当前中转站的真实形态：/api/library/rtk → 404
    await expectPlaneError(
      () => service.setRTKAgentHook('codex', true, { plane: 'relay', home, confirm: true,
        kernel: { engine: 'cpa' as const }, relay: { baseUrl: noRoute.url, key: 'test-key' } }),
      501, 'relay_write_not_supported',
    )
    assert.deepEqual(noRoute.requests.filter(item => item.method !== 'GET'), [], '未支持的平面不允许发写请求')

    // 2) 假设未来中转站真的暴露了该面：默认仍是只读，403 且不发写请求
    await expectPlaneError(
      () => service.setRTKAgentHook('codex', true, { plane: 'relay', home, confirm: true,
        kernel: { engine: 'cpa' as const }, relay: { baseUrl: withRoute.url, key: 'test-key' } }),
      403, 'remote_write_disabled',
    )
    assert.deepEqual(withRoute.requests.filter(item => item.method !== 'GET'), [], '默认只读时不允许发写请求')

    // 3) 开关 + 确认齐备才下发（当前部署永远不会走到这里）
    process.env.RTK_ALLOW_REMOTE_WRITE = '1'
    try {
      const result = await service.setRTKAgentHook('codex', true, { plane: 'relay', home, confirm: true,
        kernel: { engine: 'cpa' as const }, relay: { baseUrl: withRoute.url, key: 'test-key' } })
      assert.equal(result.plane, 'relay')
      assert.equal(withRoute.requests.filter(item => item.method === 'POST').length, 1)
    } finally {
      delete process.env.RTK_ALLOW_REMOTE_WRITE
    }
  } finally {
    await closeAll([noRoute.server, withRoute.server])
  }
})

test('内核写入默认 501（沙箱 HOME，不影响本机 agent 配置），显式打开后才走闸门', async () => {
  const fake = await startSocket((_req, res) => json(res, 200, kernelView))
  const home = tempHome('kernel-gate')
  try {
    const targets = { kernel: { engine: 'magpie' as const, socket: fake.socket }, relay: { baseUrl: '', key: '' } }
    await expectPlaneError(
      () => service.setRTKAgentHook('codex', true, { plane: 'kernel', home, confirm: true, ...targets }),
      501, 'kernel_write_not_supported',
    )
    process.env.RTK_ALLOW_KERNEL_WRITE = '1'
    try {
      await expectPlaneError(
        () => service.setRTKAgentHook('codex', true, { plane: 'kernel', home, confirm: true, ...targets }),
        403, 'remote_write_disabled',
      )
      process.env.RTK_ALLOW_REMOTE_WRITE = '1'
      try {
        await expectPlaneError(
          () => service.setRTKAgentHook('codex', true, { plane: 'kernel', home, ...targets }),
          403, 'confirmation_required',
        )
        const result = await service.setRTKAgentHook('codex', true, { plane: 'kernel', home, confirm: true, ...targets })
        assert.equal(result.plane, 'kernel')
      } finally {
        delete process.env.RTK_ALLOW_REMOTE_WRITE
      }
    } finally {
      delete process.env.RTK_ALLOW_KERNEL_WRITE
    }
  } finally {
    await closeAll([fake.server])
  }
})

test('toggle：项目级 agent 与未知 agent 明确拒绝', async () => {
  const home = tempHome('toggle-unsupported')
  await expectPlaneError(
    () => service.setRTKAgentHook('windsurf', true, { plane: 'local', home, bin: rtkBinary, ...offlineTargets }),
    501, 'project_scoped_only',
  )
  await expectPlaneError(
    () => service.setRTKAgentHook('ghost', true, { plane: 'local', home, bin: rtkBinary, ...offlineTargets }),
    404, 'unknown_agent',
  )
  await expectPlaneError(
    () => service.setRTKAgentHook('codex', true, { plane: 'nope' as 'local', home, bin: rtkBinary, ...offlineTargets }),
    400, 'unknown_plane',
  )
})

test('本机写入闸门：RTK_WRITE_MODE=off 全只读，=confirm 需显式确认', async () => {
  const home = tempHome('write-mode')
  process.env.RTK_WRITE_MODE = 'off'
  try {
    await expectPlaneError(
      () => service.setRTKAgentHook('codex', true, { plane: 'local', home, bin: rtkBinary, ...offlineTargets }),
      403, 'write_disabled',
    )
  } finally {
    delete process.env.RTK_WRITE_MODE
  }
  process.env.RTK_WRITE_MODE = 'confirm'
  try {
    await expectPlaneError(
      () => service.setRTKAgentHook('codex', true, { plane: 'local', home, bin: rtkBinary, ...offlineTargets }),
      403, 'confirmation_required',
    )
  } finally {
    delete process.env.RTK_WRITE_MODE
  }
  assert.equal(fs.existsSync(path.join(home, '.codex/hooks.json')), false, '被拒绝的请求不允许落盘')
})

/* ------------------------------------------------------------------ */
/* 4. 本机落地（C 层）                                                 */
/* ------------------------------------------------------------------ */

/** 与 rtk 0.50.0 实测输出逐字节一致的权威形状（见 docs/qa/blue/rtk-control-plane.md）。 */
const VERIFIED_HOOKS: Record<string, unknown> = {
  codex: { hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'rtk hook codex' }] }] } },
  claude: { hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'rtk hook claude' }] }] } },
  trae: { hooks: { PreToolUse: [{ matcher: 'RunCommand', hooks: [{ type: 'command', command: 'rtk hook trae', timeout: 30 }] }] } },
  droid: { PreToolUse: [{ matcher: 'Execute', hooks: [{ type: 'command', command: 'rtk hook droid' }] }] },
  cursor: { version: 1, hooks: { preToolUse: [{ command: 'rtk hook cursor', matcher: 'Shell' }] } },
  copilot: { version: 1, hooks: { PreToolUse: [{ type: 'command', command: 'rtk hook copilot', cwd: '.', timeout: 5 }] } },
}
const HOOK_FILES: Record<string, string> = {
  codex: '.codex/hooks.json',
  claude: '.claude/settings.json',
  trae: '.trae/hooks.json',
  droid: '.factory/hooks.json',
  cursor: '.cursor/hooks.json',
  copilot: '.copilot/hooks/rtk-rewrite.json',
}

test('T5/T10 本机开关：codex 经 rtk CLI 落地，形状与实测一致且 exitCode=0/stderr 为空', { skip: !rtkBinary }, async () => {
  const home = tempHome('cli-codex')
  const result = await service.setRTKAgentHook('codex', true, { plane: 'local', home, bin: rtkBinary, ...offlineTargets })
  assert.equal(result.ok, true)
  assert.equal(result.plane, 'local')
  assert.equal(result.mechanism, 'rtk-cli')
  assert.equal(result.cli?.exitCode, 0)
  assert.equal(result.cli?.stderr, '')
  assert.deepEqual(readJson(path.join(home, HOOK_FILES.codex)), VERIFIED_HOOKS.codex)
  assert.equal(result.localAgents.find(agent => agent.id === 'codex')?.on, true)
  assert.ok(result.backup && fs.existsSync(result.backup), '写入前必须留下备份')
})

test('T10 agent 覆盖矩阵：11 个全局 agent 各自 ON→OFF，退出码 0、stderr 为空、状态独立', { skip: !rtkBinary }, async () => {
  const ids = plane.RTK_AGENT_SPECS.filter(spec => spec.initFlags).map(spec => spec.id)
  assert.equal(ids.length, 11)
  for (const id of ids) {
    // 每个 agent 独立 HOME：rtk 的 cursor 目标会连带写 Claude 的钩子（见下一条用例），
    // 共用 HOME 会互相污染，测不出「该 agent 自己的开关是否有效」。
    const home = tempHome(`matrix-${id}`)
    const on = await service.setRTKAgentHook(id, true, { plane: 'local', home, bin: rtkBinary, ...offlineTargets })
    assert.equal(on.mechanism, 'rtk-cli', `${id} ON 应走官方 CLI`)
    assert.equal(on.cli?.exitCode, 0, `${id} ON 退出码应为 0，实际 ${on.cli?.exitCode} (${on.cli?.stderr})`)
    assert.equal(on.cli?.stderr, '', `${id} ON stderr 应为空`)
    assert.equal(on.localAgents.find(agent => agent.id === id)?.on, true, `${id} ON 后应为已挂载`)

    const off = await service.setRTKAgentHook(id, false, { plane: 'local', home, bin: rtkBinary, ...offlineTargets })
    assert.equal(off.mechanism, 'rtk-cli')
    assert.equal(off.cli?.exitCode, 0, `${id} OFF 退出码应为 0，实际 ${off.cli?.exitCode} (${off.cli?.stderr})`)
    assert.equal(off.cli?.stderr, '', `${id} OFF stderr 应为空`)
    assert.equal(off.localAgents.find(agent => agent.id === id)?.on, false, `${id} OFF 后应为未挂载`)
  }
})

test('缺陷 1：cursor ON 连带打开的 Claude 配置必须按快照撤回，并如实回传', { skip: !rtkBinary }, async () => {
  const home = tempHome('cursor-claude-coupling')
  const on = await service.setRTKAgentHook('cursor', true, { plane: 'local', home, bin: rtkBinary, ...offlineTargets })
  assert.equal(on.localAgents.find(agent => agent.id === 'cursor')?.on, true, 'cursor 自己的钩子应已注册')
  // rtk 实测会连带在 .claude/settings.json 注册 claude 钩子、新建 .claude/RTK.md 与 .claude/CLAUDE.md
  assert.deepEqual(on.collateralReverted, ['claude'], '连带打开必须撤回并回传')
  assert.equal(on.localAgents.find(agent => agent.id === 'claude')?.on, false, '用户没点 claude，就不能被打开')
  assert.equal(fs.existsSync(path.join(home, '.claude/RTK.md')), false, '.claude/RTK.md 不应残留')
  assert.equal(fs.existsSync(path.join(home, '.claude/CLAUDE.md')), false, '.claude/CLAUDE.md 不应残留')
  const settings = fs.existsSync(path.join(home, '.claude/settings.json'))
    ? fs.readFileSync(path.join(home, '.claude/settings.json'), 'utf8')
    : ''
  assert.ok(!settings.includes('rtk hook claude'), '.claude/settings.json 不应留下 rtk 钩子')
  assert.ok((on.collateralFiles || []).some(file => file.includes('.claude')), '回传里要列出被连带动到的文件')
  assert.match(fs.readFileSync(path.join(home, '.cursor/hooks.json'), 'utf8'), /rtk hook cursor/)

  // cursor OFF 后仍然没有 claude 残留（判据：ON→OFF 回到操作前状态）
  const off = await service.setRTKAgentHook('cursor', false, { plane: 'local', home, bin: rtkBinary, ...offlineTargets })
  assert.equal(off.localAgents.find(agent => agent.id === 'cursor')?.on, false)
  assert.equal(off.localAgents.find(agent => agent.id === 'claude')?.on, false)
  assert.equal(fs.existsSync(path.join(home, '.claude/RTK.md')), false)
  assert.equal(fs.existsSync(path.join(home, '.claude/CLAUDE.md')), false)
})

test('缺陷 1（反向，不许改坏）：claude OFF 连带删掉的 cursor 钩子仍要修回', { skip: !rtkBinary }, async () => {
  const home = tempHome('claude-off-collateral')
  await service.setRTKAgentHook('cursor', true, { plane: 'local', home, bin: rtkBinary, ...offlineTargets })
  const claudeOn = await service.setRTKAgentHook('claude', true, { plane: 'local', home, bin: rtkBinary, ...offlineTargets })
  assert.equal(claudeOn.localAgents.find(agent => agent.id === 'claude')?.on, true)
  const off = await service.setRTKAgentHook('claude', false, { plane: 'local', home, bin: rtkBinary, ...offlineTargets })
  assert.equal(off.localAgents.find(agent => agent.id === 'claude')?.on, false)
  assert.equal(off.localAgents.find(agent => agent.id === 'cursor')?.on, true, '连带删掉的 cursor 钩子必须从备份修回')
  assert.deepEqual(off.collateralRestored, ['cursor'])
})

test('缺陷 1（既有 claude 已开启）：cursor ON 不得改动已有的 claude 配置', { skip: !rtkBinary }, async () => {
  const home = tempHome('claude-already-on')
  const settingsPath = path.join(home, '.claude/settings.json')
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true })
  const original = `${JSON.stringify({
    hooks: { PreToolUse: [
      { matcher: 'Bash', hooks: [{ type: 'command', command: 'orca-hook' }] },
      { matcher: 'Bash', hooks: [{ type: 'command', command: 'rtk hook claude' }] },
    ] },
  }, null, 2)}\n`
  fs.writeFileSync(settingsPath, original)
  await service.setRTKAgentHook('cursor', true, { plane: 'local', home, bin: rtkBinary, ...offlineTargets })
  assert.equal(fs.readFileSync(settingsPath, 'utf8'), original, 'claude 已开启时 cursor ON 不得改动该文件')
})

test('缺陷 2：rtk 未安装时 local 平面不再谎报「已安装」', async () => {
  process.env.RTK_BIN = missingBinary
  try {
    const status = await service.readRTKStatus({ home: tempHome('defect2'), fresh: true, ...offlineTargets })
    const localPlane = status.planes.find(item => item.id === 'local')
    assert.ok(localPlane)
    assert.equal(localPlane?.state, 'degraded')
    assert.equal(localPlane?.reason, 'local_rtk_missing')
    assert.ok(!String(localPlane?.detail).includes('已安装'), `不应再出现「已安装」字样: ${localPlane?.detail}`)
    assert.equal(status.connected, false)
    assert.equal(status.path, null)
    assert.equal(status.local.connected, false)
  } finally {
    delete process.env.RTK_BIN
  }
})

test('缺陷 3：CLI 把钩子文件写坏时必须按 CLI 之前的原文回填，并保留 409/plane/reason/backup', async () => {
  const home = tempHome('defect3')
  const filePath = path.join(home, '.codex/hooks.json')
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  const pristine = `${JSON.stringify({
    hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo third-party-a' }] }] },
  }, null, 2)}\n`
  fs.writeFileSync(filePath, pristine)

  // 假 rtk：照常 exit 0，但把目标文件覆盖成垃圾（模拟 CLI 崩溃/被杀/写一半）
  const fakeBin = path.join(workspace, 'fake-rtk-corrupt.sh')
  fs.writeFileSync(fakeBin, `#!/bin/sh\nprintf 'THIS IS NOT JSON' > "$HOME/.codex/hooks.json"\nexit 0\n`, { mode: 0o755 })

  const error = await expectPlaneError(
    () => service.setRTKAgentHook('codex', true, { plane: 'local', home, bin: fakeBin, ...offlineTargets }),
    409, 'hook_file_unparsable',
  )
  assert.equal(fs.readFileSync(filePath, 'utf8'), pristine, '文件必须回到 CLI 运行之前的原文（字节一致）')
  assert.ok(error.backup && fs.existsSync(path.join(error.backup, 'manifest.json')), '错误里要带可回退的备份目录')
  assert.match(error.message, /rollback/, '文案要给出回退入口')
})

test('缺陷 3（附带）：目录不可写时返回结构化错误，不泄漏服务端临时路径', async () => {
  const home = tempHome('defect3-eacces')
  const dir = path.join(home, '.codex')
  fs.mkdirSync(dir, { recursive: true })
  fs.chmodSync(dir, 0o500)
  try {
    const error = await expectPlaneError(
      () => service.setRTKAgentHook('codex', true, { plane: 'local', home, bin: missingBinary, ...offlineTargets }),
      500, 'hook_write_failed',
    )
    assert.equal(error.plane, 'local')
    assert.ok(error.backup, '结构化错误仍要带备份目录')
    assert.ok(!error.message.includes('.rtk-'), `不得泄漏临时文件路径: ${error.message}`)
    assert.ok(!error.message.includes(workspace), `不得泄漏服务端路径: ${error.message}`)
  } finally {
    fs.chmodSync(dir, 0o700)
  }
})

test('缺陷 4：备份按 RTK_BACKUP_KEEP 轮转，toggle 响应不回传备份历史', async () => {
  const home = tempHome('defect4')
  const keepRoot = path.join(workspace, 'backups-keep3')
  process.env.RTK_BACKUP_KEEP = '3'
  // 轮转受保护窗口约束；这里显式设 0 才是在验证「窗口之外按 N 保留」的语义
  process.env.RTK_BACKUP_GRACE_MS = '0'
  process.env.RTK_BACKUP_DIR = keepRoot
  try {
    let last: Awaited<ReturnType<typeof service.setRTKAgentHook>> | null = null
    for (let i = 0; i < 5; i += 1) {
      last = await service.setRTKAgentHook('codex', i % 2 === 0, { plane: 'local', home, bin: missingBinary, ...offlineTargets })
    }
    const ids = fs.readdirSync(keepRoot).filter(name => fs.existsSync(path.join(keepRoot, name, 'manifest.json')))
    assert.equal(ids.length, 3, `保留策略应只留 3 份，实际 ${ids.length}`)
    assert.ok(last)
    assert.ok(!('backups' in (last as object)), 'toggle 响应不得回传备份历史列表')
    assert.ok(last?.backupId && typeof last?.backupFileCount === 'number', 'toggle 只回传本次备份摘要')

    const status = await service.readRTKStatus({ home, fresh: true, ...offlineTargets })
    assert.equal(status.backupKeep, 3)
    assert.ok(status.backups.length <= 3)
    for (const item of status.backups) {
      assert.equal(typeof item.fileCount, 'number')
      assert.ok(!('files' in item), '备份摘要不得带完整文件清单')
    }
  } finally {
    delete process.env.RTK_BACKUP_KEEP
    delete process.env.RTK_BACKUP_GRACE_MS
    process.env.RTK_BACKUP_DIR = path.join(workspace, 'backups')
  }
})

test('T7 关闭时只移除 rtk 自己那一条，第三方 hook 全部保留', async () => {
  const home = tempHome('third-party')
  const filePath = path.join(home, HOOK_FILES.codex)
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, `${JSON.stringify({
    hooks: {
      PreToolUse: [
        { matcher: 'Bash', hooks: [{ type: 'command', command: 'orca-hook' }] },
        { matcher: 'Bash', hooks: [{ type: 'command', command: 'clawd-hook' }] },
        { matcher: 'Bash', hooks: [{ type: 'command', command: 'datetime-hook' }] },
      ],
    },
  }, null, 2)}\n`)

  const on = await service.setRTKAgentHook('codex', true, { plane: 'local', home, bin: missingBinary, ...offlineTargets })
  const afterOn = readJson(filePath) as { hooks: { PreToolUse: Array<{ hooks: Array<{ command: string }> }> } }
  assert.equal(afterOn.hooks.PreToolUse.length, 4, 'ON 之后第三方 3 条 + rtk 1 条')
  assert.equal(on.localAgents.find(agent => agent.id === 'codex')?.on, true)

  const off = await service.setRTKAgentHook('codex', false, { plane: 'local', home, bin: missingBinary, ...offlineTargets })
  const afterOff = readJson(filePath) as { hooks: { PreToolUse: Array<{ hooks: Array<{ command: string }> }> } }
  assert.equal(afterOff.hooks.PreToolUse.length, 3, 'OFF 之后只剩第三方 3 条（回归旧实现 3→1 的破坏）')
  assert.deepEqual(
    afterOff.hooks.PreToolUse.map(item => item.hooks[0].command).sort(),
    ['clawd-hook', 'datetime-hook', 'orca-hook'],
  )
  assert.equal(off.localAgents.find(agent => agent.id === 'codex')?.on, false)
})

test('T4/T6 并发与幂等：连续/并发 ON 之后 rtk 条目只有一条，第三方数量不变', async () => {
  const home = tempHome('concurrency')
  const filePath = path.join(home, HOOK_FILES.claude)
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, `${JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'orca-hook' }] }] } }, null, 2)}\n`)

  await Promise.all([
    service.setRTKAgentHook('claude', true, { plane: 'local', home, bin: missingBinary, ...offlineTargets }),
    service.setRTKAgentHook('claude', true, { plane: 'local', home, bin: missingBinary, ...offlineTargets }),
  ])
  const once = fs.readFileSync(filePath, 'utf8')
  const parsedOnce = JSON.parse(once) as { hooks: { PreToolUse: Array<{ hooks: Array<{ command: string }> }> } }
  assert.equal(parsedOnce.hooks.PreToolUse.length, 2)
  assert.equal(parsedOnce.hooks.PreToolUse.filter(item => item.hooks.some(hook => hook.command === 'rtk hook claude')).length, 1)
  assert.equal(parsedOnce.hooks.PreToolUse.filter(item => item.hooks.some(hook => hook.command === 'orca-hook')).length, 1)

  await service.setRTKAgentHook('claude', true, { plane: 'local', home, bin: missingBinary, ...offlineTargets })
  assert.equal(fs.readFileSync(filePath, 'utf8'), once, '连续两次 ON 必须字节级一致')
})

test('已验证 schema 兜底：rtk CLI 不可用时六个 hook agent 形状仍与实测一致', async () => {
  for (const id of Object.keys(VERIFIED_HOOKS)) {
    const home = tempHome(`json-${id}`)
    const result = await service.setRTKAgentHook(id, true, { plane: 'local', home, bin: missingBinary, ...offlineTargets })
    assert.equal(result.mechanism, 'hooks-json', `${id} 应走 JSON 兜底`)
    assert.ok(result.fallbackReason, '兜底必须记录 CLI 失败原因，禁止空 catch')
    assert.deepEqual(readJson(path.join(home, HOOK_FILES[id])), VERIFIED_HOOKS[id], `${id} 形状与 rtk 0.50.0 实测不一致`)
    assert.equal(result.localAgents.find(agent => agent.id === id)?.on, true)
  }
})

test('T9 坏 JSON 不覆盖：返回 409、原文件字节不变、备份存在', async () => {
  const home = tempHome('bad-json')
  const filePath = path.join(home, HOOK_FILES.codex)
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  const broken = '{ this is not json'
  fs.writeFileSync(filePath, broken)
  const error = await expectPlaneError(
    () => service.setRTKAgentHook('codex', true, { plane: 'local', home, bin: missingBinary, ...offlineTargets }),
    409, 'hook_file_unparsable',
  )
  assert.equal(fs.readFileSync(filePath, 'utf8'), broken, '解析失败时必须原样保留用户文件')
  assert.ok(error.backup && fs.existsSync(path.join(error.backup, 'manifest.json')), '失败也要留下备份')
})

test('T8 关得掉：CLI ON 之后走控制台 OFF，条目移除且状态回到 on=false', { skip: !rtkBinary }, async () => {
  const home = tempHome('t8-off')
  const on = await service.setRTKAgentHook('codex', true, { plane: 'local', home, bin: rtkBinary, ...offlineTargets })
  assert.equal(on.localAgents.find(agent => agent.id === 'codex')?.on, true)
  const off = await service.setRTKAgentHook('codex', false, { plane: 'local', home, bin: rtkBinary, ...offlineTargets })
  assert.equal(off.localAgents.find(agent => agent.id === 'codex')?.on, false, '旧实现这里永远 true')
  const written = readJson(path.join(home, HOOK_FILES.codex)) as { hooks: { PreToolUse: unknown[] } }
  assert.deepEqual(written.hooks.PreToolUse, [])
})

test('一键回退：从备份原地恢复 agent 配置', async () => {
  const home = tempHome('rollback')
  const filePath = path.join(home, HOOK_FILES.codex)
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  const original = `${JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'orca-hook' }] }] } }, null, 2)}\n`
  fs.writeFileSync(filePath, original)

  const on = await service.setRTKAgentHook('codex', true, { plane: 'local', home, bin: missingBinary, ...offlineTargets })
  assert.notEqual(fs.readFileSync(filePath, 'utf8'), original)
  assert.ok(on.backup)

  await expectPlaneError(() => service.rollbackRTK({ home }), 403, 'confirmation_required')
  const restored = await service.rollbackRTK({ home, confirm: true })
  assert.equal(restored.ok, true)
  assert.equal(restored.backupId, on.backup?.split('/').pop())
  assert.ok(restored.restored.includes(HOOK_FILES.codex))
  assert.equal(fs.readFileSync(filePath, 'utf8'), original, '回退后必须与写入前逐字节一致')
  assert.equal(restored.localAgents.find(agent => agent.id === 'codex')?.on, false)
})

test('T11 字段一致性：getRTKStats 与 rtk gain --daily --format json 逐项相等', { skip: !rtkBinary }, async () => {
  const home = tempHome('gain')
  const raw = JSON.parse(execFileSync(rtkBinary as string, ['gain', '--daily', '--format', 'json'], {
    env: { ...process.env, HOME: home }, encoding: 'utf8', timeout: 10_000,
  })) as { summary: Record<string, number>; daily: Array<Record<string, number | string>> }
  const stats = await service.getRTKStats(rtkBinary as string, home)
  assert.ok(stats.gain)
  assert.equal(stats.gain!.commands, Number(raw.summary.total_commands) || 0)
  assert.equal(stats.gain!.input, Number(raw.summary.total_input) || 0)
  assert.equal(stats.gain!.saved, Number(raw.summary.total_saved) || 0)
  assert.equal(stats.gain!.pct, Number(raw.summary.avg_savings_pct) || 0)
  assert.deepEqual(stats.days, raw.daily.map(day => ({
    date: String(day.date), commands: Number(day.commands) || 0,
    input: Number(day.input_tokens) || 0, saved: Number(day.saved_tokens) || 0, pct: Number(day.savings_pct) || 0,
  })).sort((a, b) => a.date.localeCompare(b.date)))
})

test('本机检测：覆盖 rtk init 支持的全部 agent，项目级 agent 标 supported=false', () => {
  const agents = service.detectAgentHooks(tempHome('detect'))
  assert.equal(agents.length, plane.RTK_AGENT_SPECS.length)
  assert.equal(agents.filter(agent => agent.supported).length, 11)
  assert.deepEqual(
    agents.filter(agent => !agent.supported).map(agent => agent.id).sort(),
    ['antigravity', 'cline', 'kilocode', 'kimi', 'windsurf'],
  )
  for (const agent of agents) {
    assert.equal(typeof agent.on, 'boolean')
    assert.equal(agent.plane, 'local')
  }
})

test('本机检测：注册表覆盖 `rtk init --help` 列出的每个 agent', { skip: !rtkBinary }, async () => {
  const { stdout } = await execFileAsync(rtkBinary as string, ['init', '--help'], { timeout: 10_000 })
  const fromAgentFlag = [...stdout.matchAll(/^\s+- ([a-z]+):\s/gm)].map(match => match[1])
  assert.ok(fromAgentFlag.length >= 13, `未能从 --help 解析 agent 列表: ${stdout.slice(0, 200)}`)
  const known = new Set(plane.RTK_AGENT_SPECS.map(spec => spec.id))
  for (const id of [...fromAgentFlag, 'codex', 'gemini', 'copilot']) {
    assert.ok(known.has(id), `rtk 支持但控制台注册表缺少 agent: ${id}`)
  }
  // codex / gemini / copilot 是独立 flag，不属于 --agent 取值，注册表必须单独记住它们。
  assert.deepEqual(
    plane.RTK_AGENT_SPECS.filter(spec => spec.initFlags && !spec.initFlags.includes('--agent')).map(spec => spec.id).sort(),
    ['codex', 'copilot', 'gemini'],
  )
})

test('检测不看说明文件：只有 RTK.md/AGENTS.md 时必须仍是 on=false（否则永远关不掉）', () => {
  const home = tempHome('instructions-only')
  fs.mkdirSync(path.join(home, '.codex'), { recursive: true })
  fs.writeFileSync(path.join(home, '.codex/RTK.md'), '# rtk instructions')
  fs.writeFileSync(path.join(home, '.codex/AGENTS.md'), '@RTK.md\n')
  assert.equal(service.detectAgentHooks(home).find(agent => agent.id === 'codex')?.on, false)
})

test('测试上下文拒绝对真实 home 写入 agent 配置', async () => {
  const spec = plane.rtkAgentSpec('codex')
  assert.ok(spec)
  await expectPlaneError(
    () => service.applyLocalAgentHook(spec!, true, { home: realHome, bin: rtkBinary }),
    500, 'test_context_real_home_refused',
  )
  await expectPlaneError(
    () => service.rollbackRTK({ home: realHome, confirm: true }),
    500, 'test_context_real_home_refused',
  )
  assert.equal(service.resolveHome({ ...process.env }), process.env.RTK_HOME)
})

before(() => {
  assert.equal(process.env.NODE_TEST_CONTEXT !== undefined, true, '测试必须跑在 node --test 里，否则真实 home 闸门不生效')
})

after(async () => {
  for (const [rel, before] of realDigests) {
    assert.equal(digest(path.join(realHome, rel)), before, `真实 agent 配置被测试改动了: ~/${rel}`)
  }
  fs.rmSync(workspace, { recursive: true, force: true })
})


/* ------------------------------------------------------------------ */
/* 红队第三轮：P0/P1/P2                                                */
/* ------------------------------------------------------------------ */

const writeFakeCli = (name: string, body: string): string => {
  const file = path.join(workspace, name)
  fs.writeFileSync(file, `#!/bin/sh\n${body}\n`, { mode: 0o755 })
  return file
}

test('P0-1 轮转不得删掉在飞/刚创建的备份：并发 toggle 后每个 backupId 都还能 rollback', async () => {
  const home = tempHome('p01-concurrent')
  const keepRoot = path.join(workspace, 'backups-p01')
  process.env.RTK_BACKUP_KEEP = '2'
  process.env.RTK_BACKUP_DIR = keepRoot
  try {
    // 只用有已核实 JSON 兜底 schema 的 agent，保证并发用例聚焦「轮转不误删」
    const agents = ['codex', 'claude', 'cursor', 'trae', 'droid', 'copilot']
    const results = await Promise.all(agents.map(agent =>
      service.setRTKAgentHook(agent, true, { plane: 'local', home, bin: missingBinary, ...offlineTargets }),
    ))
    const ids = results.map(result => result.backupId as string)
    assert.equal(new Set(ids).size, ids.length, '每次操作都应拿到独立的 backupId')
    for (const id of ids) {
      const dir = path.join(keepRoot, id)
      assert.ok(fs.existsSync(path.join(dir, 'manifest.json')), `响应里返回过的备份 ${id} 不该被轮转删掉`)
    }
    // 拿响应里的 id 真去 rollback，必须成功（不能 404）
    const restored = await service.rollbackRTK({ home, confirm: true, backup: ids[0], ...offlineTargets })
    assert.equal(restored.backupId, ids[0])
    assert.ok(service.listRtkBackups(home, 20).length >= ids.length)
  } finally {
    delete process.env.RTK_BACKUP_KEEP
    process.env.RTK_BACKUP_DIR = path.join(workspace, 'backups')
  }
})

test('P0-1（次要）孤儿备份目录：过保护窗口后清理，status 期间如实计数', async () => {
  const home = tempHome('p01-orphan')
  const root = path.join(workspace, 'backups-orphan')
  fs.mkdirSync(path.join(root, '2020-01-01T00-00-00-000Z'), { recursive: true })
  const recentId = new Date().toISOString().replace(/[:.]/g, '-')
  fs.mkdirSync(path.join(root, recentId), { recursive: true })
  process.env.RTK_BACKUP_DIR = root
  try {
    // 红队 ⑦ 的复现形状：空目录 zzz-orphan（崩溃/中断残留，改老 mtime 模拟历史遗留）；
    // 另有「不认识的目录」只计数不删
    const old = new Date('2020-01-01T00:00:00Z')
    fs.mkdirSync(path.join(root, 'zzz-orphan'), { recursive: true })
    fs.utimesSync(path.join(root, 'zzz-orphan'), old, old)
    fs.mkdirSync(path.join(root, 'someone-elses-dir'), { recursive: true })
    fs.writeFileSync(path.join(root, 'someone-elses-dir', 'keep.txt'), 'do not delete\n')
    fs.utimesSync(path.join(root, 'someone-elses-dir'), old, old)
    assert.equal(service.countRtkBackupOrphans(home), 3)
    assert.equal(service.countRtkBackupForeign(home), 1)
    const removed = service.pruneRtkBackups(home, 10)
    assert.deepEqual(removed.sort(), ['2020-01-01T00-00-00-000Z', 'zzz-orphan'], '过窗口的孤儿/空目录清理')
    assert.equal(fs.existsSync(path.join(root, 'someone-elses-dir', 'keep.txt')), true, '不认识的目录不能删')
    assert.equal(service.countRtkBackupOrphans(home), 1)
    const status = await service.readRTKStatus({ home, fresh: true, ...offlineTargets })
    assert.equal(status.backupOrphans, 1)
    assert.equal(status.backupForeign, 1)
    assert.ok(status.backupGraceMs > 0)
  } finally {
    process.env.RTK_BACKUP_DIR = path.join(workspace, 'backups')
  }
})

test('P0-2 OFF 与 ON 共用同一套写后校验：假 CLI 写坏文件时两边都 409 并回填', async () => {
  const corrupt = writeFakeCli('fake-rtk-off-corrupt.sh', 'printf \'THIS IS NOT JSON\' > "$HOME/.codex/hooks.json"\nexit 0')
  for (const on of [true, false]) {
    const home = tempHome(`p02-${on ? 'on' : 'off'}`)
    const filePath = path.join(home, '.codex/hooks.json')
    fs.mkdirSync(path.dirname(filePath), { recursive: true })
    const pristine = `${JSON.stringify({
      hooks: { PreToolUse: [
        { matcher: 'Bash', hooks: [{ type: 'command', command: 'orca-hook' }] },
        ...(on ? [] : [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'rtk hook codex' }] }]),
      ] },
    }, null, 2)}\n`
    fs.writeFileSync(filePath, pristine)
    const error = await expectPlaneError(
      () => service.setRTKAgentHook('codex', on, { plane: 'local', home, bin: corrupt, ...offlineTargets }),
      409, 'hook_file_unparsable',
    )
    assert.equal(error.plane, 'local')
    assert.ok(error.backup && fs.existsSync(path.join(error.backup, 'manifest.json')))
    assert.equal(fs.readFileSync(filePath, 'utf8'), pristine, `ON=${on} 时必须回填操作前原文`)
  }
})

test('P1-a CLI 窗口内的第三方改动必须保留（条目级最小差异还原）', async () => {
  // 假 CLI 模拟 rtk 的连带行为：给 .claude 加 rtk 条目，同时「用户」在窗口内也加了别的条目，
  // 并让 cursor 自己的钩子生效（保证目标校验通过）。
  const cli = writeFakeCli('fake-rtk-concurrent.sh', [
    'mkdir -p "$HOME/.claude" "$HOME/.cursor"',
    'printf %s \'{"hooks":{"PreToolUse":[{"matcher":"Bash","hooks":[{"type":"command","command":"rtk hook claude"}]},{"matcher":"Bash","hooks":[{"type":"command","command":"user-added-during-cli"}]}]}}\' > "$HOME/.claude/settings.json"',
    'printf %s \'{"version":1,"hooks":{"preToolUse":[{"command":"rtk hook cursor","matcher":"Shell"}]}}\' > "$HOME/.cursor/hooks.json"',
    'exit 0',
  ].join('\n'))
  const home = tempHome('p1a-concurrent')
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true })
  const before = `${JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'orca-hook' }] }] } }, null, 2)}\n`
  fs.writeFileSync(path.join(home, '.claude/settings.json'), before)

  const result = await service.setRTKAgentHook('cursor', true, { plane: 'local', home, bin: cli, ...offlineTargets })
  assert.equal(result.ok, true)
  const settings = JSON.parse(fs.readFileSync(path.join(home, '.claude/settings.json'), 'utf8')) as {
    hooks: { PreToolUse: Array<{ hooks: Array<{ command: string }> }> }
  }
  const commands = settings.hooks.PreToolUse.flatMap(entry => entry.hooks.map(hook => hook.command)).sort()
  assert.deepEqual(commands, ['orca-hook', 'user-added-during-cli'], '只摘掉 rtk 自己那条，用户窗口内的改动必须保留')
  assert.deepEqual(result.collateralReverted, ['claude'])
  assert.ok(!result.collateralSkipped?.length)
})

test('P1-a 结构无法安全还原时不覆盖，如实上报 collateralSkipped', async () => {
  const cli = writeFakeCli('fake-rtk-unparsable-collateral.sh', [
    'mkdir -p "$HOME/.claude" "$HOME/.cursor"',
    'printf %s \'not json at all\' > "$HOME/.claude/settings.json"',
    'printf %s \'{"version":1,"hooks":{"preToolUse":[{"command":"rtk hook cursor","matcher":"Shell"}]}}\' > "$HOME/.cursor/hooks.json"',
    'exit 0',
  ].join('\n'))
  const home = tempHome('p1a-skip')
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true })
  fs.writeFileSync(path.join(home, '.claude/settings.json'), `${JSON.stringify({ hooks: { PreToolUse: [] } })}\n`)
  const result = await service.setRTKAgentHook('cursor', true, { plane: 'local', home, bin: cli, ...offlineTargets })
  assert.equal(result.ok, true)
  assert.equal(fs.readFileSync(path.join(home, '.claude/settings.json'), 'utf8'), 'not json at all', '无法安全还原时不许覆盖')
  assert.deepEqual(result.collateralSkipped?.map(item => item.agent), ['claude'])
  assert.equal(result.collateral?.find(entry => entry.agent === 'claude')?.action, 'skipped')
})

test('P1-b 目标文件自己的 .bak 纳管：成功后还原用户原件，失败后也回到操作前', async () => {
  const home = tempHome('p1b-bak')
  const codexDir = path.join(home, '.codex')
  const bakPath = path.join(codexDir, 'hooks.json.bak')
  fs.mkdirSync(codexDir, { recursive: true })
  fs.writeFileSync(path.join(codexDir, 'hooks.json'), `${JSON.stringify({ hooks: { PreToolUse: [] } })}\n`)
  fs.writeFileSync(bakPath, 'USER-OWN-BAK\n')

  const cli = writeFakeCli('fake-rtk-bak.sh', [
    'mkdir -p "$HOME/.codex"',
    'printf %s \'CLI-WROTE-BAK\' > "$HOME/.codex/hooks.json.bak"',
    'printf %s \'{"hooks":{"PreToolUse":[{"matcher":"Bash","hooks":[{"type":"command","command":"rtk hook codex"}]}]}}\' > "$HOME/.codex/hooks.json"',
    'exit 0',
  ].join('\n'))
  const ok = await service.setRTKAgentHook('codex', true, { plane: 'local', home, bin: cli, ...offlineTargets })
  assert.equal(ok.ok, true)
  assert.equal(fs.readFileSync(bakPath, 'utf8'), 'USER-OWN-BAK\n', '成功路径也要把用户原有的 .bak 还回去')
  assert.deepEqual(ok.preservedBak, ['.codex/hooks.json.bak'])

  // 失败路径：.bak 也回到操作前
  const corrupt = writeFakeCli('fake-rtk-bak-corrupt.sh', [
    'printf %s \'garbage\' > "$HOME/.codex/hooks.json"',
    'printf %s \'garbage-bak\' > "$HOME/.codex/hooks.json.bak"',
    'exit 0',
  ].join('\n'))
  const home2 = tempHome('p1b-bak-fail')
  fs.mkdirSync(path.join(home2, '.codex'), { recursive: true })
  fs.writeFileSync(path.join(home2, '.codex/hooks.json'), `${JSON.stringify({ hooks: { PreToolUse: [] } })}\n`)
  fs.writeFileSync(path.join(home2, '.codex/hooks.json.bak'), 'USER-OWN-BAK-2\n')
  await expectPlaneError(
    () => service.setRTKAgentHook('codex', true, { plane: 'local', home: home2, bin: corrupt, ...offlineTargets }),
    409, 'hook_file_unparsable',
  )
  assert.equal(fs.readFileSync(path.join(home2, '.codex/hooks.json.bak'), 'utf8'), 'USER-OWN-BAK-2\n')
})

test('P2 同一 agent 不会同时出现在 reverted 与 restored，collateral 每个 agent 只有一条', async () => {
  // 假 CLI：既删掉 claude 已有的 rtk 条目（restored 方向），又新建 .claude/RTK.md（reverted 方向）
  const cli = writeFakeCli('fake-rtk-both-directions.sh', [
    'mkdir -p "$HOME/.claude" "$HOME/.cursor"',
    'printf %s \'{"hooks":{"PreToolUse":[{"matcher":"Bash","hooks":[{"type":"command","command":"orca-hook"}]}]}}\' > "$HOME/.claude/settings.json"',
    'printf %s \'# rtk instructions\' > "$HOME/.claude/RTK.md"',
    'printf %s \'{"version":1,"hooks":{"preToolUse":[{"command":"rtk hook cursor","matcher":"Shell"}]}}\' > "$HOME/.cursor/hooks.json"',
    'exit 0',
  ].join('\n'))
  const home = tempHome('p2-both')
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true })
  fs.writeFileSync(path.join(home, '.claude/settings.json'), `${JSON.stringify({
    hooks: { PreToolUse: [
      { matcher: 'Bash', hooks: [{ type: 'command', command: 'orca-hook' }] },
      { matcher: 'Bash', hooks: [{ type: 'command', command: 'rtk hook claude' }] },
    ] },
  }, null, 2)}\n`)

  const result = await service.setRTKAgentHook('cursor', true, { plane: 'local', home, bin: cli, ...offlineTargets })
  const reverted = result.collateralReverted || []
  const restored = result.collateralRestored || []
  assert.deepEqual(reverted.filter(agent => restored.includes(agent)), [], '两个集合必须互斥')
  const claudeEntries = (result.collateral || []).filter(entry => entry.agent === 'claude')
  assert.equal(claudeEntries.length, 1, '每个 agent 在 collateral 里只有一条')
  assert.equal(claudeEntries[0].action, 'restored', '确定性最终态取 restored')
  assert.ok(restored.includes('claude'))
  assert.ok(!reverted.includes('claude'))
  // claude 的 rtk 条目被修回、RTK.md 被撤回
  const settings = fs.readFileSync(path.join(home, '.claude/settings.json'), 'utf8')
  assert.match(settings, /rtk hook claude/)
  assert.equal(fs.existsSync(path.join(home, '.claude/RTK.md')), false)
})

test('红队 ⑥ 宽并发下 rtk CLI 不再互相干扰：6 个 agent × 2 次并发 ON 全部成功', { skip: !rtkBinary }, async () => {
  const home = tempHome('r3-wide-concurrency')
  const agents = ['codex', 'claude', 'cursor', 'gemini', 'copilot', 'pi']
  const requests = [...agents, ...agents].map(agent =>
    service.setRTKAgentHook(agent, true, { plane: 'local', home, bin: rtkBinary, ...offlineTargets }),
  )
  const results = await Promise.allSettled(requests)
  const failures = results
    .map((result, index) => ({ result, agent: [...agents, ...agents][index] }))
    .filter(item => item.result.status === 'rejected')
    .map(item => `${item.agent}: ${String((item.result as PromiseRejectedResult).reason).slice(0, 120)}`)
  assert.deepEqual(failures, [], `宽并发下不应有 502：${failures.join(' | ')}`)
  for (const agent of agents) {
    const status = await service.readRTKStatus({ home, fresh: true, ...offlineTargets })
    assert.equal(status.localAgents.find(item => item.id === agent)?.on, true, `${agent} 应已挂载`)
  }
})

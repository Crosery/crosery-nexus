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

type PlaneFailure = Error & { status: number; reason: string; backup?: string }

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

test('rtk 的真实耦合：cursor 目标会同时注册 Claude 钩子（UI 需如实展示，不能藏）', { skip: !rtkBinary }, async () => {
  const home = tempHome('cursor-claude-coupling')
  const on = await service.setRTKAgentHook('cursor', true, { plane: 'local', home, bin: rtkBinary, ...offlineTargets })
  const claude = on.localAgents.find(agent => agent.id === 'claude')
  const cursor = on.localAgents.find(agent => agent.id === 'cursor')
  assert.equal(cursor?.on, true, 'cursor 自己的钩子应已注册')
  assert.equal(claude?.on, true, '实测 rtk init -g --agent cursor 会连带写 .claude/settings.json')
  assert.match(fs.readFileSync(path.join(home, '.claude/settings.json'), 'utf8'), /rtk hook claude/)
  assert.match(fs.readFileSync(path.join(home, '.cursor/hooks.json'), 'utf8'), /rtk hook cursor/)

  // 关掉 claude 时 rtk CLI 会连带删掉 .cursor/hooks.json，控制台必须修回来（只关用户点的那个）
  const off = await service.setRTKAgentHook('claude', false, { plane: 'local', home, bin: rtkBinary, ...offlineTargets })
  assert.equal(off.localAgents.find(agent => agent.id === 'claude')?.on, false)
  assert.equal(off.localAgents.find(agent => agent.id === 'cursor')?.on, true, '连带删掉的 cursor 钩子必须从备份修复')
  assert.deepEqual(off.collateralRestored, ['cursor'])
  assert.match(fs.readFileSync(path.join(home, '.cursor/hooks.json'), 'utf8'), /rtk hook cursor/)
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

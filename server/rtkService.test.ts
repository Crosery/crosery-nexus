import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFile, execFileSync, spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import test, { after, before } from 'node:test'

/**
 * RTK 控制面测试（含红队 task-1 反例清单 T1-T13 的可自动化部分）。
 *
 * 纪律（COORDINATION.md）：
 * - 绝不读写真实 ~/.codex、~/.claude 等 agent 配置：写入的 HOME 全是 mkdtemp 出来的；
 * - 文件末尾用 sha256 断言真实 agent 配置在整轮测试前后逐字节不变（T5）；
 * - rtkService 在 NODE_TEST_CONTEXT 下对真实 home 有硬闸门（专门用例覆盖）。
 */

// 必须在动态 import 服务模块之前清干净，避免环境里的真实配置被带进测试。
delete process.env.RTK_BIN
delete process.env.RTK_WRITE_MODE
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
const missingBinary = path.join(workspace, 'no-such-rtk')
const tempHome = (name: string): string => {
  const dir = path.join(workspace, `home-${name}`)
  fs.mkdirSync(dir, { recursive: true })
  return dir
}
const readJson = (filePath: string): Record<string, unknown> => JSON.parse(fs.readFileSync(filePath, 'utf8'))

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
/* 1. 平面                                                             */
/* ------------------------------------------------------------------ */

test('T1 只有本机平面：rtk 装没装只影响 state/reason，平面始终可用且不报回退', () => {
  const found = plane.resolveRtkPlane({ localBinFound: true })
  assert.equal(found.plane, 'local')
  assert.equal(found.fellBack, false)
  assert.deepEqual(found.planes.map(item => [item.id, item.available, item.configured, item.state, item.reason]), [['local', true, true, 'available', 'local_host']])

  const missing = plane.resolveRtkPlane({ localBinFound: false })
  assert.deepEqual(missing.planes.map(item => [item.id, item.available, item.state, item.reason]), [['local', true, 'degraded', 'local_rtk_missing']])
})

test('T1/T2 readRTKStatus：plane=local，数据与开关都来自本机', async () => {
  const status = await service.readRTKStatus({ home: tempHome('t1-local'), fresh: true })
  assert.equal(status.plane, 'local')
  assert.deepEqual(status.planes.map(item => item.id), ['local'])
  assert.equal(status.local.connected, Boolean(rtkBinary))
  assert.equal(status.connected, status.local.connected)
  assert.equal(status.localAgents.length, plane.RTK_AGENT_SPECS.length)
  assert.deepEqual(status.agents, status.localAgents)
  assert.ok(status.localAgents.every(agent => agent.plane === 'local'))
})

/* ------------------------------------------------------------------ */
/* 2. 写入闸门与「平面不支持」                                         */
/* ------------------------------------------------------------------ */

test('T3 rtk 未安装时拒绝写入并给安装指引，绝不返回成功', async () => {
  process.env.RTK_BIN = missingBinary
  try {
    assert.equal(service.findRTKBinary(), null, 'RTK_BIN 显式指向不存在的路径时必须返回 null，不得回落到别的候选')
    const error = await expectPlaneError(
      () => service.setRTKAgentHook('codex', true, { plane: 'local', home: tempHome('t3') }),
      503, 'rtk_binary_missing',
    )
    assert.match(error.message, /install\.sh/)
    const status = await service.readRTKStatus({ home: tempHome('t3'), fresh: true })
    assert.equal(status.connected, false)
    assert.equal(status.install?.includes('install.sh'), true)
  } finally {
    delete process.env.RTK_BIN
  }
})

test('install/upgrade：本机不代装返回 501，不静默成功；未知平面 400', async () => {
  await expectPlaneError(() => service.installRTK(), 501, 'local_install_not_supported')
  await expectPlaneError(() => service.installRTK({ plane: 'local' }), 501, 'local_install_not_supported')
  await expectPlaneError(() => service.upgradeRTK({ plane: 'local' }), 501, 'local_upgrade_not_supported')
  await expectPlaneError(() => service.installRTK({ plane: 'kernel' as 'local' }), 400, 'unknown_plane')
  await expectPlaneError(() => service.upgradeRTK({ plane: 'relay' as 'local' }), 400, 'unknown_plane')
})

test('toggle：项目级 agent 与未知 agent 明确拒绝', async () => {
  const home = tempHome('toggle-unsupported')
  await expectPlaneError(
    () => service.setRTKAgentHook('windsurf', true, { plane: 'local', home, bin: rtkBinary }),
    501, 'project_scoped_only',
  )
  await expectPlaneError(
    () => service.setRTKAgentHook('ghost', true, { plane: 'local', home, bin: rtkBinary }),
    404, 'unknown_agent',
  )
  await expectPlaneError(
    () => service.setRTKAgentHook('codex', true, { plane: 'nope' as 'local', home, bin: rtkBinary }),
    400, 'unknown_plane',
  )
})

test('本机写入闸门：RTK_WRITE_MODE=off 全只读，=confirm 需显式确认', async () => {
  const home = tempHome('write-mode')
  process.env.RTK_WRITE_MODE = 'off'
  try {
    await expectPlaneError(
      () => service.setRTKAgentHook('codex', true, { plane: 'local', home, bin: rtkBinary }),
      403, 'write_disabled',
    )
  } finally {
    delete process.env.RTK_WRITE_MODE
  }
  process.env.RTK_WRITE_MODE = 'confirm'
  try {
    await expectPlaneError(
      () => service.setRTKAgentHook('codex', true, { plane: 'local', home, bin: rtkBinary }),
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
  const result = await service.setRTKAgentHook('codex', true, { plane: 'local', home, bin: rtkBinary })
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
    const on = await service.setRTKAgentHook(id, true, { plane: 'local', home, bin: rtkBinary })
    assert.equal(on.mechanism, 'rtk-cli', `${id} ON 应走官方 CLI`)
    assert.equal(on.cli?.exitCode, 0, `${id} ON 退出码应为 0，实际 ${on.cli?.exitCode} (${on.cli?.stderr})`)
    assert.equal(on.cli?.stderr, '', `${id} ON stderr 应为空`)
    assert.equal(on.localAgents.find(agent => agent.id === id)?.on, true, `${id} ON 后应为已挂载`)

    const off = await service.setRTKAgentHook(id, false, { plane: 'local', home, bin: rtkBinary })
    assert.equal(off.mechanism, 'rtk-cli')
    assert.equal(off.cli?.exitCode, 0, `${id} OFF 退出码应为 0，实际 ${off.cli?.exitCode} (${off.cli?.stderr})`)
    assert.equal(off.cli?.stderr, '', `${id} OFF stderr 应为空`)
    assert.equal(off.localAgents.find(agent => agent.id === id)?.on, false, `${id} OFF 后应为未挂载`)
  }
})

test('缺陷 1：cursor ON 连带打开的 Claude 配置必须按快照撤回，并如实回传', { skip: !rtkBinary }, async () => {
  const home = tempHome('cursor-claude-coupling')
  const on = await service.setRTKAgentHook('cursor', true, { plane: 'local', home, bin: rtkBinary })
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
  const off = await service.setRTKAgentHook('cursor', false, { plane: 'local', home, bin: rtkBinary })
  assert.equal(off.localAgents.find(agent => agent.id === 'cursor')?.on, false)
  assert.equal(off.localAgents.find(agent => agent.id === 'claude')?.on, false)
  assert.equal(fs.existsSync(path.join(home, '.claude/RTK.md')), false)
  assert.equal(fs.existsSync(path.join(home, '.claude/CLAUDE.md')), false)
})

test('缺陷 1（反向，不许改坏）：claude OFF 连带删掉的 cursor 钩子仍要修回', { skip: !rtkBinary }, async () => {
  const home = tempHome('claude-off-collateral')
  await service.setRTKAgentHook('cursor', true, { plane: 'local', home, bin: rtkBinary })
  const claudeOn = await service.setRTKAgentHook('claude', true, { plane: 'local', home, bin: rtkBinary })
  assert.equal(claudeOn.localAgents.find(agent => agent.id === 'claude')?.on, true)
  const off = await service.setRTKAgentHook('claude', false, { plane: 'local', home, bin: rtkBinary })
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
  await service.setRTKAgentHook('cursor', true, { plane: 'local', home, bin: rtkBinary })
  assert.equal(fs.readFileSync(settingsPath, 'utf8'), original, 'claude 已开启时 cursor ON 不得改动该文件')
})

test('缺陷 2：rtk 未安装时 local 平面不再谎报「已安装」', async () => {
  process.env.RTK_BIN = missingBinary
  try {
    const status = await service.readRTKStatus({ home: tempHome('defect2'), fresh: true })
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
    () => service.setRTKAgentHook('codex', true, { plane: 'local', home, bin: fakeBin }),
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
      () => service.setRTKAgentHook('codex', true, { plane: 'local', home, bin: missingBinary }),
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
      last = await service.setRTKAgentHook('codex', i % 2 === 0, { plane: 'local', home, bin: missingBinary })
    }
    const ids = fs.readdirSync(keepRoot).filter(name => fs.existsSync(path.join(keepRoot, name, 'manifest.json')))
    assert.equal(ids.length, 3, `保留策略应只留 3 份，实际 ${ids.length}`)
    assert.ok(last)
    assert.ok(!('backups' in (last as object)), 'toggle 响应不得回传备份历史列表')
    assert.ok(last?.backupId && typeof last?.backupFileCount === 'number', 'toggle 只回传本次备份摘要')

    const status = await service.readRTKStatus({ home, fresh: true })
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

  const on = await service.setRTKAgentHook('codex', true, { plane: 'local', home, bin: missingBinary })
  const afterOn = readJson(filePath) as { hooks: { PreToolUse: Array<{ hooks: Array<{ command: string }> }> } }
  assert.equal(afterOn.hooks.PreToolUse.length, 4, 'ON 之后第三方 3 条 + rtk 1 条')
  assert.equal(on.localAgents.find(agent => agent.id === 'codex')?.on, true)

  const off = await service.setRTKAgentHook('codex', false, { plane: 'local', home, bin: missingBinary })
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
    service.setRTKAgentHook('claude', true, { plane: 'local', home, bin: missingBinary }),
    service.setRTKAgentHook('claude', true, { plane: 'local', home, bin: missingBinary }),
  ])
  const once = fs.readFileSync(filePath, 'utf8')
  const parsedOnce = JSON.parse(once) as { hooks: { PreToolUse: Array<{ hooks: Array<{ command: string }> }> } }
  assert.equal(parsedOnce.hooks.PreToolUse.length, 2)
  assert.equal(parsedOnce.hooks.PreToolUse.filter(item => item.hooks.some(hook => hook.command === 'rtk hook claude')).length, 1)
  assert.equal(parsedOnce.hooks.PreToolUse.filter(item => item.hooks.some(hook => hook.command === 'orca-hook')).length, 1)

  await service.setRTKAgentHook('claude', true, { plane: 'local', home, bin: missingBinary })
  assert.equal(fs.readFileSync(filePath, 'utf8'), once, '连续两次 ON 必须字节级一致')
})

test('已验证 schema 兜底：rtk CLI 不可用时六个 hook agent 形状仍与实测一致', async () => {
  for (const id of Object.keys(VERIFIED_HOOKS)) {
    const home = tempHome(`json-${id}`)
    const result = await service.setRTKAgentHook(id, true, { plane: 'local', home, bin: missingBinary })
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
    () => service.setRTKAgentHook('codex', true, { plane: 'local', home, bin: missingBinary }),
    409, 'hook_file_unparsable',
  )
  assert.equal(fs.readFileSync(filePath, 'utf8'), broken, '解析失败时必须原样保留用户文件')
  assert.ok(error.backup && fs.existsSync(path.join(error.backup, 'manifest.json')), '失败也要留下备份')
})

test('T8 关得掉：CLI ON 之后走控制台 OFF，条目移除且状态回到 on=false', { skip: !rtkBinary }, async () => {
  const home = tempHome('t8-off')
  const on = await service.setRTKAgentHook('codex', true, { plane: 'local', home, bin: rtkBinary })
  assert.equal(on.localAgents.find(agent => agent.id === 'codex')?.on, true)
  const off = await service.setRTKAgentHook('codex', false, { plane: 'local', home, bin: rtkBinary })
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

  const on = await service.setRTKAgentHook('codex', true, { plane: 'local', home, bin: missingBinary })
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
      service.setRTKAgentHook(agent, true, { plane: 'local', home, bin: missingBinary }),
    ))
    const ids = results.map(result => result.backupId as string)
    assert.equal(new Set(ids).size, ids.length, '每次操作都应拿到独立的 backupId')
    for (const id of ids) {
      const dir = path.join(keepRoot, id)
      assert.ok(fs.existsSync(path.join(dir, 'manifest.json')), `响应里返回过的备份 ${id} 不该被轮转删掉`)
    }
    // 拿响应里的 id 真去 rollback，必须成功（不能 404）
    const restored = await service.rollbackRTK({ home, confirm: true, backup: ids[0] })
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
    const status = await service.readRTKStatus({ home, fresh: true })
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
      () => service.setRTKAgentHook('codex', on, { plane: 'local', home, bin: corrupt }),
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

  const result = await service.setRTKAgentHook('cursor', true, { plane: 'local', home, bin: cli })
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
  const result = await service.setRTKAgentHook('cursor', true, { plane: 'local', home, bin: cli })
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
  const ok = await service.setRTKAgentHook('codex', true, { plane: 'local', home, bin: cli })
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
    () => service.setRTKAgentHook('codex', true, { plane: 'local', home: home2, bin: corrupt }),
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

  const result = await service.setRTKAgentHook('cursor', true, { plane: 'local', home, bin: cli })
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
    service.setRTKAgentHook(agent, true, { plane: 'local', home, bin: rtkBinary }),
  )
  const results = await Promise.allSettled(requests)
  const failures = results
    .map((result, index) => ({ result, agent: [...agents, ...agents][index] }))
    .filter(item => item.result.status === 'rejected')
    .map(item => `${item.agent}: ${String((item.result as PromiseRejectedResult).reason).slice(0, 120)}`)
  assert.deepEqual(failures, [], `宽并发下不应有 502：${failures.join(' | ')}`)
  for (const agent of agents) {
    const status = await service.readRTKStatus({ home, fresh: true })
    assert.equal(status.localAgents.find(item => item.id === agent)?.on, true, `${agent} 应已挂载`)
  }
})


/* ------------------------------------------------------------------ */
/* 跨进程写入锁（task-30）                                             */
/* ------------------------------------------------------------------ */

const lockPathFor = (backupDir: string) => path.join(path.dirname(backupDir), 'rtk-write.lock')

test('锁：基本获取/释放，内容可诊断，释放后无残留', async () => {
  const home = tempHome('lock-basic')
  const backupDir = path.join(workspace, 'lock-basic-backups')
  fs.mkdirSync(backupDir, { recursive: true })
  const lock = await service.acquireRtkFileLock({ home, purpose: 'unit-test', env: { ...process.env, RTK_BACKUP_DIR: backupDir } })
  const lockPath = service.rtkLockPath(home, { ...process.env, RTK_BACKUP_DIR: backupDir } as NodeJS.ProcessEnv)
  assert.equal(lockPath, lockPathFor(backupDir))
  assert.ok(fs.existsSync(lockPath))
  const payload = JSON.parse(fs.readFileSync(lockPath, 'utf8'))
  assert.equal(payload.pid, process.pid)
  assert.equal(payload.purpose, 'unit-test')
  assert.ok(typeof payload.at === 'string')
  assert.ok(lock.info.waitedMs >= 0)
  assert.equal(lock.info.stolen, false)
  lock.release()
  assert.equal(fs.existsSync(lockPath), false, '释放后不能留锁文件')
})

test('锁：持锁进程已死 → 接管并如实上报 stolenFromPid', async () => {
  const home = tempHome('lock-dead-holder')
  const backupDir = path.join(workspace, 'lock-dead-backups')
  fs.mkdirSync(backupDir, { recursive: true })
  const env = { ...process.env, RTK_BACKUP_DIR: backupDir }
  const { execFileSync } = await import('node:child_process')
  // 拿一个「确定已经退出」的 pid
  const deadPid = Number(execFileSync(process.execPath, ['-e', 'console.log(process.pid)'], { encoding: 'utf8' }).trim())
  const lockPath = service.rtkLockPath(home, env as NodeJS.ProcessEnv)
  fs.mkdirSync(path.dirname(lockPath), { recursive: true })
  fs.writeFileSync(lockPath, JSON.stringify({ token: 'dead-token', pid: deadPid, at: new Date().toISOString(), purpose: 'crash-sim', home }))
  assert.equal(service.inspectRtkLock(lockPath).stale, true)

  const lock = await service.acquireRtkFileLock({ home, purpose: 'takeover', env })
  assert.equal(lock.info.stolen, true, '必须接管陈旧锁')
  assert.equal(lock.info.stolenFromPid, deadPid)
  lock.release()
  assert.equal(fs.existsSync(lockPath), false)
})

test('锁：持锁进程还活着但超时 → 也算陈旧并可接管', async () => {
  const home = tempHome('lock-timeout-holder')
  const backupDir = path.join(workspace, 'lock-timeout-backups')
  fs.mkdirSync(backupDir, { recursive: true })
  const env = { ...process.env, RTK_BACKUP_DIR: backupDir }
  const lockPath = service.rtkLockPath(home, env as NodeJS.ProcessEnv)
  fs.mkdirSync(path.dirname(lockPath), { recursive: true })
  // 「卡死的持有者」= 活着的 pid + at 与 mtime **一致地**过期（R9-C 之后：只改 mtime 不再算陈旧）
  const old = new Date(Date.now() - 10 * 60_000)
  fs.writeFileSync(lockPath, JSON.stringify({ token: 'hung-token', pid: process.pid, at: old.toISOString(), purpose: 'hung', home }))
  fs.utimesSync(lockPath, old, old)
  const state = service.inspectRtkLock(lockPath, Date.now(), 1000)
  assert.equal(state.stale, true)
  assert.equal(state.reason, 'holder_timeout')
  const lock = await service.acquireRtkFileLock({ home, purpose: 'takeover-timeout', env, staleMs: 1000 })
  assert.equal(lock.info.stolen, true)
  assert.ok((lock.info.stolenFromAgeMs ?? 0) > 1000)
  lock.release()
})

test('锁：等待超时 → 503 rtk_lock_timeout，且不删别人的锁', async () => {
  const home = tempHome('lock-wait-timeout')
  const backupDir = path.join(workspace, 'lock-wait-backups')
  fs.mkdirSync(backupDir, { recursive: true })
  const env = { ...process.env, RTK_BACKUP_DIR: backupDir }
  const lockPath = service.rtkLockPath(home, env as NodeJS.ProcessEnv)
  fs.mkdirSync(path.dirname(lockPath), { recursive: true })
  const held = JSON.stringify({ token: 'other-process', pid: process.pid, at: new Date().toISOString(), purpose: 'held', home })
  fs.writeFileSync(lockPath, held)
  await expectPlaneError(
    () => service.acquireRtkFileLock({ home, purpose: 'should-timeout', env, timeoutMs: 250, staleMs: 60_000 }),
    503, 'rtk_lock_timeout',
  )
  assert.equal(fs.readFileSync(lockPath, 'utf8'), held, '超时不得删除别人持有的锁')
  fs.rmSync(lockPath)
})

test('锁：释放时锁已被接管 → 不删别人的锁并上报 lost', async () => {
  const home = tempHome('lock-lost')
  const backupDir = path.join(workspace, 'lock-lost-backups')
  fs.mkdirSync(backupDir, { recursive: true })
  const env = { ...process.env, RTK_BACKUP_DIR: backupDir }
  const lock = await service.acquireRtkFileLock({ home, purpose: 'victim', env })
  const lockPath = service.rtkLockPath(home, env as NodeJS.ProcessEnv)
  const thief = JSON.stringify({ token: 'thief-token', pid: process.pid, at: new Date().toISOString(), purpose: 'thief', home })
  fs.writeFileSync(lockPath, thief)
  lock.release()
  assert.equal(lock.lost, true)
  assert.equal(fs.readFileSync(lockPath, 'utf8'), thief, '失去锁的一方不能删接管者的锁')
  fs.rmSync(lockPath)
})

test('锁：进程被杀留下的残留锁会被下一次写入自动清理，并在响应里如实上报', async () => {
  const home = tempHome('lock-residual')
  const backupDir = path.join(workspace, 'lock-residual-backups')
  fs.mkdirSync(backupDir, { recursive: true })
  process.env.RTK_BACKUP_DIR = backupDir
  try {
    const { execFileSync } = await import('node:child_process')
    const deadPid = Number(execFileSync(process.execPath, ['-e', 'console.log(process.pid)'], { encoding: 'utf8' }).trim())
    const lockPath = service.rtkLockPath(home)
    fs.mkdirSync(path.dirname(lockPath), { recursive: true })
    fs.writeFileSync(lockPath, JSON.stringify({ token: 'killed', pid: deadPid, at: new Date().toISOString(), purpose: 'killed-mid-write', home }))

    const result = await service.setRTKAgentHook('codex', true, { plane: 'local', home, bin: missingBinary })
    assert.equal(result.ok, true)
    assert.equal(result.lockStolen, true, '接管残留锁必须如实上报')
    assert.equal(typeof result.lockWaitMs, 'number')
    assert.equal(fs.existsSync(lockPath), false, '写入结束后不能留锁文件')
  } finally {
    process.env.RTK_BACKUP_DIR = path.join(workspace, 'backups')
  }
})

test('锁：异常路径（409）也必须释放，不留残留锁', async () => {
  const home = tempHome('lock-409')
  const backupDir = path.join(workspace, 'lock-409-backups')
  fs.mkdirSync(backupDir, { recursive: true })
  process.env.RTK_BACKUP_DIR = backupDir
  try {
    const cli = writeFakeCli('fake-rtk-lock-garbage.sh', 'printf \'NOT JSON\' > "$HOME/.codex/hooks.json"')
    const filePath = path.join(home, '.codex/hooks.json')
    fs.mkdirSync(path.dirname(filePath), { recursive: true })
    fs.writeFileSync(filePath, `${JSON.stringify({ hooks: { PreToolUse: [] } })}\n`)
    await expectPlaneError(
      () => service.setRTKAgentHook('codex', true, { plane: 'local', home, bin: cli }),
      409, 'hook_file_unparsable',
    )
    assert.equal(fs.existsSync(service.rtkLockPath(home)), false, '失败路径也要在 finally 释放锁')
  } finally {
    process.env.RTK_BACKUP_DIR = path.join(workspace, 'backups')
  }
})

test('锁：同进程并发不退化（6 个 agent 并发仍全部完成且带 lockWaitMs）', async () => {
  const home = tempHome('lock-same-process')
  const agents = ['codex', 'claude', 'cursor', 'trae', 'droid', 'copilot']
  const started = Date.now()
  const results = await Promise.all(agents.map(agent =>
    service.setRTKAgentHook(agent, true, { plane: 'local', home, bin: missingBinary }),
  ))
  const elapsed = Date.now() - started
  assert.equal(results.length, 6)
  for (const result of results) {
    assert.equal(result.ok, true)
    assert.equal(typeof result.lockWaitMs, 'number')
  }
  assert.ok(elapsed < 20_000, `同进程 6 路并发不应退化：${elapsed}ms`)
})

test('锁：RTK_LOCK_DISABLED=1 时不创建锁文件（仅供「去掉锁」的对照实验）', async () => {
  const home = tempHome('lock-disabled')
  const backupDir = path.join(workspace, 'lock-disabled-backups')
  fs.mkdirSync(backupDir, { recursive: true })
  const env = { ...process.env, RTK_BACKUP_DIR: backupDir, RTK_LOCK_DISABLED: '1' }
  const lock = await service.acquireRtkFileLock({ home, purpose: 'disabled', env })
  assert.equal(fs.existsSync(service.rtkLockPath(home, env as NodeJS.ProcessEnv)), false)
  lock.release()
  assert.equal(lock.lost, false)
})

/* ---- 双实例端到端：同一个 RTK_HOME，跨进程并发 ON/OFF ---- */

const freePort = async (): Promise<number> => {
  const { createServer } = await import('node:net')
  const server = createServer()
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as { port: number }).port
  await new Promise<void>(resolve => server.close(() => resolve()))
  return port
}

type StageInstance = { port: number; stop: () => void }

async function startInstance(options: { dir: string; home: string; backups: string; lockDisabled?: boolean }): Promise<StageInstance> {
  const port = await freePort()
  const child = spawn(process.execPath, ['--import', 'tsx', 'server/index.ts'], {
    cwd: path.resolve(path.dirname(new URL(import.meta.url).pathname), '..'),
    env: {
      ...process.env,
      HOST: '127.0.0.1', PORT: String(port), COOKIE_SECURE: 'false',
      CONSOLE_USERNAME: 'admin', CONSOLE_PASSWORD: 'lock-test-password', SESSION_SECRET: 'lock-test-session-secret',
      DATA_DIR: path.join(options.dir, 'data'), RTK_HOME: options.home, RTK_BACKUP_DIR: options.backups,
      ...(options.lockDisabled ? { RTK_LOCK_DISABLED: '1' } : {}),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let log = ''
  child.stdout.on('data', chunk => { log += chunk })
  child.stderr.on('data', chunk => { log += chunk })
  for (let i = 0; i < 120; i += 1) {
    if (child.exitCode !== null) throw new Error(`实例提前退出：${log.slice(-400)}`)
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/session`)
      if (response.status === 200) break
    } catch {
      // 还没起来
    }
    await new Promise(resolve => setTimeout(resolve, 250))
  }
  const login = await fetch(`http://127.0.0.1:${port}/api/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'lock-test-password' }),
  })
  const cookie = String(login.headers.get('set-cookie') || '').split(';')[0]
  assert.ok(cookie.startsWith('crosery_console_session='), `登录失败：${login.status}`)
  return {
    port,
    stop: () => { child.kill('SIGTERM') },
    ...( { cookie } as object ),
  } as StageInstance & { cookie: string }
}

/**
 * 双实例交叉并发：同一 RTK_HOME、不同 PORT/DATA_DIR。
 * 返回实测结果，供「有锁 / 无锁」两次运行对比。
 */
async function runCrossProcessToggle(options: { lockDisabled?: boolean; rounds?: number }): Promise<{
  statuses: number[]
  finalOn: boolean
  lastIntent: boolean
  backupIdsAlive: boolean
  invalidJsonSamples: number
  residualLock: boolean
  waitMs: number[]
  samples: number
}> {
  const dir = path.join(workspace, `xp-${options.lockDisabled ? 'nolock' : 'lock'}`)
  const home = path.join(dir, 'home')
  const backups = path.join(dir, 'backups')
  for (const sub of ['data', 'home', 'backups']) fs.mkdirSync(path.join(dir, sub), { recursive: true })
  const a = await startInstance({ dir: path.join(dir, 'a'), home, backups, lockDisabled: options.lockDisabled }) as StageInstance & { cookie: string }
  const b = await startInstance({ dir: path.join(dir, 'b'), home, backups, lockDisabled: options.lockDisabled }) as StageInstance & { cookie: string }
  const hookFile = path.join(home, '.codex/hooks.json')
  let invalidJsonSamples = 0
  let samples = 0
  const sampler = setInterval(() => {
    const content = fs.existsSync(hookFile) ? fs.readFileSync(hookFile, 'utf8') : ''
    if (!content.trim()) return
    samples += 1
    try {
      JSON.parse(content)
    } catch {
      invalidJsonSamples += 1
    }
  }, 4)
  const toggle = async (instance: StageInstance & { cookie: string }, on: boolean, index: number) => {
    const response = await fetch(`http://127.0.0.1:${instance.port}/api/rtk/toggle`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: instance.cookie },
      body: JSON.stringify({ agent: 'codex', on, plane: 'local', confirm: true }),
    })
    const body = await response.json().catch(() => ({}))
    return { index, on, status: response.status, body, completedAt: Date.now() }
  }
  const rounds = options.rounds ?? 8
  const requests: Array<Promise<Awaited<ReturnType<typeof toggle>>>> = []
  for (let i = 0; i < rounds; i += 1) {
    requests.push(toggle(i % 2 === 0 ? a : b, i % 4 < 2, i))
    requests.push(toggle(i % 2 === 0 ? b : a, i % 4 >= 2, i + 100))
  }
  let results: Awaited<ReturnType<typeof toggle>>[] = []
  try {
    results = await Promise.all(requests)
  } finally {
    clearInterval(sampler)
    a.stop()
    b.stop()
    // 【前提等待】等两个实例退出后清场稳定（等待本身不产生断言）：
    // 余量 = 数倍于 SIGTERM 处理时间；失败模式是后续断言（最终状态 / 残余锁）失败，而不是随机通过。
    await new Promise(resolve => setTimeout(resolve, 400))
  }
  const ok = results.filter(result => result.status === 200).sort((left, right) => left.completedAt - right.completedAt)
  const last = ok[ok.length - 1]
  const status = await service.readRTKStatus({ home, fresh: true })
  const finalOn = Boolean(status.localAgents.find(agent => agent.id === 'codex')?.on)
  const backupIdsAlive = ok.every(result => {
    const id = result.body?.backupId as string | undefined
    return Boolean(id && fs.existsSync(path.join(backups, id, 'manifest.json')))
  })
  return {
    statuses: results.map(result => result.status),
    finalOn,
    lastIntent: Boolean(last?.on),
    backupIdsAlive,
    invalidJsonSamples,
    residualLock: fs.existsSync(path.join(path.dirname(backups), 'rtk-write.lock')),
    waitMs: ok.map(result => Number(result.body?.lockWaitMs ?? -1)),
    samples,
  }
}

test('双实例并发（有跨进程锁）：最终状态=最后一次成功写入的意图，backupId 都还在，无残留锁', { timeout: 90_000 }, async () => {
  const result = await runCrossProcessToggle({})
  assert.deepEqual(result.statuses.filter(status => status !== 200), [], '不应有失败请求')
  assert.equal(result.finalOn, result.lastIntent, '最终状态必须等于最后一次成功写入的意图')
  assert.equal(result.backupIdsAlive, true, '成功响应返回的 backupId 目录必须仍然存在（不能被另一个进程轮转掉）')
  assert.equal(result.invalidJsonSamples, 0, '钩子文件在并发期间不允许出现非法 JSON（写出半截）')
  assert.equal(result.residualLock, false, '结束后不允许有残留锁文件')
  assert.equal(result.waitMs.every(ms => ms >= 0), true, '每个成功响应都要带 lockWaitMs')
})


const toggleViaInstance = async (instance: StageInstance & { cookie: string }, agent: string, on: boolean) => {
  const response = await fetch(`http://127.0.0.1:${instance.port}/api/rtk/toggle`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: instance.cookie },
    body: JSON.stringify({ agent, on, plane: 'local', confirm: true }),
  })
  return { status: response.status, body: await response.json().catch(() => ({})) }
}

const hookHasMarker = (home: string, rel: string, marker: string): boolean => {
  try {
    return JSON.parse(fs.readFileSync(path.join(home, rel), 'utf8')).hooks?.PreToolUse?.some?.((entry: unknown) =>
      JSON.stringify(entry).includes(marker)) ?? JSON.stringify(JSON.parse(fs.readFileSync(path.join(home, rel), 'utf8'))).includes(marker)
  } catch {
    return false
  }
}

test('双实例跨进程「连带还原」竞态：A 的 cursor ON 不得被 B 的 claude OFF 撤回', { timeout: 120_000 }, async () => {
  // 无锁对照（/tmp 脚本，见 docs/qa/blue/rtk-cross-process-lock.md）里 6 轮复现出 1 轮：
  // A 返回 200 但 cursor 钩子被 B 当成「rtk 的连带改动」撤回。有锁时同一场景 6/6 正常。
  for (let round = 0; round < 3; round += 1) {
    const dir = path.join(workspace, `xp-race-${round}`)
    const home = path.join(dir, 'home')
    const backups = path.join(dir, 'backups')
    for (const sub of ['home', 'backups']) fs.mkdirSync(path.join(dir, sub), { recursive: true })
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true })
    fs.writeFileSync(path.join(home, '.claude/settings.json'), `${JSON.stringify({
      hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'rtk hook claude' }] }] },
    }, null, 2)}\n`)

    const a = await startInstance({ dir: path.join(dir, 'a'), home, backups }) as StageInstance & { cookie: string }
    const b = await startInstance({ dir: path.join(dir, 'b'), home, backups }) as StageInstance & { cookie: string }
    let results: Array<{ status: number; body: Record<string, unknown> }>
    try {
      results = await Promise.all([toggleViaInstance(a, 'cursor', true), toggleViaInstance(b, 'claude', false)])
    } finally {
      a.stop()
      b.stop()
      // 【前提等待】等两个实例退出后清场稳定（同 §双实例并发：余量数倍、失败模式为断言失败）。
      await new Promise(resolve => setTimeout(resolve, 300))
    }
    assert.equal(results[0].status, 200, `round ${round}: cursor ON 应成功`)
    assert.equal(results[1].status, 200, `round ${round}: claude OFF 应成功`)
    assert.equal(hookHasMarker(home, '.cursor/hooks.json', 'rtk hook cursor'), true,
      `round ${round}: A 的成功写入不能被另一个进程撤回`)
    assert.equal(hookHasMarker(home, '.claude/settings.json', 'rtk hook claude'), false,
      `round ${round}: B 的 claude OFF 必须生效`)
    assert.equal(fs.existsSync(path.join(path.dirname(backups), 'rtk-write.lock')), false, `round ${round}: 不能留残留锁`)
  }
})

/* ------------------------------------------------------------------ */
/* 路径穿越（task-56）：rollback 的 backupId 与 manifest.files[].rel        */
/* ------------------------------------------------------------------ */

test('路径收口单元契约：assertRelShape / assertInsideDir / homeRelPath', () => {
  const dir = path.join(workspace, 'path-guard')
  const home = path.join(dir, 'home')
  fs.mkdirSync(home, { recursive: true })
  // 形状白名单
  for (const bad of ['', '   ', '/etc/passwd', '../x', 'a/../b', 'a//b', './a', 'a\\b', 'x\0y']) {
    assert.throws(() => service.assertRelShape(bad), (error: { reason?: string; status?: number }) => {
      assert.equal(error.status, 400, `应 400：${JSON.stringify(bad)}`)
      assert.equal(error.reason, 'rel_path_invalid')
      return true
    }, `应拒绝非法 rel：${JSON.stringify(bad)}`)
  }
  assert.equal(service.assertRelShape('.codex/hooks.json'), '.codex/hooks.json', '合法 rel 原样返回')
  // 归属：resolve 与 realpath 两道
  assert.equal(service.homeRelPath(home, '.codex/hooks.json'), path.join(home, '.codex/hooks.json'))
  assert.throws(() => service.assertInsideDir(home, path.join(home, '..', 'outside.txt')), /允许目录之外/)
  const outside = path.join(dir, 'outside-dir')
  fs.mkdirSync(outside, { recursive: true })
  fs.symlinkSync(outside, path.join(home, 'link-out'))
  // 形状合法但经软链接逃出 home：assertInsideDir 用默认 reason，homeRelPath 会把 reason 换成调用方给的
  assert.throws(() => service.assertInsideDir(home, 'link-out/written.txt'), (error: { reason?: string }) => {
    assert.equal(error.reason, 'path_escape')
    return true
  }, '经软链接逃出 home 必须被拒（assertInsideDir）')
  assert.throws(() => service.homeRelPath(home, 'link-out/written.txt'), (error: { reason?: string }) => {
    assert.equal(error.reason, 'rel_path_invalid')
    return true
  }, '经软链接逃出 home 必须被拒（homeRelPath）')
})

test('安全：POST /api/rtk/rollback 的路径穿越利用链全部被拒（红队 ①②③ + symlink 变体）', { timeout: 90_000 }, async () => {
  const dir = path.join(workspace, 'traversal-e2e')
  const secHome = path.join(dir, 'home')
  const secBackups = path.join(dir, 'backups')
  for (const sub of ['home', 'backups']) fs.mkdirSync(path.join(dir, sub), { recursive: true })
  // 哨兵：home 内的文件（删除类利用的目标）
  const canary = path.join(secHome, 'pwned-canary.txt')
  fs.writeFileSync(canary, 'KEEP-ME\n')
  // 哨兵：home 之外的文件（越界写入的目标）
  const outsideTarget = path.join(dir, 'cac-sec-write-canary.txt')
  const validId = '2026-10-01T00-00-00-000Z-cafe01'
  const rogueDir = path.join(dir, 'evil')                       // 备份根之外
  const symlinkOutside = path.join(dir, 'symlink-outside')

  const instance = await startInstance({ dir: path.join(dir, 'a'), home: secHome, backups: secBackups }) as StageInstance & { cookie: string }
  const rollback = async (backup: unknown) => {
    const response = await fetch(`http://127.0.0.1:${instance.port}/api/rtk/rollback`, {
      method: 'POST', headers: { 'content-type': 'application/json', cookie: instance.cookie },
      body: JSON.stringify({ confirm: true, backup }),
    })
    return { status: response.status, body: await response.json().catch(() => ({})) as Record<string, unknown> }
  }
  const writeManifest = (target: string, manifest: unknown) => {
    fs.mkdirSync(target, { recursive: true })
    fs.writeFileSync(path.join(target, 'manifest.json'), JSON.stringify(manifest))
  }
  try {
    // ① backup="../../etc"（对照：以前只做存在性判断 → 404；现在白名单直接拒）
    const case1 = await rollback('../../etc')
    assert.equal(case1.status, 400)
    assert.equal(case1.body.reason, 'backup_id_invalid')

    // ② 备份根之外的 rogue 备份：以前会删掉 home 下文件
    writeManifest(rogueDir, { id: '../evil', home: secHome, files: [{ rel: 'pwned-canary.txt', existed: false }] })
    const case2 = await rollback('../evil')
    assert.equal(case2.status, 400)
    assert.equal(case2.body.reason, 'backup_id_invalid')
    assert.equal(fs.readFileSync(canary, 'utf8'), 'KEEP-ME\n', '哨兵文件不得被删除')

    // ③ 形似合法的 id 落在备份根内，但 rel 逃出 home：以前会越界写任意文件
    const escapeDir = path.join(secBackups, validId)
    writeManifest(escapeDir, { id: validId, home: secHome, files: [{ rel: '../cac-sec-write-canary.txt', existed: true }] })
    fs.writeFileSync(path.join(escapeDir, '..__cac-sec-write-canary.txt'), 'ARBITRARY-WRITE-PROOF\n')
    const case3 = await rollback(validId)
    assert.equal(case3.status, 400)
    assert.equal(case3.body.reason, 'manifest_rel_invalid')
    assert.equal(fs.existsSync(outsideTarget), false, 'home 之外不得被创建文件')
    fs.rmSync(escapeDir, { recursive: true, force: true })

    // ③b symlink 变体：rel 形状合法（无 ..），但中间目录是指向 home 之外的软链
    fs.mkdirSync(symlinkOutside, { recursive: true })
    fs.symlinkSync(symlinkOutside, path.join(secHome, 'link-out'))
    writeManifest(escapeDir, { id: validId, home: secHome, files: [{ rel: 'link-out/written-by-rollback.txt', existed: true }] })
    fs.writeFileSync(path.join(escapeDir, 'link-out__written-by-rollback.txt'), 'ARBITRARY-WRITE-PROOF\n')
    const case3b = await rollback(validId)
    assert.equal(case3b.status, 400, `symlink 变体必须被拒：${JSON.stringify(case3b.body)}`)
    assert.equal(case3b.body.reason, 'manifest_rel_outside_home')
    assert.equal(fs.existsSync(path.join(symlinkOutside, 'written-by-rollback.txt')), false, '软链接之外不得被写入')

    // ③c 备份目录本身是软链（指向备份根之外）→ 归属校验必须拦住
    fs.mkdirSync(symlinkOutside, { recursive: true })
    fs.rmSync(escapeDir, { recursive: true, force: true })
    const linkId = '2026-10-01T00-00-00-000Z-cafe02'
    fs.symlinkSync(symlinkOutside, path.join(secBackups, linkId))
    const case3c = await rollback(linkId)
    assert.equal(case3c.status, 400)
    assert.equal(case3c.body.reason, 'backup_path_escape')
    fs.rmSync(path.join(secBackups, linkId), { force: true })

    // ④ manifest 结构类：home 不一致 / id 不一致 / files 为空 —— 全部整单拒绝
    for (const [label, manifest, reason] of [
      ['home 不一致', { id: validId, home: '/somewhere/else', files: [{ rel: '.codex/hooks.json', existed: true }] }, 'manifest_invalid'],
      ['id 不一致', { id: 'other-id', home: secHome, files: [{ rel: '.codex/hooks.json', existed: true }] }, 'manifest_invalid'],
      ['files 为空', { id: validId, home: secHome, files: [] }, 'manifest_invalid'],
      ['files 项结构非法', { id: validId, home: secHome, files: [{ rel: 123, existed: true }] }, 'manifest_invalid'],
    ] as const) {
      writeManifest(escapeDir, manifest)
      const result = await rollback(validId)
      assert.equal(result.status, 400, `${label} 必须被拒：${JSON.stringify(result.body)}`)
      assert.equal(result.body.reason, reason, label)
      assert.equal(fs.readFileSync(canary, 'utf8'), 'KEEP-ME\n')
      fs.rmSync(escapeDir, { recursive: true, force: true })
    }

    // ⑤ 审计仍留痕：被拒的 rollback 必须在审计里有 outcome=error + reason
    const audit = await fetch(`http://127.0.0.1:${instance.port}/api/audit`, { headers: { cookie: instance.cookie } })
    const auditBody = await audit.json() as { items: Array<{ action?: string; target?: string; details?: string }> }
    const rejected = auditBody.items.filter(item => String(item.details || '').includes('rollback_rtk_hook') || String(item.action || '').includes('rollback'))
    assert.ok(rejected.length > 0, `审计里必须有被拒的回滚记录：${JSON.stringify(auditBody.items.slice(0, 3))}`)
    assert.ok(rejected.some(item => /reason=(backup_id_invalid|manifest_invalid|manifest_rel_invalid|manifest_rel_outside_home|backup_path_escape)/.test(String(item.details))),
      `审计必须记下明确 reason：${rejected.map(item => item.details).join(' | ')}`)

    // ⑥ 合法回滚仍然可用（没把正常路径一起堵死）：注意本进程也要用实例那套 RTK_BACKUP_DIR，
    // 否则备份会写到默认目录、实例按 RTK_BACKUP_DIR 找不到
    const previousBackups = process.env.RTK_BACKUP_DIR
    process.env.RTK_BACKUP_DIR = secBackups
    let seeded: Awaited<ReturnType<typeof service.setRTKAgentHook>>
    try {
      seeded = await service.setRTKAgentHook('codex', true, { plane: 'local', home: secHome, bin: path.join(dir, 'no-rtk') })
    } finally {
      if (previousBackups === undefined) delete process.env.RTK_BACKUP_DIR
      else process.env.RTK_BACKUP_DIR = previousBackups
    }
    assert.ok(seeded.backupId, '需要一份真实备份')
    fs.writeFileSync(canary, 'MUTATED\n')
    const happy = await rollback(seeded.backupId)
    assert.equal(happy.status, 200, `合法回滚必须仍然成功：${JSON.stringify(happy.body)}`)
    fs.rmSync(canary, { force: true })
  } finally {
    instance.stop()
    await new Promise(resolve => setTimeout(resolve, 200))
    fs.rmSync(path.join(secHome, 'link-out'), { force: true })
  }
})

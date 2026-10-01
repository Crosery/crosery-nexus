import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

/**
 * task-78 ④：magpie 更新器的状态机、幂等、校验与回滚。
 *
 * 全部在 `mkdtemp` 临时目录里跑：**不碰真实运行时、不碰 launchd、不联网**
 * （"发布源"就是一个本地目录 + manifest.json，与生产 URL 发布源同形状）。
 */

const REPO = new URL('../', import.meta.url).pathname
const SCRIPT = path.join(REPO, 'scripts/magpie-update.mjs')

const sha256 = (buffer) => createHash('sha256').update(buffer).digest('hex')

/** 造一个"发布源"目录：manifest.json + 产物（可指定内容/版本/校验和是否正确）。 */
function makeRelease(dir, { version, body, corruptSha = false, name = 'magpie-kernel' }) {
  fs.mkdirSync(dir, { recursive: true })
  const buffer = Buffer.from(body)
  const declared = corruptSha ? sha256(Buffer.from('something-else')) : sha256(buffer)
  fs.writeFileSync(path.join(dir, name), buffer, { mode: 0o755 })
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({
    version, revision: 'a'.repeat(40), files: [{ name, sha256: declared }],
  }, null, 2))
  return { buffer, sha: sha256(buffer) }
}

/** 当前安装目录：一份"旧版本"产物 + 状态文件。 */
function makeRoot(dir, { version = 'crosery-0000000', body = 'old-binary crosery-0000000\n' } = {}) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  const binary = path.join(dir, 'magpie-kernel')
  const buffer = Buffer.from(body)
  fs.writeFileSync(binary, buffer, { mode: 0o755 })
  fs.writeFileSync(path.join(dir, 'magpie-update-status.json'), JSON.stringify({ currentVersion: version }, null, 2))
  return { binary, buffer, sha: sha256(buffer) }
}

const run = (args, { expectStatus = 0 } = {}) => {
  try {
    const stdout = execFileSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    if (expectStatus !== 0) assert.fail(`期望退出码 ${expectStatus}，实际 0：${stdout}`)
    return { status: 0, stdout, json: stdout.trim().startsWith('{') ? JSON.parse(stdout.trim().split('\n').pop()) : null }
  } catch (error) {
    const status = typeof error.status === 'number' ? error.status : 1
    if (status !== expectStatus) {
      assert.fail(`期望退出码 ${expectStatus}，实际 ${status}：${String(error.stdout || '')}${String(error.stderr || '')}`)
    }
    return { status, stdout: String(error.stdout || ''), stderr: String(error.stderr || ''), json: null }
  }
}

test('status 只读：不存在的状态文件也要能回答（含 currentVersion 回读）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'magpie-status-'))
  try {
    const root = path.join(dir, 'bin')
    const result = run(['status', '--root', root])
    assert.equal(result.json.action, 'status')
    assert.equal(result.json.currentVersion, null, '没有任何版本信息时如实返回 null，不编造')
    assert.equal(result.json.lastResult, null)
    assert.equal(fs.existsSync(path.join(root, 'magpie-update-status.json')), false, 'status 不得写任何东西（只读）')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('check 只读：只更新状态文件里的检查时间/结论，不动产物', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'magpie-check-'))
  try {
    const root = path.join(dir, 'bin')
    const release = path.join(dir, 'release')
    const rootState = makeRoot(root, { version: 'crosery-0000000' })
    makeRelease(release, { version: 'crosery-1111111', body: 'new-binary crosery-1111111\n' })

    const result = run(['check', '--root', root, '--from', release])
    assert.equal(result.json.status, 'update-available')
    assert.equal(result.json.latestVersion, 'crosery-1111111')
    assert.equal(result.json.executable, false, 'check 不做任何替换')
    assert.equal(sha256(fs.readFileSync(rootState.binary)), rootState.sha, '产物必须原样未动')

    const status = JSON.parse(fs.readFileSync(path.join(root, 'magpie-update-status.json'), 'utf8'))
    assert.equal(status.lastResult, 'update-available')
    assert.ok(status.lastCheckedAt, '必须记录检查时间（可观测）')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('apply 必须显式确认：没有 --confirm-apply 直接拒绝（退出码 2，零改动）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'magpie-confirm-'))
  try {
    const root = path.join(dir, 'bin')
    const release = path.join(dir, 'release')
    const rootState = makeRoot(root)
    makeRelease(release, { version: 'crosery-2222222', body: 'new crosery-2222222\n' })

    const result = run(['apply', '--root', root, '--from', release], { expectStatus: 2 })
    assert.match(result.stderr, /confirm-apply|确认/)
    assert.equal(sha256(fs.readFileSync(rootState.binary)), rootState.sha, '被拒绝时产物必须零改动')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('幂等：同一版本重复 apply 不产生任何变化（第二次报 already up-to-date）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'magpie-idempotent-'))
  try {
    const root = path.join(dir, 'bin')
    const release = path.join(dir, 'release')
    const before = makeRoot(root, { version: 'crosery-3333333' })
    const published = makeRelease(release, { version: 'crosery-3333333', body: 'same-version crosery-3333333\n' })

    const first = run(['apply', '--confirm-apply', '--root', root, '--from', release])
    assert.equal(first.json.status, 'up-to-date', JSON.stringify(first.json))
    assert.equal(first.json.changed, false)
    const after = fs.readFileSync(path.join(root, 'magpie-kernel'))
    assert.equal(sha256(after), before.sha, '同版本时产物保持原字节（幂等，不重写）')
    assert.notEqual(sha256(published.buffer), before.sha, '夹具本身要有区分度：发布产物与当前产物不同')
    const backups = fs.readdirSync(root).filter(name => name.includes('.before-'))
    assert.deepEqual(backups, [], '同版本时不该产生备份（幂等）')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('更新全链路：下载 → 校验 → 备份 → 原子替换，版本真的变了', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'magpie-update-'))
  try {
    const root = path.join(dir, 'bin')
    const release = path.join(dir, 'release')
    const before = makeRoot(root, { version: 'crosery-4444444' })
    const published = makeRelease(release, { version: 'crosery-5555555', body: 'brand-new crosery-5555555\n' })

    const result = run(['apply', '--confirm-apply', '--root', root, '--from', release])
    assert.equal(result.json.status, 'updated', JSON.stringify(result.json))
    assert.equal(result.json.changed, true)
    assert.equal(result.json.sha256, published.sha)

    const after = fs.readFileSync(path.join(root, 'magpie-kernel'))
    assert.equal(sha256(after), published.sha, '产物必须换成新版本')
    assert.ok(result.json.backup, '必须有备份')
    assert.equal(sha256(fs.readFileSync(result.json.backup)), before.sha, '备份内容 = 旧版本（可回滚）')

    const status = JSON.parse(fs.readFileSync(path.join(root, 'magpie-update-status.json'), 'utf8'))
    assert.equal(status.lastResult, 'updated')
    assert.equal(status.currentVersion, 'crosery-5555555', '状态要跟上新版本')
    assert.equal(status.backupPath, result.json.backup)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('校验失败必须回滚：sha256 不匹配时旧版本原样保留（非 0 退出 + 明确报错）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'magpie-rollback-'))
  try {
    const root = path.join(dir, 'bin')
    const release = path.join(dir, 'release')
    const before = makeRoot(root, { version: 'crosery-6666666' })
    makeRelease(release, { version: 'crosery-7777777', body: 'bad crosery-7777777\n', corruptSha: true })

    const result = run(['apply', '--confirm-apply', '--root', root, '--from', release], { expectStatus: 1 })
    assert.match(result.stderr, /失败/)
    const after = fs.readFileSync(path.join(root, 'magpie-kernel'))
    assert.equal(sha256(after), before.sha, '校验失败后旧版本必须逐字节完好')
    assert.equal(fs.existsSync(path.join(root, 'magpie-kernel.incoming-' + process.pid)), false, '不得留下半成品')

    const status = JSON.parse(fs.readFileSync(path.join(root, 'magpie-update-status.json'), 'utf8'))
    // 下载阶段就发现 sha256 不符 ⇒ 旧文件根本没被碰过（state 如实区分这一点）
    assert.equal(status.lastResult, 'failed-before-swap', `状态必须如实记录失败阶段：${JSON.stringify(status)}`)
    assert.ok(status.error, '必须记录失败原因')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('网络/发布源失败必须回滚：manifest 拿不到时旧版本零改动（非 0 退出）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'magpie-neterr-'))
  try {
    const root = path.join(dir, 'bin')
    const before = makeRoot(root, { version: 'crosery-8888888' })
    const result = run(['apply', '--confirm-apply', '--root', root, '--from', path.join(dir, 'does-not-exist')], { expectStatus: 1 })
    assert.match(result.stderr, /失败/)
    assert.equal(sha256(fs.readFileSync(path.join(root, 'magpie-kernel'))), before.sha, '旧版本不得被改动')
    const status = JSON.parse(fs.readFileSync(path.join(root, 'magpie-update-status.json'), 'utf8'))
    assert.equal(status.lastResult, 'failed-before-swap', '区分"替换前失败"与"替换后回滚"')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('rehearse 在临时目录演练完整流程：真实 root 一个字节都不动', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'magpie-rehearse-'))
  try {
    const root = path.join(dir, 'bin')
    const release = path.join(dir, 'release')
    const before = makeRoot(root, { version: 'crosery-9999999' })
    makeRelease(release, { version: 'crosery-aaaaaaa', body: 'rehearsed crosery-aaaaaaa\n' })

    const result = run(['rehearse', '--root', root, '--from', release])
    assert.equal(result.json.status, 'rehearsed', JSON.stringify(result.json))
    assert.equal(result.json.changed, true, '演练也要真的走完替换（只是发生在临时 root）')
    assert.equal(sha256(fs.readFileSync(path.join(root, 'magpie-kernel'))), before.sha, '真实 root 必须零改动')
    const stagedRoot = path.join(result.json.stage, 'root', 'magpie-kernel')
    assert.equal(sha256(fs.readFileSync(stagedRoot)), sha256(fs.readFileSync(path.join(release, 'magpie-kernel'))), '临时 root 里换成新版本')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('状态 JSON 字段齐全（我做服务端适配器时按这些字段读）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'magpie-fields-'))
  try {
    const root = path.join(dir, 'bin')
    const release = path.join(dir, 'release')
    makeRoot(root, { version: 'crosery-bbbbbbb' })
    makeRelease(release, { version: 'crosery-ccccccc', body: 'x crosery-ccccccc\n' })
    run(['check', '--root', root, '--from', release])
    const status = JSON.parse(fs.readFileSync(path.join(root, 'magpie-update-status.json'), 'utf8'))
    for (const field of ['lastCheckedAt', 'latestVersion', 'currentVersion', 'lastResult', 'backupPath', 'error']) {
      assert.ok(field in status, `状态 JSON 缺少字段：${field}（实际 ${JSON.stringify(status)}）`)
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('替换后校验失败必须真回滚：备份被放回、目标逐字节恢复（回滚分支不是摆设）', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'magpie-postswap-'))
  try {
    const root = path.join(dir, 'bin')
    const before = makeRoot(root, { version: 'crosery-ddddddd' })
    const staged = path.join(dir, 'staged-kernel')
    fs.writeFileSync(staged, Buffer.from('new crosery-eeeeeee\n'), { mode: 0o755 })

    const { swapIn } = await import('./magpie-update.mjs')
    const result = swapIn({
      root,
      binary: 'magpie-kernel',
      staged,
      backupSuffix: 'test-postswap',
      expectedSha: sha256(fs.readFileSync(staged)),
      // 注入"替换之后才发现装错了"（真实场景：磁盘/rename 之后内容被改坏）
      verifyPostSwap: () => { throw new Error('post-swap 校验失败（注入）') },
    })
    assert.equal(result.ok, false, '后置校验失败必须报失败')
    assert.equal(result.rolledBack, true, '必须走了回滚')
    assert.match(String(result.error), /post-swap/)
    const after = fs.readFileSync(path.join(root, 'magpie-kernel'))
    assert.equal(sha256(after), before.sha, '回滚后目标必须逐字节恢复为旧版本')
    assert.deepEqual(fs.readdirSync(root).filter(name => name.includes('.incoming-')), [], '不得留下半成品')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

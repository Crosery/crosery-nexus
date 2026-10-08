import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { canonicalChannelName, ensureLockoutKey, ensureProbeKeys, isSystemKey, parseSystemKeys, readSystemKeys } from './systemKeys.js'

const tempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'system-keys-'))
const LEGACY = `sk-lockout-${'e'.repeat(64)}`

test('首次读取把旧 cpa-lockout-key 迁进 system-keys.json：同一把，旧文件留着', () => {
  const dir = tempDir()
  try {
    fs.writeFileSync(path.join(dir, 'cpa-lockout-key'), `${LEGACY}\n`, { mode: 0o600 })
    assert.deepEqual(readSystemKeys(dir), { version: 1, lockout: LEGACY, probes: {} })
    const file = path.join(dir, 'system-keys.json')
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { version: 1, lockout: LEGACY, probes: {} })
    assert.equal(fs.statSync(file).mode & 0o777, 0o600)
    assert.ok(fs.existsSync(path.join(dir, 'cpa-lockout-key')))
    assert.equal(ensureLockoutKey(dir), LEGACY)
    assert.deepEqual(fs.readdirSync(dir).sort(), ['cpa-lockout-key', 'system-keys.json'], '不留临时文件')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('探测 Key 按规范渠道名存，写入时补齐封锁 Key，文件始终符合契约', () => {
  const dir = tempDir()
  try {
    const probes = ensureProbeKeys(dir, ['claude', 'openai-compatible-OpenRouter', 'openrouter'])
    assert.match(probes.claude, /^sk-probe-claude-[0-9a-f]{64}$/)
    assert.equal(probes['openai-compatible-OpenRouter'], probes.openrouter, '同一渠道共用一把')
    const stored = JSON.parse(fs.readFileSync(path.join(dir, 'system-keys.json'), 'utf8'))
    assert.deepEqual(Object.keys(stored), ['version', 'lockout', 'probes'])
    assert.match(stored.lockout, /^sk-lockout-[0-9a-f]{64}$/)
    assert.deepEqual(stored.probes, { claude: probes.claude, openrouter: probes.openrouter })
    assert.deepEqual(ensureProbeKeys(dir, ['claude']), { claude: probes.claude })
    assert.equal(ensureLockoutKey(dir), stored.lockout)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('解析宽松、识别按格式：坏条目丢掉；控制台发放的 32 位 Key 不算系统 Key', () => {
  const good = `sk-probe-codex-${'f'.repeat(64)}`
  assert.deepEqual(parseSystemKeys({ version: 1, lockout: 'nope', probes: { codex: good, bad: 'sk-real', '': good } }), { version: 1, lockout: null, probes: { codex: good } })
  assert.deepEqual(parseSystemKeys('garbage'), { version: 1, lockout: null, probes: {} })
  assert.equal(isSystemKey(good), true)
  assert.equal(isSystemKey(LEGACY), true)
  assert.equal(isSystemKey(`sk-probe-codex-${'f'.repeat(32)}`), false)
  assert.equal(canonicalChannelName(' Openai-Compatible-Mox-AIGW '), 'mox-aigw')
})

test('服务外的脚本用纯 Node 就能读（不依赖 tsx 和服务配置）', () => {
  const dir = tempDir()
  try {
    fs.writeFileSync(path.join(dir, 'cpa-lockout-key'), `${LEGACY}\n`)
    const module = path.join(path.dirname(fileURLToPath(import.meta.url)), 'systemKeys.ts')
    const output = execFileSync(process.execPath, ['--input-type=module', '-e',
      `const { readSystemKeys } = await import(${JSON.stringify(module)}); process.stdout.write(JSON.stringify(readSystemKeys(${JSON.stringify(dir)})))`,
    ], { env: { PATH: process.env.PATH ?? '' }, encoding: 'utf8' })
    assert.deepEqual(JSON.parse(output), { version: 1, lockout: LEGACY, probes: {} })
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

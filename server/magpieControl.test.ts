import './testDataDir.js'

import assert from 'node:assert/strict'
import test from 'node:test'
import { magpieCredentialReference, resolveMagpieSecret, validateMagpieChannels } from './magpieControl.js'

const channel = {
  name: 'test', 'base-url': 'https://upstream.invalid/v1', models: [{ name: 'real', alias: 'public' }],
  'api-key-entries': [{ 'api-key': 'env:TEST_UPSTREAM_KEY' }],
}
test('registry stores references, never raw upstream keys', () => {
  assert.equal(validateMagpieChannels([channel]).length, 1)
  assert.throws(() => validateMagpieChannels([{ ...channel, 'api-key-entries': [{ 'api-key': 'fixture-secret' }] }]), /raw credentials/)
  const reference = magpieCredentialReference('openai-compatibility', 'test', 0)
  assert.equal(validateMagpieChannels([{ ...channel, 'api-key-entries': [{ 'api-key': reference }] }]).length, 1)
  assert.ok(!reference.includes('test'))
})
test('credential references resolve only at runtime', () => {
  assert.equal(resolveMagpieSecret('env:TEST_UPSTREAM_KEY', { TEST_UPSTREAM_KEY: 'fixture-secret' }), 'fixture-secret')
  assert.throws(() => resolveMagpieSecret('env:TEST_UPSTREAM_KEY', {}), /unavailable/)
  assert.throws(() => resolveMagpieSecret('raw-key', {}), /reference/)
  assert.throws(() => resolveMagpieSecret('env:TEST_UPSTREAM_KEY', { TEST_UPSTREAM_KEY: 'unsafe\nheader' }), /unavailable/)
})
test('invalid registries fail closed before a provider is configured', () => {
  assert.throws(() => validateMagpieChannels([channel, channel]), /duplicate/)
  assert.throws(() => validateMagpieChannels([{ ...channel, protocol: 'gemini' }]), /protocol/)
  assert.throws(() => validateMagpieChannels([{ ...channel, models: [] }]), /models/)
  assert.throws(() => validateMagpieChannels([{ ...channel, headers: { Authorization: 'fixture-secret' } }]), /header/)
  assert.throws(() => validateMagpieChannels([{ ...channel, 'proxy-url': 'http://user:password@proxy.invalid' }]), /credentials/)
})

test('unrelated admin-input fields cannot become another persisted credential store', () => {
  const projected = validateMagpieChannels([{ ...channel, secret: 'fixture-secret',
    'api-key-entries': [{ 'api-key': 'env:TEST_UPSTREAM_KEY', privateHeader: 'fixture-secret' }],
  }])
  assert.ok(!JSON.stringify(projected).includes('fixture-secret'))
})

test('local auth-files and excluded models management operates safely', async () => {
  const { listLocalAuthFiles, saveLocalAuthFile, setLocalAuthFileStatus, setLocalAuthFileProxy, deleteLocalAuthFile, readExcludedModels, writeExcludedModels, magpieManagementRequest } = await import('./magpieControl.js')
  const testFile = `test-oauth-${Date.now()}.json`
  const testContent = JSON.stringify({ type: 'claude', provider: 'claude', email: 'test@example.com', access_token: 'tok-123' })
  
  deleteLocalAuthFile(testFile)
  saveLocalAuthFile(testFile, testContent)
  const files = listLocalAuthFiles()
  const found = files.find(f => f.name === testFile)
  assert.ok(found)
  assert.equal(found.type, 'claude')
  assert.equal(found.disabled, false)

  setLocalAuthFileStatus(testFile, true)
  assert.equal(listLocalAuthFiles().find(f => f.name === testFile)?.disabled, true)

  setLocalAuthFileProxy(testFile, 'http://127.0.0.1:7890')
  assert.equal(listLocalAuthFiles().find(f => f.name === testFile)?.proxy_url, 'http://127.0.0.1:7890')

  // management request integration
  const reqResult = await magpieManagementRequest<{ files: Array<Record<string, unknown>> }>('/auth-files')
  assert.ok(reqResult.files.some(f => f.name === testFile))

  // excluded models
  writeExcludedModels({ claude: ['claude-haiku-4-5'] })
  assert.deepEqual(readExcludedModels(), { claude: ['claude-haiku-4-5'] })

  deleteLocalAuthFile(testFile)
  assert.equal(listLocalAuthFiles().some(f => f.name === testFile), false)
})

/* ────────────────── 凭据文件名路径穿越（task-61 F1/F2，红队第十七轮） ────────────────── */

test('凭据路径单点校验：越界删除/读取/写入一律拒绝，合法名字仍可用', async () => {
  const fs = await import('node:fs')
  const path = await import('node:path')
  const { testDataDir } = await import('./testDataDir.js')
  const {
    assertAuthFileName, authFilePath, saveLocalAuthFile, getLocalAuthFile, deleteLocalAuthFile,
  } = await import('./magpieControl.js')

  const dataDir = path.resolve(testDataDir)
  const authDir = path.join(dataDir, 'auth-files')
  fs.mkdirSync(authDir, { recursive: true })
  // 哨兵放在 DATA_DIR **之外**（与红队用例同构：../../canary.txt 指向它）
  const outsideDir = path.dirname(dataDir)
  const canary = path.join(outsideDir, `cac-wp-canary-${process.pid}.txt`)
  const probe = path.join(outsideDir, `cac-wp-probe-${process.pid}.json`)
  fs.writeFileSync(canary, 'CANARY\n')
  fs.writeFileSync(probe, JSON.stringify({ secret: 'OUTSIDE-DATA' }))
  const relative = `../../${path.basename(canary)}`
  const relativeProbe = `../../${path.basename(probe)}`

  try {
    // ① DELETE：红队实测过的越界删除
    assert.throws(() => deleteLocalAuthFile(relative), (error: { status?: number; message?: string }) => {
      assert.equal(error.status, 400)
      assert.equal(error.message, 'credential_name_invalid')
      return true
    })
    assert.equal(fs.existsSync(canary), true, 'DATA_DIR 之外的哨兵不得被删除')
    assert.equal(fs.readFileSync(canary, 'utf8'), 'CANARY\n', '内容也不得被改动')

    // ② GET：红队实测过的越界读取
    assert.throws(() => getLocalAuthFile(relativeProbe), /credential_name_invalid/)
    assert.throws(() => getLocalAuthFile('/etc/hosts'), /credential_name_invalid/, '绝对路径必须拒绝')
    assert.throws(() => saveLocalAuthFile(relativeProbe, Buffer.from('x')), /credential_name_invalid/, '普通保存同样拒绝')

    // ③ symlink 变体：文件名单段但指向 DATA_DIR 之外 → 归属校验（realpath）拦下
    const linkName = `cac-wp-link-${process.pid}.json`
    try { fs.symlinkSync(probe, path.join(authDir, linkName)) } catch { /* 已存在则复用 */ }
    assert.throws(() => getLocalAuthFile(linkName), /credential_path_escape/, '软链接逃逸必须拒绝')
    assert.throws(() => deleteLocalAuthFile(linkName), /credential_path_escape/)
    assert.equal(fs.existsSync(probe), true, '软链接目标不得被删除')

    // ④ 硬链接变体（F3）：路径确实在目录内，realpath 看不出来 → nlink 校验拦下
    const hardName = `cac-wp-hard-${process.pid}.json`
    const hardPath = path.join(authDir, hardName)
    fs.rmSync(hardPath, { force: true })
    fs.linkSync(probe, hardPath)
    assert.throws(() => getLocalAuthFile(hardName), /credential_hardlink_rejected/, '硬链接必须拒绝')
    assert.equal(fs.existsSync(probe), true)

    // ⑤ 形状白名单的其它形态
    for (const bad of ['', '   ', '.', '..', 'a/b.json', 'a\\b.json', 'x\0y.json', '/abs.json']) {
      assert.throws(() => assertAuthFileName(bad), /credential_name_invalid/, `应拒绝：${JSON.stringify(bad)}`)
    }

    // ⑥ 合法路径必须仍然可用
    const good = `cac-wp-legit-${process.pid}.json`
    saveLocalAuthFile(good, Buffer.from(JSON.stringify({ provider: 'anthropic' })))
    assert.equal(authFilePath(good), path.join(authDir, good))
    assert.deepEqual(getLocalAuthFile(good), { provider: 'anthropic' })
    assert.equal(deleteLocalAuthFile(good), undefined)
    assert.equal(fs.existsSync(path.join(authDir, good)), false)
  } finally {
    fs.rmSync(canary, { force: true })
    fs.rmSync(probe, { force: true })
  }
})

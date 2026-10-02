import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { ensureCopy, needsCopy, parseMihomoVersion, resolveMihomoBinary, versionSupported } from './mihomoBinary.js'

test('binary: version parsing and gate', () => {
  assert.equal(parseMihomoVersion('Mihomo Meta v1.19.31 darwin arm64 with go1.26.8'), '1.19.31')
  assert.equal(parseMihomoVersion('Clash v1.18.0'), null)
  assert.equal(versionSupported('1.19.0'), true)
  assert.equal(versionSupported('1.18.9'), false)
  assert.equal(versionSupported('2.0.0'), true)
})

function tempDir(prefix: string) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

function fakeExecutable(file: string, body = '#!/bin/sh\necho "Mihomo Meta v1.19.31 fake"\n') {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, body, { mode: 0o755 })
  return file
}

test('binary discovery: MIHOMO_BIN wins, then the bundle (darwin only), then PATH; bad MIHOMO_BIN is reported', async () => {
  const root = tempDir('mihomo-bin-')
  const dir = path.join(root, 'kernel')
  const explicit = fakeExecutable(path.join(root, 'explicit', 'mihomo'))
  const bundle = fakeExecutable(path.join(root, 'Clash Party.app', 'Contents', 'Resources', 'sidecar', 'mihomo'))
  const onPath = fakeExecutable(path.join(root, 'pathdir', 'clash-meta'))
  const readVersion = async () => 'Mihomo Meta v1.19.31 fake'

  const fromEnv = await resolveMihomoBinary({ dir, env: { MIHOMO_BIN: explicit, PATH: path.dirname(onPath) }, platform: 'darwin', bundlePath: bundle, readVersion })
  assert.ok(fromEnv.ok)
  assert.equal(fromEnv.source, 'env')
  assert.equal(fromEnv.runPath, explicit, 'a plain MIHOMO_BIN runs in place')
  assert.equal(fromEnv.copied, false)

  const fromBundle = await resolveMihomoBinary({ dir, env: { PATH: path.dirname(onPath) }, platform: 'darwin', bundlePath: bundle, readVersion })
  assert.ok(fromBundle.ok)
  assert.equal(fromBundle.source, 'bundle')
  assert.equal(fromBundle.copied, true, '.app sources are copied')
  assert.equal(fromBundle.runPath, path.join(dir, 'bin', 'mihomo'))
  assert.equal(fs.statSync(fromBundle.runPath).mode & 0o7777, 0o700)

  const fromPath = await resolveMihomoBinary({ dir, env: { PATH: path.dirname(onPath) }, platform: 'linux', bundlePath: bundle, readVersion })
  assert.ok(fromPath.ok)
  assert.equal(fromPath.source, 'path')
  assert.equal(fromPath.runPath, onPath)

  const none = await resolveMihomoBinary({ dir, env: { PATH: '' }, platform: 'linux', bundlePath: bundle, readVersion })
  assert.equal(none.ok, false)
  const bad = await resolveMihomoBinary({ dir, env: { MIHOMO_BIN: 'relative/mihomo' }, platform: 'darwin', bundlePath: bundle, readVersion })
  assert.deepEqual(bad, { ok: false, reason: 'MIHOMO_BIN 不是可执行文件的绝对路径' })
  const old = await resolveMihomoBinary({ dir, env: { MIHOMO_BIN: explicit }, readVersion: async () => 'Mihomo Meta v1.18.10' })
  assert.equal(old.ok, false)
})

test('binary copy: setuid sources are copied without the bit, refreshed only when the content changes', async () => {
  const root = tempDir('mihomo-copy-')
  const source = fakeExecutable(path.join(root, 'src', 'mihomo'))
  try { fs.chmodSync(source, 0o4755) } catch { /* some filesystems refuse; the .app rule is covered above */ }
  const stat = fs.statSync(source)
  if ((stat.mode & 0o4000) !== 0) assert.equal(needsCopy(source, stat), true)
  const dir = path.join(root, 'kernel')
  const copy = await ensureCopy(source, dir)
  assert.equal(fs.statSync(copy).mode & 0o7777, 0o700, 'never setuid, owner-only')
  const firstIno = fs.statSync(copy).ino
  await ensureCopy(source, dir)
  assert.equal(fs.statSync(copy).ino, firstIno, 'unchanged source → no recopy')
  fs.writeFileSync(source, '#!/bin/sh\necho "Mihomo Meta v1.19.32 fake"\n')
  await ensureCopy(source, dir)
  assert.match(fs.readFileSync(copy, 'utf8'), /1\.19\.32/)
})

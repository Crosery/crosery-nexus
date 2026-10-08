import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { gzipSync } from 'node:zlib'
import { fileURLToPath } from 'node:url'

const gate = fileURLToPath(new URL('../deploy/kernels/relay/cpa-pipeline-gate.sh', import.meta.url))

async function host(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cpa-gate-'))
  t.after(() => fs.rm(dir, { recursive: true, force: true }))
  await fs.mkdir(path.join(dir, 'bin'))
  await fs.mkdir(path.join(dir, 'data/kernels'), { recursive: true })
  await fs.writeFile(path.join(dir, 'bin/systemctl'), `#!/bin/bash\necho "$*" >> "${dir}/kicks"\n`, { mode: 0o755 })
  await fs.writeFile(path.join(dir, 'cli-proxy-api'), '#!/bin/sh\necho "CLIProxyAPI Version: 8.0.21-patched.a, Commit: x"\n', { mode: 0o755 })
  await fs.writeFile(path.join(dir, 'data/kernels/cpa.json'), '{"version":1,"kernel":"cpa"}')
  await fs.writeFile(path.join(dir, 'data/kernels/cpa-promotion.json'), '{"kind":"cpa-promotion"}')
  const env = { PATH: `${path.join(dir, 'bin')}:${process.env.PATH}`, KERNEL_LIB_DIR: path.join(dir, 'lib'), KERNEL_DATA_DIR: path.join(dir, 'data'), CPA_BINARY: path.join(dir, 'cli-proxy-api') }
  const call = (role, command, input = '') => {
    const out = spawnSync('bash', [gate, ...(role ? [role] : [])], { env: { ...env, SSH_ORIGINAL_COMMAND: command }, input, encoding: input instanceof Buffer ? undefined : 'utf8' })
    return { code: out.status, stdout: String(out.stdout) }
  }
  const read = file => fs.readFile(path.join(dir, file), 'utf8')
  const inbox = () => fs.readdir(path.join(dir, 'lib/cpa/inbox'))
  return { dir, call, read, inbox }
}

test('gate: a role is required; arbitrary commands are denied', async t => {
  const h = await host(t)
  assert.equal(h.call(null, 'cpa-state').code, 2)
  assert.equal(h.call('staging', 'cpa-state').code, 2)
  for (const command of ['bash -c id', 'cpa-state; id', 'cpa-install /tmp/x', '']) assert.equal(h.call('production', command).code, 2, command)
  assert.match(h.call('preview', 'cpa-version').stdout, /Version: 8\.0\.21-patched\.a/)
  assert.equal(JSON.parse(h.call('preview', 'cpa-state').stdout).kernel, 'cpa')
  assert.deepEqual(JSON.parse(h.call('production', 'rtk-state').stdout), {})
})

test('gate: preview takes acceptance runs and hands out its promotion record; production takes promotion records only', async t => {
  const h = await host(t)
  assert.equal(h.call('preview', 'cpa-accept', '{"kind":"cpa-acceptance"}').code, 0)
  assert.equal(await h.read('lib/cpa/inbox/acceptance.json'), '{"kind":"cpa-acceptance"}')
  assert.match(await h.read('kicks'), /start --no-block crosery-kernel-update\.service/)
  assert.equal(JSON.parse(h.call('preview', 'cpa-promotion').stdout).kind, 'cpa-promotion')
  for (const command of ['cpa-promote', 'rtk-promote']) assert.equal(h.call('preview', command, '{}').code, 2, command)
  for (const command of ['cpa-accept', 'cpa-promotion']) assert.equal(h.call('production', command, '{}').code, 2, command)
  assert.equal(h.call('production', 'cpa-promote', '{"kind":"cpa-promotion"}').code, 0)
  assert.equal(await h.read('lib/cpa/inbox/promotion.json'), '{"kind":"cpa-promotion"}')
  assert.equal(h.call('production', 'rtk-promote', '{"kind":"rtk-promotion"}').code, 0)
  assert.equal(await h.read('data/rtk/promotion.json'), '{"kind":"rtk-promotion"}')
})

test('gate: upload then stage under a strict version; oversized reports are refused and leave nothing', async t => {
  const h = await host(t)
  assert.equal(h.call('preview', 'cpa-stage 8.0.21-patched.b').code, 2, 'nothing uploaded yet')
  const upload = h.call('preview', 'cpa-upload', gzipSync(Buffer.from('binary bytes')))
  assert.equal(upload.code, 0)
  assert.equal(h.call('preview', 'cpa-stage 8.0.21; rm -rf /').code, 2)
  assert.equal(h.call('preview', 'cpa-stage ../../etc/passwd').code, 2)
  assert.equal(h.call('preview', 'cpa-stage 8.0.21-patched.b').code, 0)
  assert.equal(await h.read('lib/cpa/inbox/8.0.21-patched.b.bin'), 'binary bytes')
  assert.equal(h.call('preview', 'cpa-report', 'x'.repeat(65_537)).code, 2)
  assert.deepEqual((await h.inbox()).sort(), ['8.0.21-patched.b.bin'])
  assert.equal(h.call('preview', 'cpa-report', '{"version":1}').code, 0)
  assert.deepEqual((await h.inbox()).sort(), ['8.0.21-patched.b.bin', 'report.json'])
})

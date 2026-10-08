import assert from 'node:assert/strict'
import test from 'node:test'
import {
  checkTag, manifestHashes, parseEnvFile, parseRecords, parseReleaseTag, productionEvidence, publicEnvProblems, releaseIdFor, RELAY_ENTRY,
  relayCodeFiles, relayRestartDecision, rollbackTarget, secretLikeKeys, shippable,
} from './release-policy.mjs'

const C = 'c'.repeat(40)

test('tag 解析：rc 与正式，前导 0 与杂项后缀拒绝', () => {
  assert.deepEqual(parseReleaseTag('v0.2.0-rc.1'), { version: '0.2.0', rc: 1 })
  assert.deepEqual(parseReleaseTag('v1.10.3'), { version: '1.10.3', rc: null })
  for (const bad of ['0.2.0', 'v0.2', 'v01.2.0', 'v0.2.0-rc.0', 'v0.2.0-rc1', 'v0.2.0-beta.1', 'v0.2.0+x', 'v0.2.0-rc.01']) {
    assert.equal(parseReleaseTag(bad), null, bad)
  }
})

test('环境只收自己的 tag，且版本等于 package.json', () => {
  assert.deepEqual(checkTag('preview', 'v0.2.0-rc.3', '0.2.0'), [])
  assert.deepEqual(checkTag('production', 'v0.2.0', '0.2.0'), [])
  assert.match(checkTag('preview', 'v0.2.0', '0.2.0')[0], /预发布只接受/)
  assert.match(checkTag('production', 'v0.2.0-rc.1', '0.2.0')[0], /正式只接受/)
  assert.match(checkTag('production', 'v0.2.1', '0.2.0')[0], /package.json/)
  assert.throws(() => checkTag('staging', 'v0.2.0', '0.2.0'), /未知环境/)
})

test('发布目录名按时间排序', () => {
  assert.equal(releaseIdFor('v0.2.0-rc.1', new Date('2026-10-09T03:04:05.678Z')), '20261009T030405Z-v0.2.0-rc.1')
})

const deploy = (over = {}) => ({ at: '2026-10-09T03:00:00Z', action: 'deploy', result: 'success', tag: 'v0.2.0-rc.1', commit: C, releaseId: 'R1', path: '/r/R1', ...over })
const accept = (over = {}) => ({ at: '2026-10-09T03:10:00Z', action: 'accept', result: 'success', commit: C, releaseId: 'R1', api: 'passed', ...over })
const evidence = (over = {}) => productionEvidence({
  tag: 'v0.2.0', commit: C, tagsOnCommit: ['v0.2.0-rc.1', 'v0.2.0'], previewRecords: [deploy(), accept()],
  previewHostCommit: C, previewPublicCommit: C, ...over,
})

test('正式证据齐全才放行', () => {
  const result = evidence()
  assert.equal(result.ok, true, result.reasons.join('; '))
  assert.equal(result.deploy.releaseId, 'R1')
})

test('正式证据：缺 rc tag、缺部署、缺验收、验收早于部署、验收跳过网关、预发布已换提交 —— 各自拒绝', () => {
  assert.match(evidence({ tagsOnCommit: ['v0.2.0', 'v0.1.9-rc.1'] }).reasons.join(), /没有 v0.2.0-rc.N/)
  assert.match(evidence({ previewRecords: [deploy({ result: 'failed' }), accept()] }).reasons.join(), /没有该提交.*成功部署/)
  assert.match(evidence({ previewRecords: [deploy({ tag: 'v0.2.0-rc.9' }), accept()] }).reasons.join(), /成功部署/)
  assert.match(evidence({ previewRecords: [deploy()] }).reasons.join(), /验收通过记录/)
  assert.match(evidence({ previewRecords: [accept({ at: '2026-10-09T02:00:00Z' }), deploy()] }).reasons.join(), /验收通过记录/)
  assert.match(evidence({ previewRecords: [deploy(), accept({ api: 'skipped' })] }).reasons.join(), /验收通过记录/)
  assert.match(evidence({ previewRecords: [deploy(), accept({ releaseId: 'R0' })] }).reasons.join(), /验收通过记录/)
  assert.match(evidence({ previewHostCommit: 'd'.repeat(40) }).reasons.join(), /预发布主机当前运行/)
  assert.match(evidence({ previewPublicCommit: null }).reasons.join(), /公网发布身份/)
  assert.equal(evidence({ tag: 'v0.2.0-rc.1' }).ok, false)
})

test('同一提交重新部署 rc.2 后，验收必须针对 rc.2 的发布目录', () => {
  const records = [deploy(), accept(), deploy({ at: '2026-10-09T04:00:00Z', tag: 'v0.2.0-rc.2', releaseId: 'R2', path: '/r/R2' })]
  const result = evidence({ tagsOnCommit: ['v0.2.0-rc.1', 'v0.2.0-rc.2', 'v0.2.0'], previewRecords: records })
  assert.equal(result.ok, false)
  assert.match(result.reasons.join(), /R2/)
})

test('部署记录：半行忽略；回滚目标取当前目录那次部署记下的上一个目录', () => {
  const records = parseRecords([JSON.stringify(deploy({ previous: '/r/R0' })), '{"action":"dep', ''].join('\n'))
  assert.equal(records.length, 1)
  assert.equal(rollbackTarget(records, '/r/R1'), '/r/R0')
  assert.equal(rollbackTarget(records, '/r/other'), null)
  assert.equal(rollbackTarget([deploy({ previous: '/r/R1' })], '/r/R1'), null)
})

test('env 文件：注释、引号、非法行；密钥样式的键名被识别', () => {
  assert.deepEqual(parseEnvFile('# x\n\nA=1\nB="two words"\nC=\'3\'\nD=a=b\n'), { A: '1', B: 'two words', C: '3', D: 'a=b' })
  assert.throws(() => parseEnvFile('just text'), /格式/)
  assert.throws(() => parseEnvFile('lower=1'), /键名/)
  assert.deepEqual(secretLikeKeys({ PORT: '1', CPA_MANAGEMENT_KEY: 'x', SESSION_SECRET: 'x', DATA_PLANE_TOKEN_FILE: '/f', PROXY_PRESETS: 'x', CONSOLE_PASSWORD: 'x' }).sort(),
    ['CONSOLE_PASSWORD', 'CPA_MANAGEMENT_KEY', 'PROXY_PRESETS', 'SESSION_SECRET'])
})

test('入库 env 文件：密钥、发布目标、IP、外部地址都拒绝，本机回环 URL 放行', () => {
  assert.deepEqual(publicEnvProblems({ CPA_BASE_URL: 'http://127.0.0.1:8317', HEALTH: 'http://localhost:8787/x', DATA_DIR: '/opt/x/data', PORT: '8787' }), [])
  const problems = publicEnvProblems({
    SESSION_SECRET: 'x', RELEASE_SSH: 'host', DATA_PLANE_BASE_URL: 'http://192.0.2.5:8793', PUBLIC_GATEWAY_BASE_URL: 'https://api.example.com/v1', NOTE: 'peer 198.51.100.2',
  }).join('\n')
  for (const key of ['SESSION_SECRET', 'RELEASE_SSH', 'DATA_PLANE_BASE_URL', 'PUBLIC_GATEWAY_BASE_URL', 'NOTE']) assert.match(problems, new RegExp(key))
})

test('仓库里的 preview/production env 文件本身合规', async () => {
  const fs = await import('node:fs')
  for (const env of ['preview', 'production']) {
    const parsed = parseEnvFile(fs.readFileSync(new URL(`../deploy/env/${env}.env`, import.meta.url), 'utf8'))
    assert.deepEqual(publicEnvProblems(parsed), [], env)
    assert.equal(parsed.CROSERY_ENV, env)
  }
})

test('发布包不带 QA 交付物与本地状态', () => {
  for (const file of ['docs/qa/deploy/x.md', '.env', '.env.local', 'data/console.db', 'node_modules/a/b.js', 'src/.DS_Store']) assert.equal(shippable(file), false, file)
  for (const file of ['.env.example', 'server/index.ts', 'docs/cli.md', 'deploy/env/preview.env']) assert.equal(shippable(file), true, file)
})

test('release.mjs 能加载：无参数时打印用法并以 2 退出（内嵌 shell 里的 ${} 会在加载时被 JS 求值）', async () => {
  const { spawnSync } = await import('node:child_process')
  const result = spawnSync(process.execPath, [new URL('./release.mjs', import.meta.url).pathname], { encoding: 'utf8' })
  assert.equal(result.status, 2, result.stderr)
  assert.match(result.stderr, /用法/)
})

test('中转代码闭包：相对导入（.js → .ts）、type 导入不算、内置模块不算、外部包带上 package-lock.json', () => {
  const tree = {
    'server/main.ts': "import fs from 'node:fs'\nimport { a } from './a.js'\nimport type { T } from './typesOnly.js'\nexport * from './b.js'\n",
    'server/a.ts': "import {\n  b,\n  type B,\n} from './b.js'\nimport path from 'path'\nconst lazy = () => import('../lib/c.js')\n",
    'server/b.ts': "import './a.js'\n",
    'lib/c.js': 'export const c = 1\n',
    'server/typesOnly.ts': "import x from 'left-pad'\n",
  }
  const read = (file) => tree[file] ?? null
  assert.deepEqual(relayCodeFiles(read, 'server/main.ts'), ['lib/c.js', 'server/a.ts', 'server/b.ts', 'server/main.ts'])
  tree['server/b.ts'] += "import express from 'express'\n"
  assert.deepEqual(relayCodeFiles(read, 'server/main.ts'), ['lib/c.js', 'package-lock.json', 'server/a.ts', 'server/b.ts', 'server/main.ts'])
})

test('仓库里的中转进程只加载自己的模块：不带控制台（db/index）也不依赖外部包', async () => {
  const fs = await import('node:fs')
  const read = (file) => fs.existsSync(new URL(`../${file}`, import.meta.url)) ? fs.readFileSync(new URL(`../${file}`, import.meta.url), 'utf8') : null
  const files = relayCodeFiles(read)
  for (const file of [RELAY_ENTRY, 'server/relayCompressionProxy.ts', 'server/toolCompress.ts', 'server/rtkRelayLedger.ts']) assert.ok(files.includes(file), file)
  for (const file of ['server/db.ts', 'server/index.ts', 'server/config.ts', 'package-lock.json']) assert.ok(!files.includes(file), file)
  assert.ok(files.every((file) => read(file) !== null), files.join(' '))
})

test('发布后中转：没装/没 enable 跳过，代码或配置没变保持，变了才重启', () => {
  const sha = (char) => char.repeat(64)
  const manifest = (entries) => Object.entries(entries).map(([file, hash]) => `${sha(hash)}  ${file}`).join('\n')
  const files = [RELAY_ENTRY, 'server/relayCompressionProxy.ts']
  const env = { RTK_RELAY_PORT: '8792', PORT: '8787', DATA_DIR: '/data', USAGE_RETENTION_DAYS: '30' }
  const from = { manifest: manifest({ [RELAY_ENTRY]: 'a', 'server/relayCompressionProxy.ts': 'b', 'server/index.ts': 'c', 'src/App.vue': 'd' }), files, env }
  const to = (over = {}, envOver = {}, extra = {}) => ({
    manifest: manifest({ [RELAY_ENTRY]: 'a', 'server/relayCompressionProxy.ts': 'b', 'server/index.ts': 'e', 'src/App.vue': 'f', ...over }),
    files, env: { ...env, ...envOver }, ...extra,
  })
  const decide = (target, state = {}) => relayRestartDecision({ installed: true, enabled: true, dropIn: true, from, to: target, ...state })

  assert.equal(decide(to(), { installed: false }).action, 'skip')
  assert.equal(decide(to({ 'server/relayCompressionProxy.ts': '9' }), { enabled: false }).action, 'skip')
  const keep = decide(to({}, { USAGE_RETENTION_DAYS: '7' }))
  assert.deepEqual({ action: keep.action, changed: keep.changed }, { action: 'keep', changed: [] }, '只改控制台代码与无关配置')

  assert.deepEqual(decide(to({ 'server/relayCompressionProxy.ts': '9' })).changed, ['server/relayCompressionProxy.ts'])
  assert.deepEqual(decide(to({}, { RTK_RELAY_PORT: '8793' })).changed, ['env RTK_RELAY_PORT'])
  assert.deepEqual(decide(to({}, { RTK_RELAY_TARGET: 'http://127.0.0.1:9000' })).changed, ['env RTK_RELAY_TARGET'])
  assert.deepEqual(decide(to(), { dropIn: false }).changed, ['drop-in'])
  const imported = decide(to({ 'server/newHelper.ts': '1' }, {}, { files: [...files, 'server/newHelper.ts'] }))
  assert.deepEqual({ action: imported.action, changed: imported.changed }, { action: 'restart', changed: ['server/newHelper.ts'] }, '入口新导入的文件')
  assert.equal(decide(to(), {}).action, 'keep')
  assert.match(decide(to({ 'server/relayCompressionProxy.ts': '9' })).reason, /relayCompressionProxy/)

  const unknownFrom = relayRestartDecision({ installed: true, enabled: true, dropIn: true, from: { manifest: '', files: null, env: {} }, to: to() })
  assert.equal(unknownFrom.action, 'restart', '中转运行的目录没有清单：按变了处理')
  const older = to()
  older.manifest = manifest({ 'server/index.ts': 'e' })
  assert.equal(decide(older).action, 'keep', '回滚到没有中转入口的发布：不重启')
  assert.equal(manifestHashes(`${sha('a')}  a b.txt\nbroken\n`).get('a b.txt'), sha('a'))
})

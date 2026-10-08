import assert from 'node:assert/strict'
import test from 'node:test'
import {
  checkTag, parseEnvFile, parseRecords, parseReleaseTag, productionEvidence, publicEnvProblems, releaseIdFor, rollbackTarget, secretLikeKeys, shippable,
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

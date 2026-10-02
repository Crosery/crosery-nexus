// cradmin gateway：main() + 假 fetch（不起服务端）。
import assert from 'node:assert/strict'
import test from 'node:test'
import { Readable } from 'node:stream'
import { main } from './cradmin.mjs'

const NOW = Date.now()
const token = () => `${NOW + 3_600_000}.v2.admin.-.0123456789abcdef`
const json = (status, body, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } })
const sink = () => {
  const chunks = []
  return { isTTY: false, columns: 0, write: chunk => { chunks.push(String(chunk)); return true }, text: () => chunks.join('') }
}

const CATALOG = {
  groups: [{ id: 'images', title: { en: 'Images', zh: '图像' } }, { id: 'privacy', title: { en: 'Privacy', zh: '隐私' } }],
  items: [
    { key: 'vision', group: 'images', control: 'model', name: { en: 'Image recognition', zh: '识图模型' }, sub: { en: '', zh: '' } },
    { key: 'imageGen', group: 'images', control: 'model', name: { en: 'Image generation', zh: '生图模型' }, sub: { en: '', zh: '' } },
    { key: 'redact', group: 'privacy', control: 'switch', name: { en: 'Mask secrets', zh: '脱敏密钥' }, sub: { en: '', zh: '' } },
    { key: 'noStats', group: 'privacy', control: 'forced-off', name: { en: 'Count me as a user', zh: '计入用户数' }, sub: { en: '', zh: '' } },
  ],
  copy: {}, limits: {},
}
const VIEW = {
  available: true, reason: null, message: null, revision: '3fe2ff99587e17dfe0ea707ffd0eccc088824433', catalog: CATALOG,
  values: { redact: false, redactPersonal: false, redactWords: [], redactRules: [], vision: '', imageGen: 'off' },
  models: {
    vision: { auto: 'c-1/gpt-4o-mini', effective: 'c-1/gpt-4o-mini', stale: false, options: [{ id: 'c-1/gpt-4o-mini', label: 'gpt-4o-mini', provider: 'OpenAI 兼容', kind: 'chat' }] },
    imageGen: { auto: '', effective: '', stale: false, admitted: false, options: [] },
  },
  telemetry: { off: true, forced: true }, applies: 'next-request', upstream: { candidateRevision: null, added: [], changed: [], removed: [] },
}
const CPA = { ...VIEW, available: false, reason: 'cpa_engine', message: '仅 Magpie 网关可用 · 当前网关是 CPA', values: null, models: null, telemetry: null }

async function run(argv, view = VIEW) {
  const calls = []
  const stdout = sink()
  const stderr = sink()
  const fetch = async (url, init) => {
    const call = { method: init.method, path: new URL(url).pathname, body: init.body ? JSON.parse(init.body) : undefined }
    calls.push(call)
    if (call.path === '/api/login') return json(200, { ok: true }, { 'set-cookie': `crosery_console_session=${token()}` })
    if (call.path === '/api/logout') return json(200, { ok: true })
    if (call.method === 'GET' && call.path === '/api/gateway/settings') return json(200, view)
    if (call.method === 'PUT' && call.path === '/api/gateway/settings') return json(200, { ...view, values: { ...view.values, ...call.body } })
    return json(404, { error: '接口不存在' })
  }
  const code = await main(argv, {
    env: { CONSOLE_PASSWORD: 'unit-pass', CRADMIN_SESSION_CACHE: 'off', CRADMIN_KEYCHAIN: 'off', CRADMIN_HOME: '/nonexistent-cradmin-home', NO_COLOR: '1' },
    stdin: Readable.from([]), stdout, stderr, interactive: false, cwd: '/', home: '/nonexistent-cradmin-home', fetch, platform: 'linux',
  })
  return { code, stdout: stdout.text(), stderr: stderr.text(), puts: calls.filter(call => call.method === 'PUT') }
}

test('gateway settings：按 Magpie 分组列出当前值；--json 只给结构化结果', async () => {
  const human = await run(['gateway', 'settings'])
  assert.equal(human.code, 0, human.stderr)
  assert.match(human.stdout, /识图模型\s+自动 · gpt-4o-mini · OpenAI 兼容/)
  assert.match(human.stdout, /生图模型\s+关闭/)
  assert.match(human.stdout, /计入用户数\s+已关闭（控制台强制）/)
  const data = JSON.parse((await run(['gateway', 'settings', '--json'])).stdout)
  assert.equal(data.available, true)
  assert.deepEqual(data.models.vision.options, ['c-1/gpt-4o-mini'])
  assert.equal(data.models.imageGen.admitted, false)
})

test('gateway set：非交互没给 --yes 退出 2 且不写；--yes 才发 PUT，auto 写成空串', async () => {
  const refused = await run(['gateway', 'set', 'redact', 'on'])
  assert.equal(refused.code, 2)
  assert.equal(refused.puts.length, 0)
  const ok = await run(['gateway', 'set', 'redact', 'on', '--yes'])
  assert.equal(ok.code, 0, ok.stderr)
  assert.deepEqual(ok.puts.map(call => call.body), [{ redact: true }])
  const auto = await run(['gateway', 'set', 'imageGen', 'auto', '--yes'])
  assert.deepEqual(auto.puts.map(call => call.body), [{ imageGen: '' }])
  const words = await run(['gateway', 'set', 'redactWords', '代号甲，acme', '--yes'])
  assert.deepEqual(words.puts.map(call => call.body), [{ redactWords: ['代号甲', 'acme'] }])
  const same = await run(['gateway', 'set', 'redact', 'off', '--yes'])
  assert.equal(same.puts.length, 0)
  assert.match(same.stdout, /已是这个值/)
})

test('gateway set：未知 key / 坏值是用法错误；CPA 网关读出原因、写入退出 1', async () => {
  assert.equal((await run(['gateway', 'set', 'lanKey', 'x', '--yes'])).code, 2)
  assert.equal((await run(['gateway', 'set', 'redact', 'maybe', '--yes'])).code, 2)
  assert.equal((await run(['gateway', 'set', 'redactRules', '{bad', '--yes'])).code, 2)
  const read = await run(['gateway', 'settings'], CPA)
  assert.equal(read.code, 0)
  assert.match(read.stdout + read.stderr, /仅 Magpie 网关可用/)
  const write = await run(['gateway', 'set', 'redact', 'on', '--yes'], CPA)
  assert.equal(write.code, 1)
  assert.equal(write.puts.length, 0)
})

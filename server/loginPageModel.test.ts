import assert from 'node:assert/strict'
import test from 'node:test'
import { describeLoginError, lockError, lockSeconds, mainField, precheck } from '../src/features/auth/loginModel.js'
import { createSessionStore, keyGoneNotice } from '../src/app/sessionStore.js'
import { glyphBudget, isStacked, sphereTarget } from '../src/ui/login/globe.js'

/*
 * /login without the DOM: what a failed sign-in says, the per-mode 429 lock, the pre-checks that keep obviously
 * wrong input from spending the per-IP attempt budget, and where the glyph globe sits beside or above the plate.
 */

const apiError = (status: number, code: string | null = null, extra: Record<string, unknown> = {}) => ({ status, code, message: '', retryAfterSec: null, ...extra })

test('login precheck: nothing that cannot succeed is sent', () => {
  assert.deepEqual(precheck({ mode: 'key', key: '' }), { field: 'key', text: '◆ 粘贴你的 API Key' })
  assert.match(precheck({ mode: 'key', key: 'sk-team-abc\ndef12345' })!.text, /空格或换行/)
  assert.match(precheck({ mode: 'key', key: 'gw key with spaces' })!.text, /空格或换行/)
  assert.equal(precheck({ mode: 'key', key: 'sk-growth-team-0123456789abcdef' }), null)
  // AI-06: the server accepts any 8–512 char key (gateway-configured keys need not start with sk-)
  assert.equal(precheck({ mode: 'key', key: 'cpa-team-key-0123' }), null, 'a gateway-side key without sk- is sent')
  assert.equal(precheck({ mode: 'key', key: 'sk-abc12' }), null, 'a short sk- key of 8 chars is sent')
  assert.equal(precheck({ mode: 'key', key: 'k'.repeat(512) }), null)
  assert.match(precheck({ mode: 'key', key: 'sk-abc1' })!.text, /太短/, '7 chars can never match a key')
  assert.match(precheck({ mode: 'key', key: 'k'.repeat(513) })!.text, /太长/)
  assert.deepEqual(precheck({ mode: 'admin', username: '', password: 'x' }), { field: 'username', text: '◆ 输入账号' })
  assert.deepEqual(precheck({ mode: 'admin', username: 'admin', password: '' }), { field: 'password', text: '◆ 输入密码' })
  assert.equal(precheck({ mode: 'admin', username: 'admin', password: ' spaced ' }), null, 'passwords are sent as typed')
})

test('login errors: plain words under the field to blame, raw codes only as a suffix', () => {
  assert.deepEqual(describeLoginError(apiError(401, 'key_invalid'), 'key'), { field: 'key', text: '◆ Key 无效 · 检查是否复制完整' })
  assert.deepEqual(describeLoginError(apiError(401, 'key_invalid'), 'key', 'sk-team-0123456789'), { field: 'key', text: '◆ Key 无效 · 检查是否复制完整' })
  assert.deepEqual(describeLoginError(apiError(401, 'key_invalid'), 'key', 'hunter2-admin-password'), { field: 'key', text: '◆ Key 无效 · 控制台发的 Key 以 sk- 开头' }, 'the sk- hint is soft: after the server said no')
  assert.deepEqual(describeLoginError(apiError(401, 'key_disabled'), 'key'), { field: 'key', text: '◆ Key 已被停用 · 找管理员恢复' })
  assert.deepEqual(describeLoginError(apiError(401, 'invalid_credentials'), 'admin'), { field: 'password', text: '◆ 账号或密码不对' })
  assert.deepEqual(describeLoginError(apiError(502), 'admin'), { field: 'password', text: '◆ 服务器出错 · 稍后再试 · 502' })
  assert.deepEqual(describeLoginError(new TypeError('Failed to fetch'), 'key'), { field: 'key', text: '◆ 连不上服务器 · 检查网络后重试' })
  assert.deepEqual(describeLoginError(apiError(403, 'forbidden', { message: '来源不被允许' }), 'key'), { field: 'key', text: '◆ 来源不被允许' })
  assert.deepEqual(describeLoginError(apiError(400), 'key'), { field: 'key', text: '◆ 登录失败 · 400' })
  for (const mode of ['key', 'admin'] as const) {
    const { text } = describeLoginError(apiError(500, null, { message: 'SqliteError: database is locked at /srv/db' }), mode)
    assert.ok(!text.includes('Sqlite'), 'server internals never reach the login page')
  }
})

test('login 429: a lock with a ticking clock and one fixed announcement', () => {
  assert.equal(lockSeconds(apiError(401, 'key_invalid')), null)
  assert.equal(lockSeconds(new Error('offline')), null)
  assert.equal(lockSeconds(apiError(429, 'rate_limited', { retryAfterSec: 41.2 })), 42)
  assert.equal(lockSeconds(apiError(429, 'rate_limited')), 30, 'no Retry-After: wait 30s rather than unlock at once')
  const a = lockError('key', 42_000, 42)
  const b = lockError('key', 41_000, 42)
  assert.equal(a.text, '◆ 尝试过多 · 00:42 后再试')
  assert.equal(b.text, '◆ 尝试过多 · 00:41 后再试')
  assert.equal(a.live, b.live, 'the screen reader hears it once, not every second')
  assert.equal(a.live, '◆ 尝试过多 · 42 秒后再试')
  assert.equal(lockError('admin', 900_000, 900).live, '◆ 尝试过多 · 约 15 分钟后再试')
  assert.equal(lockError('admin', 1, 900).field, 'password')
  assert.equal(mainField('key'), 'key')
})

test('globe placement: the dial never touches the plate, labels stay on screen, phones use the room above', () => {
  const desktop = (W: number, H: number) => {
    const left = Math.min(0.6 * W, W - 468) // LoginGlobe dock: clamp(24px, 60vw, 100vw − 468px)
    const s = sphereTarget(W, H, { left, top: H / 2 - 200 })
    return { ...s, dialRight: s.x + 1.12 * s.r + 10, cropLeft: left - 14, labelsLeft: s.x - 1.36 * s.r - 80 }
  }
  for (const [W, H] of [[1440, 900], [1280, 800], [1097, 935], [1097, 900], [1024, 768], [960, 900], [1920, 1080], [900, 600], [800, 700]]) {
    assert.equal(isStacked(W, H), false, `${W}×${H} is side by side`)
    const g = desktop(W, H)
    assert.ok(g.cropLeft - g.dialRight >= 27.9, `${W}×${H}: dial ${Math.round(g.dialRight)} vs crop marks ${Math.round(g.cropLeft)}`)
    assert.ok(g.labelsLeft >= 23.9, `${W}×${H}: left orbit labels start at ${Math.round(g.labelsLeft)}`)
    assert.ok(g.r <= 0.31 * H + 1e-9 && g.r <= 0.2 * W + 1e-9)
  }
  const wide = desktop(1440, 900)
  assert.ok(wide.r > 270, 'a roomy viewport keeps the full-size sphere')
  // 390×844, key plate docked at the bottom: centred in the paper above the crop marks, clear of both edges
  const phone = sphereTarget(390, 844, { left: 16, top: 437 })
  const room = 437 - 14
  assert.ok(Math.abs(phone.y - room / 2) < 4)
  assert.ok(phone.y - (1.12 * phone.r + 10) >= 18 && room - (phone.y + 1.12 * phone.r + 10) >= 14)
  assert.ok(phone.r <= 0.29 * 390 && phone.r > 100)
  // portrait tablets stack instead of shrinking the sphere beside the plate
  for (const [W, H] of [[768, 1024], [900, 900], [834, 1112]]) assert.equal(isStacked(W, H), true, `${W}×${H} stacks`)
  const tablet = sphereTarget(768, 1024, { left: 174, top: 1024 - 16 - 400 })
  assert.ok(tablet.r > 180 && tablet.r <= 240, `768×1024 sphere r=${Math.round(tablet.r)}`)
  // the plate fills a short screen: keep the old top-30% spot (the sheet covers the rest)
  assert.deepEqual(sphereTarget(320, 568, { left: 16, top: 150 }), { x: 160, y: 113.60000000000001, r: 80 })
})

test('globe density: a smaller sphere gets fewer glyphs, not a darker blob', () => {
  assert.equal(glyphBudget(279, false), 1700)
  assert.equal(glyphBudget(320, false), 1700, 'never more than the desktop budget')
  assert.equal(glyphBudget(200, false), 874)
  assert.equal(glyphBudget(112, false), 520, 'never under the phone budget')
  assert.equal(glyphBudget(279, true), 520, 'compact devices keep 520 whatever the size')
})

/* ── session store (AI-11) and the key-gone notice (AI-16) ── */

type Info = import('../src/types.js').SessionInfo
function deferred() {
  let resolve!: (info: Info) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<Info>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}
const ADMIN: Info = { authenticated: true, role: 'admin', user: { name: 'admin' } }
const KEY_B: Info = { authenticated: true, role: 'key', key: { name: 'b', masked: 'sk-bb…bbbb' } }

test('session store: a probe that started before sign-out never brings the old session back', async () => {
  const probes: Array<ReturnType<typeof deferred>> = []
  const store = createSessionStore(() => { const d = deferred(); probes.push(d); return d.promise })
  store.apply(ADMIN)
  const late = store.load(true) // e.g. onRoleDenied during a cross-tab switch
  store.clear() // the user signs out before the answer arrives
  probes[0].resolve(ADMIN)
  const after = await late
  assert.equal(after.authenticated, false, 'the late answer is outdated by the sign-out')
  assert.equal(store.state.role, null)
  assert.equal(store.identity(), '')
})

test('session store: force always starts a new probe; the older answer is ignored and its callers get the newer one', async () => {
  const probes: Array<ReturnType<typeof deferred>> = []
  const store = createSessionStore(() => { const d = deferred(); probes.push(d); return d.promise })
  const first = store.load()
  const shared = store.load()
  assert.equal(shared, first, 'unforced callers share the probe in flight')
  const forced = store.load(true)
  assert.equal(probes.length, 2, 'a forced probe does not reuse the one in flight')
  probes[1].resolve(KEY_B)
  probes[0].resolve(ADMIN) // the older probe answers last
  const [a, b] = await Promise.all([first, forced])
  assert.equal(store.state.role, 'key', 'the newest probe wins regardless of arrival order')
  assert.equal(a.role, 'key')
  assert.equal(b.role, 'key')
  assert.equal(store.identity(), 'key||b|sk-bb…bbbb')
})

test('session store: two keys with the same name and masked head/tail are still two identities (server ref)', () => {
  const store = createSessionStore(() => new Promise<Info>(() => {}))
  store.apply({ authenticated: true, role: 'key', key: { name: 'team', masked: 'sk-te…a1b2', ref: '1111111111111111' } })
  const first = store.identity()
  store.apply({ authenticated: true, role: 'key', key: { name: 'team', masked: 'sk-te…a1b2', ref: '2222222222222222' } })
  assert.notEqual(store.identity(), first, 'the key shell remounts: no rows or cursor of the other key survive')
})

test('session store: a failed probe keeps an earlier answer; session_unavailable is reported, not read as signed out', async () => {
  const probes: Array<ReturnType<typeof deferred>> = []
  let unavailable = 0
  const store = createSessionStore(() => { const d = deferred(); probes.push(d); return d.promise }, { onUnavailable: () => { unavailable += 1 } })
  const cold = store.load()
  probes[0].reject({ status: 503, code: 'session_unavailable' })
  assert.equal((await cold).authenticated, false, 'nothing known yet: signed out for the router')
  assert.equal(store.state.checked, true)
  assert.equal(unavailable, 1)
  store.apply(KEY_B)
  const warm = store.load(true)
  probes[1].reject(new TypeError('Failed to fetch'))
  assert.equal((await warm).role, 'key', 'a network blip is not a sign-out')
  const busy = store.load(true)
  probes[2].reject({ status: 503, code: 'session_unavailable' })
  assert.equal((await busy).role, 'key', 'a busy database is not a sign-out either')
  assert.equal(unavailable, 1, 'no login-plate notice while signed in: it would surface later, after a normal sign-out')
})

test('key-gone notice: client words, no doubled 重新登录, a disabled key is sent to the admin', () => {
  assert.equal(keyGoneNotice('key_invalid'), 'API Key 已失效 · 重新登录')
  assert.equal(keyGoneNotice('key_disabled'), 'API Key 已被停用 · 找管理员恢复')
  assert.equal(keyGoneNotice('forbidden_role'), null)
  assert.equal(keyGoneNotice(null), null)
})

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { createApp, defineComponent, effectScope, h, nextTick } from 'vue'
import { createMemoryHistory, createRouter } from 'vue-router'
import { ApiError } from '../src/api/http.js'
import { errorReason } from '../src/lib/errors.js'
import { paginate, resettingField, useQueryState } from '../src/lib/listState.js'
import { channelStatusFilter } from '../src/features/channels/channelModel.js'
import { batchTargets, legacyModelsQuery, type ModelRow } from '../src/features/models/modelRows.js'
import { useSheetWrite, whenIdle } from '../src/lib/resource.js'
import { jobAction, type SyncJobLike } from '../src/features/settings/settingsModel.js'
import { buildAccounts, classifyResetError, classifyResetSuccess, filterGroups, groupAccounts, mergeAccountsPayload, PROXY_CUSTOM, proxyKeepsDraft, proxySentAfterWrite, verifyOutcome } from '../src/features/accounts/model.js'

/*
 * review-frontend-flows (FF-01 … FF-32): the agreed functional findings on the admin pages. Pure logic is
 * exercised directly; a few template facts that cannot run under node (a disabled hidden submit, an input type)
 * are pinned on the SFC source.
 */

// keysModel (and modules that import it) are loaded by URL, the keysView.test.ts pattern: their extensionless type
// imports must stay out of the server tsc build's NodeNext resolution
type Loose = any
const { createKeyWithQuota, quotaDraftOf, validateQuotaDraft } = await import(new URL('../src/features/keys/keysModel.ts', import.meta.url).href)
const overview = await import(new URL('../src/features/overview/model.ts', import.meta.url).href)

const src = (path: string) => readFileSync(new URL(`../src/${path}`, import.meta.url), 'utf8')
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const deferred = <T>() => {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

/* ── FF-01 / FF-13: one write per sheet; a reopened sheet is a new generation ───────────────────── */

test('FF-01 sheet write: a second submit while the first is pending sends nothing', async () => {
  const sheet = useSheetWrite()
  sheet.renew()
  const gate = deferred<string>()
  let calls = 0
  const write = () => {
    calls += 1
    return gate.promise
  }
  const first = sheet.run(write, {})
  const second = await sheet.run(write, {})
  assert.equal(second, false)
  assert.equal(calls, 1)
  assert.equal(sheet.busy.value, true)
  gate.resolve('ok')
  assert.equal(await first, true)
  assert.equal(sheet.busy.value, false)
})

test('FF-01 sheet write: reopening mid-request does not unlock a second create', async () => {
  const sheet = useSheetWrite()
  sheet.renew()
  const gate = deferred<string>()
  let calls = 0
  const pending = sheet.run(() => {
    calls += 1
    return gate.promise
  }, {})
  sheet.renew() // closed and opened again while POST /api/keys is in flight
  assert.equal(sheet.busy.value, true)
  assert.equal(sheet.stale.value, true)
  assert.equal(await sheet.run(() => Promise.resolve('again'), {}), false)
  assert.equal(calls, 1)
  gate.resolve('done')
  await pending
  assert.equal(sheet.busy.value, false)
  assert.equal(sheet.stale.value, false)
})

test('FF-13 sheet write: an old completion still reaches the parent but is told the sheet moved on', async () => {
  const sheet = useSheetWrite()
  sheet.renew()
  const gate = deferred<string>()
  const seen: Array<[string, boolean]> = []
  const pending = sheet.run(() => gate.promise, { done: (result, current) => void seen.push([result, current]) })
  sheet.renew()
  gate.resolve('A saved')
  await pending
  assert.deepEqual(seen, [['A saved', false]])

  const fail = deferred<string>()
  const failures: boolean[] = []
  const next = sheet.run(() => fail.promise, { failed: (_error, current) => void failures.push(current) })
  fail.reject(new Error('boom'))
  await next
  assert.deepEqual(failures, [true])
})

/* ── FF-05: the server's specific reason survives ──────────────────────────────────────────────── */

test('FF-05 errorReason keeps the server message for 4xx/5xx and falls back for generic or network errors', () => {
  assert.equal(errorReason(new ApiError(400, '模型扫描失败。上游返回 HTTP 401', {})), '模型扫描失败。上游返回 HTTP 401')
  assert.equal(errorReason(new ApiError(409, '渠道“x”已存在', {})), '渠道“x”已存在')
  assert.equal(errorReason(new ApiError(502, '网关拒绝写入', {})), '网关拒绝写入')
  assert.equal(errorReason(new ApiError(500, '请求失败 500', {})), '稍后重试通常就好了；一直失败请把下面这行发给维护者。')
  assert.equal(errorReason(new TypeError('Failed to fetch')), '请检查网络或服务是否在运行，然后重试。')
  assert.equal(errorReason(new ApiError(400, '', {})), '请检查填写的内容后重试。')
})

/* ── FF-06: two URL writers on one page do not revert each other ────────────────────────────────── */

async function twoWriters(path: string) {
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/:p(.*)*', component: defineComponent({ render: () => h('div') }) }] })
  await router.push(path)
  const app = createApp({ render: () => h('div') })
  app.use(router)
  const scope = effectScope()
  const pair = app.runWithContext(() => scope.run(() => ({ a: useQueryState({ q: '' }), b: useQueryState({ show: 'all' }) })))!
  return { router, scope, ...pair }
}

test('FF-06 typing then clicking a filter: the filter click survives the search flush', async () => {
  const { router, scope, a, b } = await twoWriters('/accounts')
  a.state.q = 'gmail'
  await sleep(100)
  b.state.show = 'cool'
  await sleep(600)
  await nextTick()
  assert.equal(b.state.show, 'cool')
  assert.equal(a.state.q, 'gmail')
  assert.deepEqual({ ...router.currentRoute.value.query }, { q: 'gmail', show: 'cool' })
  scope.stop()
})

test('FF-06 clicking a filter then typing: the typed text survives the filter flush', async () => {
  const { router, scope, a, b } = await twoWriters('/accounts')
  b.state.show = 'cool'
  await sleep(120)
  a.state.q = 'gma'
  await sleep(600)
  await nextTick()
  assert.equal(a.state.q, 'gma')
  assert.equal(b.state.show, 'cool')
  assert.deepEqual({ ...router.currentRoute.value.query }, { show: 'cool', q: 'gma' })
  scope.stop()
})

test('FF-06 Back still restores the view (URL changes win when nothing is pending)', async () => {
  const { router, scope, a, b } = await twoWriters('/accounts?q=x&show=pause')
  await router.push('/accounts')
  await sleep(10)
  assert.equal(a.state.q, '')
  assert.equal(b.state.show, 'all')
  router.back()
  await sleep(50)
  await nextTick()
  assert.equal(a.state.q, 'x')
  assert.equal(b.state.show, 'pause')
  scope.stop()
})

test('FF-06 Back during a pending search edit: the restored URL wins (the debounce does not overwrite it)', async () => {
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/:p(.*)*', component: defineComponent({ render: () => h('div') }) }] })
  await router.push('/accounts?q=old')
  const app = createApp({ render: () => h('div') })
  app.use(router)
  const scope = effectScope()
  const a = app.runWithContext(() => scope.run(() => useQueryState({ q: '' })))!
  await router.push('/accounts?q=new')
  await sleep(10)
  assert.equal(a.state.q, 'new')
  a.state.q = 'newer' // still inside the 250 ms debounce
  await sleep(50)
  router.back()
  await sleep(600)
  await nextTick()
  assert.equal(a.state.q, 'old')
  assert.equal(router.currentRoute.value.query.q, 'old')
  scope.stop()
})

test('FF-06 own write landing after more typing keeps the later keystrokes', async () => {
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/:p(.*)*', component: defineComponent({ render: () => h('div') }) }] })
  await router.push('/accounts')
  const app = createApp({ render: () => h('div') })
  app.use(router)
  const scope = effectScope()
  const a = app.runWithContext(() => scope.run(() => useQueryState({ q: '' })))!
  a.state.q = 'gm'
  a.flush() // router.replace({ q: 'gm' }) is in flight
  a.state.q = 'gma' // typed before it landed
  await sleep(20)
  await nextTick()
  assert.equal(a.state.q, 'gma')
  await sleep(400)
  await nextTick()
  assert.equal(router.currentRoute.value.query.q, 'gma')
  scope.stop()
})

/* ── FF-01 / FF-02 / FF-13 / FF-30: the Key sheets ─────────────────────────────────────────────── */

test('FF-01 Key sheets: Enter cannot resubmit — guard in submit/save and the hidden submit is disabled while busy', () => {
  const editor = src('features/keys/KeyEditorSheet.vue')
  assert.match(editor, /<button type="submit" class="kx-form__submit"[^>]*:disabled="busy"/)
  assert.match(editor, /useSheetWrite\(\)/)
  assert.match(editor, /<fieldset class="kx-form__lock" :disabled="busy && !stale">/)
  const quota = src('features/keys/KeyQuotaSheet.vue')
  assert.match(quota, /<button type="submit" class="kx-form__submit"[^>]*:disabled="busy"/)
  assert.match(quota, /useSheetWrite\(\)/)
})

test('FF-02 create applies the quota validated at submit, even if the field is cleared while the create is pending', async () => {
  const gate = deferred<{ key: string; item: { id: string } }>()
  const sent: unknown[] = []
  const draft = { daily: '10', weekly: '', total: '' }
  const snapshot = validateQuotaDraft(draft).values
  const pending = createKeyWithQuota(
    { create: () => gate.promise, quota: async (id: string, values: unknown) => void sent.push([id, values]) },
    { name: 'k' },
    snapshot,
    () => 'x',
  )
  draft.daily = '' // the person starts retyping while POST /api/keys is in flight
  gate.resolve({ key: 'sk-test', item: { id: 'id1' } })
  const out = await pending
  assert.deepEqual(sent, [['id1', { dailyUsd: 10, weeklyUsd: 0, totalUsd: 0 }]])
  assert.equal(out.quotaError, null)
  assert.equal(out.created.key, 'sk-test')
})

test('FF-02 a failed quota write after a successful create is reported, never dropped', async () => {
  const out = await createKeyWithQuota(
    { create: async () => ({ key: 'sk', item: { id: 'i' } }), quota: async () => { throw new Error('额度服务不可用') } },
    {},
    { dailyUsd: 5, weeklyUsd: 0, totalUsd: 0 },
    (error: unknown) => (error as Error).message,
  )
  assert.equal(out.quotaError, '额度服务不可用')
  const none = await createKeyWithQuota({ create: async () => ({ key: 'sk', item: { id: 'i' } }), quota: async () => assert.fail('no quota to send') }, {}, { dailyUsd: 0, weeklyUsd: 0, totalUsd: 0 }, () => '')
  assert.equal(none.quotaError, null)
})

test('FF-29 an untouched stored quota with more than 2 decimals saves unchanged', () => {
  const key = { quota: { dailyUsd: 12.345, weeklyUsd: 0, totalUsd: 100.1 } } as never
  const original = quotaDraftOf(key)
  assert.deepEqual(original, { daily: '12.345', weekly: '', total: '100.1' })
  const untouched = validateQuotaDraft({ ...original }, original)
  assert.deepEqual(untouched.errors, {})
  assert.deepEqual(untouched.values, { dailyUsd: 12.345, weeklyUsd: 0, totalUsd: 100.1 })
  // a value the person types still follows the 2-decimal rule
  assert.ok(validateQuotaDraft({ ...original, daily: '12.346' }, original).errors.daily)
  // cross-window order still applies to stored values
  assert.ok(validateQuotaDraft({ daily: '12.345', weekly: '10', total: '' }, { daily: '12.345', weekly: '', total: '' }).errors.daily)
})

test('FF-30 created-key copy no longer claims it can never be shown again', () => {
  const reveal = src('features/keys/KeyRevealSheet.vue')
  assert.doesNotMatch(reveal, /无法再查看|只显示这一次/)
  assert.match(reveal, /关闭后需确认才能再次显示/)
  assert.doesNotMatch(src('features/keys/KeyEditorSheet.vue'), /只显示一次/)
  assert.doesNotMatch(src('features/settings/PrefsSection.vue'), /新建时只出现一次/)
})

/* ── FF-26 / FF-27: settings ─────────────────────────────────────────────────────────────────── */

const job = (over: Partial<SyncJobLike> = {}): SyncJobLike => ({
  id: 'pricing', label: '价格元数据', kind: 'in-process', intervalMs: 3_600_000, lastRunAt: '2026-10-02T05:00:00Z', nextRunAt: null,
  state: 'idle', lastResult: 'ok', lastError: null, summary: null, backoffUntil: null, backoffLevel: 0, requests24h: 3, history: [],
  canRunNow: true, runCooldownUntil: null, ...over,
})

test('FF-27 run-now stays locked after 202 until the refreshed status shows the run or its cooldown', () => {
  const at = Date.parse('2026-10-02T06:00:00Z')
  assert.equal(jobAction(job(), at + 500, at).kind, 'running')
  assert.equal(jobAction(job(), at + 500, at).label, '已提交')
  // the refreshed status reflects the run: the overlay gives way to the server's own state
  assert.equal(jobAction(job({ state: 'running' }), at + 2000, at).kind, 'running')
  assert.equal(jobAction(job({ runCooldownUntil: new Date(at + 300_000).toISOString() }), at + 2000, at).kind, 'cooldown')
  assert.equal(jobAction(job({ lastRunAt: new Date(at + 1000).toISOString() }), at + 2000, at).kind, 'run')
  // never stuck: after a minute without news the button comes back
  assert.equal(jobAction(job(), at + 61_000, at).kind, 'run')
  assert.equal(jobAction(job(), at + 500).kind, 'run')
})

test('FF-26 pages reuse the shell live sources', () => {
  const shell = src('shell/useAdminStatus.ts')
  assert.match(shell, /provide\(ADMIN_LIVE, /)
  const settings = src('features/settings/SettingsPage.vue')
  assert.match(settings, /useSharedAdminLive\(\)/)
  assert.match(settings, /shared\?\.sync \?\?/)
  const overview = src('features/overview/OverviewPage.vue')
  assert.match(overview, /useSharedAdminLive\(\)/)
  assert.match(overview, /shared\?\.pulse \?\?/)
})

/* ── FF-07 / FF-08 / FF-09 / FF-20 / FF-25: 概览 ───────────────────────────────────────────────── */

const SOURCES = (over: Record<string, string> = {}) =>
  ['Key', '账号', '渠道', '同步', '内核'].map((label) => ({ label, state: over[label] ?? 'ready' }))

test('FF-07 inspection: 全部正常 only when every required source was read', () => {
  assert.deepEqual(overview.inspection(SOURCES()), { state: 'complete', words: '全部正常' })
  assert.deepEqual(overview.inspection(SOURCES({ 账号: 'empty' })), { state: 'complete', words: '全部正常' })
  assert.deepEqual(overview.inspection(SOURCES({ 账号: 'error' })), { state: 'partial', words: '巡检不完整 · 账号未读到' })
  assert.deepEqual(overview.inspection(SOURCES({ 账号: 'error', 渠道: 'forbidden', 同步: 'stale' })), { state: 'partial', words: '巡检不完整 · 账号、渠道未读到 · 同步数据陈旧' })
  assert.deepEqual(overview.inspection(SOURCES({ 账号: 'loading' })), { state: 'loading', words: '巡检中… · 账号读取中' })
  const all = Object.fromEntries(['Key', '账号', '渠道', '同步', '内核'].map((k) => [k, 'error']))
  assert.deepEqual(overview.inspection(SOURCES(all)), { state: 'failed', words: '巡检失败 · 数据都没读到' })
  const page = src('features/overview/OverviewPage.vue')
  assert.doesNotMatch(page, /v-else-if="!sev\.length" class="ov-head__ok"/)
  assert.match(page, /insp\.state === 'complete'/)
  // channel error-rate attention comes from /api/overview: an unread overview is not an all-clear either
  assert.deepEqual(overview.inspection([...SOURCES(), { label: '渠道健康', state: 'error' }]), { state: 'partial', words: '巡检不完整 · 渠道健康未读到' })
  assert.match(page, /\.\.\.\(overviewMissing\.value \? \[\] : \[\{ label: '渠道健康', state: overview\.state\.value \}\]\)/)
})

test('FF-08 overview cache hit reads /api/cache-summary (cache-capable models only), like the 缓存 tab', () => {
  // capable: 100 fresh + 100 cached; incapable models add 1800 fresh tokens to the raw trend
  const cache = { points: [{ cacheReadTokens: 100, freshInputTokens: 1900, cacheWriteTokens: 0 }] }
  const summary = { totals: { hitRate: 0.5, cacheReadTokens: 100, cacheWriteTokens: 0 }, excluded: { models: 3, requests: 40 } }
  const cell = (input: Loose) => overview.ledger({ now: Date.now(), ...input }).find((c: Loose) => c.key === 'cache')
  assert.equal(cell({ cache, cacheSummary: summary }).value, '50.0%')
  assert.match(cell({ cache, cacheSummary: summary }).sub, /不含 3 个不缓存的模型/)
  // summary not served yet (404 before restart): the trend figure is labelled as a different population
  const fallback = cell({ cache, cacheSummary: null })
  assert.equal(fallback.value, '5.0%')
  assert.match(fallback.sub, /含不支持缓存的模型/)
  assert.match(src('features/overview/OverviewPage.vue'), /\/api\/cache-summary\?days=1/)
})

test('FF-09 Key burn meter shows the tightest of 日 / 周 / 总', () => {
  const w = (limitUsd: number, spentUsd: number) => ({ limitUsd, spentUsd, ratio: spentUsd / limitUsd, exceeded: false, startsAt: null, resetsAt: null })
  const k = {
    id: 'a', name: 'a', maskedKey: 'sk-•••a', enabled: true, blockedReason: '', lastUsedAt: null,
    quotaState: { daily: w(100, 5), weekly: w(100, 10), total: w(100, 95), exceeded: false },
  }
  const [row] = overview.burnRows([k], null, Date.now())
  assert.equal(row.total.ratio, 0.95)
  assert.deepEqual(overview.tightWindow(row), { label: '总', ratio: 0.95 })
  assert.equal(overview.tightWindow({ ...row, total: { ...row.total, ratio: null } }).label, '周')
  assert.equal(overview.tightWindow({ ...row, today: { ...row.today, ratio: null }, week: { ...row.week, ratio: null }, total: { ...row.total, ratio: null } }), null)
  assert.match(src('features/overview/KeyBurnPlate.vue'), /tightWindow/)
})

test('FF-20 the disabled-channels attention item links to a filter /channels knows', () => {
  const r = overview.attention({ now: Date.now(), channels: [{ name: 'x', enabled: false, stale: false, keyCount: 1, baseUrl: 'https://x', models: [] }] })
  const item = r.items.find((it: Loose) => it.id === 'chan-off')
  assert.equal(item.action.to, '/channels?status=off')
})

test('FF-25 the overview pulse stops asking after a 404 when it polls on its own', () => {
  const page = src('features/overview/OverviewPage.vue')
  assert.match(page, /enabled: \(\) => !pulseMissing\.value/)
  assert.match(page, /watch\(pulse\.error,[\s\S]{0,120}404\) pulseMissing\.value = true/)
})

/* ── FF-04 / FF-10 / FF-11 / FF-14 / FF-15 / FF-16 / FF-17 / FF-23 / FF-24 / FF-31: 账号 ─────────── */

const cred = (name: string, email: string, over: Record<string, unknown> = {}) => ({ name, type: 'codex', label: email, email, account: email, disabled: false, status: 'active', ...over })
const rowsOf = (...creds: Array<ReturnType<typeof cred>>) => buildAccounts(creds as never, [], Date.now())

test('FF-04 verify: an existing account is never taken as the new one', () => {
  const before = rowsOf(cred('codex-a.json', 'a@example.com'))
  const baseline = new Set(before.map((r) => r.key))
  // deep link: the list was never read before the flow — nothing can be told apart, so no false ✓ 已加入
  assert.equal(verifyOutcome(before, null, null, true), null)
  // B not listed yet while A exists: keep waiting (null), never ✓ 已续期 (removals-regressions fixer, verifyOutcome)
  assert.equal(verifyOutcome(before, baseline, null, true), null)
  const after = rowsOf(cred('codex-a.json', 'a@example.com'), cred('codex-b.json', 'b@example.com'))
  assert.deepEqual(verifyOutcome(after, baseline, null, true), { name: 'codex-b.json', email: 'b@example.com' })
  // re-authorising A: renewed only when that identity is there
  assert.deepEqual(verifyOutcome(before, baseline, 'A@example.com', true), { renewed: true })
  assert.equal(verifyOutcome(before, baseline, 'z@example.com', true), null)
  const page = src('features/accounts/CpaAccountsPage.vue')
  assert.match(page, /const addBaseline = shallowRef<Set<string> \| null>\(null\)/)
  // no list yet → null; the first list that arrives while the sheet is open becomes the baseline
  assert.match(page, /payload\.value\?\.channels \? new Set\(rows\.value\.map\(\(r\) => r\.key\)\) : null/)
  assert.match(page, /if \(addOpen\.value && addBaseline\.value === null\) addBaseline\.value = listedKeys\(\)/)
  // the baseline is captured before the post-OAuth refresh can fill it with the new account
  assert.match(page, /const baseline = addBaseline\.value\s*await refresh\(\)[\s\S]{0,400}verifyOutcome\(mine, baseline,/)
})

test('FF-10 a 5xx that is not the upstream refusal reads as result-unknown (the reset may have happened)', () => {
  assert.equal(classifyResetError(502, { error: 'fetch failed' }).outcome, 'unknown')
  assert.equal(classifyResetError(504, {}).outcome, 'unknown')
  assert.equal(classifyResetError(500, { error: '重置失败' }).outcome, 'unknown')
  assert.equal(classifyResetError(502, { error: '上游返回 HTTP 500', detail: 'boom' }).outcome, 'unavailable')
  assert.equal(classifyResetError(502, { error: '上游返回 HTTP 429', detail: '' }).outcome, 'cooldown')
  assert.equal(classifyResetError(409, { error: '凭据缺少 organization uuid，无法重置' }).outcome, 'unavailable')
  // the catch-all after the credit was consumed: its gateway words must not read as a definite refusal
  assert.equal(classifyResetError(502, { error: 'CPA 429: {"error":"rate limited"}' }).outcome, 'unknown')
  assert.equal(classifyResetError(502, { error: 'CPA 500: too many open connections' }).outcome, 'unknown')
  assert.equal(classifyResetError(502, { error: 'CPA 503: no reset handler' }).outcome, 'unknown')
  // the proven pre-dispatch refusal still reads its upstream body
  assert.equal(classifyResetError(502, { error: '上游返回 HTTP 400', detail: '{"code":"already_redeemed"}' }).outcome, 'redeemed')
})

test('FF-16 the success toast states a remaining count only when the server reported it', () => {
  assert.deepEqual(classifyResetSuccess({ ok: true, cooldownCleared: true, resetCredits: { availableCount: null } }, { creditsBefore: 2, coolUntil: null }), { outcome: 'ok', remaining: null })
  assert.deepEqual(classifyResetSuccess({ ok: true, cooldownCleared: true, result: 'reset' }, { creditsBefore: 2, coolUntil: null }), { outcome: 'ok', remaining: null })
  assert.deepEqual(classifyResetSuccess({ ok: true, cooldownCleared: true, resetCredits: { availableCount: 1 } }, { creditsBefore: 2, coolUntil: null }), { outcome: 'ok', remaining: 1 })
})

test('FF-17 a filtered provider head counts the filtered accounts only', () => {
  const rows = rowsOf(cred('codex-a.json', 'a@example.com'), cred('codex-b.json', 'b@example.com'), cred('codex-c.json', 'c@example.com', { disabled: true }))
  const all = groupAccounts(rows)
  assert.equal(all[0].routable, 2)
  const paused = filterGroups(all, 'pause', '')
  assert.equal(paused.length, 1)
  assert.equal(paused[0].accounts.length, 1)
  assert.equal(paused[0].routable, 0)
  assert.equal(all[0].routable, 2) // the provider-wide group (pause-last-account guard) is untouched
  assert.deepEqual(filterGroups(all, 'all', 'nobody'), [])
})

test('FF-11 a paused account can still use its reset credits', () => {
  assert.doesNotMatch(src('features/accounts/AccountRow.vue'), /暂停中的账号不重置|Boolean\(busy\) \|\| row\.disabled/)
  assert.doesNotMatch(src('features/accounts/AccountDetail.vue'), /Boolean\(busy\) \|\| row\.disabled/)
  assert.doesNotMatch(src('features/accounts/CpaAccountsPage.vue'), /actions\.busy\[detailRow\.key\]\) \|\| detailRow\.disabled/)
})

test('FF-14 OAuth sheet: a late start is cancelled, a late poll does not finalize twice', () => {
  const sheet = src('features/accounts/AddAccountSheet.vue')
  assert.match(sheet, /if \(mine !== generation\) \{\s*(?:\/\/[^\n]*\s*)?void api\.cancelOAuth\(res\.state\)/)
  assert.match(sheet, /const res = await api\.getOAuthStatus\(state\)\s*if \(mine !== generation \|\| step\.value !== 'auth'\) return/)
  assert.match(sheet, /if \(finalized === mine\) return\s*finalized = mine/)
})

test('FF-15 the paste-callback field accepts a bare code or code=…&state=…', () => {
  const sheet = src('features/accounts/AddAccountSheet.vue')
  assert.match(sheet, /<form v-if="chosen\.paste" class="acc-add__paste" novalidate/)
  assert.match(sheet, /id="acc-cb"[^>]*type="text" inputmode="url"/)
})

test('FF-24 a failed proxy pick snaps back to what the server has (removals-regressions fixer: proxyStore)', () => {
  const actions = src('features/accounts/useAccountActions.ts')
  assert.match(actions, /catch \(error\) \{\s*fail\('代理没改成', error\)[\s\S]{0,160}void readProxy\(row\.name\)/)
  // the guard only spares an address still being typed; a failed save (`sent`) or a failed pick still snaps back
  assert.match(src('features/accounts/AccountDetail.vue'), /watch\(read, \(value\) => \{\s*(?:if \(proxyKeepsDraft\(choice\.value, draft\.value, sent\)\) return\s*sent = null\s*)?choice\.value = proxyChoice\(value/)
})

test('FF-24 a failed custom-proxy save keeps the typed address for a retry; a landed one is replaced by the answer', () => {
  const addr = 'socks5://192.0.2.9:1080'
  // success: setProxy lands the answer (knowProxy) while busy is still 'proxy' → the address is still `sent`
  // at that read, so the answer replaces it (RR-2 rule) — the busy transition afterwards changes nothing
  assert.equal(proxyKeepsDraft(PROXY_CUSTOM, addr, addr), false)
  assert.equal(proxySentAfterWrite('proxy', undefined, null), null)
  // failure: the write ends with the address still outstanding → it is a draft again before the re-read lands
  const sent = proxySentAfterWrite('proxy', undefined, addr)
  assert.equal(sent, null)
  assert.equal(proxyKeepsDraft(PROXY_CUSTOM, addr, sent), true)
  // other actions on the row (reset, routing) or a write still in flight do not touch it
  assert.equal(proxySentAfterWrite('reset', undefined, addr), addr)
  assert.equal(proxySentAfterWrite(undefined, 'proxy', addr), addr)
  const detail = src('features/accounts/AccountDetail.vue')
  assert.match(detail, /watch\(\(\) => props\.busy, \(now, before\) => \{ sent = proxySentAfterWrite\(before, now, sent\) \}\)/)
  // setProxy: the answer lands before the write ends; the failure re-read is not awaited inside the write
  const actions = src('features/accounts/useAccountActions.ts')
  assert.match(actions, /knowProxy\(row\.name, saved\)[\s\S]{0,120}await refresh\(\)/)
  assert.match(actions, /fail\('代理没改成', error\)[\s\S]{0,160}void readProxy\(row\.name\)/)
})

test('FF-23 a partial account refresh keeps the last good copy of the source that failed (removals-regressions fixer)', () => {
  const prev = { channels: { credentials: [{ name: 'n' }] }, monitor: { accounts: [] }, channelsError: null, monitorError: null, at: 1, channelsAt: 1, monitorAt: 1 }
  const next = { channels: null, monitor: { accounts: [{ name: 'n' }] }, channelsError: new Error('down'), monitorError: null, at: 2, channelsAt: null, monitorAt: 2 }
  const merged: Loose = mergeAccountsPayload(prev as Loose, next as Loose)
  assert.deepEqual(merged.channels, prev.channels)
  assert.equal(merged.channelsAt, 1)
  assert.ok(merged.channelsError)
  assert.equal(merged.monitorAt, 2)
  assert.match(src('features/accounts/CpaAccountsPage.vue'), /mergeAccountsPayload\(live\.data\.value, next\)/)
})

test('FF-31 every account poll revalidates (no SWR copy stamped as fresh)', async () => {
  const { loadAccounts } = await import(new URL('../src/features/accounts/accountsApi.ts', import.meta.url).href)
  const realFetch = globalThis.fetch
  const caches: string[] = []
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    caches.push(String(init.cache))
    const body = url.startsWith('/api/channels') ? { credentials: [], channels: [] } : { accounts: [] }
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
  }) as typeof fetch
  try {
    await loadAccounts(new AbortController().signal)
    assert.deepEqual(caches, ['no-cache', 'no-cache'])
  } finally {
    globalThis.fetch = realFetch
  }
  assert.doesNotMatch(src('features/accounts/CpaAccountsPage.vue'), /loadAccounts\(signal, /)
})

/* ── channels ──────────────────────────────────────────────────────────────────────────────────── */

test('FF-05 channel, model and OAuth flows show the server reason, not the generic status text', () => {
  const page = src('features/channels/ChannelsPage.vue')
  assert.match(page, /function failToast\(title: string, error: unknown\) \{\s*notify\(`◆ \$\{title\}`, \{ tone: 'bad', description: errorReason\(error\) \}\)/)
  const create = src('features/channels/CreateChannelSheet.vue')
  assert.match(create, /probeError\.value = errorReason\(error\)/)
  assert.match(create, /const reason = errorReason\(error\)/)
  assert.match(src('features/models/ModelSheet.vue'), /description: `\$\{errorReason\(error\)\} · \$\{mapping\.model\}`/)
  assert.equal(src('features/accounts/AddAccountSheet.vue').match(/errorReason\(error\)/g)?.length, 4)
  for (const file of ['features/channels/ChannelsPage.vue', 'features/channels/CreateChannelSheet.vue', 'features/models/ModelSheet.vue', 'features/accounts/AddAccountSheet.vue']) {
    assert.doesNotMatch(src(file), /describeError\(error\)\.(detail|title)/, file)
  }
})

test('FF-13 add-channel sheet: one create per sheet across reopen; older probe / create never touch a reopened sheet', () => {
  const create = src('features/channels/CreateChannelSheet.vue')
  assert.match(create, /const write = useSheetWrite\(\)/)
  assert.match(create, /done: \(_result, current\) => \{[\s\S]{0,200}emit\('created', channelName\)\s*if \(current\) open\.value = false/)
  assert.match(create, /failed: \(error, current\) => \{[\s\S]{0,120}if \(current\) submitError\.value = reason\s*else notify\(/)
  assert.match(create, /if \(mine !== probeGen\) return\s*discovered\.value = result\.models/)
  assert.match(create, /&& !busy\.value,\s*\)/) // canCreate waits for an older create still in flight
  // dismissing mid-write renews the session, so the outcome becomes a toast rather than text on a hidden sheet
  for (const file of ['features/keys/KeyEditorSheet.vue', 'features/keys/KeyQuotaSheet.vue']) {
    assert.match(src(file), /if \(!value\) \{[\s\S]{0,140}write\.renew\(\)\s*return\s*\}/, file)
  }
  assert.match(create, /apiKey\.value = ''[\s\S]{0,140}write\.renew\(\)/)
})

test('FF-18 channel / model switches stay locked until the re-read lands', () => {
  const page = src('features/channels/ChannelsPage.vue')
  assert.match(page, /await api\.setChannelEnabled\(channel\.name, next\)[\s\S]{0,160}await reconcile\(\)\s*\} catch/)
  assert.match(page, /async function reconcile\(\) \{[\s\S]{0,80}await channels\.refresh\(\)/)
  assert.match(page, /await api\.setModelEnabled\(channel\.name, modelId, next\)[\s\S]{0,160}await channels\.refresh\(\)\.catch\(\(\) => undefined\)\s*await whenIdle\(channels\.loading\)\s*return true/)
  assert.match(page, /async function reconcile\(\) \{[\s\S]{0,200}await whenIdle\(channels\.loading\)\s*\}/)
  const sheet = src('features/models/ModelSheet.vue')
  assert.match(sheet, /if \(props\.reload\) await props\.reload\(\)\.catch\(\(\) => undefined\)\s*else emit\('changed'\)\s*\} catch[\s\S]{0,300}finally \{\s*busy\.value = ''/)
  const models = src('features/models/ModelsPage.vue')
  assert.match(models, /:reload="reload"/)
  assert.match(models, /async function reload\(\) \{\s*await live\.refresh\(\)[\s\S]{0,140}await whenIdle\(live\.loading\)\s*\}/)
})

test('FF-18 a re-read superseded by a background poll still holds the lock until the newer read lands', async () => {
  const { useLive } = await import(new URL('../src/ui/composables/useLive.ts', import.meta.url).href)
  const reads = [deferred<string>(), deferred<string>()]
  let n = 0
  const scope = effectScope()
  const live: Loose = scope.run(() => useLive(() => reads[n++].promise, { intervalMs: 0, immediate: false }))
  const mutationRead = live.refresh() // the write's re-read
  const poll = live.refresh() // a background poll starts before it answers: the first read is dropped
  let released = false
  const lock = mutationRead.then(() => whenIdle(live.loading)).then(() => { released = true })
  reads[0].resolve('old')
  await mutationRead
  // without whenIdle the switch would unlock here, while the screen still shows the pre-write state
  assert.equal(live.data.value, undefined)
  assert.equal(live.loading.value, true)
  await sleep(5)
  assert.equal(released, false)
  reads[1].resolve('acknowledged')
  await poll
  await lock
  assert.equal(released, true)
  assert.equal(live.data.value, 'acknowledged')
  // nothing in flight: resolves at once
  await whenIdle(live.loading)
  scope.stop()
})

test('FF-19 stale-channel cleanup is always reachable (palette + plate action), still confirmed first', () => {
  const page = src('features/channels/ChannelsPage.vue')
  assert.doesNotMatch(page, /if \(!stale\.length\) return/)
  assert.doesNotMatch(page, /if \(counts\.value\.stale\) cmds\.push/)
  assert.match(page, /id: 'act:channel:prune',[\s\S]{0,200}run: \(\) => void pruneStale\(\)/)
  assert.match(page, /<button type="button" class="ui-link" :disabled="pruning"[^>]*@click="pruneStale">清理残留<\/button>/)
  assert.match(page, /async function pruneStale\(\) \{[\s\S]{0,200}const ok = await confirmSheet\(/)
})

test('FF-20 /channels applies an old ?status=disabled as 停用 and rewrites unknown values', () => {
  assert.equal(channelStatusFilter('disabled'), 'off')
  assert.equal(channelStatusFilter('off'), 'off')
  assert.equal(channelStatusFilter('warn'), 'warn')
  assert.equal(channelStatusFilter('bogus'), 'all')
  assert.equal(channelStatusFilter(''), 'all')
  assert.match(src('features/channels/ChannelsPage.vue'), /const applied = channelStatusFilter\(raw\)\s*if \(applied !== raw\) scope\.patch\(\{ status: applied \}\)/)
})

test('FF-22 channel sheet model list clamps the page when the last page empties', () => {
  const ids = Array.from({ length: 50 }, (_, i) => i)
  const p = paginate(ids, 2, 50) // 51 → 50 rows while on page 2
  assert.equal(p.page, 1)
  assert.equal(p.rows.length, 50)
  const sheet = src('features/channels/ChannelSheet.vue')
  assert.match(sheet, /const paged = computed\(\(\) => paginate\(models\.value, page\.value, PAGE\)\)/)
  assert.match(sheet, /<Pager v-model:page="currentPage"/)
  assert.doesNotMatch(sheet, /models\.value\.slice\(\(page\.value - 1\)/)
})

/* ── models ────────────────────────────────────────────────────────────────────────────────────── */

const mapping = (model: string, channel: string, enabled: boolean, channelEnabled = true, kind: 'compat' | 'oauth' = 'compat') => ({ model, channel, kind, enabled, channelEnabled, upstreams: 1 })
const modelRow = (key: string, mappings: Array<ReturnType<typeof mapping>>) => ({ key, mappings }) as unknown as ModelRow

test('FF-12 batch targets: exact mapping identities, skip what is already there, never switch on a disabled channel', () => {
  const rows = [
    modelRow('gpt-x', [mapping('gpt-x', 'a', true), mapping('openai/gpt-x', 'b', false), mapping('gpt-x', 'off-ch', false, false)]),
    modelRow('claude-y', [mapping('claude-y', 'a', true), mapping('claude-y', 'c', true, false, 'oauth')]),
  ]
  const on = batchTargets(rows, true)
  assert.deepEqual(on.map((m) => `${m.model}@${m.channel}:${m.kind}`), ['openai/gpt-x@b:compat'])
  const off = batchTargets(rows, false)
  assert.deepEqual(off.map((m) => `${m.model}@${m.channel}:${m.kind}`), ['gpt-x@a:compat', 'claude-y@a:compat', 'claude-y@c:oauth'])
  assert.deepEqual(batchTargets([rows[0], rows[0]], false).length, 1) // the same mapping is written once
  const page = src('features/models/ModelsPage.vue')
  // confirmed first, then one PATCH per mapping in order, failures collected and reported, then a re-read
  assert.match(page, /const ok = await confirmSheet\(\{[\s\S]{0,600}if \(!ok\) return/)
  assert.match(page, /for \(const m of targets\) \{\s*try \{\s*await api\.setModelSourceEnabled\(m\.model, m\.channel, m\.kind, next\)\s*\} catch \(error\) \{\s*failed\.push/)
  assert.match(page, /批量\$\{verb\}完成 \$\{done\}\/\$\{targets\.length\} · 失败 \$\{failed\.length\} 条/)
  assert.match(page, /const pickedRows = computed\(\(\) => visible\.value\.filter\(\(row\) => picked\.value\.has\(row\.key\)\)\)/)
})

test('FF-20 old /models bookmarks land on their equivalent and drop scopes this page cannot apply', () => {
  assert.equal(legacyModelsQuery({ q: 'claude', page: '2' }), null)
  assert.equal(legacyModelsQuery({ sort: 'tokens:desc' }), null)
  assert.deepEqual(legacyModelsQuery({ days: '30', keyId: 'K', filter: 'off' }), { view: 'off' })
  assert.deepEqual(legacyModelsQuery({ filter: 'enabled', channel: 'acme', kind: 'oauth' }), { q: 'acme' })
  assert.deepEqual(legacyModelsQuery({ filter: 'contested', sort: 'usage', dir: 'desc' }), { view: 'multi', sort: 'tokens:desc' })
  assert.deepEqual(legacyModelsQuery({ sort: 'name' }), { view: 'all', sort: 'id:asc' })
  // old size=25 page 3 (rows 51–75) is page 2 at 50 a page; the sheet key survives
  assert.deepEqual(legacyModelsQuery({ size: '25', page: '3', model: 'gpt-x', cols: 'model' }), { view: 'all', page: '2', model: 'gpt-x' })
  assert.match(src('features/models/ModelsPage.vue'), /const legacy = legacyModelsQuery\(route\.query, PAGE_SIZE\)\s*if \(legacy\) void router\.replace\(\{ query: legacy/)
})

test('FF-32 Back restores q and page together; only a user edit resets the page', async () => {
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/models', component: defineComponent({ render: () => h('div') }) }] })
  await router.push('/models?q=claude&page=2')
  const app = createApp({ render: () => h('div') })
  app.use(router)
  const effect = effectScope()
  const got = app.runWithContext(() => effect.run(() => {
    const scope = useQueryState({ view: 'inuse', q: '', vendor: '', page: '1' })
    return { scope, q: resettingField(scope, 'q', { page: '1' }) }
  }))!
  assert.equal(got.scope.state.page, '2')
  await router.push('/models')
  await sleep(50)
  router.back()
  await sleep(100)
  await nextTick()
  assert.equal(got.scope.state.q, 'claude')
  assert.equal(got.scope.state.page, '2', 'the page restored by Back is kept')
  got.q.value = 'gpt'
  assert.equal(got.scope.state.page, '1', 'a user edit goes back to page 1')
  got.q.value = 'gpt' // same value: no reset of a page changed since
  got.scope.state.page = '3'
  got.q.value = 'gpt'
  assert.equal(got.scope.state.page, '3')
  effect.stop()
  const page = src('features/models/ModelsPage.vue')
  assert.doesNotMatch(page, /watch\(\(\) => \[scope\.state\.view, scope\.state\.q, scope\.state\.vendor\], \(\) => \{ if \(scope\.state\.page !== '1'\)/)
  assert.match(page, /<Segmented v-model="viewModel"/)
  assert.match(page, /<SearchField v-model="qModel"/)
  assert.match(page, /<FilterField v-model="vendorModel"/)
})

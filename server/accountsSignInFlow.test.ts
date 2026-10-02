import assert from 'node:assert/strict'
import test from 'node:test'
import {
  DEADLINE_SLACK_MS, isLive, isTerminal, openFlow, pastDeadline, pollDelay, reduceFlow, remainingMs, startRequest, waitingHint,
  type FlowItem, type FlowState,
} from '../src/features/accounts/signIn.js'
import type { SignInView } from '../src/types.js'

/* The add-account sheet's sign-in state machine (Magpie startSignIn / followSignIn / renderSigning). */

const codex: FlowItem = { agent: 'codex', shortName: 'ChatGPT', risk: null, sites: [] }
const antigravity: FlowItem = { agent: 'antigravity', shortName: 'Antigravity', risk: { title: 'Antigravity 账号可能被封禁', note: 'Google 可能会停用…' }, sites: [] }
const zcode: FlowItem = { agent: 'zcode', shortName: 'ZCode', risk: null, sites: [{ id: 'zai', label: 'Z.ai', host: 'z.ai' }, { id: 'bigmodel', label: 'BigModel（智谱）', host: 'bigmodel.cn' }] }

function view(patch: Partial<SignInView> = {}): SignInView {
  return {
    id: 'sid-1', agent: 'codex', state: 'waiting', completion: 'relay', url: 'https://auth.openai.com/oauth/authorize?x=1', code: null,
    installing: null, pasteCallback: true, callbackLocked: false, user: null, userMasked: null, plan: null, using: false,
    error: null, errorCode: null, detail: null, next: null, startedAt: '2026-10-02T08:00:00.000Z', deadline: '2026-10-02T08:10:00.000Z',
    ...patch,
  }
}

const run = (state: FlowState, ...events: Parameters<typeof reduceFlow>[1][]) => events.reduce(reduceFlow, state)

test('first step: risk card, then the site pick, then starting', () => {
  assert.equal(openFlow(codex).step, 'starting')
  assert.equal(openFlow(antigravity).step, 'risk')
  assert.equal(openFlow(zcode).step, 'site')
  assert.equal(openFlow(zcode, { site: 'bigmodel' }).step, 'starting')
  assert.equal(openFlow(zcode, { site: 'elsewhere' }).step, 'site')
  const risky = run(openFlow(antigravity), { type: 'confirmRisk' })
  assert.equal(risky.step, 'starting')
  assert.deepEqual(startRequest(risky), { agent: 'antigravity', confirmRisk: true })
  const sited = run(openFlow(zcode), { type: 'pickSite', site: 'zai' })
  assert.deepEqual(startRequest(sited), { agent: 'zcode', site: 'zai' })
  assert.equal(run(openFlow(zcode), { type: 'pickSite', site: 'nope' }).step, 'site')
  assert.deepEqual(startRequest(openFlow(codex)), { agent: 'codex' })
  assert.equal(startRequest(openFlow(antigravity)), null, 'nothing is sent before the risk card is confirmed')
})

test('server states: installing → waiting → done; a finished flow stays finished', () => {
  let s = run(openFlow(codex), { type: 'start' }, { type: 'view', view: view({ state: 'installing', url: null, installing: 'Devin CLI' }) })
  assert.equal(s.step, 'installing')
  assert.equal(isLive(s), true)
  s = reduceFlow(s, { type: 'view', view: view() })
  assert.equal(s.step, 'waiting')
  s = reduceFlow(s, { type: 'view', view: view({ state: 'done', user: 'a@b.c', using: true, url: null }) })
  assert.equal(s.step, 'done')
  assert.equal(isTerminal(s), true)
  assert.equal(reduceFlow(s, { type: 'view', view: view({ state: 'waiting' }) }).step, 'done')
  assert.equal(reduceFlow(s, { type: 'cancel' }).step, 'done')
})

test('an answer for another sign-in id never lands on this flow', () => {
  const s = run(openFlow(codex), { type: 'start' }, { type: 'view', view: view({ id: 'sid-1' }) })
  assert.equal(reduceFlow(s, { type: 'view', view: view({ id: 'sid-old', state: 'failed', error: 'x' }) }).step, 'waiting')
})

test('failed carries the zh reason, its code and the detail; retry starts again with the same site and risk', () => {
  const base = run(openFlow(zcode), { type: 'pickSite', site: 'bigmodel' }, { type: 'start' }, { type: 'view', view: view({ agent: 'zcode' }) })
  const failed = reduceFlow(base, { type: 'view', view: view({ agent: 'zcode', state: 'failed', error: '登录超时，请重新开始', errorCode: 'signin_timeout', detail: 'the sign-in timed out' }) })
  assert.deepEqual([failed.step, failed.reason, failed.code, failed.detail], ['failed', '登录超时，请重新开始', 'signin_timeout', 'the sign-in timed out'])
  const again = reduceFlow(failed, { type: 'retry' })
  assert.deepEqual([again.step, again.site, again.view, again.reason], ['starting', 'bigmodel', null, null])
  assert.deepEqual(startRequest(again), { agent: 'zcode', site: 'bigmodel' })
  // a failed view without text still says something
  assert.equal(reduceFlow(base, { type: 'view', view: view({ agent: 'zcode', state: 'failed' }) }).reason, '登录未完成')
})

test('start refusals: risk / site go back a step, the rest fail with the server line', () => {
  const risky = run(openFlow(antigravity), { type: 'confirmRisk' })
  assert.deepEqual([reduceFlow(risky, { type: 'startFailed', code: 'risk_unconfirmed', reason: '请先确认封号风险' }).step, reduceFlow(risky, { type: 'startFailed', code: 'risk_unconfirmed', reason: '' }).riskConfirmed], ['risk', false])
  const sited = run(openFlow(zcode), { type: 'pickSite', site: 'zai' })
  assert.equal(reduceFlow(sited, { type: 'startFailed', code: 'site_required', reason: '请选择账号所在的站点' }).step, 'site')
  const gated = reduceFlow(openFlow(codex), { type: 'startFailed', code: 'signin_gated', reason: '该服务要在服务器上运行厂商 CLI 或安装器，已关闭' })
  assert.deepEqual([gated.step, gated.code], ['failed', 'signin_gated'])
  const busy = reduceFlow(openFlow(codex), { type: 'startFailed', code: 'port_busy', reason: '本机端口被占用', detail: 'port 1455 is busy' })
  assert.equal(busy.detail, 'port 1455 is busy')
})

test('paste: one submit at a time, an accepted address locks the field for the rest of the flow', () => {
  const waiting = run(openFlow(codex), { type: 'start' }, { type: 'view', view: view() })
  const busy = reduceFlow(waiting, { type: 'callbackSubmit' })
  assert.equal(busy.callbackBusy, true)
  assert.equal(reduceFlow(busy, { type: 'callbackSubmit' }), busy, 'a second submit while one is out is ignored')
  const refused = reduceFlow(busy, { type: 'callbackFailed', reason: '这不是本次登录的回调地址' })
  assert.deepEqual([refused.callbackBusy, refused.callbackError, refused.step], [false, '这不是本次登录的回调地址', 'waiting'])
  const locked = reduceFlow(reduceFlow(refused, { type: 'callbackSubmit' }), { type: 'view', view: view({ callbackLocked: true }) })
  assert.equal(locked.callbackLocked, true)
  // a later poll that forgets the flag does not unlock it
  assert.equal(reduceFlow(locked, { type: 'view', view: view() }).callbackLocked, true)
  assert.equal(reduceFlow(locked, { type: 'callbackSubmit' }), locked)
  // not waiting → no submit
  assert.equal(reduceFlow(openFlow(codex), { type: 'callbackSubmit' }).callbackBusy, false)
})

test('cancel: by the person vs by the server; lost and timeout only while live', () => {
  const waiting = run(openFlow(codex), { type: 'start' }, { type: 'view', view: view() })
  assert.deepEqual([reduceFlow(waiting, { type: 'cancel' }).step, reduceFlow(waiting, { type: 'cancel' }).canceledBy], ['canceled', 'user'])
  const elsewhere = reduceFlow(waiting, { type: 'view', view: view({ state: 'canceled' }) })
  assert.deepEqual([elsewhere.step, elsewhere.canceledBy], ['canceled', 'server'])
  assert.equal(reduceFlow(elsewhere, { type: 'retry' }).step, 'starting')
  const lost = reduceFlow(waiting, { type: 'lost', code: 'signin_not_found', reason: '这次登录已结束，请重新开始' })
  assert.deepEqual([lost.step, lost.reason], ['failed', '这次登录已结束，请重新开始'])
  assert.deepEqual([reduceFlow(waiting, { type: 'timeout' }).step, reduceFlow(waiting, { type: 'timeout' }).code], ['failed', 'signin_timeout'])
  assert.equal(reduceFlow(openFlow(antigravity), { type: 'timeout' }).step, 'risk')
})

test('polling cadence, countdown, deadline; the waiting sub text by kind', () => {
  assert.equal(pollDelay(false), 800)
  assert.equal(pollDelay(true), 3000)
  const waiting = run(openFlow(codex), { type: 'start' }, { type: 'view', view: view() })
  const deadline = Date.parse('2026-10-02T08:10:00.000Z')
  assert.equal(remainingMs(waiting, deadline - 522_000), 522_000)
  assert.equal(remainingMs(waiting, deadline + 5000), 0)
  assert.equal(remainingMs(openFlow(codex), deadline), null)
  assert.equal(pastDeadline(waiting, deadline + DEADLINE_SLACK_MS - 1), false)
  assert.equal(pastDeadline(waiting, deadline + DEADLINE_SLACK_MS + 1), true)
  assert.equal(waitingHint(waiting), 'browser')
  assert.equal(waitingHint({ ...waiting, view: view({ code: 'ABCD-1234' }) }), 'code-enter')
  assert.equal(waitingHint({ ...waiting, agent: 'factory', view: view({ code: 'ABCD-1234' }) }), 'code-confirm')
})

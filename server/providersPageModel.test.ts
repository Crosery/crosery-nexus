import assert from 'node:assert/strict'
import test from 'node:test'
import {
  accountShow, channelInStatus, matchesQuery, pageLive, parseStatus, statusCounts, statusForSection, statusItems,
  type AccountCountsLike, type ChannelBucket,
} from '../src/features/providers/providersModel.js'
import { buildAccounts, filterGroups, groupAccounts, type CredentialLike } from '../src/features/accounts/model.js'

/** /providers (src/features/providers/providersModel.ts): one filter for both sections, one live mark. */

const counts = (over: Partial<AccountCountsLike> = {}): AccountCountsLike => ({ all: 0, run: 0, cool: 0, pause: 0, bad: 0, warn: 0, hot: 0, reset: 0, ...over })

test('status: ?status= is the page\'s; the old /channels and /accounts values still land; unknown is 全部', () => {
  assert.equal(parseStatus('issue'), 'issue')
  assert.equal(parseStatus(['cool', 'off']), 'cool')
  assert.equal(parseStatus('disabled'), 'off')
  assert.equal(parseStatus('degraded'), 'issue')
  assert.equal(parseStatus('enabled'), 'run')
  assert.equal(parseStatus(undefined, 'pause'), 'off')
  assert.equal(parseStatus(undefined, 'bad'), 'issue')
  assert.equal(parseStatus(undefined, 'hot'), 'hot')
  assert.equal(parseStatus('nope', 'nope'), 'all')
  assert.equal(parseStatus(null), 'all')
})

test('status: account-only filters do not survive a section that shows channels', () => {
  assert.equal(statusForSection('hot', 'accounts'), 'hot')
  assert.equal(statusForSection('hot', 'all'), 'all')
  assert.equal(statusForSection('reset', 'channels'), 'all')
  assert.equal(statusForSection('issue', 'all'), 'issue')
})

test('one status, both sections: channel buckets and account show values say the same thing', () => {
  const buckets: ChannelBucket[] = ['run', 'warn', 'off']
  assert.deepEqual(buckets.filter((b) => channelInStatus(b, 'all')), buckets)
  assert.deepEqual(buckets.filter((b) => channelInStatus(b, 'run')), ['run'])
  assert.deepEqual(buckets.filter((b) => channelInStatus(b, 'issue')), ['warn'])
  assert.deepEqual(buckets.filter((b) => channelInStatus(b, 'off')), ['off'])
  assert.deepEqual(buckets.filter((b) => channelInStatus(b, 'cool')), [], 'channels never cool down')
  assert.equal(accountShow('off'), 'pause')
  assert.equal(accountShow('issue'), 'issue')
  assert.equal(accountShow('all'), 'all')

  // the pool applies the page's show value: 需处理 = 失效 + 异常, 停用 = 暂停
  const cred = (name: string, over: Partial<CredentialLike> = {}): CredentialLike => ({ name, type: 'codex', label: `${name}@example.test`, disabled: false, status: 'active', ...over })
  const rows = buildAccounts([cred('a.json'), cred('b.json', { disabled: true }), cred('c.json', { status: 'error' }), cred('d.json', { status: 'pending' })], [], Date.UTC(2026, 9, 9))
  const shown = (show: string, q = '') => filterGroups(groupAccounts(rows), show, q).flatMap((g) => g.accounts.map((r) => r.name)).sort()
  assert.deepEqual(shown(accountShow('run')), ['a.json'])
  assert.deepEqual(shown(accountShow('off')), ['b.json'])
  assert.deepEqual(shown(accountShow('issue')), ['c.json', 'd.json'])
  assert.deepEqual(shown(accountShow('issue'), 'D.JSON@'), ['d.json'], 'the page\'s search reaches the pool too')
})

test('search: case-insensitive over the row\'s fields', () => {
  assert.equal(matchesQuery(['relay-a', '兼容渠道', 'https://api.example.test/v1'], 'EXAMPLE'), true)
  assert.equal(matchesQuery(['relay-a', null, undefined], '  '), true)
  assert.equal(matchesQuery(['relay-a'], 'zzz'), false)
})

test('chips count what the section shows; zero chips drop except 全部 and the one in use', () => {
  const buckets: ChannelBucket[] = ['run', 'run', 'warn', 'off']
  const pool = counts({ all: 5, run: 2, cool: 1, pause: 1, bad: 1, hot: 2, reset: 0 })
  const all = statusCounts(buckets, pool, 'all')
  assert.deepEqual(all, { all: 9, run: 4, cool: 1, issue: 2, off: 2, hot: 2, reset: 0 })
  assert.deepEqual(statusCounts(buckets, pool, 'channels'), { all: 4, run: 2, cool: 0, issue: 1, off: 1, hot: 0, reset: 0 })
  assert.equal(statusCounts(buckets, null, 'accounts').all, 0, 'the pool has not reported yet')
  assert.deepEqual(statusItems(all, 'all', 'all').map((i) => i.value), ['all', 'run', 'cool', 'issue', 'off'], 'account-only chips stay out while channels show')
  assert.deepEqual(statusItems(statusCounts(buckets, pool, 'accounts'), 'accounts', 'reset').map((i) => i.value), ['all', 'run', 'cool', 'issue', 'off', 'hot', 'reset'])
  assert.deepEqual(statusItems(statusCounts(['run'], null, 'all'), 'all', 'all').map((i) => `${i.label} ${i.count}`), ['全部 1', '正常 1'])
})

test('one live mark: stale when any source failed, loading until all answered, the oldest good read is the time shown', () => {
  assert.deepEqual(pageLive([{ state: 'ready', lastAt: 2_000 }, { state: 'ready', lastAt: 1_000 }]), { state: 'ready', lastAt: 1_000 })
  assert.deepEqual(pageLive([{ state: 'ready', lastAt: 2_000 }, { state: 'stale', lastAt: 1_500 }]), { state: 'stale', lastAt: 1_500 })
  assert.deepEqual(pageLive([{ state: 'ready', lastAt: 2_000 }, { state: 'error', lastAt: null }]), { state: 'stale', lastAt: null })
  assert.deepEqual(pageLive([{ state: 'ready', lastAt: 2_000 }, { state: 'loading', lastAt: null }]), { state: 'loading', lastAt: null })
  assert.equal(pageLive([{ state: 'empty', lastAt: 5 }]).state, 'ready')
})

import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'

const source = fs.readFileSync(new URL('./index.ts', import.meta.url), 'utf8')

function route(path: string, nextPath: string) {
  const start = source.indexOf(`app.get('${path}'`)
  const end = source.indexOf(`app.get('${nextPath}'`, start + 1)
  assert.ok(start >= 0, `${path} route is missing`)
  assert.ok(end > start, `${path} route boundary is missing`)
  return source.slice(start, end)
}

test('slow report routes use persistent snapshots and a bounded configurable read pool', () => {
  assert.match(source, /new SQLiteReadPool\([^\n]+, config\.reportReadWorkers\)/)
  for (const segment of [
    route('/api/usage-page', '/api/usage-key-summaries'),
    route('/api/usage-key-summaries', '/api/dashboard'),
    route('/api/charts', '/api/charts-latency'),
    route('/api/charts-latency', '/api/monitor'),
    route('/api/cache-trend', '/api/cache-live'),
  ]) {
    assert.match(segment, /reportSnapshots\.run/)
    assert.doesNotMatch(segment, /analyticsCoordinator\.run/)
  }
})

test('p95 reports use a dedicated one-worker reader outside the core report pool', () => {
  assert.match(source, /const latencyReader = new SQLiteReadPool\([^\n]+, 1\)/)

  const analytics = route('/api/analytics', '/api/charts')
  assert.match(analytics, /loadAnalyticsReport\(latencyReader/)
  assert.doesNotMatch(analytics, /loadAnalyticsReport\(usageReader/)

  const chartsLatency = route('/api/charts-latency', '/api/monitor')
  assert.match(chartsLatency, /loadChartsLatencyReport\(latencyReader/)
  assert.doesNotMatch(chartsLatency, /loadChartsLatencyReport\(usageReader/)

  const warmup = source.slice(source.indexOf('const warmDefaultReports'), source.indexOf('const invalidateControlPlaneCaches'))
  assert.match(warmup, /loadChartsLatencyReport\(latencyReader/)
})

test('cache live history never runs a synchronous SQLite seed on the request thread', () => {
  const segment = route('/api/cache-live', '/api/cache-live/status')
  assert.match(segment, /await loadCacheLiveHistory\(usageReader/)
  assert.match(segment, /addBufferedClient\(res, model, clientType, keyId, provider\)/)
  assert.match(segment, /client\.activate\(history\)/)
  assert.doesNotMatch(segment, /db\.prepare/)
  assert.match(segment, /if \(closed\) return/)
  assert.ok(segment.indexOf('res.writeHead(200') < segment.indexOf('await listGroupsForReporting()'))
  assert.ok(segment.indexOf('addBufferedClient(res, model, clientType, keyId, provider)') < segment.indexOf('await loadCacheLiveHistory'))
})

test('default report scopes warm at startup and stay warm in the background', () => {
  const warmup = source.slice(source.indexOf('const warmDefaultReports'), source.indexOf('const invalidateControlPlaneCaches'))
  assert.match(warmup, /reportCacheKey\.usagePage/)
  assert.match(warmup, /reportCacheKey\.charts/)
  assert.match(warmup, /reportCacheKey\.cacheTrend/)
  assert.ok(warmup.indexOf('const core') < warmup.indexOf('const secondary'))
  assert.match(source, /setTimeout\(warmDefaultReportsSafely, 2_000\)\.unref\(\)/)
  assert.match(source, /setInterval\(warmDefaultReportsSafely, REPORT_WARM_INTERVAL_MS\)\.unref\(\)/)
  assert.match(warmup, /if \(reportWarmup\) return/)
})

test('bootstrap keeps local keys and quota states when the control plane fails', () => {
  const segment = route('/api/bootstrap', '/api/keys/:id/reveal')
  assert.ok(segment.indexOf('quotaStatesForAsync') < segment.indexOf('Promise.allSettled'))
  assert.match(segment, /listGroupsForReporting\(\)/)
  assert.match(segment, /degraded, degradedReason/)
  assert.doesNotMatch(segment, /await Promise\.all\(\[/)
})

test('channel and model index reads honour fresh=1 by dropping the gateway snapshot first', () => {
  const channels = route('/api/channels', '/api/usage-breakdown')
  const modelIndex = route('/api/model-index', '/api/audit')
  assert.match(channels, /if \(wantsFresh\(req\)\) invalidateGatewaySnapshot\(\)/)
  assert.match(modelIndex, /if \(wantsFresh\(req\)\) invalidateGatewaySnapshot\(\)/)
  // 必须先失效再读：RequestCoordinator 在 SWR 窗口内会先回旧值，顺序反了 fresh=1 就名不副实。
  assert.ok(channels.indexOf('invalidateGatewaySnapshot()') < channels.indexOf('listChannels()'))
  assert.ok(modelIndex.indexOf('invalidateGatewaySnapshot()') < modelIndex.indexOf('listModelIndex()'))
})

test('bootstrap always ships a complete quotaState per key even when the quota reader fails', () => {
  const segment = route('/api/bootstrap', '/api/keys/:id/reveal')
  assert.match(segment, /quotaStatesForAsync\([^\n]*\)\.catch\(/)
  assert.match(segment, /quotaStates\.get\(String\(row\.key_hash\)\) \?\? quotaStateFor\(row as unknown as KeyQuotaRow\)/)
})

test('channels and models pages poll silently on the slow tick', () => {
  const app = fs.readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8')
  const start = app.indexOf('const refreshCurrent = () => {')
  const end = app.indexOf('return () => clearInterval(timer)', start)
  assert.ok(start >= 0 && end > start)
  const block = app.slice(start, end)
  assert.match(block, /page === 'channels'\) void loadChannels\(false, true\)/)
  assert.match(block, /page === 'models'[^\n]*void loadModelIndex\(false, true\)/)
  assert.match(block, /page === 'channels' \|\| page === 'models'/)
})

test('cache trend and cache live accept key and provider filters with a v3 snapshot key', () => {
  const trend = route('/api/cache-trend', '/api/cache-live')
  assert.match(trend, /req\.query\.keyId/)
  assert.match(trend, /req\.query\.provider/)
  assert.match(trend, /loadCacheTrendReport\(usageReader, reporting\.groups, hours, model, clientType, keyId, provider\)/)
  assert.match(source, /cache-trend:v3:/)
  const live = route('/api/cache-live', '/api/cache-live/status')
  assert.match(live, /loadCacheLiveHistory\(usageReader, groups, limit, model, clientType, keyId, provider\)/)
})

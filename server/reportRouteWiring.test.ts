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
  assert.match(segment, /addBufferedClient\(res, model, clientType, keyId, provider, currentOnly\)/)
  assert.match(segment, /client\.activate\(history\)/)
  assert.doesNotMatch(segment, /db\.prepare/)
  assert.match(segment, /if \(closed\) return/)
  assert.ok(segment.indexOf('res.writeHead(200') < segment.indexOf('await listGroupsForReporting()'))
  assert.ok(segment.indexOf('addBufferedClient(res, model, clientType, keyId, provider, currentOnly)') < segment.indexOf('await loadCacheLiveHistory'))
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

/**
 * 前端定时器边界（v3：页面在 `src/features/**`，外壳在 `src/shell/**`、`src/app/**`）。
 *
 * 历史：React 死树里有过「channels/models 每 N 秒静默轮询」的 `refreshCurrent`，Vue 树里这个功能不存在，
 * 那条断言随之删除——不让绿灯来自一个不存在的功能。留下的不变量是：
 * - 页面与外壳里**唯一**允许的 `setInterval` 是账号页的 OAuth 授权状态轮询（它必须读 `getOAuthStatus`）。
 * - 其它周期性取数一律走 `useLive`（单循环、隐藏标签页暂停、乱序丢弃）或 `useNow` 的共享 1s 时钟，
 *   DESIGN §3.2 #15「没有逐元素 setInterval」。
 */
function sourceFiles(dir: URL, rel = ''): string[] {
  const out: string[] = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) out.push(...sourceFiles(new URL(`${entry.name}/`, dir), `${rel}${entry.name}/`))
    else if (/\.(vue|ts)$/.test(entry.name)) out.push(`${rel}${entry.name}`)
  }
  return out
}

test('页面与外壳里只有 OAuth 授权轮询一个 setInterval，不存在隐式的渠道/模型轮询', () => {
  const src = new URL('../src/', import.meta.url)
  const scanned = ['features/', 'shell/', 'app/'].flatMap((dir) => sourceFiles(new URL(dir, src), dir))
  assert.ok(scanned.some((file) => file.startsWith('features/')), '没有扫描到任何 features 文件，扫描逻辑需要更新')
  const intervals = scanned.filter((file) => /setInterval\(/.test(fs.readFileSync(new URL(file, src), 'utf8')))
  for (const file of intervals) {
    const source = fs.readFileSync(new URL(file, src), 'utf8')
    assert.ok(file.startsWith('features/accounts/') && /getOAuthStatus/.test(source), `${file} 用了 setInterval：周期取数请改用 useLive，倒计时用 useNow`)
  }

  const app = fs.readFileSync(new URL('App.vue', src), 'utf8')
  assert.doesNotMatch(app, /setInterval|refreshCurrent/)
})

test('cache trend and cache live accept key, provider and channel-scope filters with a v4 scoped snapshot key', () => {
  const trend = route('/api/cache-trend', '/api/cache-live')
  assert.match(trend, /req\.query\.keyId/)
  assert.match(trend, /req\.query\.provider/)
  assert.match(trend, /parseCurrentOnly\(req\.query\.currentOnly\)/)
  assert.match(trend, /loadCacheTrendReport\(usageReader, reporting\.groups, hours, model, clientType, keyId, provider, Date\.now\(\), currentOnly\)/)
  // 口径改为「默认全部渠道」后快照键升版并带口径段：旧版本号下按当前渠道算的快照不会被读到
  assert.match(source, /cache-trend:v4:\$\{scopeTag\(currentOnly\)\}:/)
  const live = route('/api/cache-live', '/api/cache-live/status')
  assert.match(live, /loadCacheLiveHistory\(usageReader, groups, limit, model, clientType, keyId, provider, currentOnly\)/)
})

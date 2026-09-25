import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'

const app = fs.readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8')
const charts = fs.readFileSync(new URL('../src/pages/ChartsPage.tsx', import.meta.url), 'utf8')
const cache = fs.readFileSync(new URL('../src/pages/CachePage.tsx', import.meta.url), 'utf8')

test('report pages use dedicated loaders with current-scope request guards', () => {
  assert.match(app, /api\.usagePage/)
  assert.match(app, /api\.usageKeySummaries/)
  assert.match(app, /api\.charts/)
  assert.match(app, /usageRequest\.current/)
  assert.match(app, /chartsRequest\.current/)
  assert.match(app, /cacheRequest\.current/)
  assert.match(app, /breakdownRequest\.current/)
})

test('usage breakdown rejects stale responses and renders only the current scope', () => {
  const start = app.indexOf('const loadUsageBreakdown = useCallback')
  const end = app.indexOf('const loadModelIndex = useCallback', start)
  assert.ok(start >= 0 && end > start)
  const loader = app.slice(start, end)
  assert.match(loader, /const request = \+\+breakdownRequest\.current/)
  assert.match(loader, /request !== breakdownRequest\.current/)
  assert.match(loader, /setUsageBreakdownScope\(scope\)/)
  assert.match(app, /currentUsageBreakdown = dataForScope\(usageBreakdown, usageBreakdownScope, currentAnalyticsScope\)/)
  assert.doesNotMatch(app, /<KeysPage[^>]+usage=\{usageBreakdown\}/)
  assert.doesNotMatch(app, /<ModelsPage[^>]+usage=\{usageBreakdown\}/)
})

test('usage renders its core before guarded key summaries merge in the background', () => {
  const start = app.indexOf('const loadUsage = useCallback')
  const end = app.indexOf('useEffect(() => { if (authenticated && page === \'usage\')', start)
  assert.ok(start >= 0 && end > start)
  const loader = app.slice(start, end)
  assert.ok(loader.indexOf('api.usagePage') < loader.indexOf('api.usageKeySummaries'))
  assert.ok(loader.indexOf('api.usageKeySummaries') < loader.indexOf('await core'))
  assert.ok(loader.indexOf('setUsage((current) => ({') < loader.indexOf('const mergeKeySummaries'))
  assert.match(loader, /outcome\.value\.days !== result\.days/)
  assert.match(loader, /request !== usageRequest\.current/)
  assert.match(loader, /usageScopeRef\.current !== scope/)
  assert.match(loader, /setUsageKeySummariesState\('error'\)/)
})

test('charts load the core before starting the latency report', () => {
  const start = app.indexOf('const loadCharts = useCallback')
  const end = app.indexOf('const loadDashboard = useCallback', start)
  assert.ok(start >= 0 && end > start)
  const loader = app.slice(start, end)
  assert.ok(loader.indexOf('await api.charts<ChartsData>') < loader.indexOf('api.chartsLatency'))
  assert.ok(loader.indexOf('setChartsScope(scope)') < loader.indexOf('api.chartsLatency'))
  assert.match(loader, /setChartsLatencyState\('error'\)/)
})

test('cache filters keep their option catalogs and current values while a new scope loads', () => {
  assert.match(app, /models=\{cacheTrend\?\.models \|\| \[\]\}/)
  assert.match(app, /clients=\{cacheTrend\?\.clients \|\| \[\]\}/)
  assert.match(cache, /model && !models\.includes\(model\) \? \[model, \.\.\.models\] : models/)
  assert.match(cache, /client && !clients\.some\(\(item\) => item\.type === client\)/)
})

test('chart series render without the default 1500ms reveal animation', () => {
  const series = charts.match(/<(?:Area|Line|Bar)\b[^>]*>/g) || []
  assert.ok(series.length >= 8)
  for (const element of series) assert.match(element, /isAnimationActive=\{false\}/)
})

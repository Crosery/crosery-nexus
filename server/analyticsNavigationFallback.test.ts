import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'

const source = fs.readFileSync(new URL('../src/pages/AnalyticsPage.tsx', import.meta.url), 'utf8')
const appSource = fs.readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8')

test('从仪表盘数据切到请求明细时不解引用缺失的 keyUsage', () => {
  assert.match(source, /const keyUsage = analytics\?\.keyUsage \?\? \[\]/)
  assert.match(source, /keyUsage\.map\(/)
  assert.doesNotMatch(source, /analytics\?\.keyUsage\.map\(/)
})

test('Dashboard 的部分响应不会覆盖已经加载的完整 Analytics', () => {
  const start = appSource.indexOf('const loadDashboard = useCallback')
  const end = appSource.indexOf('const loadMonitor = useCallback', start)
  assert.ok(start >= 0 && end > start)
  const loader = appSource.slice(start, end)
  assert.match(loader, /setDashboard\(result\)/)
  assert.match(loader, /dashboardRequest\.current/)
  assert.doesNotMatch(loader, /setAnalytics\(/)
  assert.doesNotMatch(loader, /analyticsRequest\.current/)
})

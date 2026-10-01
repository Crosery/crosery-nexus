/**
 * 报表接口的**端到端 HTTP 压测**（task-59 ③，新增脚本）。
 *
 * 在临时实例（生产规模数据 + 最小 CPA stub）上量 `/api/usage-overview`、`/api/cache-trend`、
 * `/api/analytics` 的 HTTP p50/p95。要点：
 * - 报表层有 `reportSnapshots` 新鲜度缓存，重复打同一 URL 会命中缓存 → 每次换一个查询参数
 *   （`days` / `hours` 合法档位），保证量到的是**真实计算**路径；
 * - 只打临时实例（`BASE_URL` 必须显式给出），绝不碰生产 8791；
 * - 登录用临时实例自己的 `CONSOLE_PASSWORD`（由调用方传入环境变量）。
 *
 * 用法：
 *   BASE_URL=http://127.0.0.1:8899 CONSOLE_PASSWORD=perf-pass node scripts/perf-report-http.mjs
 */
const base = process.env.BASE_URL
if (!base) throw new Error('必须显式设置 BASE_URL（脚本只打临时实例，不碰生产）')
if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(base)) throw new Error(`只允许打 127.0.0.1 上的临时实例，收到：${base}`)
const password = process.env.CONSOLE_PASSWORD
if (!password) throw new Error('必须给出临时实例的 CONSOLE_PASSWORD')

const percentile = (values, p) => {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))]
}

const login = await fetch(`${base}/api/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ username: 'admin', password }),
})
if (login.status !== 200) throw new Error(`临时实例登录失败：${login.status}`)
const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0]

const timeGet = async (path) => {
  const started = performance.now()
  const res = await fetch(`${base}${path}`, { headers: { cookie } })
  const text = await res.text()
  return { ms: performance.now() - started, status: res.status, bytes: text.length }
}

/** 每个用例用不同的合法参数，绕开新鲜度缓存。 */
const cases = [
  {
    name: '/api/usage-overview',
    paths: [30, 29, 28, 27, 26, 25, 24, 23, 22, 21].map((days) => `/api/usage-overview?days=${days}`),
  },
  {
    name: '/api/cache-trend',
    paths: [168, 167, 166, 165, 164, 163, 162, 161, 160, 159].map((hours) => `/api/cache-trend?hours=${hours}`),
  },
  {
    name: '/api/analytics',
    paths: [30, 29, 28, 27, 26, 25, 24, 23, 22, 21].map((days) => `/api/analytics?days=${days}`),
  },
  {
    name: '/api/dashboard',
    paths: [7, 8, 9, 10, 11, 12, 13, 14, 15, 16].map((days) => `/api/dashboard?days=${days}`),
  },
]

for (const item of cases) {
  const runs = []
  for (const path of item.paths) {
    const result = await timeGet(path)
    if (result.status !== 200) {
      console.log(JSON.stringify({ route: item.name, path, status: result.status, note: '非 200，已跳过' }))
      continue
    }
    runs.push(result.ms)
  }
  if (!runs.length) {
    console.log(JSON.stringify({ route: item.name, p50: null, p95: null, note: '全部非 200' }))
    continue
  }
  console.log(JSON.stringify({
    route: item.name,
    samples: runs.length,
    p50: Number(percentile(runs, 50).toFixed(1)),
    p95: Number(percentile(runs, 95).toFixed(1)),
    min: Number(Math.min(...runs).toFixed(1)),
    max: Number(Math.max(...runs).toFixed(1)),
  }))
}

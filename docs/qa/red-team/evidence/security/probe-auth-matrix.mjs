// 红队第十五轮：鉴权覆盖矩阵（对临时实例逐路由发未认证请求）
// 用法: node probe-auth-matrix.mjs <port>
import fs from 'node:fs'

const PORT = Number(process.argv[2] || 8850)
const src = fs.readFileSync(new URL('../../../../../server/index.ts', import.meta.url), 'utf8')
const lines = src.split('\n')

// 1) 解析所有路由注册（含多路径数组形式）
const routes = []
lines.forEach((line, i) => {
  const m = /^app\.(get|post|put|patch|delete|all)\((['"[])(.+?)\2/.exec(line)
  if (!m) return
  const method = m[1].toUpperCase()
  let raw = m[3]
  if (raw.trim().startsWith('[')) {
    for (const p of raw.matchAll(/'([^']+)'/g)) routes.push({ method, path: p[1], line: i + 1 })
  } else routes.push({ method, path: raw.replace(/^\[|\]$/g, ''), line: i + 1 })
})
// 2) 找到鉴权中间件行号
const authLine = lines.findIndex(l => /^app\.use\('\/api', requireAuth\)/.test(l)) + 1
// 3) 未认证探测：只对不需要 body 也能判定鉴权的路径；动态段用占位值
const probe = async (r) => {
  const p = r.path.replace(/:name|:id|:model|:channel|:authIndex/g, 'probe-id')
  const url = `http://127.0.0.1:${PORT}${p}`
  try {
    const res = await fetch(url, { method: r.method === 'ALL' ? 'GET' : r.method, headers: { 'content-type': 'application/json' }, body: ['POST', 'PUT', 'PATCH'].includes(r.method) ? '{}' : undefined, redirect: 'manual' })
    return { status: res.status, auth: res.headers.get('www-authenticate'), location: res.headers.get('location'), snippet: (await res.text()).slice(0, 80).replace(/\n/g, ' ') }
  } catch (error) { return { status: 'ERR', error: String(error).slice(0, 60) } }
}
const out = []
for (const r of routes) {
  if (r.path === '/docs' || r.path === '/docs/') continue
  const res = await probe(r)
  out.push({ line: r.line, method: r.method, path: r.path, beforeAuthMw: r.line < authLine, ...res })
}
console.log('authMiddleWare line:', authLine, ' routes:', routes.length)
console.log(JSON.stringify(out, null, 0).replace(/\},\{/g, '},\n{'))
const not401 = out.filter(o => o.status !== 401)
console.log('\n=== 未返回 401 的路由（需要逐一解释）===')
console.log(JSON.stringify(not401, null, 1))

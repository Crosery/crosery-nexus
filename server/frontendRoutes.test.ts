import assert from 'node:assert/strict'
import test from 'node:test'
import * as auth from './auth.js'
import { startContractCpa } from './testing/contractFixture.js'
import { launchConsole } from './testing/consoleProcess.js'
import { apiMembersUsed, frontendCalls, frontendSources, type FrontendCall } from './testing/frontendCalls.js'
import type { RouteTableEntry } from './testing/routeTableDump.js'

/**
 * 前后端路由契约（phase 4）：前端发出的每个 (method, path) 都必须是服务端真注册的路由，每条服务端路由都必须
 * 落在鉴权模型里（公开白名单 / key 会话 / 管理员），否则 `npm test` 红，而不是等用户点按钮才发现。
 *
 * - 前端调用：`testing/frontendCalls.ts` 用 TypeScript 解析器读 `src/**` 里每个 `/api/` 字面量和它喂给的请求；
 * - 服务端路由：真起 `server/index.ts`（CPA 模式，即正式形态），由 `testing/routeTableDump.ts` 在 listen 时导出
 *   Express 路由栈——条件注册（`if (cpa) app.post('/api/credentials/upload')`）和 `/api/me` 子路由都在里面。
 */

const REPO = new URL('../', import.meta.url).pathname

/**
 * 不是请求的 `/api` 字面量（有意保留，逐条写理由）。新增的字面量要么被解析成请求，要么加到这里——
 * 解析器读不懂的写法不能悄悄跳过检查。
 */
const NON_CALL_LITERALS: Record<string, string> = {
  'src/api/http.ts /api/login': 'AUTH_PROBES：401 是登录探测的回答，不触发会话过期跳转',
  'src/api/http.ts /api/session': 'AUTH_PROBES：同上',
  'src/api/http.ts /api/logout': 'AUTH_PROBES：同上',
}

/** key 会话的页面、外壳、客户端与外壳加载的会话模块（两种角色共用）；其余 `src/**` 是管理员控制台。 */
const KEY_ROLE_FILES = [/^src\/api\/me\.ts$/, /^src\/features\/me\//, /^src\/shell\/KeyShell\.vue$/, /^src\/shell\/logout\.ts$/, /^src\/app\/session\.ts$/]
/** key 页面能用的共享客户端成员（`api.me.*` 与两种角色共用的会话入口）。 */
const KEY_ROLE_API = /^(me\.\w+|me|session|login|loginWithKey|logout)$/

type Role = 'public' | 'key' | 'admin'

function roleOf(method: string, path: string): Role | null {
  if (auth.PUBLIC_PATHS.some(rule => (!rule.method || rule.method === method) && rule.pattern.test(path))) return 'public'
  if (auth.KEY_SESSION_PATHS.some(pattern => pattern.test(path))) return 'key'
  if (auth.SESSION_PROTECTED_PREFIXES.some(pattern => pattern.test(path))) return 'admin'
  return null
}

/** Express 路径只用到字面段与 `:param`；出现别的语法（通配、可选段）时下面的匹配器要先扩展。 */
const PLAIN_ROUTE = /^(\/(:?[A-Za-z0-9_.-]+))+$/

function routeMatches(route: string, call: string): boolean {
  const server = route.split('/')
  const client = call.split('/')
  if (server.length !== client.length) return false
  return server.every((segment, index) => {
    const sent = client[index]
    if (segment.startsWith(':')) return sent.length > 0
    return sent === ':param' || sent === segment
  })
}

const label = (call: FrontendCall) => `${call.method} ${call.path}  (${call.file}:${call.line})`

const calls = frontendCalls(REPO)
const requests = calls.filter(call => call.kind !== 'reference')

test('前端调用清单：解析器读到了全部 API 客户端，非请求字面量都在白名单里', () => {
  assert.ok(requests.length >= 120, `应解析出全部前端请求（实际 ${requests.length} 条）——解析器失效会让后面的断言空转`)
  for (const file of ['src/api/admin.ts', 'src/api/me.ts', 'src/api/proxy.ts', 'src/api/accounts.ts', 'src/api/sync.ts', 'src/features/models/ModelsPage.vue']) {
    assert.ok(requests.some(call => call.file === file), `${file} 里没解析到请求`)
  }
  assert.deepEqual(requests.filter(call => call.method === '?').map(label), [], '这些请求的 method 解析不出来（改成字面量 method，或扩展 frontendCalls.ts）')
  const references = calls.filter(call => call.kind === 'reference').map(call => `${call.file} ${call.path}`)
  assert.deepEqual(references.filter(key => !(key in NON_CALL_LITERALS)), [], '不是请求的 /api 字面量必须登记在 NON_CALL_LITERALS（写明理由）')
  assert.deepEqual(Object.keys(NON_CALL_LITERALS).filter(key => !references.includes(key)), [], 'NON_CALL_LITERALS 里有已经不存在的条目')
})

test('key 页面只用 key 会话可达的客户端成员', () => {
  const keyFiles = frontendSources(REPO).filter(file => KEY_ROLE_FILES.some(pattern => pattern.test(file)))
  assert.ok(keyFiles.includes('src/shell/KeyShell.vue') && keyFiles.some(file => file.startsWith('src/features/me/')), `key 页面清单不全：${keyFiles.join(', ')}`)
  const misuse: string[] = []
  for (const file of keyFiles) {
    for (const member of apiMembersUsed(REPO, file)) if (!KEY_ROLE_API.test(member)) misuse.push(`${file}: api.${member}`)
  }
  assert.deepEqual(misuse, [], 'key 会话页面调用了管理员接口（服务端会 403 forbidden_role）')
})

test('前后端路由契约：每个前端请求都命中服务端路由；每条路由都在鉴权模型里', { timeout: 120_000 }, async (t) => {
  const cpa = await startContractCpa()
  t.after(() => cpa.stop())
  const app = await launchConsole({ CPA_BASE_URL: cpa.base, CPA_MANAGEMENT_KEY: cpa.key })
  t.after(() => app.stop())
  const table = app.routes()
  const routes = table.filter(entry => entry.method !== 'USE')

  await t.test('路由表来自真实路由栈', () => {
    assert.ok(routes.length > 100, `路由表应包含全部路由（实际 ${routes.length} 条）`)
    for (const expected of ['GET /api/me/models', 'POST /api/credentials/upload', 'GET /api/sync/status', 'GET /api/public/release']) {
      assert.ok(routes.some(entry => `${entry.method} ${entry.path}` === expected), `路由表缺 ${expected}`)
    }
    assert.deepEqual(routes.filter(entry => !PLAIN_ROUTE.test(entry.path)).map(entry => `${entry.method} ${entry.path}`), [],
      '这些路由用了字面段与 :param 之外的路径语法，先扩展 routeMatches')
  })

  await t.test('每个前端 (method, path) 都有服务端路由', () => {
    const dead = requests.filter(call => !routes.some(entry => entry.method === call.method && routeMatches(entry.path, call.path)))
    assert.deepEqual(dead.map(label), [], '前端在调用服务端没有的接口（路径或方法不对）')
  })

  await t.test('每条服务端路由都已归类：公开白名单 / key 会话 / 管理员', () => {
    const unclassified = table.filter(entry => roleOf(entry.method === 'USE' ? 'GET' : entry.method, entry.path) === null)
    assert.deepEqual(unclassified.map(entry => `${entry.method} ${entry.path}`), [],
      '这些路由不在 PUBLIC_PATHS、KEY_SESSION_PATHS 或受保护前缀下（server/auth.ts）')
    const publicApi = routes.filter(entry => entry.path.startsWith('/api/') && roleOf(entry.method, entry.path) === 'public').map(entry => `${entry.method} ${entry.path}`)
    assert.deepEqual([...new Set(publicApi)].sort(), ['GET /api/public/model-catalog', 'GET /api/public/release', 'GET /api/session', 'POST /api/login', 'POST /api/logout'],
      '公开的 /api 路由必须恰好是这五个')
    const keyRoutes = routes.filter(entry => roleOf(entry.method, entry.path) === 'key')
    assert.ok(keyRoutes.length >= 6, `应有 /api/me* 路由（实际 ${keyRoutes.length}）`)
    assert.deepEqual(keyRoutes.filter(entry => entry.method !== 'GET').map(entry => `${entry.method} ${entry.path}`), [], 'key 会话只读：/api/me* 只允许 GET')
  })

  await t.test('前端请求的角色与页面一致：key 页面只打 key/公开接口，管理员页面不打 /api/me*', () => {
    const wrong: string[] = []
    for (const call of requests) {
      const keyPage = KEY_ROLE_FILES.some(pattern => pattern.test(call.file))
      const role = roleOf(call.method, call.path)
      if (keyPage && role === 'admin') wrong.push(`key 页面 → 管理员接口：${label(call)}`)
      if (!keyPage && role === 'key') wrong.push(`管理员页面 → key 接口（admin 会话 403 not_key_session）：${label(call)}`)
    }
    assert.deepEqual(wrong, [])
  })

  await t.test('鉴权行为：未登录 401、key 会话碰管理员路由 403 forbidden_role、key 路由放行', async () => {
    const keyCookie = await app.loginKey(await app.createKey('contract-route-key'))
    const concrete = (entry: RouteTableEntry) => entry.path.replace(/:[A-Za-z0-9_]+/g, 'contract-x')
    const failures: string[] = []
    for (const entry of routes) {
      const role = roleOf(entry.method, entry.path)
      if (role === 'public') continue
      const anonymous = await app.send(entry.method, concrete(entry))
      if (anonymous.status !== 401) failures.push(`未登录 ${entry.method} ${entry.path} → ${anonymous.status}`)
      if (role === 'admin') {
        const asKey = await app.send(entry.method, concrete(entry), { cookie: keyCookie })
        if (asKey.status !== 403 || asKey.body?.code !== 'forbidden_role') failures.push(`key 会话 ${entry.method} ${entry.path} → ${asKey.status} ${asKey.text.slice(0, 80)}`)
      } else if (role === 'key') {
        const asKey = await app.send(entry.method, concrete(entry), { cookie: keyCookie })
        if (asKey.status === 401 || asKey.status === 403) failures.push(`key 会话被拒 ${entry.method} ${entry.path} → ${asKey.status}`)
        const asAdmin = await app.send(entry.method, concrete(entry), { cookie: app.adminCookie })
        if (asAdmin.status !== 403 || asAdmin.body?.code !== 'not_key_session') failures.push(`admin 会话 ${entry.method} ${entry.path} → ${asAdmin.status}（应 403 not_key_session）`)
      }
    }
    assert.deepEqual(failures, [], app.log().slice(-600))
  })
})

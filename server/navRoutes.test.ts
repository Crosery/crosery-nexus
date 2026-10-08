import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import { createMemoryHistory, createRouter } from 'vue-router'
import { carry } from '../src/app/legacyRedirect.js'

/**
 * 导航 ⇄ 路由一致性（CONTRACTS「Frontend routes」）。
 *
 * 为什么是源码解析而不是 import：`src/app/routes.ts` 引 `.vue` 与无扩展名模块，放进 server 的 NodeNext
 * 程序会编译失败；而它的约定（子路由一律写绝对路径）让「每条记录写的就是真实 URL」，正则足够可靠。
 * 解析不到任何东西会显式失败，避免解析器失效后整组断言空转变绿。
 *
 * 断言的不变量：
 * 1. 两棵角色树各自闭合：admin 页面路由 = 顶栏 8 项 ∪ 用量工作台 4 个页签；key 页面路由 = KEY_NAV 4 项。
 * 2. 角色守卫：AdminShell 记录带 `role: 'admin'`，KeyShell 记录带 `role: 'key'`，key 树只在 /me 下。
 * 3. 旧路径重定向表与契约逐条相等，目标都是真实存在的 admin 页面；被删除的 /credentials、/ab 不再挂页面。
 * 4. `/` 与未知路径交给守卫按角色回首页（meta.home），而不是写死 /dashboard。
 */
const SRC = new URL('../src/', import.meta.url)
const read = (file: string) => fs.readFileSync(new URL(file, SRC), 'utf8')

type PageRoute = { path: string; name: string }

function between(source: string, start: string, end: string): string {
  const from = source.indexOf(start)
  assert.ok(from >= 0, `没找到起点 ${start}`)
  const to = source.indexOf(end, from + start.length)
  assert.ok(to > from, `没找到终点 ${end}`)
  return source.slice(from, to)
}

/** `{ path: '/x', name: 'y', component: () => import(...) }` → 挂页面的命名路由（不含 meta.home 占位）。 */
function pageRoutes(block: string): PageRoute[] {
  const out: PageRoute[] = []
  for (const match of block.matchAll(/\{\s*path: '([^']+)',\s*name: '([^']+)',\s*component: ([^,}]+)[^}]*\}/g)) {
    if (/meta: \{ home: true \}/.test(match[0])) continue
    assert.match(match[3], /import\('\.\.\/features\//, `${match[1]} 的页面必须来自 src/features/**`)
    out.push({ path: match[1], name: match[2] })
  }
  return out
}

function navTargets(source: string, exportName: string): Array<{ id: string; to: string; idx?: string }> {
  const block = between(source, `export const ${exportName}`, '\n]')
  const items = [...block.matchAll(/\{ id: '([^']+)',(?: idx: '(\d+)',)?[^}]*?to: '([^']+)' \}/g)].map((m) => ({ id: m[1], idx: m[2], to: m[3] }))
  assert.ok(items.length > 0, `没有从 nav.ts 的 ${exportName} 解析出条目`)
  return items
}

const routesSource = read('app/routes.ts')
const navSource = read('app/nav.ts')
const adminBlock = between(routesSource, "import('../shell/AdminShell.vue')", "import('../shell/KeyShell.vue')")
const keyBlock = between(routesSource, "import('../shell/KeyShell.vue')", '// v2 paths')
const adminRoutes = pageRoutes(adminBlock)
const keyRoutes = pageRoutes(keyBlock)

const diff = (a: string[], b: string[]) => {
  const set = new Set(b)
  return a.filter((value) => !set.has(value))
}

test('admin 树：页面路由 = 顶栏 7 项 ∪ 用量页签，双向无差集', () => {
  const routePaths = adminRoutes.map((r) => r.path).sort()
  const navPaths = [...navTargets(navSource, 'ADMIN_NAV'), ...navTargets(navSource, 'USAGE_TABS')].map((n) => n.to)
  const unique = [...new Set(navPaths)].sort()
  assert.deepEqual(diff(routePaths, unique), [], '有 admin 页面没有导航入口（顶栏或用量页签）')
  assert.deepEqual(diff(unique, routePaths), [], '有导航项指向不存在的 admin 页面')
  assert.deepEqual(routePaths, [
    '/dashboard', '/help', '/keys', '/models', '/providers', '/settings',
    '/usage', '/usage/cache', '/usage/performance', '/usage/requests',
  ])
})

test('顶栏 01–07 连续编号（1–7 跳转快捷键按顺序绑定），key 用户 01–04', () => {
  const admin = navTargets(navSource, 'ADMIN_NAV')
  assert.deepEqual(admin.map((n) => n.idx), ['01', '02', '03', '04', '05', '06', '07'])
  const key = navTargets(navSource, 'KEY_NAV')
  assert.deepEqual(key.map((n) => n.idx), ['01', '02', '03', '04'])
  // 移动端底栏与「更多」只引用顶栏里存在的 id
  const ids = new Set(admin.map((n) => n.id))
  const tabIds = [...between(navSource, 'export const ADMIN_TAB_IDS', '\n').matchAll(/'([^']+)'/g)].map((m) => m[1])
  assert.deepEqual(tabIds, ['dashboard', 'providers', 'keys', 'usage'])
  const moreIds = [...between(navSource, 'export const ADMIN_MORE_IDS', '\n]').matchAll(/ids: \[([^\]]*)\]/g)].flatMap((m) => [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]))
  assert.deepEqual(diff([...tabIds, ...moreIds], [...ids]), [])
  assert.deepEqual([...ids].filter((id) => !tabIds.includes(id) && !moreIds.includes(id)), [], '每个顶栏页面在手机上也要能到达（底栏或更多）')
})

test('key 树：只在 /me 下，且与 KEY_NAV 一一对应', () => {
  const routePaths = keyRoutes.map((r) => r.path).sort()
  const navPaths = navTargets(navSource, 'KEY_NAV').map((n) => n.to).sort()
  assert.deepEqual(routePaths, ['/me', '/me/connect', '/me/models', '/me/usage'])
  assert.deepEqual(routePaths, navPaths)
  assert.ok(keyRoutes.every((r) => r.path === '/me' || r.path.startsWith('/me/')))
  assert.ok(adminRoutes.every((r) => !r.path.startsWith('/me')), 'admin 树不得出现 /me 路径')
})

test('角色守卫：两个壳各自声明 meta.role，路由守卫按 meta.role 拦截', () => {
  assert.match(between(routesSource, "path: '/',", 'children'), /meta: \{ role: 'admin' \}/)
  assert.match(between(routesSource, "path: '/me',", 'children'), /meta: \{ role: 'key' \}/)
  const router = read('router.ts')
  assert.match(router, /to\.meta\.role && to\.meta\.role !== current\.role/)
  assert.match(router, /if \(to\.meta\.home\) return roleHome\(current\.role\)/)
  assert.match(read('app/session.ts'), /role === 'key' \? '\/me' : '\/dashboard'/)
})

test('旧路径重定向与契约逐条相等；被删除的页面不再挂载', () => {
  const redirects = Object.fromEntries([...routesSource.matchAll(/\{ path: '([^']+)', redirect: (?:carry\()?'([^']+)'\)? \}/g)].map((m) => [m[1], m[2]]))
  assert.deepEqual(redirects, {
    '/channels': '/providers?tab=channels',
    '/accounts': '/providers?tab=accounts',
    '/oauth': '/providers?tab=accounts',
    '/monitor': '/providers?tab=accounts',
    '/rtk': '/settings',
    '/charts': '/usage/performance',
    '/analytics': '/usage/requests',
    '/cache': '/usage/cache',
    '/credentials': '/dashboard',
    '/ab': '/dashboard',
  })
  for (const match of routesSource.matchAll(/\{ path: '([^']+)', redirect: '([^']+)' \}/g)) {
    assert.ok(!match[2].includes('?'), `${match[1]} 的目标自带查询，要用 carry()，否则 ?q= / ?add= 会丢`)
  }
  const pages = new Set(adminRoutes.map((r) => r.path))
  assert.deepEqual(Object.values(redirects).map((to) => to.split('?')[0]).filter((to) => !pages.has(to)), [], '重定向目标必须是真实页面')
  const all = [...adminRoutes, ...keyRoutes].map((r) => r.path)
  for (const removed of ['/credentials', '/ab', '/channels', '/accounts', '/oauth', '/monitor', '/rtk', '/charts', '/analytics', '/cache']) {
    assert.ok(!all.includes(removed), `${removed} 不应再挂页面（只剩重定向）`)
  }
  assert.match(routesSource, /path: '\/:pathMatch\(\.\*\)\*', name: 'unknown', component: Redirecting, meta: \{ home: true \}/)
})

test('旧链接的查询与锚点跟着重定向走：/channels?q=、/accounts?add=1 不丢', async () => {
  const Page = { render: () => null }
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/providers', component: Page },
      { path: '/channels', redirect: carry('/providers?tab=channels') },
      { path: '/accounts', redirect: carry('/providers?tab=accounts') },
    ],
  })
  await router.push('/channels?q=openrouter&status=off')
  assert.deepEqual(router.currentRoute.value.query, { q: 'openrouter', status: 'off', tab: 'channels' })
  await router.push('/accounts?add=1#oauth')
  assert.equal(router.currentRoute.value.path, '/providers')
  assert.deepEqual(router.currentRoute.value.query, { add: '1', tab: 'accounts' })
  assert.equal(router.currentRoute.value.hash, '#oauth')
  await router.push('/accounts?tab=channels')
  assert.equal(router.currentRoute.value.query.tab, 'accounts', '目标自己的 tab 优先')
})

test('解析守卫有牙齿：合成样本里漏一个导航项、多一个路由都必须被抓出来', () => {
  const sample = `children: [\n  { path: '/keys', name: 'keys', component: () => import('../features/keys/KeysPage.vue') },\n  { path: '/ghost', name: 'ghost', component: () => import('../features/ghost/GhostPage.vue') },\n  { path: '/', name: 'home', component: Redirecting, meta: { home: true } },\n]`
  const parsed = pageRoutes(sample).map((r) => r.path)
  assert.deepEqual(parsed, ['/keys', '/ghost'], 'meta.home 占位不算页面')
  assert.deepEqual(diff(parsed, ['/keys']), ['/ghost'])
  assert.deepEqual(diff(['/keys'], parsed), [])
  assert.throws(() => pageRoutes(`{ path: '/x', name: 'x', component: () => import('../pages/X.vue') }`), /src\/features/)
})

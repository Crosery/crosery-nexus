import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'

/**
 * R6-F：每个**已挂载的子路由**都应当在侧栏导航里有一项。
 *
 * 为什么不是「访问 /nope」那种验收法：现有路由表有 catch-all `path: '/:pathMatch(.*)*' → /dashboard`，
 * 任何不存在的路径都会被静默重定向到概览，所以「访问未知路径」观察不到 D32 想验的东西。
 * 差集断言才是可观测的：今天两侧集合相同 → 通过；将来新增路由却忘了加导航项 → 必红
 * （那正是 D32 的成因：用户在新页面上看不到任何高亮项，且没有任何测试会提醒）。
 */

const SRC = new URL('../src/', import.meta.url)

/**
 * **显式豁免**：这些路由有页面、可以访问，但**故意不放进侧边栏**。
 * 目前只有 A/B 实验台——它是内部 QA 工具（看新旧交互、投一票），不是产品功能，
 * 入口在运行概览底部；放进产品导航会让用户问"这是干什么的"。
 * 豁免必须写在这里：漏加导航项仍然会让上面的差集断言变红，不会静默通过。
 * 同时下面会断言豁免项**确实还在路由表里**——豁免不能用来藏一个已被删掉的路由。
 */
const NAV_EXEMPT_ROUTES = ['ab']

/** 从 router.ts 里取「有 name 的子路由」（即真正挂载页面的那些）。 */
function mountedChildRoutes(): string[] {
  const source = fs.readFileSync(new URL('router.ts', SRC), 'utf8')
  const shell = source.slice(source.indexOf('children: ['), source.indexOf('  },\n  {\n    path: \'/:pathMatch'))
  const paths = [...shell.matchAll(/path: '([^']+)',\s*name: '([^']+)'/g)].map((match) => match[1])
  assert.ok(paths.length > 0, '没有从 router.ts 解析出任何子路由，解析逻辑需要更新')
  return paths.sort()
}

/**
 * 从导航单一真源 `src/lib/nav.ts` 里取导航项的目标路径。
 *
 * 第 34 轮之前这里读的是 `components/ConsoleNav.vue`，因为导航项写在那里面；
 * 现在导航与面包屑共用 `lib/nav.ts`（那次搬家顺带修掉了"分组标题从不渲染"
 * 与"面包屑显示原始路由片段"两个缺陷）。**搬家时这条测试红了**——正是它该有的行为，
 * 所以这里跟着换文件，而不是把断言放宽。
 */
function navTargets(): string[] {
  const source = fs.readFileSync(new URL('lib/nav.ts', SRC), 'utf8')
  const targets = [...source.matchAll(/to: '\/([^']+)'/g)].map((match) => match[1])
  assert.ok(targets.length > 0, '没有从 lib/nav.ts 解析出导航项，解析逻辑需要更新')
  return targets.sort()
}

test('路由表与侧栏导航一一对应（差集为空）', () => {
  const routes = mountedChildRoutes()
  const nav = new Set(navTargets())
  const exempt = new Set(NAV_EXEMPT_ROUTES)
  const missing = routes.filter((path) => !nav.has(path) && !exempt.has(path))
  assert.deepEqual(
    missing,
    [],
    `这些子路由没有对应的侧栏导航项：${missing.join('、')}。要么在 ConsoleNav.vue 的 navEntries 里补一项，要么把路由从 router.ts 移除。`,
  )

  // 反向也要成立：导航项指向不存在的路由 = 死链接
  const routeSet = new Set(routes)
  const dangling = [...nav].filter((path) => !routeSet.has(path))
  assert.deepEqual(dangling, [], `这些导航项指向不存在的路由：${dangling.join('、')}`)

  // 豁免项必须真的还存在：否则"豁免"就成了藏已删路由的地方
  const ghostExempt = NAV_EXEMPT_ROUTES.filter((path) => !routeSet.has(path))
  assert.deepEqual(ghostExempt, [], `豁免名单里的路由已不存在（要么删掉豁免，要么恢复路由）：${ghostExempt.join('、')}`)
})

test('解析守卫有牙齿：合成样本里漏一个导航项必须被抓出来（不读生产文件的差集逻辑自检）', () => {
  const diff = (routes: string[], nav: string[]) => routes.filter((path) => !new Set(nav).has(path))
  assert.deepEqual(diff(['keys', 'ghost'], ['keys']), ['ghost'])
  assert.deepEqual(diff(['keys'], ['keys']), [])
})

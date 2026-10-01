import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'

/**
 * 为什么要有这条：`tsc -b` **不检查 `.vue`**（项目没有 vue-tsc），Vite 构建也不会因为
 * 「用了未导入的标识符」而失败——它只在浏览器里变成 `ReferenceError`，页面局部白屏。
 * 2026-10-01 真发生过：`ModelsPage.vue` 用了 `tableSortState`／`sortKeyForColumn`，
 * import 那一行因为一次没断言的字符串替换**静默没插进去**；`npm run build` 绿、`npm test` 绿，
 * 只有浏览器里报 `ReferenceError`（表格整块不渲染）。
 *
 * 它**只**做一件事：**页面/组件脚本里用到的本地模块导出，是否真的被 import 了**。
 *
 * 覆盖范围（第五轮扩面 + 自检自包含）：
 * - 扫描对象：`src/App.vue`、`src/pages/*.vue`、`src/components/*.vue` 的 `<script setup>`
 * - 符号来源：`src/lib/*.ts`、`src/api.ts`、`src/types.ts`、`src/chartTheme.ts`、
 *   `src/clientLabels.ts`、`src/channelLabels.ts`、`src/gatewayStatus.ts`、`src/components/*.vue`（按文件名当默认导入名）
 *
 * **仍然覆盖不到（它的自我定位必须诚实）**：
 * 1. **模板**里的未导入引用（只扫 `<script setup>`；模板里的 `PascalCase` 组件、过滤器式调用都不在扫描面内）
 * 2. 类型/参数/prop 不匹配（这是 vue-tsc 的活，不是正则的活）
 * 3. 拼写错误与大小写差异（例如 `useResourse`）
 * 4. 动态引用（`import(变量)`、`defineAsyncComponent` 的字符串路径、`app.component` 注册）
 * 5. 第三方包的导出（只认本地模块；`vue`/`@talex-touch/tuffex` 用错名字它不管）
 * 6. 跨文件重命名后的语义漂移
 * 结论：它是「补上工具链盲区的一道窄守卫」，不能当类型检查用。
 */

export type LocalSymbol = { symbol: string; moduleName: string }

/** 从一份 `.ts`/`.vue` 源码里静态解析导出名（不运行时 import，避免把 NodeNext 图拉进 server 程序）。 */
export function exportedSymbolsOf(source: string, moduleName: string): LocalSymbol[] {
  const patterns = [
    /export\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/g,
    /export\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g,
    /export\s+(?:type|interface|enum)\s+([A-Za-z_$][\w$]*)/g,
  ]
  const out: LocalSymbol[] = []
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) out.push({ symbol: match[1], moduleName })
  }
  return out
}

/** 去掉注释与字符串字面量，避免把说明文字当成真实引用。 */
export function stripNoise(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ')
    .replace(/'(?:[^'\\\n]|\\.)*'/g, "''")
    .replace(/"(?:[^"\\\n]|\\.)*"/g, '""')
    .replace(/`(?:[^`\\]|\\.)*`/g, '``')
}

/** 收集一个脚本里 import 进来的所有绑定名：具名（含别名）、默认、命名空间。 */
export function importedBindingsOf(script: string): Set<string> {
  const names = new Set<string>()
  const named = /import\s+(?:type\s+)?\{([^}]*)\}\s+from\s*'[^']+'/g
  for (const match of script.matchAll(named)) {
    for (const part of match[1].split(',')) {
      // 处理 `type Foo`、`Foo as Bar`、`type Foo as Bar`
      const name = part.trim().replace(/^type\s+/, '').split(/\s+as\s+/).pop()?.trim()
      if (name) names.add(name)
    }
  }
  // 默认导入 / 命名空间导入 / 混合写法
  const others = /import\s+(?:type\s+)?(?:([A-Za-z_$][\w$]*)\s*,?\s*)?(?:\*\s+as\s+([A-Za-z_$][\w$]*))?\s*from\s*'[^']+'/g
  for (const match of script.matchAll(others)) {
    if (match[1]) names.add(match[1])
    if (match[2]) names.add(match[2])
  }
  return names
}

/**
 * 核心扫描（纯函数）：给定一段脚本源码与「符号目录」，返回「用到但没导入」的符号。
 * 自检用合成样本直接调用它，**不读任何生产文件**。
 */
export function findMissingImports(script: string, catalogue: LocalSymbol[]): string[] {
  const imported = importedBindingsOf(script)
  const withoutImports = script
    .replace(/import\s+(?:type\s+)?\{[^}]*\}\s+from\s*'[^']+'/g, ' ')
    .replace(/import\s+(?:type\s+)?[^;\n]*from\s*'[^']+'/g, ' ')
  const body = stripNoise(withoutImports)
  const declaredLocally = new Set(
    [...body.matchAll(/(?:function|const|let|var|class|type|interface|enum)\s+([A-Za-z_$][\w$]*)/g)].map((m) => m[1]),
  )
  const problems: string[] = []
  for (const { symbol, moduleName } of catalogue) {
    if (imported.has(symbol) || declaredLocally.has(symbol)) continue
    if (new RegExp(`(?<![\\w$.])${symbol}(?![\\w$])`).test(body)) {
      problems.push(`${symbol}（来自 ${moduleName}）`)
    }
  }
  return problems
}

const SRC = new URL('../src/', import.meta.url)
const ROOT = new URL('../', import.meta.url)

function listVueFiles(): string[] {
  const out: string[] = ['src/App.vue']
  for (const dir of ['pages', 'components']) {
    const abs = new URL(`${dir}/`, SRC)
    for (const name of fs.readdirSync(abs)) {
      if (name.endsWith('.vue')) out.push(path.join('src', dir, name))
    }
  }
  return out
}

/** 收集本地模块的导出符号（含组件的默认导入名 = 文件名）。 */
function localCatalogue(): LocalSymbol[] {
  const out: LocalSymbol[] = []
  for (const file of fs.readdirSync(new URL('lib/', SRC))) {
    if (!file.endsWith('.ts')) continue
    out.push(...exportedSymbolsOf(fs.readFileSync(new URL(`lib/${file}`, SRC), 'utf8'), `src/lib/${file}`))
  }
  for (const file of ['api.ts', 'types.ts', 'chartTheme.ts', 'clientLabels.ts', 'channelLabels.ts', 'gatewayStatus.ts']) {
    out.push(...exportedSymbolsOf(fs.readFileSync(new URL(file, SRC), 'utf8'), `src/${file}`))
  }
  for (const name of fs.readdirSync(new URL('components/', SRC))) {
    if (name.endsWith('.vue')) out.push({ symbol: name.replace(/\.vue$/, ''), moduleName: `src/components/${name}` })
  }
  return out
}

test('每个 .vue 脚本用到的本地模块导出都必须被 import（防 ReferenceError 白屏）', () => {
  const catalogue = localCatalogue()
  const failures: string[] = []
  for (const relative of listVueFiles()) {
    const source = fs.readFileSync(new URL(relative, ROOT), 'utf8')
    const script = source.match(/<script setup[^>]*>([\s\S]*?)<\/script>/)?.[1]
    if (!script) continue
    const missing = findMissingImports(script, catalogue)
    if (missing.length) failures.push(`${relative}: ${missing.join('、')}`)
  }
  assert.deepEqual(failures, [], `发现「用了但没导入」的符号：\n${failures.join('\n')}`)
})

/* ------------------------------------------------------------------ *
 * 自检：全部使用**合成样本**，不读生产文件（红队第五轮 R5-B：
 * 上一版用「单行正则从生产文件里抠 import」造样本，把 import 重排成多行就会假红）。
 * ------------------------------------------------------------------ */

const SYNTHETIC: LocalSymbol[] = [
  { symbol: 'tableSortState', moduleName: 'src/lib/tableSort.ts' },
  { symbol: 'sortKeyForColumn', moduleName: 'src/lib/tableSort.ts' },
  { symbol: 'useResource', moduleName: 'src/lib/resource.ts' },
  { symbol: 'api', moduleName: 'src/api.ts' },
  { symbol: 'PageHeader', moduleName: 'src/components/PageHeader.vue' },
]

test('自检 1：单行 import + 使用 → 不报', () => {
  const script = [
    "import { tableSortState } from '../lib/tableSort'",
    'const sort = computed(() => tableSortState(key.value, dir.value))',
  ].join('\n')
  assert.deepEqual(findMissingImports(script, SYNTHETIC), [])
})

test('自检 2：import 被重排成多行（语义不变）→ 不报（上一版的假阳性来源）', () => {
  const script = [
    'import {',
    '  sortKeyForColumn,',
    '  tableSortState,',
    "} from '../lib/tableSort'",
    'const sort = computed(() => tableSortState(key.value, dir.value))',
    'const back = sortKeyForColumn(column.value)',
  ].join('\n')
  assert.deepEqual(findMissingImports(script, SYNTHETIC), [], '合法格式化不得触发告警')
})

test('自检 3（有牙齿）：删掉 import 后必须报出来', () => {
  const script = [
    'const sort = computed(() => tableSortState(key.value, dir.value))',
    'const back = sortKeyForColumn(column.value)',
  ].join('\n')
  const missing = findMissingImports(script, SYNTHETIC)
  assert.deepEqual(missing.sort(), ['sortKeyForColumn（来自 src/lib/tableSort.ts）', 'tableSortState（来自 src/lib/tableSort.ts）'])
})

test('自检 4：命名导入别名视为已导入', () => {
  const script = [
    "import { tableSortState as tableSortOf } from '../lib/tableSort'",
    'const sort = computed(() => tableSortState(key.value))',
    'const alias = tableSortOf(key.value)',
  ].join('\n')
  // 别名绑定的是 tableSortOf，但同名标识符 tableSortState 仍被使用 → 应当报
  assert.deepEqual(findMissingImports(script, SYNTHETIC), ['tableSortState（来自 src/lib/tableSort.ts）'])
  const correct = [
    "import { tableSortState as tableSortOf } from '../lib/tableSort'",
    'const alias = tableSortOf(key.value)',
  ].join('\n')
  assert.deepEqual(findMissingImports(correct, SYNTHETIC), [])
})

test('自检 5：本地声明同名符号（如页面自建 describeError）不报', () => {
  const script = ['function api() { return 1 }', 'const value = api()'].join('\n')
  assert.deepEqual(findMissingImports(script, SYNTHETIC), [])
})

test('自检 6：注释与字符串里的名字不算引用', () => {
  const script = ['// 这里曾经用过 tableSortState', "const note = 'useResource 已迁移'"].join('\n')
  assert.deepEqual(findMissingImports(script, SYNTHETIC), [])
})

test('自检 7（如实记录盲区）：模板里的未导入引用**扫不到**', () => {
  const script = ['const x = 1'].join('\n')
  // 模板里的 <PageHeader /> 不在 <script setup> 扫描面内 —— 这是这条守卫的已知盲区
  assert.deepEqual(findMissingImports(script, SYNTHETIC), [], '守卫只扫 script，模板盲区必须显式记录')
  const withScriptUse = ['const y = PageHeader'].join('\n')
  assert.deepEqual(findMissingImports(withScriptUse, SYNTHETIC), ['PageHeader（来自 src/components/PageHeader.vue）'])
})

test('自检 8：内联 `type` 修饰的具名导入算已导入', () => {
  const script = [
    "import { gatewayStatusCopy, type DashboardState, type GatewayState } from '../gatewayStatus'",
    'const copy = gatewayStatusCopy(state as GatewayState, engine)',
    'const s: DashboardState = \'ready\'',
  ].join('\n')
  assert.deepEqual(findMissingImports(script, SYNTHETIC), [], 'type 修饰符不得被当成标识符的一部分')
})

test('自检 9：默认导入与命名空间导入都算已导入', () => {
  assert.deepEqual(findMissingImports("import PageHeader from '../components/PageHeader.vue'\nconst a = PageHeader", SYNTHETIC), [])
  assert.deepEqual(findMissingImports("import * as api from '../api'\nconst a = api.session", SYNTHETIC), [])
})

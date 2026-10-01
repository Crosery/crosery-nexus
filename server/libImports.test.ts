import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'

/**
 * 为什么要有这条：`tsc -b` **不检查 `.vue`**（项目没有 vue-tsc），Vite 构建也不会因为
 * 「用了未导入的标识符」而失败——它只在浏览器里变成 `ReferenceError`，页面局部白屏。
 * 2026-10-01 就真发生过一次：`ModelsPage.vue` 用了 `tableSortState`／`sortKeyForColumn`，
 * 而 import 那一行因为一次没断言的字符串替换**静默没插进去**；`npm run build` 绿、`npm test` 绿，
 * 只有浏览器里报 `ReferenceError: tableSortState is not defined`（页面表格整块不渲染）。
 *
 * 这条测试只做一件很窄的事：**检查页面/组件脚本里用到的 `src/lib` 导出是否真的被 import 了**。
 * 它不能替代类型检查，也不是行为测试；它是补上工具链盲区的一道静态守卫。
 */

/**
 * 导出名**静态解析**（不运行时 import）：服务端项目的 `moduleResolution: NodeNext` 要求相对导入带扩展名，
 * 而 `src/lib/format.ts` 里是 `from '../chartTheme'`；把整个 lib 图拉进 server 程序会平白报 TS2835。
 * 这条守卫本来也只需要「符号名 → 模块名」的映射，不需要真的执行模块。
 */
function exportedSymbols(libDir: URL): Array<{ symbol: string; moduleName: string }> {
  const out: Array<{ symbol: string; moduleName: string }> = []
  for (const file of fs.readdirSync(libDir)) {
    if (!file.endsWith('.ts')) continue
    const moduleName = file.replace(/\.ts$/, '')
    const source = fs.readFileSync(new URL(file, libDir), 'utf8')
    const patterns = [
      /export\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/g,
      /export\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g,
      /export\s+(?:type|interface|enum)\s+([A-Za-z_$][\w$]*)/g,
    ]
    for (const pattern of patterns) {
      for (const match of source.matchAll(pattern)) out.push({ symbol: match[1], moduleName })
    }
  }
  return out
}

const SRC = new URL('../src/', import.meta.url)
const ROOT = new URL('../', import.meta.url)

function vueFiles(): string[] {
  const out: string[] = []
  for (const dir of ['pages', 'components']) {
    const abs = new URL(`${dir}/`, SRC)
    for (const name of fs.readdirSync(abs)) {
      if (name.endsWith('.vue')) out.push(path.join('src', dir, name))
    }
  }
  out.push('src/App.vue')
  return out
}

/** 去掉注释与字符串字面量，避免把说明文字当成真实引用。 */
function stripNoise(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ')
    .replace(/'(?:[^'\\\n]|\\.)*'/g, "''")
    .replace(/"(?:[^"\\\n]|\\.)*"/g, '""')
    .replace(/`(?:[^`\\]|\\.)*`/g, '``')
}

test('每个 .vue 脚本用到的 src/lib 导出都必须被 import（防 ReferenceError 白屏）', () => {
  const problems: string[] = []
  const exported = exportedSymbols(new URL('../src/lib/', import.meta.url))

  for (const relative of vueFiles()) {
    const source = fs.readFileSync(new URL(relative, ROOT), 'utf8')
    const setupMatch = source.match(/<script setup[^>]*>([\s\S]*?)<\/script>/)
    if (!setupMatch) continue
    const rawScript = setupMatch[1]
    // 注意：必须**在去注释/去字符串之前**提取 import —— stripNoise 会把模块路径变成空串。
    const importPattern = /import\s+(?:type\s+)?\{([^}]*)\}\s+from\s+'[^']+'/g
    const importedNames = new Set(
      [...rawScript.matchAll(importPattern)]
        .flatMap((match) => match[1].split(','))
        .map((part) => part.trim().split(/\s+as\s+/).pop()?.trim() ?? '')
        .filter(Boolean),
    )
    // 先在原始脚本里删掉 import 语句，再做「去注释/去字符串」，最后扫引用
    const withoutImports = rawScript
      .replace(importPattern, ' ')
      .replace(/import\s+[^;\n]+from\s+'[^']+'/g, ' ')
    const body = stripNoise(withoutImports)
    // 页面自己声明的同名函数/常量不算「未导入」（例如 RtkPage.vue 有本地的 describeError）
    const declaredLocally = new Set(
      [...body.matchAll(/(?:function|const|let|var|class|type|interface|enum)\s+([A-Za-z_$][\w$]*)/g)].map((match) => match[1]),
    )
    for (const { symbol, moduleName } of exported) {
      if (importedNames.has(symbol) || declaredLocally.has(symbol)) continue
      const used = new RegExp(`(?<![\\w$.])${symbol}(?![\\w$])`).test(body)
      if (used) problems.push(`${relative}: 用到 ${symbol}（来自 src/lib/${moduleName}.ts）但没有 import`)
    }
  }

  assert.deepEqual(problems, [], `发现「用了但没导入」的符号：\n${problems.join('\n')}`)
})

test('守卫本身有牙齿：故意构造一个未导入的引用会被抓出来', () => {
  // 反向自检：把 ModelsPage 的 import 行临时去掉，检查逻辑必须报错
  const source = fs.readFileSync(new URL('src/pages/ModelsPage.vue', ROOT), 'utf8')
  const withoutImport = source.replace(/^import \{ sortKeyForColumn, tableSortState \}.*$/m, '')
  assert.notEqual(withoutImport, source, 'ModelsPage 应当有 tableSort 的 import 行（守卫的前提）')
  const raw = withoutImport.match(/<script setup[^>]*>([\s\S]*?)<\/script>/)![1]
  const body = stripNoise(raw.replace(/import\s+[^;\n]+from\s+'[^']+'/g, ' '))
  assert.match(body, /(?<![\w$.])tableSortState(?![\w$])/, '去掉 import 后应仍能扫到标识符引用，守卫才有意义')
})

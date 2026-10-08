import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'

/**
 * Esc 要能关掉面板：抽屉与确认框都在 document / window 上听 Escape。行内操作格（⋯ 菜单、调整额度、开关）
 * 曾写成裸 `@keydown.stop` 挡住行的 Enter/Space，连 Escape 一起拦了——从这些按钮打开的面板焦点还留在
 * 触发按钮上，按 Esc 没反应。行只认 Enter 与空格，所以只停这两个键。
 */
const SRC = path.resolve(import.meta.dirname, '../src')

function vueFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) return vueFiles(full)
    return entry.name.endsWith('.vue') ? [full] : []
  })
}

test('模板里没有裸 @keydown.stop：只停具体按键，Escape 要能冒泡到面板', () => {
  const files = vueFiles(SRC)
  assert.ok(files.length > 50, '没扫到 .vue 文件')
  const bare = files.flatMap((file) =>
    fs.readFileSync(file, 'utf8').split('\n').flatMap((line, i) => (/@keydown\.stop(?![.\w])/.test(line) ? [`${path.relative(SRC, file)}:${i + 1}`] : [])),
  )
  assert.deepEqual(bare, [])
})

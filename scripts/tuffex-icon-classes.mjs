import { readdirSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Tuffex 组件自己渲染的图标类（`<i class="i-carbon-…">`）。
 * UnoCSS 默认不扫描 node_modules，这些类名不会被提取，宿主必须显式 safelist。
 */
const ICON_CLASS = /\bi-carbon-[a-z0-9-]+/g

function resolveDistRoot() {
  const require = createRequire(import.meta.url)
  try {
    return join(dirname(require.resolve('@talex-touch/tuffex')), '..', 'es')
  } catch {
    return null
  }
}

function* walkJs(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) yield* walkJs(full)
    else if (entry.isFile() && entry.name.endsWith('.js')) yield full
  }
}

/** @returns {string[]} 去重、排序后的 tuffex dist 图标类。 */
export function tuffexIconClasses() {
  const root = resolveDistRoot()
  if (!root) return []
  const found = new Set()
  try {
    for (const file of walkJs(root)) {
      for (const match of readFileSync(file, 'utf8').matchAll(ICON_CLASS)) found.add(match[0])
    }
  } catch {
    // fallback if directory cannot be walked
  }
  return [...found].sort()
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const classes = tuffexIconClasses()
  for (const cls of classes) console.log(cls)
  console.error(`${classes.length} icon classes`)
}

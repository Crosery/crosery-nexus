import fs from 'node:fs'
import path from 'node:path'
import { gzipSync } from 'node:zlib'

const dist = path.resolve(process.env.BUNDLE_DIST || 'dist')
const manifestPath = path.join(dist, '.vite', 'manifest.json')
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
const entry = manifest['index.html']
if (!entry) throw new Error('Vite manifest does not contain index.html')

const visited = new Set()
const files = new Set()
function collect(chunk) {
  if (!chunk || visited.has(chunk.file)) return
  visited.add(chunk.file)
  files.add(chunk.file)
  for (const css of chunk.css || []) files.add(css)
  for (const key of chunk.imports || []) collect(manifest[key])
}
collect(entry)

const totals = { js: 0, css: 0 }
for (const file of files) {
  const size = gzipSync(fs.readFileSync(path.join(dist, file))).byteLength
  if (file.endsWith('.js')) totals.js += size
  if (file.endsWith('.css')) totals.css += size
}

const jsBudget = Number(process.env.BUNDLE_JS_GZIP_BUDGET || 90 * 1024)
const cssBudget = Number(process.env.BUNDLE_CSS_GZIP_BUDGET || 20 * 1024)
console.log(JSON.stringify({
  entry: 'index.html',
  jsGzipBytes: totals.js,
  cssGzipBytes: totals.css,
  jsBudget,
  cssBudget,
}))

if (totals.js > jsBudget || totals.css > cssBudget) {
  console.error('Initial Console bundle exceeds the gzip budget')
  process.exitCode = 1
}

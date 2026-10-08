import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'

const source = fs.readFileSync(new URL('./index.ts', import.meta.url), 'utf8')

test('入口 HTML 不会被静态资源的一小时缓存锁住', () => {
  assert.match(source, /express\.static\(dist, \{\s*maxAge: '1h', immutable: true, index: false,/)
  assert.match(source, /res\.setHeader\('Cache-Control', 'no-cache'\)\s*\n\s*res\.sendFile\(path\.join\(dist, 'index\.html'\)\)/)
})

import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'

const source = fs.readFileSync(new URL('../deploy/nginx/console-compression.conf', import.meta.url), 'utf8')

test('console nginx include compresses hashed assets and JSON responses', () => {
  assert.match(source, /gzip on;/)
  assert.match(source, /gzip_vary on;/)
  assert.match(source, /application\/javascript/)
  assert.match(source, /application\/json/)
  assert.match(source, /text\/css/)
})

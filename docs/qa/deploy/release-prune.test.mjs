// node --test docs/qa/deploy/release-prune.test.mjs（docs/qa 不进 release，也不在 npm test 的 glob 里）
import assert from 'node:assert/strict'
import test from 'node:test'
import { planPrune, splitZ } from './release-prune.mjs'

test('deleted code files from the production base are pruned; everything else stays or is only flagged', () => {
  const assembled = [
    'server/zipEntries.ts', 'server/multipartUpload.ts', 'server/index.ts', 'scripts/ab-report.mjs',
    'deploy/edge/old.conf', 'data/console.db', '.env', 'node_modules/busboy/index.js', 'server/prodOnlyHotfix.ts',
    'server/readded.ts',
  ]
  const kept = ['server/index.ts', 'server/readded.ts']
  const deleted = ['server/zipEntries.ts', 'server/multipartUpload.ts', 'scripts/ab-report.mjs', 'deploy/edge/old.conf',
    'data/console.db', '.env', 'node_modules/busboy/index.js', 'server/readded.ts', 'server/never-shipped.ts']
  const plan = planPrune({ assembled, kept, deleted })
  assert.deepEqual(plan.prune, ['scripts/ab-report.mjs', 'server/multipartUpload.ts', 'server/zipEntries.ts'])
  assert.deepEqual(plan.review, ['deploy/edge/old.conf'], 'outside the code roots: flagged, never deleted')
  // prod-only files git never knew, re-added files, runtime state and secrets survive
  for (const rel of ['server/prodOnlyHotfix.ts', 'server/readded.ts', 'data/console.db', '.env', 'node_modules/busboy/index.js', 'server/index.ts']) {
    assert.ok(!plan.prune.includes(rel) && !plan.review.includes(rel), rel)
  }
})

test('splitZ reads NUL-separated git output', () => {
  assert.deepEqual(splitZ('a.ts\0b.ts\0\0a.ts\0'), ['a.ts', 'b.ts'])
  assert.deepEqual(splitZ(''), [])
})

test('splitZ keeps paths byte-exact: a deleted "server/legacy.ts " never prunes the live "server/legacy.ts"', () => {
  assert.deepEqual(splitZ('server/legacy.ts \0\nserver/b.ts\0'), ['server/legacy.ts ', 'server/b.ts'])
  const plan = planPrune({ assembled: ['server/legacy.ts'], kept: [], deleted: splitZ('server/legacy.ts \0') })
  assert.deepEqual(plan.prune, [])
  assert.deepEqual(plan.review, [])
})

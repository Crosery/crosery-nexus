import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { readPublicRelease } from './releaseInfo.js'

const withDir = (content: string | null, run: (dir: string) => void) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'release-info-'))
  try {
    if (content !== null) fs.writeFileSync(path.join(dir, 'RELEASE.json'), content)
    run(dir)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

test('只公开发布身份字段：构建机路径、锁文件摘要等不出去', () => {
  withDir(JSON.stringify({
    env: 'preview', version: '0.2.0', tag: 'v0.2.0-rc.1', commit: 'a'.repeat(40), releaseId: '20261009T030000Z-v0.2.0-rc.1',
    createdAt: '2026-10-09T03:00:00.000Z', buildHost: '/Users/someone/build', lockSha256: 'f'.repeat(64),
  }), (dir) => {
    assert.deepEqual(readPublicRelease(dir), {
      env: 'preview', version: '0.2.0', tag: 'v0.2.0-rc.1', commit: 'a'.repeat(40), releaseId: '20261009T030000Z-v0.2.0-rc.1',
      createdAt: '2026-10-09T03:00:00.000Z',
    })
  })
})

test('没有或损坏的 RELEASE.json、非字符串字段一律为 null', () => {
  const empty = { env: null, version: null, tag: null, commit: null, releaseId: null, createdAt: null }
  withDir(null, (dir) => assert.deepEqual(readPublicRelease(dir), empty))
  withDir('{not json', (dir) => assert.deepEqual(readPublicRelease(dir), empty))
  withDir(JSON.stringify({ commit: 42, tag: ['v1'], env: 'x'.repeat(201) }), (dir) => assert.deepEqual(readPublicRelease(dir), empty))
})

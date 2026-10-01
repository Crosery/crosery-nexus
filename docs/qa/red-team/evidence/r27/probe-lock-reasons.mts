// 红队第二十七轮：三种 stale reason 的直接取证（只读，不碰任何真实配置）
// 用法: node --import tsx docs/qa/red-team/evidence/r27/probe-lock-reasons.mts <tmpdir>
import fs from 'node:fs'
import path from 'node:path'
import { inspectRtkLock } from '../../../../../server/rtkService.js'

const dir = process.argv[2]
fs.mkdirSync(dir, { recursive: true })
const now = Date.now()
const lock = (name: string, payload: string, ageMs: number) => {
  const p = path.join(dir, name)
  fs.writeFileSync(p, payload)
  const t = (now - ageMs) / 1000
  fs.utimesSync(p, t, t)
  return p
}

const cases: Array<[string, string, number, string | undefined]> = [
  ['dead.json', JSON.stringify({ token: 't1', pid: 999_999, at: new Date(now - 60_000).toISOString(), purpose: 'x', home: '/tmp/home' }), 60_000, '/tmp/home'],
  ['alive-timeout.json', JSON.stringify({ token: 't2', pid: process.pid, at: new Date(now - 60_000).toISOString(), purpose: 'x', home: '/tmp/home' }), 60_000, '/tmp/home'],
  ['garbage-old.json', 'GARBAGE-NOT-JSON', 60_000, '/tmp/home'],
  ['garbage-fresh.json', 'GARBAGE-NOT-JSON', 1_000, '/tmp/home'],
  ['foreign-timeout.json', JSON.stringify({ token: 't3', pid: process.pid, at: new Date(now - 60_000).toISOString(), purpose: 'x', home: '/tmp/other-home' }), 60_000, '/tmp/home'],
]
for (const [name, payload, age, home] of cases) {
  const p = lock(name, payload, age)
  const verdict = inspectRtkLock(p, Date.now(), 5_000, home)
  console.log(`${name.padEnd(20)} → ${JSON.stringify(verdict)}`)
}

import assert from 'node:assert/strict'
import test from 'node:test'
import { DatabaseSync } from 'node:sqlite'

/**
 * 回归：时间窗口比较必须用 julianday，不能直接字符串比较。
 *
 * CPA 写入的时间戳带 +08:00 偏移（生产 19654/19654 条都是这个格式），
 * 而 datetime('now') 返回 UTC 裸串。字符串比较下 "2026-08-10T19:.." > "2026-08-10 11:.."，
 * 会把 8 小时外的数据算进窗口 —— 实测「最近 1 小时」返回 14137 条，正确值是 334 条。
 */
const withDb = (fn: (db: DatabaseSync) => void) => {
  const db = new DatabaseSync(':memory:')
  db.exec('CREATE TABLE usage_events (id INTEGER PRIMARY KEY AUTOINCREMENT, request_id TEXT UNIQUE, timestamp TEXT)')
  try { fn(db) } finally { db.close() }
}

/** 生成带 +08:00 偏移的时间戳，与生产格式一致。 */
const plus8 = (msAgo: number) => {
  const d = new Date(Date.now() - msAgo)
  return `${d.toLocaleString('sv', { timeZone: 'Asia/Shanghai' }).replace(' ', 'T')}+08:00`
}

test('julianday 正确判定时间窗口，字符串比较会误判', () => {
  withDb((db) => {
    const ins = db.prepare('INSERT INTO usage_events (request_id, timestamp) VALUES (?, ?)')
    ins.run('recent', plus8(30 * 60 * 1000))       // 30 分钟前 → 在 1h 窗口内
    ins.run('old', plus8(5 * 3600 * 1000))          // 5 小时前 → 不在 1h 窗口内

    const correct = db.prepare("SELECT COUNT(*) c FROM usage_events WHERE julianday(timestamp) >= julianday('now','-1 hour')").get() as { c: number }
    assert.equal(correct.c, 1, 'julianday 只应命中 30 分钟前那条')

    const legacy = db.prepare("SELECT COUNT(*) c FROM usage_events WHERE timestamp >= datetime('now','-1 hour')").get() as { c: number }
    assert.equal(legacy.c, 2, '字符串比较把 5 小时前的也算进来了（这正是修复前的 bug）')
  })
})

test('julianday 在跨日边界仍然正确', () => {
  withDb((db) => {
    const ins = db.prepare('INSERT INTO usage_events (request_id, timestamp) VALUES (?, ?)')
    ins.run('h2', plus8(2 * 3600 * 1000))
    ins.run('h30', plus8(30 * 3600 * 1000))

    const within24 = db.prepare("SELECT COUNT(*) c FROM usage_events WHERE julianday(timestamp) >= julianday('now','-24 hour')").get() as { c: number }
    assert.equal(within24.c, 1, '30 小时前那条不应算进 24 小时窗口')
  })
})

/**
 * 回归：INSERT OR IGNORE 重复插入时 changes=0，但 lastInsertRowid 保留旧值。
 * 广播必须以 changes 为闸门，否则重复投递的记录会被再推一次给前端。
 */
test('INSERT OR IGNORE 重复插入时 changes 为 0 而 lastInsertRowid 陈旧', () => {
  withDb((db) => {
    const ins = db.prepare('INSERT OR IGNORE INTO usage_events (request_id, timestamp) VALUES (?, ?)')

    const first = ins.run('req-1', '2026-08-10T12:00:00+08:00')
    assert.equal(first.changes, 1)

    const dup = ins.run('req-1', '2026-08-10T12:00:00+08:00')
    assert.equal(dup.changes, 0, '重复插入 changes 必须为 0')
    assert.equal(Number(dup.lastInsertRowid), Number(first.lastInsertRowid), 'lastInsertRowid 是陈旧值，不能用它判断是否新插入')

    const fresh = ins.run('req-2', '2026-08-10T12:00:01+08:00')
    assert.equal(fresh.changes, 1)
  })
})

// 红队第三轮：备份轮转 + 并发安全（实例 F1 keep=1 / F2 keep=2，各自独立 RTK_BACKUP_DIR）
import fs from 'node:fs'
import path from 'node:path'

const cookie = (p) => fs.readFileSync(p, 'utf8').split('\n').map(l => l.startsWith('#HttpOnly_') ? l.slice(10) : l)
  .filter(l => l && !l.startsWith('#')).map(l => l.split('\t')).filter(c => c.length >= 7).map(c => `${c[5]}=${c[6]}`).join('; ')
const api = async (port, method, url, body) => {
  const res = await fetch(`http://127.0.0.1:${port}${url}`, { method, headers: { 'content-type': 'application/json', cookie: cookie(`/tmp/cac-r3/ck-${port}.txt`) }, body: body === undefined ? undefined : JSON.stringify(body) })
  let json = null; try { json = await res.json() } catch {}
  return { status: res.status, json }
}
const dirs = (root) => { try { return fs.readdirSync(root).filter(n => fs.existsSync(path.join(root, n, 'manifest.json'))).sort() } catch { return [] } }
const inspect = (root, id) => {
  const dir = path.join(root, id)
  if (!fs.existsSync(path.join(dir, 'manifest.json'))) return { id, exists: false }
  const m = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'))
  const present = fs.readdirSync(dir).filter(n => n !== 'manifest.json')
  const expected = m.files.filter(f => f.existed).map(f => f.rel.replace(/[\\/]/g, '__'))
  const missing = expected.filter(n => !present.includes(n))
  return { id, exists: true, manifestFiles: m.files.length, expiredCopies: present.length, missingCopies: missing }
}
const log = (label, data) => console.log(label, JSON.stringify(data))

// R1: F1 keep=1，顺序 3 次
for (const [i, on] of [[1, true], [2, false], [3, true]]) {
  const r = await api(8808, 'POST', '/api/rtk/toggle', { agent: 'codex', on, plane: 'local', confirm: true })
  const id = r.json?.backupId
  log(`R1-seq-${i}`, { http: r.status, ok: r.json?.ok, backupId: id, dirs: dirs('/tmp/cac-r3/bk-F1'), hasBackupsArray: Array.isArray(r.json?.backups), keepsNewest: id ? inspect('/tmp/cac-r3/bk-F1', id).exists : null })
}
const st1 = await api(8808, 'GET', '/api/rtk/status')
log('R1-status', { backupKeep: st1.json?.backupKeep, backupsField: st1.json?.backups })
const rb1 = await api(8808, 'POST', '/api/rtk/rollback', { confirm: true })
log('R1-rollback', { http: rb1.status, ok: rb1.json?.ok, backupId: rb1.json?.backupId, restored: rb1.json?.restored?.length, error: rb1.json?.error })

// R2: F2 keep=2，顺序 4 次
for (let i = 1; i <= 4; i++) {
  const r = await api(8809, 'POST', '/api/rtk/toggle', { agent: 'claude', on: i % 2 === 1, plane: 'local', confirm: true })
  log(`R2-seq-${i}`, { http: r.status, ok: r.json?.ok, backupId: r.json?.backupId, dirs: dirs('/tmp/cac-r3/bk-F2'), newestAlive: r.json?.backupId ? inspect('/tmp/cac-r3/bk-F2', r.json.backupId).exists : null })
}

// R3: F2 并发 6 个不同 agent 的 ON
const agents = ['codex', 'claude', 'gemini', 'copilot', 'cursor', 'pi']
const results = await Promise.all(agents.map(a => api(8809, 'POST', '/api/rtk/toggle', { agent: a, on: true, plane: 'local', confirm: true })))
const ids = results.map(r => r.json?.backupId)
log('R3-concurrent', {
  http: results.map(r => r.status), ok: results.map(r => r.json?.ok),
  ids, distinctIds: new Set(ids.filter(Boolean)).size,
  sameMsCollision: ids.filter(Boolean).length !== new Set(ids.filter(Boolean)).size,
  dirsOnDisk: dirs('/tmp/cac-r3/bk-F2'),
  referencedButMissing: ids.filter(id => id && !inspect('/tmp/cac-r3/bk-F2', id).exists),
  details: ids.filter(Boolean).map(id => inspect('/tmp/cac-r3/bk-F2', id)),
})
const st2 = await api(8809, 'GET', '/api/rtk/status')
log('R3-status', { backupKeep: st2.json?.backupKeep, backupsField: st2.json?.backups })
const rb2 = await api(8809, 'POST', '/api/rtk/rollback', { confirm: true })
log('R3-rollback', { http: rb2.status, ok: rb2.json?.ok, backupId: rb2.json?.backupId, restored: rb2.json?.restored?.length, error: rb2.json?.error })

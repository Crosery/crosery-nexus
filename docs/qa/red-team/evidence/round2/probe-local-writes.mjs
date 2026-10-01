// 红队第二轮：在隔离实例（HOME=/tmp/cac-r2/home, PORT=8795）上做 C 层端到端写入验证。
// 只操作临时 HOME；每个步骤都重新读取真实 HOME 的 sha256 以证明零改动。
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

const PORT = Number(process.argv[2] || 8795)
const HOME = process.argv[3] || '/tmp/cac-r2/home'
const REAL = process.env.REAL_HOME
const COOKIE = process.argv[4] || '/tmp/cac-r2/cookies.txt'
const cookie = fs.readFileSync(COOKIE, 'utf8').split('\n')
  .map(l => l.startsWith('#HttpOnly_') ? l.slice('#HttpOnly_'.length) : l)
  .filter(l => l && !l.startsWith('#'))
  .map(l => l.split('\t')).filter(c => c.length >= 7)
  .map(c => `${c[5]}=${c[6]}`).join('; ')
if (!cookie) throw new Error('cookie jar 解析为空：' + COOKIE)

const out = []
const log = (label, data) => { out.push({ label, ...data }); console.log(JSON.stringify({ label, ...data })) }

async function api(method, url, body) {
  const res = await fetch(`http://127.0.0.1:${PORT}${url}`, {
    method, headers: { 'content-type': 'application/json', cookie }, body: body === undefined ? undefined : JSON.stringify(body),
  })
  let json = null
  try { json = await res.json() } catch {}
  return { status: res.status, json }
}

const read = rel => { try { return fs.readFileSync(path.join(HOME, rel), 'utf8') } catch { return null } }
const sha = p => { try { return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex').slice(0, 16) } catch { return null } }
const realFiles = ['/Users/crosery/.codex/hooks.json', '/Users/crosery/.claude/settings.json', '/Users/crosery/.cursor/hooks.json', '/Users/crosery/.gemini/settings.json', '/Users/crosery/.gemini/GEMINI.md', '/Users/crosery/.omp/agent/extensions/rtk.ts', '/Users/crosery/.pi/agent/extensions/rtk.ts']
const realSnapshot = () => Object.fromEntries(realFiles.map(f => [f.replace(REAL, '~'), sha(f)]))
const realBefore = realSnapshot()

/** 汇总一个 json 配置文件里的 hooks 结构（不判断格式对不对，只报告） */
function summarize(rel) {
  const raw = read(rel)
  if (raw === null) return { file: rel, exists: false }
  let j
  try { j = JSON.parse(raw) } catch (e) { return { file: rel, exists: true, invalidJson: true, bytes: raw.length } }
  const hooks = j.hooks || {}
  const result = { file: rel, exists: true, bytes: raw.length, events: {} }
  for (const [ev, arr] of Object.entries(hooks)) {
    if (!Array.isArray(arr)) { result.events[ev] = 'not-array'; continue }
    result.events[ev] = arr.map(e => ({
      matcher: e.matcher === undefined ? null : e.matcher,
      nested: Array.isArray(e.hooks) ? e.hooks.length : null,
      cmds: Array.isArray(e.hooks) ? e.hooks.map(h => String(h.command || '').slice(0, 40)) : (e.command !== undefined ? ['<flat> ' + String(e.command).slice(0, 40)] : []),
    }))
  }
  return result
}
const rtkHit = (rel, needle) => (read(rel) || '').includes(needle)

const results = { realBefore, steps: [] }
const step = (label, data) => { results.steps.push({ label, ...data }); log(label, data) }

// ---------- T7 / T8 / T16: codex 关 → 开 → 关 ----------
let r = await api('POST', '/api/rtk/toggle', { agent: 'codex', on: false, plane: 'local', confirm: true })
step('T8-codex-OFF', { http: r.status, ok: r.json?.ok, mechanism: r.json?.mechanism, backup: r.json?.backup?.id, fallbackReason: r.json?.fallbackReason, err: r.json?.error, codex: summarize('.codex/hooks.json') })
let st = await api('GET', '/api/rtk/status')
step('T8-detect-after-OFF', { codexOn: st.json?.agents?.find(a => a.id === 'codex')?.on, localCodexOn: st.json?.localAgents?.find(a => a.id === 'codex')?.on })

r = await api('POST', '/api/rtk/toggle', { agent: 'codex', on: true, plane: 'local', confirm: true })
step('T7-codex-ON', { http: r.status, ok: r.json?.ok, mechanism: r.json?.mechanism, backup: r.json?.backup?.id, codex: summarize('.codex/hooks.json') })

r = await api('POST', '/api/rtk/toggle', { agent: 'codex', on: false, plane: 'local', confirm: true })
step('T16-codex-OFF-again', { http: r.status, ok: r.json?.ok, codex: summarize('.codex/hooks.json'), claudeStillHasRtk: rtkHit('.claude/settings.json', 'rtk hook claude') })

// ---------- T14: claude / gemini 非交互必须真的写进去 ----------
r = await api('POST', '/api/rtk/toggle', { agent: 'claude', on: true, plane: 'local', confirm: true })
step('T14-claude-ON', { http: r.status, ok: r.json?.ok, mechanism: r.json?.mechanism, stderr: r.json?.stderr, claude: summarize('.claude/settings.json') })
r = await api('POST', '/api/rtk/toggle', { agent: 'gemini', on: true, plane: 'local', confirm: true })
step('T14-gemini-ON', { http: r.status, ok: r.json?.ok, mechanism: r.json?.mechanism, gemini: summarize('.gemini/settings.json') })

// ---------- 危险操作确认门 ----------
r = await api('POST', '/api/rtk/toggle', { agent: 'codex', on: false, plane: 'local' })
step('gate-toggle-after-claude-state', { http: r.status, ok: r.json?.ok, note: 'local 平面默认可写（writeMode=local），未要求 confirm' })

// ---------- T9: 坏 JSON 不覆盖 ----------
const badPath = path.join(HOME, '.codex/hooks.json')
const badBefore = read('.codex/hooks.json')
fs.writeFileSync(badPath, '{"hooks":{"PreToolUse":[ BROKEN')
r = await api('POST', '/api/rtk/toggle', { agent: 'codex', on: true, plane: 'local', confirm: true })
step('T9-bad-json', { http: r.status, ok: r.json?.ok, err: r.json?.error, reason: r.json?.reason, bytesAfter: fs.statSync(badPath).size, unchanged: read('.codex/hooks.json') === '{"hooks":{"PreToolUse":[ BROKEN', backupTaken: r.json?.backup?.id })
fs.writeFileSync(badPath, badBefore) // 恢复临时 HOME 的种子内容

// ---------- T10: agent 覆盖矩阵 ----------
const agents = ['codex', 'claude', 'gemini', 'copilot', 'cursor', 'omp', 'pi', 'droid', 'hermes', 'trae', 'vibe']
const matrix = []
for (const a of agents) {
  const on = await api('POST', '/api/rtk/toggle', { agent: a, on: true, plane: 'local', confirm: true })
  const stOn = await api('GET', '/api/rtk/status')
  const off = await api('POST', '/api/rtk/toggle', { agent: a, on: false, plane: 'local', confirm: true })
  const stOff = await api('GET', '/api/rtk/status')
  matrix.push({
    agent: a,
    on: { http: on.status, ok: on.json?.ok, mechanism: on.json?.mechanism, err: on.json?.error, reason: on.json?.reason, detected: stOn.json?.localAgents?.find(x => x.id === a)?.on, supported: stOn.json?.localAgents?.find(x => x.id === a)?.supported },
    off: { http: off.status, ok: off.json?.ok, err: off.json?.error, reason: off.json?.reason, detected: stOff.json?.localAgents?.find(x => x.id === a)?.on },
  })
}
step('T10-agent-matrix', { matrix })

// ---------- T4: 并发 toggle ----------
const [c1, c2] = await Promise.all([
  api('POST', '/api/rtk/toggle', { agent: 'codex', on: true, plane: 'local', confirm: true }),
  api('POST', '/api/rtk/toggle', { agent: 'codex', on: true, plane: 'local', confirm: true }),
])
step('T4-concurrent-ON', { http: [c1.status, c2.status], ok: [c1.json?.ok, c2.json?.ok], codex: summarize('.codex/hooks.json'), rtkEntryCount: (read('.codex/hooks.json') || '').split('rtk hook codex').length - 1, validJson: (() => { try { JSON.parse(read('.codex/hooks.json')); return true } catch { return false } })() })

// ---------- 真实配置零改动 ----------
step('T5-real-config-unchanged', { before: realBefore, after: realSnapshot(), identical: JSON.stringify(realBefore) === JSON.stringify(realSnapshot()) })

// ---------- 备份与回退 ----------
const stB = await api('GET', '/api/rtk/status')
step('backups', { count: stB.json?.backups?.length, ids: (stB.json?.backups || []).map(b => b.id).slice(0, 4), firstFiles: (stB.json?.backups || [])[0]?.files })
const rb = await api('POST', '/api/rtk/rollback', { confirm: true })
step('rollback-latest', { http: rb.status, ok: rb.json?.ok, backupId: rb.json?.backupId, restored: rb.json?.restored, collateralRestored: rb.json?.collateralRestored, codex: summarize('.codex/hooks.json') })

fs.writeFileSync('/tmp/cac-r2/probe-local-writes.json', JSON.stringify(results, null, 1))
console.log('WROTE /tmp/cac-r2/probe-local-writes.json')

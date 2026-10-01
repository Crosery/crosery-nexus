// 红队第十八轮 (A)：凭据名穿越修复的攻击矩阵
// 用法: node attack-authname.mjs <port> <cookieFile> <TMP>
import fs from 'node:fs'

const PORT = Number(process.argv[2])
const cookie = (() => {
  const raw = fs.readFileSync(process.argv[3], 'utf8').split('\n')
    .map(l => l.startsWith('#HttpOnly_') ? l.slice(10) : l).filter(l => l && !l.startsWith('#'))
    .map(l => l.split('\t')).filter(c => c.length >= 7)
  return raw.map(c => `${c[5]}=${c[6]}`).join('; ')
})()
const TMP = process.argv[4]
const AUTH = `${TMP}/data/auth-files`
const SENTINEL = `${TMP}/outside/sentinel.txt`
const OUTSIDE_JSON = `${TMP}/outside/outside.json`

const call = async (method, urlPath, body) => {
  const res = await fetch(`http://127.0.0.1:${PORT}${urlPath}`, {
    method, headers: { cookie, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body), redirect: 'manual',
  })
  let text = ''
  try { text = (await res.text()).slice(0, 160) } catch {}
  return { status: res.status, body: text }
}
const sentinelOk = () => fs.existsSync(SENTINEL) && fs.readFileSync(SENTINEL, 'utf8') === 'SENTINEL-CONTENT\n'

const attacks = [
  ['穿越删除 (URL 编码斜杠)', 'DELETE', '/api/credentials/..%2F..%2Foutside%2Fsentinel.txt'],
  ['穿越删除 (小写编码)', 'DELETE', '/api/credentials/..%2f..%2foutside%2fsentinel.txt'],
  ['穿越删除 (%2e%2e%2f)', 'DELETE', '/api/credentials/%2e%2e%2f%2e%2e%2foutside%2fsentinel.txt'],
  ['穿越删除 (大写编码)', 'DELETE', '/api/credentials/%2E%2E%2F%2E%2E%2Foutside%2Fsentinel.txt'],
  ['双重编码 %252e%252e', 'DELETE', '/api/credentials/..%252f..%252foutside%252fsentinel.txt'],
  ['绝对路径', 'DELETE', '/api/credentials/%2Fetc%2Fpasswd'],
  ['裸斜杠（Express 归并）', 'DELETE', '/api/credentials/..%2F..%2Foutside%2Fsentinel.txt/'],
  ['反斜杠', 'DELETE', '/api/credentials/..%5C..%5Coutside%5Csentinel.txt'],
  ['NUL 字节', 'DELETE', '/api/credentials/canary%00.txt'],
  ['超长名字 (4000)', 'DELETE', '/api/credentials/' + 'a'.repeat(4000)],
  ['全角斜杠/点', 'DELETE', '/api/credentials/%EF%BC%8E%EF%BC%8E%EF%BC%8Foutside'],
  ['点号', 'DELETE', '/api/credentials/.'],
  ['点点', 'DELETE', '/api/credentials/..'],
  ['穿越读取 (proxy)', 'GET', '/api/credentials/..%2F..%2Foutside%2Foutside.json/proxy'],
  ['穿越读取 (%2e%2e)', 'GET', '/api/credentials/%2e%2e%2f%2e%2e%2foutside%2foutside.json/proxy'],
  ['穿越 PATCH 状态', 'PATCH', '/api/credentials/..%2F..%2Foutside%2Fsentinel.txt'],
  ['穿越 PATCH 代理', 'PATCH', '/api/credentials/..%2F..%2Foutside%2Fsentinel.txt/proxy'],
]

console.log('=== 攻击矩阵 ===')
const rows = []
for (const [label, method, path] of attacks) {
  const body = method === 'PATCH'
    ? (path.endsWith('/proxy') ? { proxyUrl: 'socks5://127.0.0.1:1' } : { enabled: false })
    : undefined
  const r = await call(method, path, body)
  const ok = sentinelOk() && fs.existsSync(OUTSIDE_JSON)
  rows.push({ label, method, status: r.status, body: r.body, sentinelIntact: ok })
  console.log(`${r.status} | ${ok ? '目标完好' : '目标被破坏!!'} | ${label} ${method} → ${r.body}`)
}
console.log('\n=== 符号链接攻击 ===')
fs.symlinkSync(`${TMP}/outside/outside.json`, `${AUTH}/link-to-outside.json`)
let r = await call('DELETE', '/api/credentials/link-to-outside.json')
console.log(`symlink 删除: ${r.status} ${r.body} | 软链仍在=${fs.existsSync(`${AUTH}/link-to-outside.json`)} 目标仍在=${fs.existsSync(OUTSIDE_JSON)}`)
r = await call('GET', '/api/credentials/link-to-outside.json/proxy')
console.log(`symlink 读取: ${r.status} ${r.body}`)
fs.rmSync(`${AUTH}/link-to-outside.json`, { force: true })

console.log('\n=== 硬链接攻击 ===')
fs.linkSync(`${TMP}/outside/outside.json`, `${AUTH}/hardlink-to-outside.json`)
r = await call('DELETE', '/api/credentials/hardlink-to-outside.json')
console.log(`hardlink 删除: ${r.status} ${r.body} | 硬链仍在=${fs.existsSync(`${AUTH}/hardlink-to-outside.json`)} 目标仍在=${fs.existsSync(OUTSIDE_JSON)}`)
r = await call('GET', '/api/credentials/hardlink-to-outside.json/proxy')
console.log(`hardlink 读取: ${r.status} ${r.body}`)
fs.rmSync(`${AUTH}/hardlink-to-outside.json`, { force: true })

console.log('\n=== 合法名字仍可用 ===')
r = await call('GET', '/api/credentials/codex-legit.json/proxy')
console.log(`合法读取: ${r.status} ${r.body}`)
r = await call('PATCH', '/api/credentials/codex-legit.json', { enabled: false })
console.log(`合法禁用: ${r.status} ${r.body}`)
r = await call('DELETE', '/api/credentials/codex-legit.json')
console.log(`合法删除: ${r.status} ${r.body} | 文件已删=${!fs.existsSync(`${AUTH}/codex-legit.json`)}`)

fs.writeFileSync(`${TMP}/attack-matrix.json`, JSON.stringify(rows, null, 1))
console.log('\n哨兵最终状态:', sentinelOk() ? '完好' : '被破坏')

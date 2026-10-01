#!/usr/bin/env node
/**
 * 只读采样器：在**运行中的真实服务**上长期采样（几小时～几天），用来发现慢泄漏。
 *
 * 为什么会需要它：单轮 soak（见 soak.mjs）只能抓**快泄漏**（分钟级可见）。
 * "跑三天才涨"的慢泄漏无法在一轮里证明——只有长期采样才能证。
 *
 * 用法（默认只读，不写任何文件到被采样目录，不做任何变更）：
 *   node read-only-sampler.mjs --port 8791 --label prod --interval 300 --out ~/leak-samples.jsonl
 *   可选：--pid <console pid>    直接用 pid 采 FD（默认用 lsof 按端口找 LISTEN pid）
 *         --inspect 9333        如果服务不是用 --inspect 启的，堆采样会跳过（RSS 仍可用）
 *         --cookie <file>       若要顺带打一条只读 API（/api/session）验证可用性
 *
 * 采什么：
 *   fd        —— lsof -p 的行数（句柄/连接数；泄漏最直观的指标）
 *   rssMb     —— 进程 RSS（读 /proc 不可用，macOS 下用 vmmap/ps 均需权限，因此**优先走 inspector**；
 *                没有 inspector 时退化为只采 fd + 可用性）
 *   heapMb    —— inspector CDP 的 process.memoryUsage()（需要 --inspect）
 *   sse       —— 可选：打一条 /api/cache-live/status 看客户端数（只读）
 *
 * 判读方法（重要）：
 *   1. 先看 **fd 的长期斜率**：正常应围绕加载后的水平线小幅波动；单调上升 = 句柄泄漏（最可信的泄漏信号）。
 *   2. 再看 heapUsed 的**周期性低点（GC 后基线）**，不要看瞬时值——RSS/heap 的单点高值通常是 GC 锯齿或缓存预热。
 *      ⇒ 判据：把每个采样窗口的**最小值**连成线，若基线随天数单调上升才是泄漏。
 *   3. 出现重启（pid 变化）会把计数清零：脚本会记录 pid，遇到变化时写入 {"restart": true} 便于剔除。
 *   4. launchd 的 KeepAlive=1 + ThrottleInterval=10 意味着"泄漏 → OOM → 每 10 秒崩一次"；
 *      若采样里看到 pid 频繁变化 + fd/heap 每次重启后仍快速抬高，就是这一形态。
 */
import fs from 'node:fs'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const run = promisify(execFile)
const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : fallback
}
const PORT = Number(arg('port', '8791'))
const LABEL = arg('label', `port-${PORT}`)
const INTERVAL_S = Number(arg('interval', '300'))
const OUT = arg('out', `${process.env.HOME}/leak-samples-${PORT}.jsonl`)
const INSPECT = Number(arg('inspect', '0'))
const COOKIE_FILE = arg('cookie', '')

const log = (obj) => {
  const line = JSON.stringify(obj)
  fs.appendFileSync(OUT, `${line}\n`)
  console.log(line)
}
const listenPid = async () => {
  try {
    const { stdout } = await run('lsof', ['-i', `tcp:${PORT}`, '-sTCP:LISTEN', '-t'])
    return Number(String(stdout).trim().split('\n')[0]) || null
  } catch { return null }
}
const fdCount = async (pid) => {
  try {
    const { stdout } = await run('lsof', ['-p', String(pid)])
    return String(stdout).trim().split('\n').length - 1
  } catch { return null }
}
const heap = async () => {
  if (!INSPECT) return null
  try {
    const list = await (await fetch(`http://127.0.0.1:${INSPECT}/json/list`)).json()
    const target = list.find((t) => t.webSocketDebuggerUrl)
    if (!target) return null
    return await new Promise((resolve) => {
      const ws = new WebSocket(target.webSocketDebuggerUrl)
      const timer = setTimeout(() => { try { ws.close() } catch {} resolve(null) }, 5000)
      ws.addEventListener('open', () => ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: 'JSON.stringify(process.memoryUsage())', returnByValue: true } })))
      ws.addEventListener('message', (event) => {
        try {
          const msg = JSON.parse(event.data)
          if (msg.id !== 1) return
          clearTimeout(timer); ws.close(); resolve(JSON.parse(msg.result.result.value))
        } catch { clearTimeout(timer); resolve(null) }
      })
      ws.addEventListener('error', () => { clearTimeout(timer); resolve(null) })
    })
  } catch { return null }
}

let lastPid = null
process.on('unhandledRejection', () => {}) // 采样器自身不能因为一次失败退出
console.log(`采样开始：port=${PORT} label=${LABEL} interval=${INTERVAL_S}s out=${OUT}`)
for (;;) {
  const pid = await listenPid()
  const mem = await heap()
  const row = {
    at: new Date().toISOString(), label: LABEL, port: PORT, pid,
    restart: lastPid !== null && pid !== null && pid !== lastPid,
    fd: pid ? await fdCount(pid) : null,
    rssMb: mem ? +(mem.rss / 1048576).toFixed(1) : null,
    heapUsedMb: mem ? +(mem.heapUsed / 1048576).toFixed(2) : null,
    externalMb: mem ? +(mem.external / 1048576).toFixed(2) : null,
    alive: false,
  }
  try {
    const headers = COOKIE_FILE ? { cookie: fs.readFileSync(COOKIE_FILE, 'utf8').trim() } : {}
    const res = await fetch(`http://127.0.0.1:${PORT}/api/session`, { headers })
    row.alive = res.status === 200
  } catch { row.alive = false }
  lastPid = pid
  log(row)
  await new Promise((r) => setTimeout(r, INTERVAL_S * 1000))
}

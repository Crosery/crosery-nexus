/**
 * 第二十八轮 ⑨：有界 soak —— FD 采样（lsof）+ 堆采样（inspector CDP）+ SSE 连断 churn + API 调用
 *
 * 用法: node soak.mjs <appPort> <inspectPort> <cookieFile> <minutes> <outJsonl>
 *
 * 诚实边界：本脚本只能抓**快泄漏**（分钟级可见的趋势）。跑几天才涨的慢泄漏它测不出来，
 * 那种只能靠 read-only-sampler.mjs 在真实服务上长期采样。
 */
import fs from 'node:fs'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

process.on("unhandledRejection", (e) => { console.error("[soak] 忽略客户端 abort 引发的未处理拒绝:", String(e && e.name || e).slice(0,60)) })
const [appPort, inspectPort, cookieFile, minutesRaw, outPath] = process.argv.slice(2)
const APP = `http://127.0.0.1:${appPort}`
const MINUTES = Number(minutesRaw || 6)
const run = promisify(execFile)

const cookie = fs.readFileSync(cookieFile, 'utf8').split('\n')
  .map((l) => (l.startsWith('#HttpOnly_') ? l.slice(10) : l))
  .filter((l) => l && !l.startsWith('#'))
  .map((l) => l.split('\t')).filter((c) => c.length >= 7)
  .map((c) => `${c[5]}=${c[6]}`).join('; ')

const pidOf = async () => {
  const { stdout } = await run('lsof', ['-i', `tcp:${appPort}`, '-sTCP:LISTEN', '-t'])
  return Number(String(stdout).trim().split('\n')[0])
}
const fdCount = async (pid) => {
  try {
    const { stdout } = await run('lsof', ['-p', String(pid)])
    return String(stdout).trim().split('\n').length - 1
  } catch { return -1 }
}

/** 用 Node 内置 WebSocket 连 inspector，读 process.memoryUsage() */
async function heapSample(inspectPort) {
  const list = await (await fetch(`http://127.0.0.1:${inspectPort}/json/list`)).json()
  const target = list.find((t) => t.webSocketDebuggerUrl)
  if (!target) return null
  return await new Promise((resolve) => {
    const ws = new WebSocket(target.webSocketDebuggerUrl)
    const timer = setTimeout(() => { try { ws.close() } catch {} resolve(null) }, 4000)
    ws.addEventListener('open', () => {
      ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: 'JSON.stringify(process.memoryUsage())', returnByValue: true } }))
    })
    ws.addEventListener('message', (event) => {
      try {
        const msg = JSON.parse(event.data)
        if (msg.id !== 1) return
        clearTimeout(timer)
        ws.close()
        resolve(JSON.parse(msg.result.result.value))
      } catch { clearTimeout(timer); resolve(null) }
    })
    ws.addEventListener('error', () => { clearTimeout(timer); resolve(null) })
  })
}

const pid = await pidOf()
console.log(`console pid=${pid} app=${APP} inspect=${inspectPort} 时长=${MINUTES} 分钟`)
const samples = []
let apiCalls = 0
let sseCycles = 0

const endpoints = ['/api/session', '/api/version', '/api/bootstrap', '/api/dashboard', '/api/channels',
  '/api/usage-overview', '/api/audit', '/api/cache-live/status', '/api/rtk/status', '/api/data-plane/status']
const hitApi = async () => {
  const p = endpoints[Math.floor(Math.random() * endpoints.length)]
  try { await fetch(`${APP}${p}`, { headers: { cookie } }); apiCalls++ } catch {}
}
/** SSE：连上、读一小段、主动 abort（模拟标签页开关） */
const sseCycle = async () => {
  const ctrl = new AbortController()
  try {
    const res = await fetch(`${APP}/api/cache-live`, { headers: { cookie, accept: 'text/event-stream' }, signal: ctrl.signal })
    const reader = res.body?.getReader()
    if (reader) {
      const reading = (async () => { for (let i = 0; i < 3; i++) { const r = await reader.read(); if (r.done) break } })().catch(() => {})
      await Promise.race([reading, new Promise((r) => setTimeout(r, 400))])
      ctrl.abort()
      try { await reading } catch {}
      ctrl.abort()
      try { await reader.cancel() } catch {}
    }
  } catch {}
  sseCycles++
}

const started = Date.now()
const deadline = started + MINUTES * 60_000
let lastSample = 0
const sample = async (label) => {
  const mem = await heapSample(inspectPort)
  samples.push({
    at: new Date().toISOString(), label, apiCalls, sseCycles,
    fd: await fdCount(pid), apiClientCount: null,
    heapUsedMb: mem ? +(mem.heapUsed / 1048576).toFixed(2) : null,
    rssMb: mem ? +(mem.rss / 1048576).toFixed(2) : null,
    externalMb: mem ? +(mem.external / 1048576).toFixed(2) : null,
    arrayBuffersMb: mem ? +(mem.arrayBuffers / 1048576).toFixed(2) : null,
    heapTotalMb: mem ? +(mem.heapTotal / 1048576).toFixed(2) : null,
  })
  console.log(JSON.stringify(samples.at(-1)))
}
await sample('baseline')

while (Date.now() < deadline) {
  // 每轮：4 次 API + 1 次 SSE 连断
  await Promise.all([hitApi(), hitApi(), hitApi(), hitApi()])
  await sseCycle()
  if (Date.now() - lastSample > 15_000) { lastSample = Date.now(); await sample('tick') }
}
// 收尾：让 SSE 全部断开后静置 20s 再采一次，看回不回收
await new Promise((r) => setTimeout(r, 20_000))
await sample('after-quiet')

fs.writeFileSync(outPath, JSON.stringify({ pid, minutes: MINUTES, apiCalls, sseCycles, samples }, null, 1))
const first = samples[0]; const last = samples.at(-1)
console.log(`\n=== 汇总 ===\napiCalls=${apiCalls} sseCycles=${sseCycles}`)
console.log(`heapUsed: ${first.heapUsedMb} → ${last.heapUsedMb} MB（Δ${(last.heapUsedMb - first.heapUsedMb).toFixed(2)}）`)
console.log(`rss:      ${first.rssMb} → ${last.rssMb} MB（Δ${(last.rssMb - first.rssMb).toFixed(2)}）`)
console.log(`FD:       ${first.fd} → ${last.fd}（Δ${last.fd - first.fd}）`)
console.log(`external: ${first.externalMb} → ${last.externalMb} MB；arrayBuffers: ${first.arrayBuffersMb} → ${last.arrayBuffersMb} MB`)

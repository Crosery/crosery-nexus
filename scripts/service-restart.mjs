#!/usr/bin/env node
// 执行控制台排的重启请求（root，由 crosery-service-restart.path 触发）。只认白名单里的两个目标，请求文件内容不决定要重启什么。
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

export const TARGETS = { cpa: 'cli-proxy-api.service', console: 'crosery-api-console.service' }

export function processRequests({ dir, statusFile, systemctl = defaultSystemctl, now = () => new Date() }) {
  let status = {}
  try { status = JSON.parse(fs.readFileSync(statusFile, 'utf8')) } catch { /* 首次 */ }
  const done = []
  // 控制台自己放最后：它重启时这个脚本的状态必须已经写好
  const names = Object.keys(TARGETS).sort((a, b) => Number(a === 'console') - Number(b === 'console'))
  for (const target of names) {
    const file = path.join(dir, `${target}.json`)
    if (!fs.existsSync(file)) continue
    let requestedAt = now().toISOString()
    try { requestedAt = JSON.parse(fs.readFileSync(file, 'utf8')).requestedAt ?? requestedAt } catch { /* 内容不重要 */ }
    fs.rmSync(file, { force: true })
    const noBlock = target === 'console'
    const result = systemctl(['restart', ...(noBlock ? ['--no-block'] : []), TARGETS[target]])
    status[target] = {
      target, requestedAt, finishedAt: now().toISOString(),
      result: result.ok ? 'ok' : 'failed',
      ...(result.ok ? {} : { message: String(result.message || '').slice(0, 300) }),
    }
    done.push(target)
    fs.writeFileSync(statusFile, `${JSON.stringify(status, null, 2)}\n`, { mode: 0o600 })
  }
  // 白名单之外的文件一律清掉，避免路径单元反复触发
  for (const name of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
    if (!name.endsWith('.tmp')) fs.rmSync(path.join(dir, name), { force: true, recursive: true })
  }
  return done
}

function defaultSystemctl(args) {
  const r = spawnSync('systemctl', args, { encoding: 'utf8' })
  return { ok: r.status === 0, message: `${r.stderr ?? ''}${r.stdout ?? ''}`.trim() }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const data = process.env.DATA_DIR || '/opt/crosery-api-console/data'
  const done = processRequests({ dir: path.join(data, 'service-requests'), statusFile: path.join(data, 'service-restart-status.json') })
  console.log(done.length ? `restarted: ${done.join(', ')}` : 'nothing to do')
}

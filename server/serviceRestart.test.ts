import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { isRestartTarget, readRestartStatus, requestRestart } from './serviceRestart.js'
// @ts-expect-error mjs 无类型
import { processRequests } from '../scripts/service-restart.mjs'

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'svc-restart-'))

test('只认白名单目标', () => {
  assert.ok(isRestartTarget('cpa') && isRestartTarget('console'))
  assert.ok(!isRestartTarget('nginx') && !isRestartTarget('../x'))
})

test('请求排队后状态为 pending，重复点击不产生第二个请求', () => {
  const dir = tmp()
  const first = requestRestart(dir, 'cpa', 1000)
  const again = requestRestart(dir, 'cpa', 9000)
  assert.equal(again.requestedAt, first.requestedAt)
  assert.equal(readRestartStatus(dir).cpa?.pending, true)
  assert.deepEqual(fs.readdirSync(path.join(dir, 'service-requests')), ['cpa.json'])
})

test('执行器：只重启白名单 unit，控制台排最后，结果写回，请求文件清空', () => {
  const dir = tmp()
  requestRestart(dir, 'console')
  requestRestart(dir, 'cpa')
  fs.writeFileSync(path.join(dir, 'service-requests', 'evil.json'), '{"unit":"sshd.service"}')
  const calls: string[][] = []
  const done = processRequests({
    dir: path.join(dir, 'service-requests'),
    statusFile: path.join(dir, 'service-restart-status.json'),
    systemctl: (args: string[]) => { calls.push(args); return { ok: args.at(-1) !== 'cli-proxy-api.service', message: 'boom' } },
  })
  assert.deepEqual(done, ['cpa', 'console'])
  assert.deepEqual(calls, [['restart', 'cli-proxy-api.service'], ['restart', '--no-block', 'crosery-api-console.service']])
  assert.deepEqual(fs.readdirSync(path.join(dir, 'service-requests')), [])
  const status = readRestartStatus(dir)
  assert.equal(status.cpa?.result, 'failed')
  assert.equal(status.cpa?.message, 'boom')
  assert.equal(status.console?.result, 'ok')
  assert.equal(status.console?.pending, false)
})

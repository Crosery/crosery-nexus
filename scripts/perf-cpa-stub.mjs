/**
 * 最小 CPA stub（task-59 ③，新增脚本）：让控制台在**临时实例**里能起来、报表接口不再 500。
 *
 * 用途：报表端到端压测时，`server/channels.ts` 的 `gatewaySnapshot()` 会去 CPA 控制面拉渠道/凭据，
 * 拉不到就让 `/api/bootstrap`、部分报表 500。这里返回**最小可用形状**，其余一律空对象/空数组——
 * 只为让「本地 channel_states + usage_events/rollup」这条路径跑通，不模拟真实控制面语义。
 *
 * 用法：
 *   node scripts/perf-cpa-stub.mjs [port]        # 默认 8399，打印 `{"cpaStub":"http://127.0.0.1:port"}`
 *   然后在临时实例里：CPA_BASE_URL=http://127.0.0.1:8399
 */
import { createServer } from 'node:http'

const port = Number(process.argv[2] || process.env.CPA_STUB_PORT || 8399)

const send500 = (res) => {
  res.statusCode = 500
  res.setHeader('content-type', 'application/json')
  res.end(JSON.stringify({ error: 'stub: 控制面不可用（有意）' }))
}

const server = createServer((req, res) => {
  const url = req.url ?? ''
  res.setHeader('content-type', 'application/json')
  const send = (payload) => res.end(JSON.stringify(payload))

  // 读取请求体（PUT 要消费掉，否则连接会挂住）
  if (req.method === 'PUT' || req.method === 'PATCH' || req.method === 'POST') {
    req.on('data', () => undefined)
    req.on('end', () => dispatch(url, req.method, send, res))
    return
  }
  dispatch(url, req.method, send, res)
})

function dispatch(url, method, send, res) {
  /**
   * 报表压测要的是「网关不可用、但控制台仍按**上一次成功的渠道策略**出报表」这条路径：
   * `listGroupsForReporting()` 只有在 `gatewaySnapshot()` 失败时才回落到持久化的分组策略
   * （app_settings 的 reporting.groups.lastKnown.v1）。若这里返回**成功但空**的渠道列表，
   * 控制台会把空策略**写回**持久化存储，报表随之变成空数据 —— 那样量出来的 HTTP 耗时就毫无意义。
   * 因此渠道/凭据端点故意返回 500（fail-closed 路径），让持久化分组策略存活。
   */
  if (url.startsWith('/api-keys')) {
    if (method === 'PUT') return send({ ok: true })
    send500(res)
    return
  }
  if (url.startsWith('/api-key-model-access')) { send500(res); return }
  if (url.startsWith('/api/channels') || url.startsWith('/channels')) { send500(res); return }
  if (url.startsWith('/api/channel')) { send500(res); return }
  if (url.startsWith('/api/credentials')) { send500(res); return }
  if (url.startsWith('/api/groups')) { send500(res); return }
  if (url.includes('version') || url.includes('health')) return send({ version: 'stub', status: 'ok' })
  // 其它一律空对象：调用方都按「缺字段 = 不可用」处理，不会让报表 500
  return send({})
}

server.listen(port, '127.0.0.1', () => {
  console.log(JSON.stringify({ cpaStub: `http://127.0.0.1:${port}` }))
})

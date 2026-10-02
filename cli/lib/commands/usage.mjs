// usage：用量统计（GET /api/usage-overview?view=workspace）。
import { UsageError, numberValue } from '../args.mjs'
import { getBootstrap } from '../ops.mjs'
import { resolveKey } from '../resolve.mjs'
import { count, percent, tokens, usd } from '../ui.mjs'

const HELP = `cradmin usage [参数]

用量统计：请求数、失败率、tokens、费用、缓存命中率（与上一个同长窗口对比），以及模型、Key、渠道的前 N 名。

参数：
  --days 1|7|30|90           统计窗口（默认 7）
  --key <key>                只看一把 Key（名称或 id 前缀）
  --model <id>               只看一个模型
  --channel <id>             只看一个渠道 / 账号池 provider
  --top <N>                  每张排行表的行数（默认 10）

示例：
  cradmin usage --days 1
  cradmin usage --days 30 --key <名称> --json
`

const delta = (current, previous, format) => {
  if (previous === null || previous === undefined || current === null || current === undefined) return ''
  const diff = Number(current) - Number(previous)
  if (!diff) return '（持平）'
  return `（${diff > 0 ? '+' : '-'}${format(Math.abs(diff))}）`
}

export default {
  name: 'usage',
  aliases: ['u'],
  summary: '用量统计',
  help: HELP,
  options: {
    days: { type: 'string' },
    key: { type: 'string' },
    model: { type: 'string' },
    channel: { type: 'string' },
    top: { type: 'string' },
  },
  async run(ctx) {
    if (ctx.positionals.length) throw new UsageError(`多余的参数：${ctx.positionals.join(' ')}`)
    const days = numberValue(ctx.values.days, '--days', { integer: true, min: 1, max: 3650 }) ?? 7
    if (![1, 7, 30, 90].includes(days)) throw new UsageError('--days 只能是 1、7、30 或 90')
    const top = numberValue(ctx.values.top, '--top', { integer: true, min: 1, max: 1000 }) ?? 10
    const params = new URLSearchParams({ view: 'workspace', days: String(days) })
    if (ctx.values.key) params.set('keyId', resolveKey((await getBootstrap(ctx)).keys || [], ctx.values.key).id)
    if (ctx.values.model) params.set('model', ctx.values.model)
    if (ctx.values.channel) params.set('provider', ctx.values.channel)
    const report = await ctx.get(`/api/usage-overview?${params}`)
    const rank = list => (list || []).slice(0, top).map(item => ({ id: item.id, label: item.label, requests: item.requests, errors: item.errors, tokens: item.tokens, costUsd: item.costUsd }))
    const data = {
      window: report.window || null,
      filters: report.filters || null,
      ledger: report.ledger || null,
      previous: report.previous || null,
      models: rank(report.models),
      keys: rank(report.keys),
      channels: rank(report.channels),
    }
    ctx.output(data, () => {
      const { ui } = ctx
      const ledger = data.ledger || {}
      const prev = data.previous
      ui.section(`最近 ${days} 天用量`, prev ? '括号内为与上一个同长窗口的差' : '')
      ui.kv('请求', `${count(ledger.requests)}${delta(ledger.requests, prev?.requests, count)}`)
      ui.kv('失败', `${count(ledger.errors)}（${percent(ledger.errorRate)}）`)
      ui.kv('Tokens', `${tokens(ledger.tokens)}${delta(ledger.tokens, prev?.tokens, tokens)}`)
      ui.kv('费用', `${usd(ledger.costUsd)}${delta(ledger.costUsd, prev?.costUsd, usd)}${ledger.hasPartialCost ? '（部分模型无价格）' : ''}`)
      ui.kv('缓存命中', percent(ledger.cacheHitRate))
      ui.kv('活跃 Key', `${count(ledger.activeKeys)} / 启用 ${count(ledger.enabledKeys)}`)
      for (const [title, list] of [['模型', data.models], ['Key', data.keys], ['渠道', data.channels]]) {
        ui.section(`${title === 'Key' ? 'Key 排行' : `${title}排行`}（前 ${top}）`)
        if (!list.length) { ui.note('没有数据'); continue }
        ui.table([title, '请求', '失败', 'Tokens', '费用'], list.map(item => [item.label || item.id, count(item.requests), count(item.errors), tokens(item.tokens), usd(item.costUsd)]),
          { align: ['left', 'right', 'right', 'right', 'right'] })
      }
    })
  },
}

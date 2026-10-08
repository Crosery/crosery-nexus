// usage：用量总览（GET /api/usage-overview?view=workspace）。
import { UsageError, numberValue } from '../args.mjs'
import { fmtCompact, fmtInt, fmtSpend } from '../fmt.mjs'
import { getBootstrap } from '../ops.mjs'
import { resolveKey } from '../resolve.mjs'
import { usageLedgerTree, usageRankName, usageVsText, usageWindowText } from '../tree.mjs'

const HELP = `cradmin usage [参数]

用量总览，词同控制台「用量 · 总览」：请求、Token、花费、失败率、缓存命中、活跃 Key（与上一个同长窗口比），
以及按模型 / 按 Key / 按渠道的前 N 名。

参数：
  --days 1|7|30|90           统计窗口（默认 7）
  --key <key>                只看一把 Key（名称或 id 前缀）
  --model <id>               只看一个模型
  --channel <id>             只看一个渠道 / 账号池 provider
  --top <N>                  每张排行的行数（默认 10）

示例：
  cradmin usage --days 1
  cradmin usage --days 30 --key <名称> --json
`

export default {
  name: 'usage',
  aliases: ['u'],
  summary: '用量总览',
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
      const span = data.window?.days ?? days
      ui.section(`用量 · ${usageWindowText(span)}`, data.previous ? usageVsText(span) : `前 ${span === 1 ? '24 小时' : `${span} 日`}无记录 · 不比较`)
      ui.tree(usageLedgerTree(data.ledger, data.previous, span))
      const ranks = [['按模型', '模型', 'models'], ['按 Key', 'Key', 'keys'], ['按渠道', '渠道', 'channels']]
      for (const [title, column, kind] of ranks) {
        ui.section(title, `前 ${top}`)
        const list = (report[kind] || []).slice(0, top)
        if (!list.length) { ui.note('— 没有请求'); continue }
        ui.table([column, '请求', '失败', 'Token', '花费'], list.map(item => [usageRankName(item, kind), fmtInt(item.requests), fmtInt(item.errors), fmtCompact(item.tokens), fmtSpend(item.costUsd)]),
          { align: ['left', 'right', 'right', 'right', 'right'] })
      }
    })
  },
}

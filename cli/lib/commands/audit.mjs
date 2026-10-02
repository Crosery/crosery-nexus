// audit：最近操作记录（服务端只返回最近 100 条、无操作者字段；过滤在客户端做）。
import { UsageError, numberValue } from '../args.mjs'
import { time, truncate } from '../ui.mjs'

const HELP = `cradmin audit [参数]

最近操作记录。服务端只保留最近 100 条，且没有操作者字段（cradmin 与网页操作无法区分）。

参数：
  --limit <N>                最多显示 N 条（≤100，默认 30）
  --action <动作>            只看某个动作（如 create_key、disable_model）
  --grep <文本>              在动作/对象/详情里搜索
`

export default {
  name: 'audit',
  aliases: [],
  summary: '最近操作记录',
  help: HELP,
  options: { limit: { type: 'string' }, action: { type: 'string' }, grep: { type: 'string' } },
  async run(ctx) {
    if (ctx.positionals.length) throw new UsageError(`多余的参数：${ctx.positionals.join(' ')}`)
    const limit = numberValue(ctx.values.limit, '--limit', { integer: true, min: 1, max: 100 }) ?? 30
    const payload = await ctx.get('/api/audit')
    let items = (payload.items || []).map(item => ({ id: item.id, action: item.action, target: item.target, details: item.details || '', createdAt: item.created_at }))
    if (ctx.values.action) items = items.filter(item => item.action === ctx.values.action)
    if (ctx.values.grep) {
      const needle = String(ctx.values.grep).toLowerCase()
      items = items.filter(item => `${item.action} ${item.target} ${item.details}`.toLowerCase().includes(needle))
    }
    items = items.slice(0, limit)
    ctx.output(items, () => {
      if (!items.length) return ctx.ui.note('没有匹配的记录')
      ctx.ui.table(['时间', '动作', '对象', '详情'], items.map(item => [time(item.createdAt), item.action, item.target, truncate(item.details, 60)]))
    })
  },
}

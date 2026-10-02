// models：模型目录、价格、拉取上游新模型。
import { CliError, UsageError } from '../args.mjs'
import { HttpError, request } from '../client.mjs'
import { getModelIndex, getSync } from '../ops.mjs'
import { runPlan } from '../plan.mjs'
import { usd } from '../ui.mjs'
import { waitForJob } from './sync.mjs'

const HELP = `cradmin models <动作> [参数]

模型目录（网关上实际可用的模型、来源渠道、价格）。

动作：
  ls                         列出网关上有来源的模型（默认）
      --channel <渠道>       只看某个渠道 / 账号池 provider 的模型
      --search <文本>        按 id 子串过滤
      --unpriced             只看没有价格的模型
      --type <类型>          只看某类模型（按输出分）：chat 对话 · image 图片 · video 视频 · audio 语音 ·
                             embedding 向量 · rerank 重排 · other 其他
      --all                  连只存在于价格目录、网关上没有来源的模型一起列出
  show <模型>                来源、价格、双源价格
  sync                       探测各渠道上游的 /models，拉取新模型（后台任务 model-discovery，等它跑完，最多 10 分钟；
                             有冷却，冷却中退出 4）

说明：每个渠道启用哪些模型用 cradmin channels models <渠道> 调整。价格不能在这里改（来自价格表与外部目录）。

示例：
  cradmin models ls --channel codex
  cradmin models ls --type image --all
  cradmin models show gpt-5.6-sol --json
`

const DISCOVERY_JOB = 'model-discovery'

const price = value => (value === null || value === undefined ? '-' : usd(value))

/** 与服务端 server/modelKind.ts 同一组类型（按输出分：能看图的对话模型仍是 chat）。 */
export const MODEL_KIND_LABEL = { chat: '对话', image: '图片', video: '视频', audio: '语音', embedding: '向量', rerank: '重排', other: '其他' }
const isKind = value => typeof value === 'string' && Object.hasOwn(MODEL_KIND_LABEL, value)
const kindText = kind => (isKind(kind) ? MODEL_KIND_LABEL[kind] : '-')

export function modelRow(model) {
  const sources = model.sources || []
  return {
    id: model.id,
    /** 旧服务端没有这个字段 ⇒ null */
    kind: isKind(model.kind) ? model.kind : null,
    enabledSources: sources.filter(source => source.enabled && source.channelEnabled !== false).length,
    totalSources: sources.length,
    sources: sources.map(source => ({ channel: source.channel, kind: source.kind, enabled: Boolean(source.enabled), channelEnabled: source.channelEnabled !== false })),
    inputPer1M: model.pricing?.input ?? null,
    outputPer1M: model.pricing?.output ?? null,
    contested: Boolean(model.contested),
    unpriced: Boolean(model.unpriced) || !model.pricing,
    catalogOnly: model.availableOnGateway === false || !sources.length,
  }
}

export default {
  name: 'models',
  aliases: ['model'],
  summary: '模型目录、价格、拉取上游新模型',
  help: HELP,
  options: {
    channel: { type: 'string' },
    search: { type: 'string' },
    unpriced: { type: 'boolean' },
    all: { type: 'boolean' },
    type: { type: 'string' },
  },
  async run(ctx) {
    const [action = 'ls', id, ...extra] = ctx.positionals
    if (extra.length) throw new UsageError(`多余的参数：${extra.join(' ')}`)
    if (action === 'ls' || action === 'list') {
      const type = ctx.values.type === undefined ? null : String(ctx.values.type).trim().toLowerCase()
      if (type !== null && !isKind(type)) throw new UsageError(`未知类型：${ctx.values.type}`, `可选：${Object.keys(MODEL_KIND_LABEL).join(' / ')}`)
      const index = await getModelIndex(ctx)
      let rows = (index.models || []).map(modelRow)
      if (type && rows.length && rows.every(row => row.kind === null)) throw new CliError('服务端没有返回模型类型（控制台版本较旧），--type 无法筛选', 1)
      if (!ctx.values.all) rows = rows.filter(row => !row.catalogOnly)
      if (ctx.values.channel) rows = rows.filter(row => row.sources.some(source => source.channel === ctx.values.channel))
      if (ctx.values.search) rows = rows.filter(row => row.id.toLowerCase().includes(String(ctx.values.search).toLowerCase()))
      if (ctx.values.unpriced) rows = rows.filter(row => row.unpriced)
      if (type) rows = rows.filter(row => row.kind === type)
      return void ctx.output(rows, () => {
        if (!rows.length) return ctx.ui.note('没有匹配的模型')
        ctx.ui.table(['模型', '类型', '来源', '输入/1M', '输出/1M', '争用', '仅价目'], rows.map(row => [
          row.id, kindText(row.kind), `${row.enabledSources}/${row.totalSources}`, price(row.inputPer1M), price(row.outputPer1M),
          row.contested ? { text: '是', tone: 'warn' } : '-', row.catalogOnly ? '是' : '-',
        ]), { align: ['left', 'left', 'right', 'right', 'right', 'center', 'center'] })
        ctx.ui.note(`共 ${rows.length} 个；来源 = 启用的来源数 / 全部来源数`)
      })
    }
    if (action === 'show') {
      if (!id) throw new UsageError('缺少 <模型>')
      const index = await getModelIndex(ctx)
      const model = (index.models || []).find(item => item.id === id)
      if (!model) throw new UsageError(`找不到模型：${id}`, '运行 cradmin models ls --search <文本> 查找')
      const data = { ...modelRow(model), pricing: model.pricing || null, pricingSources: model.pricingSources || null }
      return void ctx.output(data, () => {
        const { ui } = ctx
        ui.kv('模型', data.id)
        ui.kv('类型', kindText(data.kind))
        ui.kv('价格', data.pricing ? `输入 ${price(data.pricing.input)} · 输出 ${price(data.pricing.output)} · 缓存读 ${price(data.pricing.cacheRead)} · 缓存写 ${price(data.pricing.cacheWrite)}（每百万 token）` : '无')
        if (data.pricing?.note) ui.kv('', data.pricing.note)
        for (const [source, entry] of Object.entries(data.pricingSources || {})) {
          if (entry && typeof entry === 'object') ui.kv(source, `输入 ${price(entry.input ?? entry.inputPer1M)} · 输出 ${price(entry.output ?? entry.outputPer1M)}`)
        }
        if (data.contested) ui.warn('多个渠道提供同名模型（路由优先级不能在这里调整）')
        ui.section('来源', `${data.enabledSources}/${data.totalSources} 启用`)
        if (!data.sources.length) return ui.note('网关上没有来源（只存在于价格目录）')
        ui.table(['渠道', '类型', '模型开关', '渠道状态'], data.sources.map(source => [
          source.channel, source.kind === 'oauth' ? '账号池' : '兼容渠道',
          source.enabled ? { text: 'on', tone: 'ok' } : { text: 'off', tone: 'muted' },
          source.channelEnabled ? '启用' : { text: '停用', tone: 'warn' },
        ]), { align: ['left', 'left', 'center', 'center'] })
      })
    }
    if (action === 'sync') {
      // 全量探测可能远超 30 秒：触发后台任务再轮询，而不是挂在一个长请求上
      const before = (await getSync(ctx)).jobs?.find(job => job.id === DISCOVERY_JOB)
      const item = { area: '模型', label: '探测各渠道上游 /models', from: '-', to: '同步', method: 'POST', path: `/api/sync/${DISCOVERY_JOB}/run`, taskLabel: '模型同步' }
      item.run = async () => {
        try {
          return await request(ctx, item.method, item.path, { label: item.taskLabel })
        } catch (error) {
          if (error instanceof HttpError && error.status === 409) return { accepted: false, joined: true } // 已在运行：等它这一轮
          throw error
        }
      }
      const result = await runPlan(ctx, { level: 'A', title: '拉取上游新模型', items: [item] })
      if (result.dryRun) return void ctx.output(result)
      const job = await waitForJob(ctx, DISCOVERY_JOB, { since: before?.lastFinishedAt || null, timeoutMs: 10 * 60_000 })
      if (!job) throw new CliError('等了 10 分钟模型同步还在运行，稍后用 cradmin sync ls 查看', 1)
      ctx.output({ ...result, job }, () => {
        if (job.summary) ctx.ui.kv('结果', job.summary)
        if (job.lastError) ctx.ui.warn(job.lastError)
      })
      // partial = 部分上游探测失败（常见，照常退出 0）；整轮失败才算失败
      return job.lastResult === 'error' ? 1 : 0
    }
    throw new UsageError(`未知动作：models ${action}`, '运行 cradmin models -h 查看用法')
  },
}

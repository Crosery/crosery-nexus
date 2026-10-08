// channels：渠道，以及每个渠道启用哪些模型。
import { CliError, UsageError, listValue } from '../args.mjs'
import { channelState, channelToggleItem, getChannels, getModelIndex, modelToggleItems, modelsOf, providerModels, providersOf } from '../ops.mjs'
import { runPlan } from '../plan.mjs'
import { planModelChanges, resolveChannel } from '../resolve.mjs'
import { channelClass, channelType, channelsTree, providerInfo, providerTitle } from '../tree.mjs'

const HELP = `cradmin channels <动作> [参数]

管理渠道（兼容渠道 = 上游 API；账号池 = 按 provider 聚合的 OAuth 账号）以及每个渠道启用的模型。
<渠道> 是兼容渠道名，或账号池 provider（如 codex、claude）。

动作：
  ls                         列出全部渠道与账号池（默认）：供应商 → API 渠道 / 订阅账号池，同控制台「供应商」页
  show <渠道>                渠道状态（含原因）、地址与模型开关（同控制台渠道详情）
  models <渠道>              只看模型开关；带下面的参数时改开关
      --enable p,…           启用匹配的模型（精确 id，或带 * ? 的通配）
      --disable p,…          停用匹配的模型
      --only p,…             只启用匹配的模型，其余全部停用
  enable|disable <渠道>      启用 / 停用兼容渠道（停用后网关立即下线该渠道，可 enable 恢复）
  add <名称> --base-url <url> --api-key-env <NAME> --models id[=别名],…
                             新建 OpenAI 兼容渠道；上游 Key 用环境变量引用（env:NAME）
      --api-key-stdin        改从 stdin 读原始上游 Key（只有远程 CPA 控制面接受明文）
      --protocol openai|claude|responses
  rm <渠道>                  删除渠道（连停用快照一起删，不可撤销）
  prune                      清理失效渠道（不可撤销）

说明：
  模式一个模型都没匹配上时退出 2，不发任何请求；只为状态真正变化的模型发请求。
  启用只能恢复已归档的模型；新模型用 cradmin models sync 拉取。
  暂不支持：编辑渠道（URL、上游 Key、别名）、给渠道加第二把上游 Key（变通：rm 后 add，会丢停用快照）。

示例：
  cradmin channels models codex --only 'gpt-5*'
  cradmin channels models <渠道> --disable 'm*' --dry-run
  cradmin channels add <名称> --base-url https://api.example.com/v1 --api-key-env EXAMPLE_KEY --models gpt-4o,gpt-4o-mini=mini
`

const levelFor = changes => (changes.some(change => change.to === false) ? 'C' : 'A')

async function listView(ctx) {
  const payload = await getChannels(ctx)
  let index = null
  try { index = await getModelIndex(ctx) } catch (error) {
    if (error instanceof CliError && error.exitCode === 3) throw error
  }
  // state 是给人看的中文；脚本用 enabled / stale
  const rows = (payload.channels || []).map(channel => ({
    name: channel.name, kind: 'compat', state: channelState(channel), enabled: Boolean(channel.enabled) && !channel.stale, stale: Boolean(channel.stale),
    enabledModels: (channel.models || []).filter(model => model.enabled).length, totalModels: (channel.models || []).length,
    keys: channel.keyCount ?? null, accounts: null, baseUrl: channel.baseUrl || '',
  }))
  for (const provider of providersOf(payload)) {
    const models = index ? providerModels(index, provider.id) : null
    rows.push({
      name: provider.id, kind: 'oauth', state: provider.active ? '启用' : '无可用账号', enabled: provider.active > 0, stale: false,
      enabledModels: models ? models.filter(model => model.enabled).length : null, totalModels: models ? models.length : null,
      keys: null, accounts: provider.accounts, baseUrl: '',
    })
  }
  return rows
}

async function detail(ctx, name) {
  const payload = await getChannels(ctx)
  const resolved = resolveChannel(payload, name)
  const models = await modelsOf(ctx, resolved)
  if (resolved.kind === 'compat') {
    const { channel } = resolved
    return { resolved, data: { name: channel.name, kind: 'compat', state: channelState(channel), enabled: Boolean(channel.enabled), stale: Boolean(channel.stale), baseUrl: channel.baseUrl, keyCount: channel.keyCount ?? null, models } }
  }
  const provider = providersOf(payload).find(item => item.id === resolved.name)
  return { resolved, data: { name: resolved.name, kind: 'oauth', state: provider?.active ? '启用' : '无可用账号', accounts: provider?.accounts ?? 0, models } }
}

/** 同一个模型挂了几条上游（控制台模型行的 ×N）；只有兼容渠道有。 */
const upstreamsOf = resolved => new Map((resolved.kind === 'compat' ? resolved.channel.models || [] : []).map(model => [model.id, Number(model.upstreams) || 0]))

// 词照控制台渠道详情（src/features/channels/ChannelSheet.vue）；data.state 是 --json 的旧字段，不在这里显示
function renderDetail(ctx, data, { modelsOnly = false, upstreams = new Map() } = {}) {
  const { ui } = ctx
  const on = data.models.filter(model => model.enabled).length
  if (!modelsOnly) {
    if (data.kind === 'compat') {
      const cls = channelClass({ stale: data.stale, enabled: data.enabled, enabledModels: on })
      ui.kv('渠道', data.name)
      ui.kv('类型', channelType(data))
      ui.kv('状态', ui.paint(cls.tone, cls.label))
      if (cls.reason) ui.kv('', ui.paint('muted', `${cls.reason}${cls.hint}`))
      ui.kv('地址', data.baseUrl || '—')
      ui.kv('Key', `${data.keyCount ?? '—'} 个`)
    } else {
      const info = providerInfo(data.name)
      ui.kv('渠道', providerTitle(info, data.name))
      ui.kv('类型', `订阅账号池 · ${info.vendor}`)
      ui.kv('状态', ui.paint(data.state === '启用' ? 'ok' : 'warn', data.state))
      ui.kv('账号', `${data.accounts} 个`)
    }
  }
  if (data.kind === 'compat' && !data.enabled && !data.stale) ui.warn(`渠道停用中 · 启用后才能单独开关模型：cradmin channels enable ${data.name}`)
  ui.section(modelsOnly ? `${data.name} 的模型` : '模型', `${on} / ${data.models.length} 开着`)
  if (!data.models.length) return ui.note('— 这个渠道没有模型')
  ui.tree(data.models.map(model => {
    const n = upstreams.get(model.id) || 0
    return {
      kind: 'model',
      cells: [model.enabled ? { text: '开着', tone: 'ok' } : { text: '人工停用', tone: 'muted' }, model.id, n > 1 ? { text: `×${n}`, tone: 'muted' } : ''],
    }
  }))
  ui.note(`改开关：cradmin channels models ${data.name} --enable <模型> / --disable <模型> / --only <模式>`)
}

async function changeModels(ctx, name) {
  const enable = listValue(ctx.values.enable)
  const disable = listValue(ctx.values.disable)
  const only = listValue(ctx.values.only)
  const { resolved, data } = await detail(ctx, name)
  const changes = planModelChanges(data.models, { enable, disable, only })
  if (!changes) {
    ctx.output(data, () => renderDetail(ctx, data, { modelsOnly: true, upstreams: upstreamsOf(resolved) }))
    return
  }
  if (resolved.kind === 'compat' && !resolved.channel.enabled && changes.length) {
    throw new CliError(`渠道 ${resolved.name} 已停用，不能调整模型`, 1, `先运行 cradmin channels enable ${resolved.name}`)
  }
  const result = await runPlan(ctx, {
    level: levelFor(changes), title: `调整 ${resolved.name} 的模型`, items: modelToggleItems(ctx, resolved, changes),
    empty: '没有需要改动的模型',
  })
  ctx.output(result)
}

function parseModelList(raw) {
  const models = listValue(raw).map(item => {
    const [id, alias] = item.split('=')
    if (!id) throw new UsageError(`模型写法是 id 或 id=别名（收到 ${item}）`)
    return { id: id.trim(), alias: (alias || id).trim() }
  })
  if (!models.length) throw new UsageError('本地控制面不能扫描模型，必须用 --models 给出模型列表')
  const aliases = models.map(model => model.alias)
  const dup = aliases.find((alias, index) => aliases.indexOf(alias) !== index)
  if (dup) throw new UsageError(`公开别名重复：${dup}`)
  return models
}

async function readAllStdin(stdin) {
  let text = ''
  for await (const chunk of stdin) text += chunk
  return text.replace(/[\r\n]+$/u, '').trim()
}

async function addChannel(ctx, name) {
  const { values } = ctx
  if (!name) throw new UsageError('缺少渠道名称', '用法：cradmin channels add <名称> --base-url <url> --api-key-env <NAME> --models …')
  if (!/^[A-Za-z0-9._-]{1,48}$/.test(name)) throw new UsageError('渠道名称只能用字母、数字、. _ -，最长 48 个字符')
  const protocol = values.protocol || 'openai'
  if (!['openai', 'claude', 'responses'].includes(protocol)) throw new UsageError('--protocol 只能是 openai、claude 或 responses')
  let baseUrl
  try { baseUrl = new URL(String(values['base-url'] || '')) } catch { throw new UsageError('缺少或无效的 --base-url') }
  if (!['http:', 'https:'].includes(baseUrl.protocol)) throw new UsageError('--base-url 必须是 http(s)')
  if (values['api-key-env'] && values['api-key-stdin']) throw new UsageError('--api-key-env 与 --api-key-stdin 只能选一个')
  let apiKey
  if (values['api-key-env']) {
    if (!/^[A-Z][A-Z0-9_]*$/.test(values['api-key-env'])) throw new UsageError('--api-key-env 只能是大写环境变量名，如 EXAMPLE_KEY')
    apiKey = `env:${values['api-key-env']}`
  } else if (values['api-key-stdin']) {
    apiKey = ctx.io.stdin.isTTY ? await ctx.prompter.secret('上游 API Key：') : await readAllStdin(ctx.io.stdin)
    if (!apiKey) throw new UsageError('stdin 里没有读到上游 Key')
  } else {
    throw new UsageError('需要 --api-key-env <NAME>（推荐）或 --api-key-stdin；不接受命令行里的明文 Key')
  }
  const models = parseModelList(values.models)
  const payload = await getChannels(ctx)
  if ((payload.channels || []).some(channel => channel.name === name)) throw new UsageError(`渠道 ${name} 已存在`)
  const result = await runPlan(ctx, {
    level: 'A', title: '新建渠道',
    items: [{ area: '渠道', label: name, from: '-', to: `${baseUrl.origin} · ${models.length} 个模型`, method: 'POST', path: '/api/channels', body: { name, protocol, baseUrl: String(values['base-url']), apiKey, models } }],
  })
  ctx.output({ ...result, results: result.results.map(item => ({ ...item, result: item.result ? { name: item.result.name, baseUrl: item.result.baseUrl, models: item.result.models } : undefined })) })
}

export default {
  name: 'channels',
  aliases: ['channel', 'ch'],
  summary: '渠道，以及每个渠道启用哪些模型',
  help: HELP,
  options: {
    enable: { type: 'string', multiple: true },
    disable: { type: 'string', multiple: true },
    only: { type: 'string', multiple: true },
    'base-url': { type: 'string' },
    'api-key-env': { type: 'string' },
    'api-key-stdin': { type: 'boolean' },
    models: { type: 'string', multiple: true },
    protocol: { type: 'string' },
  },
  async run(ctx) {
    const [action = 'ls', name, ...extra] = ctx.positionals
    if (extra.length) throw new UsageError(`多余的参数：${extra.join(' ')}`)
    switch (action) {
      case 'ls':
      case 'list': {
        const rows = await listView(ctx)
        return void ctx.output(rows, () => {
          if (!rows.length) return ctx.ui.note('还没有渠道')
          const compat = rows.filter(row => row.kind === 'compat').length
          ctx.ui.section('供应商', `API 渠道 ${compat} · 订阅账号池 ${rows.length - compat}`)
          ctx.ui.tree(channelsTree(rows))
          ctx.ui.note('看模型：cradmin channels models <渠道>（订阅账号池用括号里的 type，或名称的小写）')
        })
      }
      case 'show': {
        if (!name) throw new UsageError('缺少 <渠道>')
        const { resolved, data } = await detail(ctx, name)
        return void ctx.output(data, () => renderDetail(ctx, data, { upstreams: upstreamsOf(resolved) }))
      }
      case 'models':
        if (!name) throw new UsageError('缺少 <渠道>')
        return changeModels(ctx, name)
      case 'enable':
      case 'disable': {
        if (!name) throw new UsageError('缺少 <渠道>')
        const payload = await getChannels(ctx)
        const resolved = resolveChannel(payload, name)
        if (resolved.kind !== 'compat') throw new UsageError(`${name} 是账号池，不能整体启停；用 cradmin accounts pause|resume <账号>`)
        if (resolved.channel.stale) throw new CliError(`渠道 ${name} 已失效（网关里已不存在），只能 prune 清理`, 1)
        const to = action === 'enable'
        const items = resolved.channel.enabled === to ? [] : [channelToggleItem(name, resolved.channel.enabled, to)]
        const result = await runPlan(ctx, {
          level: to ? 'A' : 'C', title: `${to ? '启用' : '停用'}渠道`, items, empty: `渠道 ${name} 已是${to ? '启用' : '停用'}状态`,
          danger: to ? '' : '网关立即下线该渠道，可 cradmin channels enable 恢复',
        })
        return void ctx.output(result)
      }
      case 'add':
        return addChannel(ctx, name)
      case 'rm':
      case 'remove':
      case 'delete': {
        if (!name) throw new UsageError('缺少 <渠道>')
        const payload = await getChannels(ctx)
        const channel = (payload.channels || []).find(item => item.name === name)
        if (!channel) throw new UsageError(`找不到兼容渠道：${name}`)
        const result = await runPlan(ctx, {
          level: 'D', title: '删除渠道', danger: '连停用快照一起删除，无法 enable 恢复',
          items: [{ area: '渠道', label: name, from: channelState(channel), to: '删除', method: 'DELETE', path: `/api/channels/${encodeURIComponent(name)}`, target: `渠道 ${name}` }],
        })
        return void ctx.output(result)
      }
      case 'prune': {
        const payload = await getChannels(ctx)
        const stale = (payload.channels || []).filter(channel => channel.stale)
        const result = await runPlan(ctx, {
          level: 'D', title: '清理失效渠道', empty: '没有失效渠道',
          items: stale.length ? [{ area: '渠道', label: stale.map(channel => channel.name).join('、'), from: '失效', to: '删除', method: 'POST', path: '/api/channels/prune-stale' }] : [],
        })
        return void ctx.output(result)
      }
      default:
        throw new UsageError(`未知动作：channels ${action}`, '运行 cradmin channels -h 查看用法')
    }
  },
}

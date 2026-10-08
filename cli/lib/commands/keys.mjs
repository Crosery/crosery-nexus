// keys：API Key 开通、改分组/并发/额度、启停、轮换、删除、复制。完整 Key 只在 create / rotate 时打印一次。
import { CliError, UsageError, listValue, numberValue } from '../args.mjs'
import { request } from '../client.mjs'
import { fmtDate } from '../fmt.mjs'
import { getBootstrap, keyCreateItem, keyQuota, keyUpdateItems, localDate } from '../ops.mjs'
import { runPlan } from '../plan.mjs'
import { parseGroupConcurrency, resolveGroups, resolveKey } from '../resolve.mjs'
import { groupScope, keyStatusView, keyWindowsTree, keysTree } from '../tree.mjs'
import { time } from '../ui.mjs'

const HELP = `cradmin keys <动作> [参数]

管理 API Key。<key> 可以是唯一的显示名称，或 id 前缀（至少 8 位十六进制）。

动作：
  ls                         列出全部 Key（同控制台「Key」页：状态、渠道范围、今日 / 本周 / 累计额度，按额度压力排序）
  show <key>                 一把 Key 的状态、渠道、并发与日 / 周 / 累计额度（同控制台 Key 详情）
  create --name <名称> --groups <分组,…>   开通新 Key，完整 Key 只显示这一次
  update <key> [参数]        改名称/备注/分组/并发/额度
  enable|disable <key>       启用 / 停用
  rotate <key> [--delete-old] [--slug <s>]  换新 Key：新建同配置（含启停状态）的 Key，旧 Key 改名并停用（或删除）
  delete <key>               删除（不可撤销）
  copy <key>                 把完整 Key 复制到剪贴板（macOS，不打印）

参数：
  --groups a,b | all         分组 = 渠道名或账号池 provider；必须是当前存在的分组
  --add-groups / --remove-groups a,b
  --concurrency <0-500>      总并发，0 表示不限
  --group-concurrency a=2,b=3
  --total-usd / --daily-usd / --weekly-usd <美元>   0 表示不限
  --reset-spent total|daily|weekly
  --slug <s>  --note <文本>  --name <名称>

说明：
  访问控制只到分组（渠道 / 账号池）这一层；暂不支持按 Key 单独的模型白名单
  （模型开关按渠道全局生效：cradmin channels models <渠道>）。
  rotate 由客户端组合实现：新 Key 的已用额度从 0 开始；Key 前缀（slug）默认按名称生成，
  原 Key 用过自定义 --slug 时轮换也要再给一次（服务端不返回 slug）。

示例：
  cradmin keys create --name <名称> --groups codex,claude --daily-usd 5
  cradmin keys update <名称> --add-groups xai --concurrency 4 --group-concurrency xai=2
`

const QUOTA_WINDOWS = ['total', 'daily', 'weekly']

export function publicKey(key) {
  const pick = ['id', 'name', 'note', 'maskedKey', 'enabled', 'groups', 'totalConcurrency', 'groupConcurrency', 'createdAt', 'updatedAt', 'lastUsedAt', 'quota', 'blockedReason', 'quotaState']
  return Object.fromEntries(pick.filter(field => field in key).map(field => [field, key[field]]))
}

/** `不限` · `4` · `4 · codex=2 · xai=1`（KeyDetail.vue 并发） */
export const concurrencyText = key => (key.totalConcurrency ? [key.totalConcurrency, ...Object.entries(key.groupConcurrency || {}).map(([g, n]) => `${g}=${n}`)].join(' · ') : '不限')

function quotaFlags(values) {
  const quota = {
    totalUsd: numberValue(values['total-usd'], '--total-usd', { min: 0, max: 1_000_000 }),
    dailyUsd: numberValue(values['daily-usd'], '--daily-usd', { min: 0, max: 1_000_000 }),
    weeklyUsd: numberValue(values['weekly-usd'], '--weekly-usd', { min: 0, max: 1_000_000 }),
  }
  return Object.values(quota).some(value => value !== undefined) ? quota : undefined
}

function printNewKey(ctx, created) {
  if (ctx.json) return
  ctx.ui.noteErr('这是唯一一次显示完整 Key，请现在保存：')
  ctx.ui.data(created.key)
}

async function findKey(ctx, query) {
  const bootstrap = await getBootstrap(ctx)
  return { bootstrap, key: resolveKey(bootstrap.keys || [], query) }
}

async function create(ctx) {
  const { values } = ctx
  const name = String(values.name || '').trim()
  if (!name) throw new UsageError('缺少 --name <名称>')
  const requested = listValue(values.groups)
  if (!requested.length) throw new UsageError('缺少 --groups <分组,…>（或 all）')
  const bootstrap = await getBootstrap(ctx)
  const groups = resolveGroups(requested, bootstrap.groups || [])
  const spec = {
    name, note: values.note, slug: values.slug, groups,
    totalConcurrency: numberValue(values.concurrency, '--concurrency', { integer: true, min: 0, max: 500 }) ?? 0,
    groupConcurrency: parseGroupConcurrency(listValue(values['group-concurrency'])),
    quota: quotaFlags(values),
  }
  const item = keyCreateItem(ctx, spec)
  let result
  try {
    result = await runPlan(ctx, { level: 'A', title: '开通 Key', items: [item] })
  } catch (error) {
    if (error.createdKey) {
      printNewKey(ctx, error.createdKey)
      if (ctx.json) ctx.ui.data(JSON.stringify({ key: error.createdKey.key, item: publicKey(error.createdKey.item), incomplete: true }, null, 2))
      ctx.ui.warnErr('Key 已创建，但额度没有设置成功；用 cradmin keys update 补上')
    }
    throw error
  }
  if (result.dryRun) return void ctx.output(result)
  const created = result.results[0].result
  printNewKey(ctx, created)
  ctx.output({ key: created.key, item: publicKey(created.item) })
}

async function update(ctx, query) {
  const { values } = ctx
  const { bootstrap, key } = await findKey(ctx, query)
  const desired = {}
  if (values.name !== undefined) desired.name = String(values.name).trim()
  if (values.note !== undefined) desired.note = String(values.note)
  const replace = listValue(values.groups)
  const add = listValue(values['add-groups'])
  const remove = listValue(values['remove-groups'])
  if (replace.length && (add.length || remove.length)) throw new UsageError('--groups 不能和 --add-groups / --remove-groups 同时用')
  if (replace.length) desired.groups = resolveGroups(replace, bootstrap.groups || [])
  else if (add.length || remove.length) {
    const added = add.length ? resolveGroups(add, bootstrap.groups || []) : []
    desired.groups = [...new Set([...key.groups, ...added])].filter(group => !remove.includes(group))
  }
  const total = numberValue(values.concurrency, '--concurrency', { integer: true, min: 0, max: 500 })
  if (total !== undefined) desired.totalConcurrency = total
  const overrides = parseGroupConcurrency(listValue(values['group-concurrency']))
  if (Object.keys(overrides).length) desired.groupConcurrency = { ...(key.groupConcurrency || {}), ...overrides }
  desired.quota = quotaFlags(values)
  const resets = listValue(values['reset-spent'])
  for (const window of resets) if (!QUOTA_WINDOWS.includes(window)) throw new UsageError('--reset-spent 只能是 total、daily 或 weekly')
  desired.resetWindows = [...new Set(resets)]
  const items = keyUpdateItems(key, desired)
  const result = await runPlan(ctx, { level: 'C', title: `修改 Key ${key.name}`, items, empty: '没有需要改动的地方' })
  ctx.output(result)
}

async function toggle(ctx, query, enabled) {
  const { key } = await findKey(ctx, query)
  const items = keyUpdateItems(key, { enabled })
  const result = await runPlan(ctx, { level: enabled ? 'A' : 'C', title: `${enabled ? '启用' : '停用'} Key`, items, empty: `Key ${key.name} 已是${enabled ? '启用' : '停用'}状态` })
  ctx.output(result)
}

async function rotate(ctx, query) {
  const { bootstrap, key } = await findKey(ctx, query)
  const groups = resolveGroups(key.groups, bootstrap.groups || [])
  const spec = {
    name: key.name, note: key.note, slug: ctx.values.slug, groups, totalConcurrency: key.totalConcurrency,
    groupConcurrency: Object.fromEntries(Object.entries(key.groupConcurrency || {}).filter(([group]) => groups.includes(group))),
    quota: keyQuota(key),
    // 额度封禁的旧 Key 算人工启用：新 Key 已用额度从 0 开始
    enabled: Boolean(key.enabled || key.blockedReason),
  }
  const createItem = keyCreateItem(ctx, spec)
  let created = null
  const runCreate = createItem.run
  createItem.run = async () => {
    try {
      created = await runCreate()
    } catch (error) {
      if (error.createdKey) created = error.createdKey
      throw error
    }
    return { id: created.item.id }
  }
  createItem.label = `新 ${key.name}`
  const names = new Set((bootstrap.keys || []).map(item => item.name))
  let retired = `${key.name}（已轮换 ${localDate(ctx.now())}）`
  for (let n = 2; names.has(retired); n += 1) retired = `${key.name}（已轮换 ${localDate(ctx.now())} #${n}）`
  const oldItem = ctx.values['delete-old']
    ? { area: 'Key', label: `旧 ${key.name}（${key.maskedKey}）`, from: key.enabled ? '启用' : '停用', to: '删除', method: 'DELETE', path: `/api/keys/${key.id}`, target: `Key ${key.name}` }
    : { area: 'Key', label: `旧 ${key.name}（${key.maskedKey}）`, from: `${key.enabled ? '启用' : '停用'}`, to: `改名「${retired}」并停用`, method: 'PATCH', path: `/api/keys/${key.id}`, body: { name: retired, enabled: false }, target: `Key ${key.name}` }
  try {
    const result = await runPlan(ctx, {
      level: 'D', title: '轮换 Key', items: [createItem, oldItem],
      danger: ctx.values['delete-old'] ? '旧 Key 会被删除，正在使用它的客户端会立即失效' : '旧 Key 会被停用，正在使用它的客户端会立即失效',
    })
    if (result.dryRun) return void ctx.output(result)
    printNewKey(ctx, created)
    ctx.output({ key: created.key, item: publicKey(created.item), old: { id: key.id, action: ctx.values['delete-old'] ? 'deleted' : 'disabled', name: ctx.values['delete-old'] ? key.name : retired } })
  } catch (error) {
    if (created) {
      printNewKey(ctx, created)
      if (ctx.json) ctx.ui.data(JSON.stringify({ key: created.key, item: publicKey(created.item), old: { id: key.id, action: 'failed' } }, null, 2))
      ctx.ui.warnErr('新 Key 已创建，但旧 Key 仍然有效；确认后手动 cradmin keys disable / delete 旧 Key')
      if (error instanceof CliError) error.exitCode = 1
    }
    throw error
  }
}

async function remove(ctx, query) {
  const { key } = await findKey(ctx, query)
  const result = await runPlan(ctx, {
    level: 'D', title: '删除 Key', danger: '正在使用这把 Key 的客户端会立即失效；用量记录保留',
    items: [{ area: 'Key', label: `${key.name}（${key.maskedKey}，最近使用 ${time(key.lastUsedAt)}）`, from: key.enabled ? '启用' : '停用', to: '删除', method: 'DELETE', path: `/api/keys/${key.id}`, target: `Key ${key.name}` }],
  })
  ctx.output(result)
}

async function copy(ctx, query) {
  if (ctx.platform !== 'darwin') throw new UsageError('keys copy 只支持 macOS（pbcopy）')
  const { key } = await findKey(ctx, query)
  if (ctx.dryRun) return void ctx.output({ dryRun: true, key: publicKey(key) }, () => ctx.ui.note(`将复制 ${key.name}（${key.maskedKey}）的完整 Key 到剪贴板`))
  const handle = await request(ctx, 'POST', `/api/keys/${key.id}/reveal-token`, { target: `Key ${key.name}` })
  const revealed = await ctx.get(`/api/keys/${key.id}/reveal?token=${encodeURIComponent(handle.token)}`, { target: `Key ${key.name}` })
  try {
    ctx.execute('/usr/bin/pbcopy', [], { input: String(revealed.key), stdio: ['pipe', 'ignore', 'ignore'], timeout: 10_000 })
  } catch {
    throw new CliError('写入剪贴板失败', 1)
  }
  ctx.output({ copied: true, id: key.id, name: key.name }, () => ctx.ui.success(`已把 ${key.name}（${key.maskedKey}）的完整 Key 复制到剪贴板`))
}

export default {
  name: 'keys',
  aliases: ['key'],
  summary: 'API Key：开通、改分组/并发/额度、启停、轮换、删除',
  help: HELP,
  options: {
    name: { type: 'string' },
    note: { type: 'string' },
    slug: { type: 'string' },
    groups: { type: 'string', multiple: true },
    'add-groups': { type: 'string', multiple: true },
    'remove-groups': { type: 'string', multiple: true },
    concurrency: { type: 'string' },
    'group-concurrency': { type: 'string', multiple: true },
    'total-usd': { type: 'string' },
    'daily-usd': { type: 'string' },
    'weekly-usd': { type: 'string' },
    'reset-spent': { type: 'string', multiple: true },
    'delete-old': { type: 'boolean' },
  },
  async run(ctx) {
    const [action = 'ls', query, ...extra] = ctx.positionals
    if (extra.length) throw new UsageError(`多余的参数：${extra.join(' ')}`)
    const needKey = () => { if (!query) throw new UsageError('缺少 <key>：名称或 id 前缀') }
    switch (action) {
      case 'ls':
      case 'list': {
        const bootstrap = await getBootstrap(ctx)
        const keys = (bootstrap.keys || []).map(publicKey)
        return void ctx.output(keys, () => {
          if (!keys.length) return ctx.ui.note('还没有 Key：cradmin keys create --name <名称> --groups <分组>')
          ctx.ui.section('全部 Key', `${keys.length} 把 · 按额度压力排序`)
          ctx.ui.tree(keysTree(keys, bootstrap.groups || []))
          ctx.ui.note('详情：cradmin keys show <名称>；无渠道 = 只能用默认开放的模型')
        })
      }
      case 'show': {
        needKey()
        const { bootstrap, key } = await findKey(ctx, query)
        const data = publicKey(key)
        return void ctx.output(data, () => {
          const { ui } = ctx
          const status = keyStatusView(data)
          ui.kv('名称', data.name)
          ui.kv('id', data.id)
          ui.kv('Key', data.maskedKey)
          ui.kv('状态', ui.paint(status.tone, status.text))
          if (data.blockedReason) ui.kv('', ui.paint('muted', `${data.blockedReason} · 调高额度或重置后自动恢复`))
          ui.kv('渠道', groupScope(data, bootstrap.groups || []))
          ui.kv('并发', concurrencyText(data))
          ui.kv('创建', fmtDate(data.createdAt))
          ui.kv('最近使用', data.lastUsedAt ? time(data.lastUsedAt) : '从未')
          if (data.note) ui.kv('备注', data.note)
          ui.section('额度', '花费按额度账本')
          ui.tree(keyWindowsTree(data, ctx.now()))
        })
      }
      case 'create':
        if (query) throw new UsageError('create 不接位置参数；名称用 --name')
        return create(ctx)
      case 'update':
        needKey()
        return update(ctx, query)
      case 'enable':
      case 'disable':
        needKey()
        return toggle(ctx, query, action === 'enable')
      case 'rotate':
        needKey()
        return rotate(ctx, query)
      case 'delete':
      case 'rm':
        needKey()
        return remove(ctx, query)
      case 'copy':
        needKey()
        return copy(ctx, query)
      default:
        throw new UsageError(`未知动作：keys ${action}`, '运行 cradmin keys -h 查看用法')
    }
  },
}

// accounts：账号池（OAuth 凭据）暂停/恢复、代理、重置额度、OAuth 添加、删除。
import { CancelError, CliError, UsageError } from '../args.mjs'
import { request } from '../client.mjs'
import { credentialProxyItem, credentialToggleItem, getChannels, proxyLabel, publicAccount } from '../ops.mjs'
import { runPlan } from '../plan.mjs'
import { resolveAccount, validateProxy } from '../resolve.mjs'
import { time } from '../ui.mjs'

const HELP = `cradmin accounts <动作> [参数]

管理账号池（OAuth 凭据）。<账号> 是精确的凭据名，或在名称/标签里唯一的子串。

动作：
  ls [--quota]               列出账号（--quota 额外读取额度，可能触发上游额度查询）
  show <账号>                账号详情与额度
  pause|resume <账号…>       暂停 / 恢复（可一次给多个）
  proxy <账号> <url|direct|none|inherit>   设置出口代理（none = direct；inherit = 继承全局；支持 http(s)/socks5/socks5h）
  reset <账号>               重置额度窗口（codex / claude；会消耗一次上游重置额度，并访问外部服务）
  add <provider>             OAuth 添加账号：打印授权地址，在浏览器完成授权
      --callback-url <url> --state <state>   提交浏览器回调地址（两步脚本用法）
  rm <账号>                  删除凭据文件（不可撤销）

说明：不开浏览器添加账号只支持 OAuth；上传凭据文件已移除。

示例：
  cradmin accounts ls --quota
  cradmin accounts pause <账号>
  cradmin accounts proxy <账号> socks5://127.0.0.1:1080
  cradmin accounts add codex
`

const OAUTH_PROVIDERS = ['antigravity', 'google', 'codex', 'openai', 'claude', 'anthropic', 'kimi', 'kimi-ai', 'devin', 'meta', 'muse', 'xai', 'grok']

async function loadMonitor(ctx) {
  try {
    return await ctx.get('/api/monitor')
  } catch (error) {
    if (error instanceof CliError && error.exitCode === 3) throw error
    ctx.ui.warnErr(`额度读取失败：${error.message}`)
    return null
  }
}

const monitorFor = (monitor, name) => (monitor?.accounts || []).find(account => account.name === name || account.filename === name)

const stateText = account => (account.paused ? { text: '暂停', tone: 'warn' } : account.status && account.status !== 'active' ? { text: account.status, tone: 'err' } : { text: '正常', tone: 'ok' })

const quotaSummary = quota => {
  if (!quota) return '-'
  if (quota.unsupported) return '不支持'
  if (quota.error) return `错误：${quota.error}`
  if (!quota.windows.length) return '-'
  return quota.windows.map(window => `${window.label} ${Math.round(window.usedPercent)}%`).join(' · ')
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

async function addAccount(ctx, provider) {
  if (!provider) throw new UsageError('缺少 <provider>', `可用：${OAUTH_PROVIDERS.join('、')}`)
  if (!OAUTH_PROVIDERS.includes(provider)) throw new UsageError(`不支持的 provider：${provider}`, `可用：${OAUTH_PROVIDERS.join('、')}`)
  const { values } = ctx
  if (values['callback-url']) {
    if (!values.state) throw new UsageError('--callback-url 需要配合 --state（来自 accounts add 打印的 state）')
    const result = await runPlan(ctx, {
      level: 'A', title: '提交 OAuth 回调',
      items: [{ area: '账号', label: `${provider} 回调`, from: '-', to: '提交', method: 'POST', path: '/api/cpa/oauth/callback', body: { provider, redirectUrl: values['callback-url'], state: values.state } }],
    })
    return void ctx.output(result)
  }
  if (ctx.dryRun) return void ctx.output({ dryRun: true, plan: [{ call: 'POST /api/cpa/oauth/start', provider }] }, () => ctx.ui.note(`将调用 POST /api/cpa/oauth/start 开始 ${provider} 授权`))
  if ((ctx.target.remote || ctx.menu) && !ctx.yes) {
    if (!ctx.interactive) throw new UsageError('非交互环境执行此操作需要 --yes')
    if (ctx.target.remote) ctx.ui.warnErr(`目标是远程控制台 ${ctx.target.host}`)
    if (!(await ctx.prompter.confirm(`开始 ${provider} 授权？`))) throw new CancelError()
  }
  const started = await request(ctx, 'POST', '/api/cpa/oauth/start', { body: { provider } })
  const state = started.state
  // 取消请求不受 Ctrl+C 中止信号影响；进程退出前由入口的 onExit 钩子等它发完
  const cancel = () => request(ctx, 'POST', '/api/cpa/oauth/cancel', { body: { state }, ignoreAbort: true, timeoutMs: 3000 }).catch(() => {})
  ctx.ui.section(`${provider} 授权`)
  ctx.ui.kv('授权地址', started.url || '-')
  if (started.user_code) ctx.ui.kv('用户码', started.user_code)
  ctx.ui.kv('state', state)
  ctx.ui.note('在浏览器打开授权地址完成登录；这里每 2 秒检查一次结果。')
  ctx.ui.note(`浏览器停在回调页时，可另开终端：cradmin accounts add ${provider} --callback-url '<地址栏 URL>' --state ${state}`)
  const deadline = ctx.now() + (Number(started.expires_in) > 0 ? Number(started.expires_in) : 600) * 1000
  const onExit = ctx.rt?.onExit
  onExit?.add(cancel)
  try {
    while (ctx.now() < deadline) {
      await sleep(ctx.io.pollMs ?? 2000)
      const status = await ctx.get(`/api/cpa/oauth/status?state=${encodeURIComponent(state)}`)
      if (status?.status === 'ok') {
        ctx.ui.success(`${provider} 账号已添加`)
        return void ctx.output({ ok: true, provider })
      }
      if (status?.status === 'error') throw new CliError(`授权失败：${status.error || '未知错误'}`, 1)
    }
    await cancel()
    throw new CliError('授权超时，已取消', 1)
  } catch (error) {
    if (error instanceof CancelError) await cancel()
    throw error
  } finally {
    onExit?.delete(cancel)
  }
}

export default {
  name: 'accounts',
  aliases: ['account', 'pool'],
  summary: '账号池：暂停/恢复、代理、重置额度、OAuth 添加',
  help: HELP,
  options: {
    quota: { type: 'boolean' },
    'callback-url': { type: 'string' },
    state: { type: 'string' },
  },
  async run(ctx) {
    const [action = 'ls', ...args] = ctx.positionals
    const single = () => {
      if (!args[0]) throw new UsageError('缺少 <账号>')
      if (args.length > 1 && action !== 'proxy') throw new UsageError(`多余的参数：${args.slice(1).join(' ')}`)
    }
    switch (action) {
      case 'ls':
      case 'list': {
        const payload = await getChannels(ctx)
        const monitor = ctx.values.quota ? await loadMonitor(ctx) : null
        const rows = (payload.credentials || []).map(credential => publicAccount(credential, ctx.values.quota ? monitorFor(monitor, credential.name) : undefined))
        return void ctx.output(rows, () => {
          if (!rows.length) return ctx.ui.note('还没有账号：cradmin accounts add <provider>')
          const headers = ['账号', 'provider', '状态', '模型', '代理', ...(ctx.values.quota ? ['额度'] : [])]
          ctx.ui.table(headers, rows.map(row => [
            row.label || row.name, row.provider, stateText(row), String(row.modelCount), proxyLabel(row.proxyUrl),
            ...(ctx.values.quota ? [quotaSummary(row.quota)] : []),
          ]), { align: ['left', 'left', 'center', 'right', 'left', 'left'] })
          if (monitor?.quotaSupport?.supported === false) ctx.ui.note(`额度：${monitor.quotaSupport.reason || '当前控制面不支持'}`)
        })
      }
      case 'show': {
        single()
        const payload = await getChannels(ctx)
        const credential = resolveAccount(payload.credentials || [], args[0])
        const monitor = await loadMonitor(ctx)
        const data = publicAccount(credential, monitorFor(monitor, credential.name) || {})
        return void ctx.output(data, () => {
          const { ui } = ctx
          ui.kv('账号', data.label || data.name)
          ui.kv('凭据名', data.name)
          ui.kv('provider', data.provider)
          ui.kv('状态', stateText(data).text)
          ui.kv('模型', String(data.modelCount))
          ui.kv('代理', proxyLabel(data.proxyUrl))
          if (data.quota?.plan || data.quota?.tier) ui.kv('套餐', [data.quota.plan, data.quota.tier].filter(Boolean).join(' · '))
          if (data.quota?.resetCredits) ui.kv('可重置', `${data.quota.resetCredits.available} 次`)
          if (data.quota?.windows?.length) {
            ui.table(['额度窗口', '已用', '重置时间'], data.quota.windows.map(window => [window.label, `${Math.round(window.usedPercent)}%`, time(window.resetsAt)]), { align: ['left', 'right', 'left'] })
          } else if (data.quota?.error) ui.note(`额度：${data.quota.error}`)
        })
      }
      case 'pause':
      case 'resume': {
        if (!args.length) throw new UsageError('缺少 <账号>')
        const payload = await getChannels(ctx)
        const to = action === 'resume'
        const credentials = [...new Map(args.map(query => resolveAccount(payload.credentials || [], query)).map(item => [item.name, item])).values()]
        const items = credentials.filter(credential => Boolean(credential.disabled) === to).map(credential => credentialToggleItem(credential, to))
        const result = await runPlan(ctx, { level: to ? 'A' : 'C', title: `${to ? '恢复' : '暂停'}账号`, items, empty: `账号已是${to ? '启用' : '暂停'}状态` })
        return void ctx.output(result)
      }
      case 'proxy': {
        if (args.length !== 2) throw new UsageError('用法：cradmin accounts proxy <账号> <url|direct|none|inherit>')
        const proxyUrl = validateProxy(args[1])
        const payload = await getChannels(ctx)
        const credential = resolveAccount(payload.credentials || [], args[0])
        const items = (credential.proxyUrl || '') === proxyUrl ? [] : [credentialProxyItem(ctx, credential, proxyUrl)]
        const result = await runPlan(ctx, { level: 'C', title: '设置账号代理', items, empty: '代理没有变化' })
        return void ctx.output(result)
      }
      case 'reset': {
        single()
        const payload = await getChannels(ctx)
        const credential = resolveAccount(payload.credentials || [], args[0])
        const kind = credential.type === 'codex' ? 'codex' : credential.type === 'claude' ? 'claude' : null
        if (!kind) throw new UsageError(`只有 codex / claude 账号支持重置额度（${credential.name} 是 ${credential.type}）`)
        const monitor = await ctx.get('/api/monitor')
        const authIndex = monitorFor(monitor, credential.name)?.auth_index
        if (authIndex === undefined || authIndex === null || authIndex === '') throw new CliError('读不到这个账号的 auth_index（本机控制面不支持重置额度）', 1)
        const result = await runPlan(ctx, {
          level: 'D', title: '重置账号额度', danger: '会消耗一次上游重置额度，并访问外部服务',
          items: [{ area: '账号', label: credential.label || credential.name, from: '-', to: '重置额度', method: 'POST', path: `/api/accounts/${encodeURIComponent(authIndex)}/reset-${kind}-quota`, target: `账号 ${credential.name}` }],
        })
        return void ctx.output(result)
      }
      case 'add':
        if (args.length > 1) throw new UsageError(`多余的参数：${args.slice(1).join(' ')}`)
        return addAccount(ctx, args[0])
      case 'rm':
      case 'remove':
      case 'delete': {
        single()
        const payload = await getChannels(ctx)
        const credential = resolveAccount(payload.credentials || [], args[0])
        const result = await runPlan(ctx, {
          level: 'D', title: '删除账号', danger: '删除凭据文件，无法恢复',
          items: [{ area: '账号', label: `${credential.label || credential.name}（${credential.name}）`, from: credential.disabled ? '暂停' : '启用', to: '删除', method: 'DELETE', path: `/api/credentials/${encodeURIComponent(credential.name)}`, target: `账号 ${credential.name}` }],
        })
        return void ctx.output(result)
      }
      default:
        throw new UsageError(`未知动作：accounts ${action}`, '运行 cradmin accounts -h 查看用法')
    }
  },
}

// status：总览。各节并发读取、独立降级。
import { CliError } from '../args.mjs'
import { channelState, providersOf } from '../ops.mjs'
import { count, percent, time, tokens, usd } from '../ui.mjs'

export function gatewaySummary(cpa) {
  return cpa ? { version: cpa.version || '', commit: cpa.commit || '' } : null
}

export function keyStats(bootstrap) {
  const keys = bootstrap?.keys || []
  return {
    total: keys.length,
    enabled: keys.filter(key => key.enabled).length,
    disabled: keys.filter(key => !key.enabled && !key.blockedReason).length,
    quotaBlocked: keys.filter(key => !key.enabled && key.blockedReason).length,
    degraded: Boolean(bootstrap?.degraded),
    degradedReason: bootstrap?.degradedReason || '',
    gatewayModelAccess: bootstrap?.gatewayModelAccess || 'unknown',
  }
}

export function channelStats(payload) {
  const channels = payload?.channels || []
  const live = channels.filter(channel => !channel.stale)
  return {
    total: channels.length,
    enabled: channels.filter(channel => channelState(channel) === '启用').length,
    disabled: channels.filter(channel => channelState(channel) === '停用').length,
    stale: channels.filter(channel => channel.stale).length,
    enabledModels: live.reduce((sum, channel) => sum + (channel.models || []).filter(model => model.enabled).length, 0),
    totalModels: live.reduce((sum, channel) => sum + (channel.models || []).length, 0),
  }
}

export function accountStats(payload) {
  return providersOf(payload || {}).map(provider => ({ provider: provider.id, accounts: provider.accounts, active: provider.active, paused: provider.paused, abnormal: provider.accounts - provider.active - provider.paused }))
}

const settle = async promise => {
  try { return { ok: true, value: await promise } } catch (error) {
    if (error instanceof CliError && error.exitCode === 3) throw error
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

export default {
  name: 'status',
  aliases: ['st'],
  summary: '总览：控制台与网关版本、同步、渠道、Key、账号、今日用量',
  help: `cradmin status [--json]

一屏总览：控制台与网关版本、Key 统计、渠道与账号池、同步任务、今日用量。
每一节独立读取，某节失败只显示「! 读取失败」，不影响其它节。
`,
  options: {},
  async run(ctx) {
    // 先登录一次，避免并发请求各自触发登录
    await ctx.session.cookie()
    const [version, bootstrap, channels, sync, usage] = await Promise.all([
      settle(ctx.get('/api/version')),
      settle(ctx.get('/api/bootstrap')),
      settle(ctx.get('/api/channels')),
      settle(ctx.get('/api/sync/status')),
      settle(ctx.get('/api/usage-overview?view=workspace&days=1')),
    ])
    const pick = (result, map) => (result.ok ? map(result.value) : { error: result.error })
    const data = {
      target: { profile: ctx.target.profile, base: ctx.target.base, remote: ctx.target.remote },
      version: pick(version, value => ({ console: value.console || null, gateway: gatewaySummary(value.cpa) })),
      keys: pick(bootstrap, keyStats),
      channels: pick(channels, channelStats),
      accounts: pick(channels, accountStats),
      sync: pick(sync, value => (value.jobs || []).map(job => ({ id: job.id, label: job.label, kind: job.kind, state: job.state, lastRunAt: job.lastFinishedAt || job.lastRunAt || null, nextRunAt: job.nextRunAt || null, lastError: job.lastError || null }))),
      usageToday: pick(usage, value => ({ ...value.ledger })),
    }
    ctx.output(data, () => render(ctx, data))
  },
}

function render(ctx, data) {
  const { ui } = ctx
  ui.banner(`${ui.g.mark} cradmin  Crosery 中转站管理  ${ctx.version}`, `${ctx.target.base}（${ctx.target.remote ? '远程' : '本地'}）`)
  const failed = section => section && typeof section === 'object' && !Array.isArray(section) && 'error' in section && Object.keys(section).length === 1
  const fail = section => ui.warn(`读取失败：${section.error}`)

  ui.section('版本')
  if (failed(data.version)) fail(data.version)
  else {
    const consoleVersion = data.version.console
    ui.kv('控制台', consoleVersion ? `${consoleVersion.version || '-'}${consoleVersion.releaseId ? `（${consoleVersion.releaseId}）` : ''}` : '-')
    const gateway = data.version.gateway
    if (gateway) ui.kv('网关', `cpa ${gateway.version || ''}`.trim())
  }

  ui.section('API Key')
  if (failed(data.keys)) fail(data.keys)
  else {
    ui.kv('数量', `启用 ${data.keys.enabled} · 停用 ${data.keys.disabled} · 超额停用 ${data.keys.quotaBlocked}`)
    if (data.keys.degraded) ui.warn(`控制面降级：分组来自上次成功的快照${data.keys.degradedReason ? `（${data.keys.degradedReason}）` : ''}`)
    if (data.keys.gatewayModelAccess === 'unavailable') ui.note('网关不执行按 Key 的模型白名单（只按分组生效）')
  }

  ui.section('渠道与账号池')
  if (failed(data.channels)) fail(data.channels)
  else {
    const c = data.channels
    ui.kv('兼容渠道', `启用 ${c.enabled} · 停用 ${c.disabled} · 残留 ${c.stale} · 模型 ${c.enabledModels}/${c.totalModels} 启用`)
    for (const provider of data.accounts) {
      ui.kv(provider.provider, `账号 ${provider.accounts}：运行 ${provider.active} · 暂停 ${provider.paused} · 异常 ${provider.abnormal}`)
    }
    if (!data.accounts.length) ui.kv('账号池', '没有账号')
  }

  ui.section('同步任务')
  if (failed(data.sync)) fail(data.sync)
  else {
    ui.table(['任务', '状态', '上次运行', '下次运行'], data.sync.map(job => [
      job.label || job.id,
      { text: job.state, tone: job.state === 'error' ? 'err' : job.state === 'running' ? 'accent' : job.state === 'disabled' ? 'muted' : null },
      time(job.lastRunAt), time(job.nextRunAt),
    ]))
  }

  ui.section('今日用量')
  if (failed(data.usageToday)) fail(data.usageToday)
  else {
    const ledger = data.usageToday
    ui.kv('请求', `${count(ledger.requests)}（失败 ${count(ledger.errors)}，${percent(ledger.errorRate)}）`)
    ui.kv('Token', tokens(ledger.tokens))
    ui.kv('花费', `${usd(ledger.costUsd)}${ledger.hasPartialCost ? '（部分模型无价格）' : ''}`)
    ui.kv('缓存命中', percent(ledger.cacheHitRate))
  }
}

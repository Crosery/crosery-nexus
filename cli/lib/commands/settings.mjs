// settings：当前生效的系统设置（只读；服务端没有设置写接口，全部是部署环境变量）。
import { CliError } from '../args.mjs'
import { getBootstrap, getChannels, getRtk, getSync, getVersion } from '../ops.mjs'
import { redactUrl } from '../resolve.mjs'

export const DEPLOY_ONLY = ['CONSOLE_USERNAME', 'CONSOLE_PASSWORD(_FILE)', 'SESSION_SECRET(_FILE)', 'USAGE_RETENTION_DAYS', 'PROXY_PRESETS', 'PUBLIC_GATEWAY_BASE_URL', 'SYNC_INTERVAL_MS', 'USAGE_COLLECT_INTERVAL_MS', 'HOST', 'PORT']

const HELP = `cradmin settings [--json]

把多个只读接口拼成「当前生效设置」：保留天数、额度时区、网关地址、全局代理与代理预设、同步策略、RTK 可写性、版本。

暂不支持写入：这些都是控制台部署的环境变量（${DEPLOY_ONLY.join('、')}），改完重启控制台。
修改管理员密码、会话列表、全局代理写入同样不支持。
`

const settle = async promise => {
  try { return await promise } catch (error) {
    if (error instanceof CliError && error.exitCode === 3) throw error
    return { error: error instanceof Error ? error.message : String(error) }
  }
}

export async function collectSettings(ctx) {
  await ctx.session.cookie()
  const [bootstrap, connect, channels, sync, rtk, version] = await Promise.all([
    settle(getBootstrap(ctx)), settle(ctx.get('/api/connect')), settle(getChannels(ctx)), settle(getSync(ctx)), settle(getRtk(ctx)), settle(getVersion(ctx)),
  ])
  return {
    retentionDays: bootstrap.retentionDays ?? null,
    quotaTimeZone: bootstrap.quotaTimeZone ?? null,
    gatewayModelAccess: bootstrap.gatewayModelAccess ?? null,
    gateway: connect.error ? null : { baseUrl: connect.baseUrl ?? null, anthropicBaseUrl: connect.anthropicBaseUrl ?? null, configured: Boolean(connect.configured) },
    // 代理地址可能带 user:pass@：只给打码后的值（标签缺省就是地址本身，一起打码）
    globalProxy: channels.error ? null : redactUrl(channels.globalProxy ?? ''),
    proxyPresets: channels.error ? null : (channels.proxyPresets || []).map(preset => ({ ...preset, label: redactUrl(preset.label), url: redactUrl(preset.url) })),
    syncPolicy: sync.error ? null : sync.policy ?? null,
    rtk: rtk.error ? null : { on: rtk.on ?? null, writable: Boolean(rtk.writable), reason: rtk.reason || null },
    versions: version.error ? null : { console: version.console || null, gateway: { version: version.cpa?.version ?? null, commit: version.cpa?.commit ?? null } },
    errors: Object.fromEntries(Object.entries({ bootstrap, connect, channels, sync, rtk, version }).filter(([, value]) => value?.error).map(([key, value]) => [key, value.error])),
  }
}

export default {
  name: 'settings',
  aliases: ['setting'],
  summary: '当前生效的系统设置（只读）',
  help: HELP,
  options: {},
  async run(ctx) {
    const data = await collectSettings(ctx)
    ctx.output({ ...data, deployOnly: DEPLOY_ONLY }, () => {
      const { ui } = ctx
      ui.section('当前生效')
      ui.kv('保留天数', data.retentionDays ?? '-')
      ui.kv('额度时区', data.quotaTimeZone ?? '-')
      ui.kv('网关地址', data.gateway?.baseUrl ? `${data.gateway.baseUrl}${data.gateway.configured ? '' : '（未配置公网地址，回退本机）'}` : '-')
      ui.kv('全局代理', data.globalProxy === null ? '-' : data.globalProxy || '直连/未设置')
      ui.kv('代理预设', data.proxyPresets?.length ? data.proxyPresets.map(preset => `${preset.label}=${preset.url}`).join('；') : '无')
      ui.kv('同步策略', data.syncPolicy ? `上游并发 ${data.syncPolicy.globalUpstreamConcurrency ?? '-'} · 单主机间隔 ${Math.round((data.syncPolicy.minIntervalPerHostMs ?? 0) / 1000)} 秒` : '-')
      ui.kv('RTK', data.rtk ? `${data.rtk.on === null ? '未知' : data.rtk.on ? 'on' : 'off'} · ${data.rtk.writable ? '可写' : `不可写（${data.rtk.reason || '-'}）`}` : '-')
      ui.kv('Key 模型', data.gatewayModelAccess === 'unavailable' ? '网关不执行按 Key 模型白名单' : data.gatewayModelAccess ?? '-')
      if (data.versions) ui.kv('版本', `控制台 ${data.versions.console?.version ?? '-'} · 网关 ${data.versions.gateway.version ?? '-'}`)
      for (const [key, message] of Object.entries(data.errors)) ui.warn(`${key} 读取失败：${message}`)
      ui.section('只能改部署配置', '改环境变量后重启控制台')
      ui.note(DEPLOY_ONLY.join('、'))
    })
  },
}

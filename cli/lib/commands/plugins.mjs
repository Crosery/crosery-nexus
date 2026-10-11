// plugins：CPA 插件列表、插件商店、安装与卸载。
import { CliError, UsageError } from '../args.mjs'
import { runPlan } from '../plan.mjs'

const HELP = `cradmin plugins <动作> [参数]

管理 CPA 插件与插件商店。注意：新安装或卸载的插件需重启 CPA 进程后才会注册/完全卸载。

动作：
  ls                              列出已装插件（id、版本/路径、已注册、生效状态；默认）
  store                           列出商店来源与可用插件（标注已装）
  install <id> [--source <来源>]  从商店安装插件；若多个来源都含该 id 则必须用 --source 指定
  rm <id>                         卸载插件（需要确认；脚本里加 --yes）

示例：
  cradmin plugins ls
  cradmin plugins store
  cradmin plugins install opencode-session-mapper --source official
  cradmin plugins rm opencode-session-mapper --yes
`

function candidateSources(store, id) {
  const found = []
  const add = value => {
    const text = typeof value === 'string'
      ? value.trim()
      : typeof value?.id === 'string'
        ? value.id.trim()
        : typeof value?.source_id === 'string'
          ? value.source_id.trim()
          : ''
    if (text && !found.includes(text)) found.push(text)
  }
  for (const item of store?.plugins || []) {
    if (item?.id !== id) continue
    add(item.source_id ?? item.source)
    for (const src of item?.sources || []) add(src)
  }
  for (const src of store?.sources || []) {
    if (Array.isArray(src?.plugins) && src.plugins.some(plugin => (typeof plugin === 'string' ? plugin : plugin?.id) === id)) {
      add(src.id ?? src.name)
    }
  }
  return found
}

export default {
  name: 'plugins',
  aliases: ['plugin'],
  summary: 'CPA 插件与插件商店',
  help: HELP,
  options: {
    source: { type: 'string' },
  },
  async run(ctx) {
    const [action = 'ls', id, ...extra] = ctx.positionals
    if (extra.length) throw new UsageError(`多余的参数：${extra.join(' ')}`)

    switch (action) {
      case 'ls':
      case 'list': {
        if (id) throw new UsageError(`多余的参数：${id}`)
        const payload = await ctx.get('/api/plugins')
        const rows = (payload?.plugins || []).map(item => ({
          ...item,
          id: String(item?.id || ''),
          version: item?.version || item?.installed_version || item?.metadata?.version || null,
          path: item?.path || '',
          registered: Boolean(item?.registered),
          enabled: Boolean(item?.enabled),
          effective_enabled: Boolean(item?.effective_enabled),
        }))
        const data = {
          plugins_enabled: Boolean(payload?.plugins_enabled),
          plugins_dir: payload?.plugins_dir || '',
          plugins: rows,
        }
        return void ctx.output(data, () => {
          ctx.ui.section('已装插件', `总开关 ${data.plugins_enabled ? 'on' : 'off'}${data.plugins_dir ? ` · 目录 ${data.plugins_dir}` : ''}`)
          if (!rows.length) return ctx.ui.note('还没有安装插件')
          ctx.ui.table(
            ['ID', '版本', '路径', '已注册', '生效'],
            rows.map(row => [
              row.id,
              row.version || '-',
              row.path || '-',
              row.registered ? { text: '是', tone: 'ok' } : { text: '否', tone: 'warn' },
              row.effective_enabled ? { text: '是', tone: 'ok' } : { text: '否', tone: 'muted' },
            ]),
          )
        })
      }

      case 'store': {
        if (id) throw new UsageError(`多余的参数：${id}`)
        const payload = await ctx.get('/api/plugins/store')
        const rawPlugins = Array.isArray(payload?.plugins) ? payload.plugins : []
        const installedIds = new Set()
        if (rawPlugins.some(item => typeof item?.installed !== 'boolean')) {
          try {
            const installed = await ctx.get('/api/plugins')
            for (const item of installed?.plugins || []) {
              if (item?.id) installedIds.add(String(item.id))
            }
          } catch (error) {
            if (error instanceof CliError && error.exitCode === 3) throw error
          }
        }
        const sources = (payload?.sources || []).map(src => ({
          ...src,
          id: String(src?.id || ''),
          name: src?.name || src?.id || '',
          url: src?.url || '',
        }))
        const plugins = rawPlugins.map(item => {
          const pluginId = String(item?.id || '')
          const sourceList = candidateSources({ plugins: [item] }, pluginId)
          const version = item?.version || item?.latest_version || item?.metadata?.version || null
          const installed = Boolean(item?.installed || item?.installed_version || installedIds.has(pluginId))
          return {
            ...item,
            id: pluginId,
            source: sourceList.join(', '),
            version,
            installed,
          }
        })
        const data = {
          plugins_enabled: Boolean(payload?.plugins_enabled),
          plugins_dir: payload?.plugins_dir || '',
          sources,
          plugins,
        }
        return void ctx.output(data, () => {
          ctx.ui.section('插件来源', `${sources.length} 个`)
          if (sources.length) {
            ctx.ui.table(
              ['来源 ID', '名称', '地址'],
              sources.map(src => [src.id, src.name || '-', src.url || '-']),
            )
          } else {
            ctx.ui.note('没有配置商店来源')
          }
          ctx.ui.section('商店插件', `${plugins.length} 个`)
          if (!plugins.length) return ctx.ui.note('商店里没有可用插件')
          ctx.ui.table(
            ['ID', '来源', '版本', '状态'],
            plugins.map(item => [
              item.id,
              item.source || '-',
              item.version || '-',
              item.installed ? { text: '已装', tone: 'ok' } : { text: '未装', tone: 'muted' },
            ]),
          )
        })
      }

      case 'install': {
        if (!id) throw new UsageError('缺少 <id>', '用法：cradmin plugins install <id> [--source <sourceId>]')
        const source = typeof ctx.values.source === 'string' ? ctx.values.source.trim() : ''
        if (!source) {
          let store = null
          try {
            store = await ctx.get('/api/plugins/store')
          } catch (error) {
            if (error instanceof CliError && error.exitCode === 3) throw error
          }
          const candidates = candidateSources(store, id)
          if (candidates.length > 1) {
            throw new UsageError(
              `插件 ${id} 存在于多个来源：${candidates.join('、')}`,
              `请用 --source <sourceId> 指定来源，例如：cradmin plugins install ${id} --source ${candidates[0]}`,
            )
          }
        }
        const result = await runPlan(ctx, {
          level: 'A',
          title: '安装插件',
          items: [{
            area: '插件',
            label: id,
            from: '-',
            to: source ? `安装（${source}）` : '安装',
            method: 'POST',
            path: `/api/plugins/store/${encodeURIComponent(id)}/install`,
            ...(source ? { body: { source } } : {}),
            target: `插件 ${id}`,
          }],
        })
        return void ctx.output(result)
      }

      case 'rm':
      case 'remove':
      case 'delete': {
        if (!id) throw new UsageError('缺少 <id>', '用法：cradmin plugins rm <id>')
        const result = await runPlan(ctx, {
          level: 'D',
          title: '卸载插件',
          danger: '卸载已装插件，需重启 CPA 完全生效',
          items: [{
            area: '插件',
            label: id,
            from: '已装',
            to: '删除',
            method: 'DELETE',
            path: `/api/plugins/${encodeURIComponent(id)}`,
            target: `插件 ${id}`,
          }],
        })
        return void ctx.output(result)
      }

      default:
        throw new UsageError(`未知动作：plugins ${action}`, '运行 cradmin plugins -h 查看用法')
    }
  },
}

// rtk：RTK 省 token 全局开关（改服务端所在机器的 agent 配置）。
import { CliError, UsageError } from '../args.mjs'
import { getRtk, rtkItem } from '../ops.mjs'
import { runPlan } from '../plan.mjs'

const HELP = `cradmin rtk <动作>

RTK 省 token 全局开关。开关会改「控制台服务端所在机器」上 ~/.claude、~/.codex 等 agent 配置。

动作：
  status                     开关、平面、支持/已开启的 agent、能否写入及原因（默认）
  on | off                   打开 / 关闭（需要确认；脚本里加 --yes）
  upgrade --dry-run          看本机 rtk 会升级到哪个版本：服务端下载并校验 sha256，不替换
  upgrade [--accept-breaking]  现在升级本机 rtk（先备份、原子替换、--version 自检、失败回滚；需确认）
  auto                       自动升级：开关与上次结果（只读）
`

export default {
  name: 'rtk',
  aliases: [],
  summary: 'RTK 省 token 开关',
  help: HELP,
  options: { 'accept-breaking': { type: 'boolean' } },
  async run(ctx) {
    const [action = 'status', ...extra] = ctx.positionals
    if (action === 'upgrade') return upgrade(ctx, extra)
    if (action === 'auto') return auto(ctx, extra)
    if (extra.length) throw new UsageError(`多余的参数：${extra.join(' ')}`)
    if (action === 'status') {
      const rtk = await getRtk(ctx)
      const data = { on: rtk.on ?? null, plane: rtk.plane ?? null, agents: rtk.agents || null, savings: rtk.savings || null, writable: Boolean(rtk.writable), reason: rtk.reason || null }
      return void ctx.output(data, () => {
        const { ui } = ctx
        ui.kv('开关', data.on === null ? '未知' : data.on ? 'on' : 'off')
        ui.kv('平面', data.plane || '-')
        ui.kv('agent', data.agents ? `支持 ${data.agents.supported} · 已开 ${data.agents.on}` : '-')
        if (data.savings) ui.kv('节省', `${(Number(data.savings.pct) || 0).toFixed(1)}%`)
        ui.kv('可写', data.writable ? '是' : `否${data.reason ? `（${data.reason}）` : ''}`)
      })
    }
    if (action === 'on' || action === 'off') {
      const on = action === 'on'
      const current = await getRtk(ctx)
      // on 只在所有 agent 都开（或都关）时才是 true/false：相等就没有任何要改的
      const result = await runPlan(ctx, {
        level: 'C', title: `RTK ${action}`, items: current.on === on ? [] : [rtkItem(current.on, on)],
        danger: '会改服务端所在机器的 ~/.claude、~/.codex 配置', empty: `RTK 已是 ${action}`,
      })
      if (result.dryRun || !result.results.length) return void ctx.output(result)
      const payload = result.results[0].result
      ctx.output({ ok: Boolean(payload?.ok), plane: payload?.plane ?? null, results: payload?.results || [] }, () => {
        const rows = payload?.results || []
        if (rows.length) {
          ctx.ui.table(['agent', '结果'], rows.map(row => [row.agent, row.ok ? { text: row.unchanged ? '未变' : '已改', tone: 'ok' } : { text: row.error || row.reason || '失败', tone: 'err' }]))
        }
      })
      if (payload && payload.ok === false) throw new CliError('部分 agent 没有改成功', 1)
      return
    }
    throw new UsageError(`未知动作：rtk ${action}`, '运行 cradmin rtk -h 查看用法')
  },
}

const UPGRADE_TIMEOUT_MS = 200_000

function planLines(ui, result) {
  const plan = result?.plan
  ui.kv('本机', `${result?.local ?? '-'}${result?.binary ? `  ${result.binary}` : ''}`)
  ui.kv('最新', result?.latest ?? '-')
  if (result?.command) ui.kv('方式', `Homebrew 安装：${result.command}`)
  if (plan) {
    ui.kv('下载', `${plan.asset}（${Math.round((plan.size || 0) / 1024)} KB）`)
    ui.kv('sha256', `${plan.sha256}  ✓ ${(plan.verifiedBy || []).join(' + ')}`)
    ui.kv('签名', plan.signature === 'none published' ? '发布方没有签名，按 sha256 校验' : String(plan.signature))
    ui.kv('替换', `${plan.target}（旧版备份到 ${plan.backupDir}）`)
  }
  for (const reason of result?.reasons || []) {
    ui.warn(reason.text)
    if (reason.code === 'breaking') for (const item of reason.items || []) ui.kv('说明', item)
  }
}

/** `rtk upgrade`：--dry-run 让服务端下载并校验（不替换）；真升级是改可执行文件，需确认。 */
async function upgrade(ctx, extra) {
  if (extra.length) throw new UsageError(`多余的参数：${extra.join(' ')}`)
  const { ui } = ctx
  if (ctx.dryRun) {
    const reply = await ctx.send('POST', '/api/autoupdate/run', { target: 'rtk', dryRun: true }, { allowInDryRun: true, timeoutMs: UPGRADE_TIMEOUT_MS })
    const result = reply?.result ?? {}
    return void ctx.output(result, () => {
      ui.section('rtk 升级预览', '--dry-run：已下载并校验，没有替换')
      ui.kv('结论', result.action === 'upgrade' ? '可以升级' : result.action === 'hold' ? '会停住（声明了破坏性变更）' : result.why === 'up-to-date' ? '已是最新' : String(result.why ?? '-'))
      planLines(ui, result)
    })
  }
  const acceptBreaking = Boolean(ctx.values['accept-breaking'])
  const result = await runPlan(ctx, {
    level: 'C', title: 'rtk upgrade',
    danger: '替换本机 rtk 可执行文件（先备份，--version 自检失败自动回滚）',
    items: [{ area: 'RTK', label: '升级本机 rtk', to: acceptBreaking ? '最新（接受破坏性变更）' : '最新', method: 'POST', path: '/api/autoupdate/run',
      body: { target: 'rtk', dryRun: false, confirm: true, ...(acceptBreaking ? { acceptBreaking: true } : {}) }, timeoutMs: UPGRADE_TIMEOUT_MS,
      unknownHint: '用 cradmin rtk auto 查看 rtk 的上次结果' }],
  })
  if (result.dryRun) return void ctx.output(result)
  const payload = result.results[0].result?.result ?? {}
  ctx.output(payload, () => planLines(ui, payload))
  if (!['upgraded', 'up-to-date'].includes(payload.why)) throw new CliError(payload.why === 'breaking' ? '这次升级声明了破坏性变更；确认无碍后加 --accept-breaking' : `没有升级（${payload.why ?? '未知'}）`, 1)
}

/** `rtk auto`：/api/autoupdate 的 rtk 一项（定时任务记下的开关与上次结果）。 */
async function auto(ctx, extra) {
  if (extra.length) throw new UsageError(`多余的参数：${extra.join(' ')}`)
  const view = (await ctx.get('/api/autoupdate'))?.rtk ?? {}
  ctx.output(view, () => {
    ctx.ui.kv('开关', view.enabled ? '开' : '关')
    ctx.ui.kv('状态', view.line ?? '-')
  })
}

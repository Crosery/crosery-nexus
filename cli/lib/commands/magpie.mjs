// magpie：内核版本与更新（服务端代跑 scripts/magpie-update.mjs；从不自动重启内核）。
import { CliError, UsageError } from '../args.mjs'
import { getVersion } from '../ops.mjs'
import { runPlan } from '../plan.mjs'
import { time } from '../ui.mjs'
import { magpieSummary } from './status.mjs'

/** 服务端更新脚本最长跑 180 秒（apply 还要 build）；客户端多等一点，超时报「结果未知」而不是「连不上」。 */
const UPDATE_TIMEOUT_MS = 200_000

const HELP = `cradmin magpie <动作> [参数]

Magpie 内核版本与更新。

动作：
  status                     内核版本、上游最新版本、差距、检查时间、更新能力与上次结果（默认）
  check [--from <ref>]       检查上游（访问 GitHub）
  rehearse [--from <ref>]    在临时目录演练一次更新
  apply                      真正替换内核（不可撤销；服务端不会自动重启内核）
  auto [status]              自动更新：开关、上次结果、下次窗口、停住的原因（Magpie 与 rtk）
  auto on | off              打开 / 关闭 Magpie 自动更新（改策略，需确认；脚本里加 --yes）
  auto run --dry-run         定时任务现在会做什么（只读）；真正的演练与替换只在 launchd 定时任务里执行

说明：check / rehearse / apply 最长等 ${UPDATE_TIMEOUT_MS / 1000} 秒；超时只代表结果未知，先用 status 确认再决定是否重试。
`

export default {
  name: 'magpie',
  aliases: [],
  summary: 'Magpie 内核版本与更新',
  help: HELP,
  options: { from: { type: 'string' } },
  async run(ctx) {
    const [action = 'status', ...extra] = ctx.positionals
    if (action === 'auto') return runAuto(ctx, extra)
    if (extra.length) throw new UsageError(`多余的参数：${extra.join(' ')}`)
    if (action === 'status') {
      const [version, update] = await Promise.all([getVersion(ctx), ctx.get('/api/magpie/update-status')])
      const data = {
        kernel: magpieSummary(version.cpa),
        update: {
          capability: Boolean(update?.capability), reason: update?.reason || null,
          currentVersion: update?.currentVersion ?? null, latestVersion: update?.latestVersion ?? null,
          lastCheckedAt: update?.lastCheckedAt ?? null, lastResult: update?.lastResult ?? null, error: update?.error ?? null,
        },
      }
      return void ctx.output(data, () => {
        const { ui } = ctx
        const kernel = data.kernel || {}
        ui.section('内核')
        ui.kv('版本', kernel.label ?? kernel.version ?? '-')
        ui.kv('提交', kernel.commit || '-')
        ui.kv('发布', kernel.release || '-')
        ui.kv('运行', kernel.running === undefined ? '-' : kernel.running ? '运行中' : '未运行')
        ui.kv('上游最新', kernel.latestRelease || '-')
        ui.kv('差距', kernel.gap ? `${kernel.gap}${kernel.commitsBehindAtLeast ? `（落后至少 ${kernel.commitsBehindAtLeast} 个提交）` : ''}` : '-')
        ui.kv('检查时间', `${time(kernel.checkedAt)}${kernel.checkFailed ? ' · 上次失败' : ''}${kernel.overdue ? ' · 已逾期' : ''}`)
        ui.section('更新')
        ui.kv('可用', data.update.capability ? '是' : `否${data.update.reason ? `（${data.update.reason}）` : ''}`)
        ui.kv('当前/最新', `${data.update.currentVersion || '-'} / ${data.update.latestVersion || '-'}`)
        ui.kv('上次检查', time(data.update.lastCheckedAt))
        ui.kv('上次结果', data.update.lastResult ? String(data.update.lastResult) : '-')
        if (data.update.error) ui.warn(String(data.update.error))
      })
    }
    if (action === 'check' || action === 'rehearse' || action === 'apply') {
      if (action === 'apply' && ctx.values.from) throw new UsageError('apply 不接受 --from')
      const body = { action, ...(ctx.values.from ? { from: ctx.values.from } : {}), ...(action === 'apply' ? { confirm: true } : {}) }
      let fromVersion = '-'
      if (action === 'apply') {
        const update = await ctx.get('/api/magpie/update-status')
        if (!update?.capability) throw new CliError(`更新能力不可用${update?.reason ? `：${update.reason}` : ''}`, 1)
        fromVersion = `${update.currentVersion || '-'}（目标 ${update.latestVersion || '上游最新'}）`
      }
      const result = await runPlan(ctx, {
        level: action === 'apply' ? 'D' : 'A', title: `Magpie ${action}`,
        danger: action === 'apply' ? '替换内核二进制；服务端不会自动重启内核' : '',
        items: [{ area: 'Magpie', label: action === 'check' ? '检查上游（访问 GitHub）' : action === 'rehearse' ? '临时目录演练' : '替换内核', from: action === 'apply' ? fromVersion : '-', to: action, method: 'POST', path: '/api/magpie/update', body, taskLabel: 'Magpie 更新',
          timeoutMs: UPDATE_TIMEOUT_MS, unknownHint: '用 cradmin magpie status 查看上次结果；不要直接重试（服务端没有并发保护）' }],
      })
      if (result.dryRun) return void ctx.output(result)
      const payload = result.results[0].result
      ctx.output({ ok: Boolean(payload?.ok), action, result: payload?.result ?? null }, () => {
        const summary = payload?.result
        if (summary && typeof summary === 'object') {
          for (const [key, value] of Object.entries(summary).slice(0, 12)) {
            if (value === null || typeof value !== 'object') ctx.ui.kv(key, String(value))
          }
        }
        if (action === 'apply') ctx.ui.warn('服务端不会自动重启内核，按 deploy/magpie/CONSOLE-KERNEL.md 重启')
      })
      return
    }
    throw new UsageError(`未知动作：magpie ${action}`, '运行 cradmin magpie -h 查看用法')
  },
}

const WHY = {
  disabled: '已关闭', 'no-local-kernel': '这里没有本机 Magpie 内核', 'no-status': '还没有可用的上游检查结果', 'up-to-date': '没有新候选',
  'kernel-offline': '内核离线，不替换', 'running-unknown': '运行中的内核不是基线也不是上次自动更新的版本，不动它', backoff: '退避中',
  rehearse: '会演练这个候选', held: '停在待复核', attempted: '这个版本已经试过一次，不再自动重试', window: '演练已通过，等窗口',
  signin: '有登录进行中，等它结束', apply: '会在这一轮替换', error: '演练出错',
}

/** `magpie auto …`：读 /api/autoupdate，开关走 PUT（改策略），run 只做服务端只读的 dry run。 */
async function runAuto(ctx, extra) {
  const [sub = 'status', ...rest] = extra
  if (rest.length) throw new UsageError(`多余的参数：${rest.join(' ')}`)
  const { ui } = ctx
  if (sub === 'status') {
    const view = await ctx.get('/api/autoupdate')
    return void ctx.output(view, () => {
      ui.section('Magpie 自动更新')
      ui.kv('开关', view.magpie.enabled ? '开' : '关')
      ui.kv('状态', view.magpie.line)
      ui.kv('窗口', `${view.magpie.window.start}–${view.magpie.window.end}${view.magpie.nextWindowAt ? `（下次 ${time(view.magpie.nextWindowAt)}）` : ''}`)
      if (view.magpie.reasons.length > 1) for (const reason of view.magpie.reasons) ui.line(`  · ${reason.text}`)
      ui.section('rtk 自动升级')
      ui.kv('开关', view.rtk.enabled ? '开' : '关')
      ui.kv('状态', view.rtk.line)
    })
  }
  if (sub === 'on' || sub === 'off') {
    const on = sub === 'on'
    const view = await ctx.get('/api/autoupdate')
    if (on && !view.magpie.available) ui.warn('这台控制台的网关不是本机 Magpie 内核：开关会保存，但没有内核可更新')
    const result = await runPlan(ctx, {
      level: 'C', title: `Magpie 自动更新 ${sub}`, empty: `Magpie 自动更新已是 ${sub}`,
      danger: on ? '兼容的新内核会在静默窗口里自动替换并重启网关（先备份，失败自动回滚）' : '',
      items: view.magpie.enabled === on ? [] : [{ area: 'Magpie', label: '自动更新', from: view.magpie.enabled ? '开' : '关', to: on ? '开' : '关', method: 'PUT', path: '/api/autoupdate', body: { magpie: { enabled: on } } }],
    })
    if (result.dryRun || !result.results.length) return void ctx.output(result)
    const next = result.results[0].result
    return void ctx.output(next, () => ui.kv('状态', next?.magpie?.line ?? '-'))
  }
  if (sub === 'run') {
    if (!ctx.dryRun) throw new UsageError('magpie auto run 只接受 --dry-run：真正的演练与替换只在 launchd 定时任务里执行（替换会重启控制台本身）', '看计划：cradmin magpie auto run --dry-run')
    const reply = await ctx.send('POST', '/api/autoupdate/run', { target: 'magpie', dryRun: true }, { allowInDryRun: true, timeoutMs: 45_000 })
    const plan = reply?.result?.magpie ?? {}
    return void ctx.output(reply?.result ?? {}, () => {
      ui.section('定时任务现在会做什么', '预览（--dry-run，只读）')
      ui.kv('动作', plan.action === 'none' ? '不动' : plan.action === 'wait' ? '等待' : plan.action === 'rehearse' ? '演练' : plan.action === 'apply' ? '替换' : String(plan.action ?? '-'))
      ui.kv('原因', WHY[plan.why] ?? String(plan.why ?? '-'))
      if (plan.candidate) ui.kv('候选', `${String(plan.candidate).slice(0, 7)}${plan.release ? ` · ${plan.release}` : ''}`)
      ui.kv('窗口', `${plan.window ?? '-'}${plan.inWindow ? '（现在在窗口内）' : plan.nextWindowAt ? `（下次 ${time(plan.nextWindowAt)}）` : ''}`)
      for (const reason of plan.reasons ?? []) ui.line(`  · ${reason.text}`)
    })
  }
  throw new UsageError(`未知动作：magpie auto ${sub}`, '运行 cradmin magpie -h 查看用法')
}

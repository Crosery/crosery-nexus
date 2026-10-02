// sync：后台同步任务。
import { CliError, UsageError } from '../args.mjs'
import { getSync } from '../ops.mjs'
import { runPlan } from '../plan.mjs'
import { duration, time } from '../ui.mjs'

const HELP = `cradmin sync <动作> [参数]

后台同步任务（模型目录、价格、账号额度等）。

动作：
  ls                         列出任务、状态、上次/下次运行、能否手动运行、剩余冷却（默认）
  run <任务> [--wait]        立即运行一次（只有 model-discovery、pricing、account-quota 可手动运行）
      --wait                 每 2 秒查一次状态，直到任务结束（最多 5 分钟）

说明：手动运行有冷却，冷却中退出 4 并给出剩余秒数。外部定时任务（catalog-sync 等）不能在这里触发。

示例：
  cradmin sync run pricing --wait
`

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

export function jobRow(job, now = Date.now()) {
  const cooldownMs = job.runCooldownUntil ? new Date(job.runCooldownUntil).getTime() - now : 0
  return {
    id: job.id, label: job.label || job.id, kind: job.kind, state: job.state,
    lastRunAt: job.lastFinishedAt || job.lastRunAt || null, nextRunAt: job.nextRunAt || null,
    canRunNow: Boolean(job.canRunNow), cooldownSec: cooldownMs > 0 ? Math.ceil(cooldownMs / 1000) : 0,
    lastResult: job.lastResult || null, lastError: job.lastError || null, summary: job.summary || null,
  }
}

/**
 * 等任务这一轮跑完：不在 running，且 lastFinishedAt 变了或中途看到过 running（避免读到上一轮的结果）。
 * 返回 jobRow；超时返回 null。
 */
export async function waitForJob(ctx, id, { since = null, timeoutMs = 5 * 60_000 } = {}) {
  const deadline = ctx.now() + timeoutMs
  let sawRunning = false
  while (ctx.now() < deadline) {
    await sleep(ctx.io.pollMs ?? 2000)
    const fresh = (await ctx.get('/api/sync/status')).jobs?.find(item => item.id === id)
    if (!fresh) continue
    if (fresh.state === 'running') { sawRunning = true; continue }
    if (sawRunning || (fresh.lastFinishedAt || null) !== since) return jobRow(fresh, ctx.now())
  }
  return null
}

export default {
  name: 'sync',
  aliases: [],
  summary: '后台同步任务',
  help: HELP,
  options: { wait: { type: 'boolean' } },
  async run(ctx) {
    const [action = 'ls', id, ...extra] = ctx.positionals
    if (extra.length) throw new UsageError(`多余的参数：${extra.join(' ')}`)
    if (action === 'ls' || action === 'list' || action === 'status') {
      const status = await getSync(ctx)
      const rows = (status.jobs || []).map(job => jobRow(job, ctx.now()))
      return void ctx.output({ policy: status.policy || null, jobs: rows }, () => {
        ctx.ui.table(['任务', '类型', '状态', '上次运行', '下次运行', '手动', '冷却'], rows.map(row => [
          `${row.label}（${row.id}）`, row.kind === 'external' ? '外部定时' : '内置',
          { text: row.state, tone: row.state === 'error' ? 'err' : row.state === 'running' ? 'accent' : row.state === 'disabled' ? 'muted' : null },
          time(row.lastRunAt), time(row.nextRunAt), row.canRunNow ? '可' : '-', row.cooldownSec ? duration(row.cooldownSec) : '-',
        ]), { align: ['left', 'left', 'center', 'left', 'left', 'center', 'right'] })
        const failed = rows.filter(row => row.lastError)
        for (const row of failed) ctx.ui.warn(`${row.label}：${row.lastError}`)
        ctx.ui.note('手动运行：cradmin sync run <任务>')
      })
    }
    if (action === 'run') {
      if (!id) throw new UsageError('缺少 <任务>', '可手动运行：model-discovery、pricing、account-quota')
      const status = await getSync(ctx)
      const job = (status.jobs || []).find(item => item.id === id)
      if (!job) throw new UsageError(`没有这个任务：${id}`, `现有任务：${(status.jobs || []).map(item => item.id).join('、')}`)
      if (job.kind === 'external') throw new UsageError('这是外部定时任务，不能在这里触发')
      const result = await runPlan(ctx, {
        level: 'A', title: '运行同步任务',
        items: [{ area: '同步', label: `${job.label || id}（${id}）`, from: job.state, to: '运行', method: 'POST', path: `/api/sync/${encodeURIComponent(id)}/run`, taskLabel: job.label || id }],
      })
      if (result.dryRun || !ctx.values.wait) return void ctx.output(result)
      const final = await waitForJob(ctx, id, { since: job.lastFinishedAt || null })
      if (!final) throw new CliError('等了 5 分钟任务还在运行，稍后用 cradmin sync ls 查看', 1)
      ctx.output({ ...result, job: final }, () => {
        if (final.lastError) ctx.ui.fail(`${final.label}：${final.lastError}`)
        else ctx.ui.success(`${final.label} 已完成${final.summary ? `：${final.summary}` : ''}`)
      })
      return final.lastError ? 1 : 0
    }
    throw new UsageError(`未知动作：sync ${action}`, '运行 cradmin sync -h 查看用法')
  },
}

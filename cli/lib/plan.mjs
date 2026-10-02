// 写计划：打印 → --dry-run 预览 → 按级别确认（默认否）→ 顺序执行，遇第一个失败就停并汇报。
import { CancelError, CliError, UsageError } from './args.mjs'
import { request } from './client.mjs'
import { redactUrl } from './resolve.mjs'

/** R 只读 · A 增加能力 · C 收缩能力/改策略 · D 不可撤销或消耗上游额度 */
export const needsConfirm = (level, remote) => level === 'C' || level === 'D' || (level === 'A' && remote)

const SECRET_FIELD = /^(password|apiKey|key|token|cookie|secret)$/i

export function summarizeBody(body) {
  if (body === undefined) return ''
  const scrub = value => {
    if (Array.isArray(value)) return value.map(scrub)
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).map(([key, child]) => [key,
        SECRET_FIELD.test(key) && !(typeof child === 'string' && /^env:[A-Z0-9_]+$/.test(child)) ? '<隐藏>' : scrub(child)]))
    }
    return redactUrl(value)
  }
  const text = JSON.stringify(scrub(body))
  return text.length > 160 ? `${text.slice(0, 159)}…` : text
}

const stepLine = (ui, item) => {
  const change = item.from !== undefined || item.to !== undefined
    ? ` ${ui.paint('muted', '·')} ${item.from ?? '-'} ${ui.g.arrow} ${item.to ?? '-'}`
    : ''
  return `${item.area ? `${ui.paint('muted', item.area)}  ` : ''}${item.label}${change}`
}

/**
 * ctx: 命令上下文；opts: {level, title, items, empty, danger, irreversible}
 * item: {area?, label, from?, to?, method, path, body?, run?(): Promise<any>, target?, taskLabel?}
 * 返回 {dryRun, plan, results}
 */
export async function runPlan(ctx, { level, title, items, empty = '没有需要改动的地方', danger = '', irreversible = level === 'D' }) {
  const { ui } = ctx
  const plan = items.map(item => ({ area: item.area, label: item.label, from: item.from, to: item.to, call: `${item.method} ${item.path}` }))
  if (!items.length) {
    ui.success(empty)
    return { dryRun: Boolean(ctx.dryRun), plan, results: [] }
  }
  // 菜单里永远走确认（规格 §7）
  const confirm = Boolean(ctx.menu) || needsConfirm(level, ctx.target.remote)
  if (ctx.target.remote) ui.warnErr(`目标是远程控制台 ${ctx.target.host}`)
  if (ctx.dryRun || confirm) {
    ui.section(title, ctx.dryRun ? '预览（--dry-run，不会发出写请求）' : `${items.length} 项`)
    for (const item of items) {
      ui.line(`  ${stepLine(ui, item)}`)
      if (ctx.dryRun) ui.line(`    ${ui.paint('muted', `${item.method} ${item.path}${item.body !== undefined ? `  ${summarizeBody(item.body)}` : ''}`)}`)
    }
  }
  if (ctx.dryRun) return { dryRun: true, plan, results: [] }
  if (confirm && !ctx.yes) {
    if (!ctx.interactive) throw new UsageError('非交互环境执行此操作需要 --yes')
    if (irreversible) ui.fail(ui.paintErr('err', `不可撤销${danger ? `：${danger}` : ''}`))
    else if (danger) ui.warnErr(danger)
    if (!(await ctx.prompter.confirm('确认执行？'))) throw new CancelError()
  }
  const results = []
  for (const [index, item] of items.entries()) {
    try {
      const result = item.run
        ? await item.run()
        : await request(ctx, item.method, item.path, { body: item.body, target: item.target ?? item.label, label: item.taskLabel, timeoutMs: item.timeoutMs, unknownHint: item.unknownHint })
      results.push({ ...plan[index], ok: true, result })
      ui.success(stepLine(ui, item))
    } catch (error) {
      if (!(error instanceof CliError)) throw error
      ui.fail(`${stepLine(ui, item)}：${error.message}`)
      if (items.length > 1) {
        const failed = new CliError(`已完成 ${index} / 失败 1 / 未执行 ${items.length - index - 1}`, index === 0 ? error.exitCode : 1)
        failed.partial = { plan, results }
        throw failed
      }
      error.reported = true
      throw error
    }
  }
  return { dryRun: false, plan, results }
}

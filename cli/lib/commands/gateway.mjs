// gateway：网关功能——Magpie 内核的脱敏、识图、生图设置（GET/PUT /api/gateway/settings；CPA 网关只读出不可用原因）。
import { CliError, UsageError } from '../args.mjs'
import { runPlan } from '../plan.mjs'

const KEYS = ['redact', 'redactPersonal', 'redactWords', 'redactRules', 'vision', 'imageGen']

const HELP = `cradmin gateway <动作> [参数]

网关功能：Magpie 内核的脱敏、识图、生图设置，文案与 Magpie 设置页同源；改动从下一个请求生效。
CPA 网关没有内核，只显示「仅 Magpie 网关可用」。

动作：
  settings                   各项设置与当前值（默认；--json 输出结构化结果）
  set <key> <value>          改一项（需要确认；脚本里加 --yes）

key 与 value：
  redact | redactPersonal    on | off
  redactWords                逗号分隔的词；'' 清空
  redactRules                JSON 数组，如 '[{"kind":"GW","prefix":"oc_sk_"}]'；'[]' 清空
  vision | imageGen          auto | off | <provider/model>（候选见 settings --json 的 models）
`

const onOff = value => (value ? '开' : '关')

/** 一项设置的当前值，按 Magpie 的写法：自动 · <它选的>、关闭、或模型名。 */
export function describe(view, key) {
  const values = view.values || {}
  if (key === 'redact' || key === 'redactPersonal') return onOff(values[key])
  if (key === 'redactWords') return values.redactWords?.length ? values.redactWords.join(', ') : '（无）'
  if (key === 'redactRules') {
    return values.redactRules?.length ? values.redactRules.map(rule => `${rule.kind} ${rule.prefix ? `前缀 ${rule.prefix}` : `正则 ${rule.regex}`}`).join('；') : '（无）'
  }
  if (key === 'noStats') return '已关闭（控制台强制）'
  const choice = view.models?.[key]
  const value = values[key] || ''
  const label = id => {
    const option = choice?.options?.find(entry => entry.id === id)
    return option ? `${option.label}${option.provider ? ` · ${option.provider}` : ''}` : id
  }
  if (value === 'off') return '关闭'
  if (!value) return `自动 · ${choice?.auto ? label(choice.auto) : '没有可用模型'}`
  return `${label(value)}${choice?.stale ? '（已不在网关里，正在用自动选择）' : ''}`
}

/** 命令行的值 → PUT 的值；格式不对直接报用法错误，不发请求。 */
export function parseValue(key, raw) {
  if (!KEYS.includes(key)) throw new UsageError(`未知设置：${key}`, `可改：${KEYS.join('、')}`)
  const text = String(raw ?? '')
  if (key === 'redact' || key === 'redactPersonal') {
    if (!['on', 'off', 'true', 'false'].includes(text)) throw new UsageError(`${key} 的值是 on 或 off`)
    return text === 'on' || text === 'true'
  }
  if (key === 'redactWords') return text.split(/[,，\n]/).map(word => word.trim()).filter(Boolean)
  if (key === 'redactRules') {
    let rules
    try { rules = JSON.parse(text) } catch { throw new UsageError('redactRules 的值是 JSON 数组', '如 \'[{"kind":"GW","prefix":"oc_sk_"}]\'') }
    if (!Array.isArray(rules)) throw new UsageError('redactRules 的值是 JSON 数组')
    return rules
  }
  return text === 'auto' ? '' : text
}

export default {
  name: 'gateway',
  aliases: [],
  summary: '网关功能（脱敏 / 识图 / 生图）',
  help: HELP,
  options: {},
  async run(ctx) {
    const [action = 'settings', ...rest] = ctx.positionals
    if (action === 'settings') {
      if (rest.length) throw new UsageError(`多余的参数：${rest.join(' ')}`)
      const view = await ctx.get('/api/gateway/settings')
      const data = {
        available: Boolean(view.available), reason: view.reason ?? null, message: view.message ?? null, revision: view.revision ?? null,
        values: view.values ?? null, telemetry: view.telemetry ?? null,
        models: view.models ? Object.fromEntries(Object.entries(view.models).map(([key, choice]) => [key, {
          auto: choice.auto, effective: choice.effective, stale: Boolean(choice.stale), options: (choice.options || []).map(option => option.id),
          ...(key === 'imageGen' ? { admitted: Boolean(choice.admitted) } : {}),
        }])) : null,
        upstream: view.upstream ?? null,
      }
      return void ctx.output(data, () => {
        const { ui } = ctx
        ui.kv('来源', `Magpie ${String(view.revision || '').slice(0, 7) || '-'}`)
        if (!view.available) return ui.warn(view.message || '仅 Magpie 网关可用')
        for (const group of view.catalog?.groups || []) {
          ui.section(group.title.zh)
          for (const item of (view.catalog.items || []).filter(entry => entry.group === group.id)) ui.kv(item.name.zh, describe(view, item.key))
        }
        if (view.models && !view.models.imageGen.admitted) ui.note('生图模型：控制台网关暂未开放 /v1/images，暂不影响控制台客户端')
        const pending = (view.upstream?.added?.length || 0) + (view.upstream?.changed?.length || 0) + (view.upstream?.removed?.length || 0)
        if (pending) ui.note(`上游有 ${pending} 项设置变化待评审（cradmin magpie status）`)
      })
    }
    if (action === 'set') {
      if (rest.length !== 2) throw new UsageError('用法：cradmin gateway set <key> <value>')
      const [key, raw] = rest
      const value = parseValue(key, raw)
      const view = await ctx.get('/api/gateway/settings')
      if (!view.available) throw new CliError(view.message || '仅 Magpie 网关可用', 1)
      const item = (view.catalog?.items || []).find(entry => entry.key === key)
      const next = { ...view, values: { ...view.values, [key]: value } }
      const same = JSON.stringify(view.values?.[key]) === JSON.stringify(value)
      const result = await runPlan(ctx, {
        level: 'C', title: '网关功能',
        items: same ? [] : [{
          area: '网关功能', label: item?.name?.zh || key, from: describe(view, key), to: describe(next, key),
          method: 'PUT', path: '/api/gateway/settings', body: { [key]: value }, taskLabel: '网关设置',
        }],
        danger: '改动从下一个请求生效，影响所有经过 Magpie 网关的请求', empty: `${item?.name?.zh || key} 已是这个值`,
      })
      if (result.dryRun || !result.results.length) return void ctx.output(result)
      const updated = result.results[0].result
      return void ctx.output({ ok: true, key, value: updated?.values?.[key] ?? value }, () => ctx.ui.kv(item?.name?.zh || key, describe(updated || next, key)))
    }
    throw new UsageError(`未知动作：gateway ${action}`, '运行 cradmin gateway -h 查看用法')
  },
}

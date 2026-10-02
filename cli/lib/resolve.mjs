// 纯函数：对象解析（Key / 渠道 / 账号 / 分组）、glob、模型改动计划、与服务端 validatePolicy / validateQuota 对齐的本地校验。
import { UsageError } from './args.mjs'

export const isGlob = pattern => /[*?]/.test(pattern)

export function globToRegExp(pattern) {
  const body = String(pattern).split('').map(char => (char === '*' ? '.*' : char === '?' ? '.' : char.replace(/[\\^$.+()|[\]{}]/g, '\\$&'))).join('')
  return new RegExp(`^${body}$`)
}

/** 每个模式必须至少命中一个 id，否则用法错误（防手误后静默什么都不做）。 */
export function matchPatterns(patterns, ids, label = '模型') {
  const hit = new Set()
  for (const pattern of patterns) {
    const matched = isGlob(pattern) ? ids.filter(id => globToRegExp(pattern).test(id)) : ids.filter(id => id === pattern)
    if (!matched.length) throw new UsageError(`${label}「${pattern}」一个都没匹配上`)
    matched.forEach(id => hit.add(id))
  }
  return hit
}

/**
 * models: [{id, enabled}]；返回只含状态真正变化的 [{id, from, to}]。
 * --only 与 --enable/--disable 互斥；同一模型不能同时出现在 --enable 与 --disable。
 */
export function planModelChanges(models, { enable = [], disable = [], only = [] }) {
  if (only.length && (enable.length || disable.length)) throw new UsageError('--only 不能和 --enable / --disable 同时用')
  if (!only.length && !enable.length && !disable.length) return null
  const ids = models.map(model => model.id)
  const target = new Map(models.map(model => [model.id, model.enabled]))
  if (only.length) {
    const keep = matchPatterns(only, ids)
    for (const id of ids) target.set(id, keep.has(id))
  } else {
    const on = matchPatterns(enable, ids)
    const off = matchPatterns(disable, ids)
    const both = [...on].filter(id => off.has(id))
    if (both.length) throw new UsageError(`同一模型不能既启用又停用：${both.join('、')}`)
    on.forEach(id => target.set(id, true))
    off.forEach(id => target.set(id, false))
  }
  return models.filter(model => target.get(model.id) !== model.enabled).map(model => ({ id: model.id, from: model.enabled, to: target.get(model.id) }))
}

const candidates = (items, describe) => items.slice(0, 8).map(describe).join('、')

/** <key>：id 前缀（≥8 位十六进制）或唯一的显示名称。 */
export function resolveKey(keys, query) {
  const text = String(query || '').trim()
  if (!text) throw new UsageError('缺少 <key>：名称或 id 前缀（至少 8 位十六进制）')
  if (/^[0-9a-f]{8,64}$/i.test(text)) {
    const byId = keys.filter(key => key.id.startsWith(text.toLowerCase()))
    if (byId.length === 1) return byId[0]
    if (byId.length > 1) throw new UsageError(`id 前缀 ${text} 对应多把 Key：${candidates(byId, key => `${key.name}(${key.id.slice(0, 12)})`)}`)
  }
  const byName = keys.filter(key => key.name === text)
  if (byName.length === 1) return byName[0]
  if (byName.length > 1) throw new UsageError(`有 ${byName.length} 把 Key 都叫「${text}」，请改用 id 前缀：${candidates(byName, key => key.id.slice(0, 12))}`)
  throw new UsageError(`找不到 Key：${text}`, '运行 cradmin keys ls 查看')
}

/** <渠道>：精确的兼容渠道名，或账号池 provider id（credentials[].type）。 */
export function resolveChannel(channelsPayload, name) {
  const text = String(name || '').trim()
  if (!text) throw new UsageError('缺少 <渠道>')
  const channel = (channelsPayload.channels || []).find(item => item.name === text)
  if (channel) return { kind: 'compat', name: text, channel }
  const credentials = (channelsPayload.credentials || []).filter(item => item.type === text)
  if (credentials.length) return { kind: 'oauth', name: text, credentials }
  const names = [...(channelsPayload.channels || []).map(item => item.name), ...new Set((channelsPayload.credentials || []).map(item => item.type))]
  throw new UsageError(`找不到渠道：${text}`, names.length ? `可用：${names.join('、')}` : '')
}

/** <账号>：精确的凭据名，或在 name/label 中唯一的子串。 */
export function resolveAccount(credentials, query) {
  const text = String(query || '').trim()
  if (!text) throw new UsageError('缺少 <账号>')
  const exact = credentials.find(item => item.name === text)
  if (exact) return exact
  const lower = text.toLowerCase()
  const hits = credentials.filter(item => String(item.name).toLowerCase().includes(lower) || String(item.label || '').toLowerCase().includes(lower))
  if (hits.length === 1) return hits[0]
  if (hits.length > 1) throw new UsageError(`「${text}」对应多个账号：${candidates(hits, item => item.name)}`)
  throw new UsageError(`找不到账号：${text}`, '运行 cradmin accounts ls 查看')
}

/** --groups：必须是 bootstrap.groups 里现有的 id（服务端会静默丢掉未知分组，生成一把什么都用不了的 Key）。 */
export function resolveGroups(requested, groups) {
  const known = groups.map(group => group.id)
  if (requested.length === 1 && requested[0] === 'all') return [...known]
  const unknown = requested.filter(id => !known.includes(id))
  if (unknown.length) throw new UsageError(`未知分组：${unknown.join('、')}`, `现有分组：${known.join('、') || '（无）'}`)
  return [...new Set(requested)]
}

export function parseGroupConcurrency(raw) {
  const out = {}
  for (const item of raw) {
    const match = /^([^=\s]+)=(\d+)$/.exec(item)
    if (!match) throw new UsageError(`--group-concurrency 格式是 分组=数字（收到 ${item}）`)
    out[match[1]] = Number(match[2])
  }
  return out
}

export const TOTAL_CONCURRENCY_RULE = '总并发必须是 0 到 500 的整数，0 表示不限速'

/** 与 server/policy.ts validatePolicy 同规则。 */
export function validatePolicy({ groups, totalConcurrency, groupConcurrency }) {
  if (!Number.isInteger(totalConcurrency) || totalConcurrency < 0 || totalConcurrency > 500) throw new UsageError(TOTAL_CONCURRENCY_RULE)
  if (!Array.isArray(groups) || !groups.length) throw new UsageError('至少选择一个渠道分组')
  if (totalConcurrency === 0) return
  for (const group of groups) {
    const limit = groupConcurrency[group]
    if (!Number.isInteger(limit) || limit < 1 || limit > totalConcurrency) {
      throw new UsageError(`${group} 分组并发必须在 1 到总并发之间`, `用 --group-concurrency ${group}=N 指定（1 ≤ N ≤ ${totalConcurrency}）`)
    }
  }
}

/** 与 server/quota.ts validateQuota 同规则。 */
export function validateQuota({ totalUsd, dailyUsd, weeklyUsd }) {
  for (const [label, value] of [['总额度', totalUsd], ['日额度', dailyUsd], ['周额度', weeklyUsd]]) {
    if (!Number.isFinite(value) || value < 0) throw new UsageError(`${label}必须是 0 或正数，0 表示不限额`)
    if (value > 1_000_000) throw new UsageError(`${label}不能超过 1000000`)
  }
  if (totalUsd > 0 && dailyUsd > totalUsd) throw new UsageError('日额度不能超过总额度')
  if (totalUsd > 0 && weeklyUsd > totalUsd) throw new UsageError('周额度不能超过总额度')
  if (weeklyUsd > 0 && dailyUsd > weeklyUsd) throw new UsageError('日额度不能超过周额度')
}

const PROXY_RULE = '代理地址必须是 http(s)://、socks5:// 或 socks5h:// 开头的 URL，或 direct / none / inherit'

/** 与 server/proxyPresets.ts normalizeProxyUrl 同规则（none = direct）。 */
export function validateProxy(raw) {
  const value = String(raw ?? '').trim()
  const lower = value.toLowerCase()
  if (lower === 'inherit' || value === '') return ''
  if (lower === 'direct' || lower === 'none') return 'direct'
  let url
  try { url = new URL(value) } catch { throw new UsageError(PROXY_RULE) }
  if (!['http:', 'https:', 'socks5:', 'socks5h:'].includes(url.protocol) || !url.hostname) throw new UsageError(PROXY_RULE)
  return value
}

/** URL 里的 userinfo（user:pass@）一律打码；只用于显示和导出，不用于发请求。 */
export const redactUrl = value => (typeof value === 'string' ? value.replace(/:\/\/\S*@/, '://***@') : value)
export const isRedactedUrl = value => typeof value === 'string' && value.includes('://***@')

export const onOff = value => (value ? 'on' : 'off')

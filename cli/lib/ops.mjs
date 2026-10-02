// 命令与 config apply 共用的读取和写计划项（同一批函数，保证校验与显式布尔值一致）。
import { CliError, UsageError } from './args.mjs'
import { HttpError, request } from './client.mjs'
import { onOff, redactUrl, validatePolicy, validateQuota } from './resolve.mjs'

const enc = encodeURIComponent

const memo = (ctx, key, load) => {
  ctx.cache ??= {}
  return (ctx.cache[key] ??= load())
}

export const getChannels = ctx => memo(ctx, 'channels', () => ctx.get('/api/channels'))
export const getModelIndex = ctx => memo(ctx, 'modelIndex', () => ctx.get('/api/model-index'))
export const getBootstrap = ctx => memo(ctx, 'bootstrap', () => ctx.get('/api/bootstrap'))
export const getRtk = ctx => memo(ctx, 'rtk', () => ctx.get('/api/rtk/global'))
export const getSync = ctx => memo(ctx, 'sync', () => ctx.get('/api/sync/status'))
export const getVersion = ctx => memo(ctx, 'version', () => ctx.get('/api/version'))

/** 账号池 provider 的模型：model-index 里 {channel: provider, kind: 'oauth'} 的来源（enabled=false 即被排除）。 */
export function providerModels(modelIndex, provider) {
  const out = []
  for (const model of modelIndex?.models || []) {
    const source = (model.sources || []).find(item => item.channel === provider && item.kind === 'oauth')
    if (source) out.push({ id: model.id, enabled: Boolean(source.enabled) })
  }
  return out.sort((a, b) => a.id.localeCompare(b.id))
}

export const compatModels = channel => (channel.models || []).map(model => ({ id: model.id, enabled: Boolean(model.enabled) }))
  .sort((a, b) => a.id.localeCompare(b.id))

export async function modelsOf(ctx, resolved) {
  if (resolved.kind === 'compat') return compatModels(resolved.channel)
  return providerModels(await getModelIndex(ctx), resolved.name)
}

/** 账号池 provider 列表：type → {accounts, active} */
export function providersOf(channelsPayload) {
  const map = new Map()
  for (const credential of channelsPayload.credentials || []) {
    const entry = map.get(credential.type) || { id: credential.type, accounts: 0, active: 0, paused: 0 }
    entry.accounts += 1
    if (credential.disabled) entry.paused += 1
    else if (!credential.status || credential.status === 'active') entry.active += 1
    map.set(credential.type, entry)
  }
  return [...map.values()].sort((a, b) => a.id.localeCompare(b.id))
}

export const channelState = channel => (channel.stale ? '失效' : channel.enabled ? '启用' : '停用')

/* ────────── 写计划项 ────────── */

export function channelToggleItem(name, from, to) {
  return {
    area: '渠道', label: name, from: from ? '启用' : '停用', to: to ? '启用' : '停用',
    method: 'PATCH', path: `/api/channels/${enc(name)}`, body: { enabled: to === true }, target: `渠道 ${name}`,
  }
}

export function modelToggleItems(ctx, resolved, changes) {
  return changes.map(change => {
    if (resolved.kind === 'compat') {
      return {
        area: '模型', label: `${resolved.name} / ${change.id}`, from: onOff(change.from), to: onOff(change.to),
        method: 'PATCH', path: `/api/channels/${enc(resolved.name)}/models/${enc(change.id)}`, body: { enabled: change.to === true },
        target: `${resolved.name} 的模型 ${change.id}`,
      }
    }
    const item = {
      area: '模型', label: `${resolved.name}（账号池） / ${change.id}`, from: onOff(change.from), to: onOff(change.to),
      method: 'PATCH', path: `/api/model-index/${enc(change.id)}/sources/${enc(resolved.name)}`, body: { kind: 'oauth', enabled: change.to === true },
    }
    item.run = async () => {
      try {
        return await request(ctx, item.method, item.path, { body: item.body })
      } catch (error) {
        // provider 在凭据列表里确实存在，服务端仍说渠道不存在 = 服务端缺陷 S1 未修
        if (error instanceof HttpError && error.status === 404 && error.reason === 'channel_not_found') {
          throw new CliError('服务端暂不支持账号池模型开关（缺陷 S1 未修，升级控制台后重试）', 1)
        }
        throw error
      }
    }
    return item
  })
}

export function credentialToggleItem(credential, to) {
  return {
    area: '账号', label: credential.name, from: credential.disabled ? '暂停' : '启用', to: to ? '启用' : '暂停',
    method: 'PATCH', path: `/api/credentials/${enc(credential.name)}`, body: { enabled: to === true }, target: `账号 ${credential.name}`,
  }
}

export const proxyLabel = value => (value === '' || value === undefined || value === null ? '继承全局' : value === 'direct' ? '直连' : redactUrl(value))

export function credentialProxyItem(ctx, credential, proxyUrl) {
  const item = {
    area: '代理', label: credential.name, from: proxyLabel(credential.proxyUrl), to: proxyLabel(proxyUrl),
    method: 'PATCH', path: `/api/credentials/${enc(credential.name)}/proxy`, body: { proxyUrl }, target: `账号 ${credential.name}`,
  }
  // 服务端回显完整 proxyUrl（可能带 user:pass@），结果里只留打码后的
  item.run = async () => {
    const result = await request(ctx, item.method, item.path, { body: item.body, target: item.target })
    return { ...result, proxyUrl: redactUrl(result?.proxyUrl) }
  }
  return item
}

/** ctx 给出时，200 但 ok:false（部分 agent 没改成）也按失败处理。 */
export function rtkItem(current, on, ctx = null) {
  const item = {
    area: 'RTK', label: '全局开关', from: current === null || current === undefined ? '未知' : onOff(current), to: onOff(on),
    method: 'POST', path: '/api/rtk/global', body: { on: on === true, confirm: true },
  }
  if (ctx) {
    item.run = async () => {
      const result = await request(ctx, item.method, item.path, { body: item.body, label: 'RTK' })
      if (result?.ok === false) {
        const failed = (result.results || []).filter(row => !row.ok).map(row => row.agent).join('、')
        throw new CliError(`部分 agent 没有改成功${failed ? `：${failed}` : ''}`, 1)
      }
      return result
    }
  }
  return item
}

/* ────────── Key ────────── */

export const keyQuota = key => ({ totalUsd: Number(key.quota?.totalUsd) || 0, dailyUsd: Number(key.quota?.dailyUsd) || 0, weeklyUsd: Number(key.quota?.weeklyUsd) || 0 })

const describeGroups = (groups, concurrency) => groups.map(group => (concurrency?.[group] ? `${group}=${concurrency[group]}` : group)).join(',') || '-'
const sameJson = (a, b) => JSON.stringify(a) === JSON.stringify(b)
const sortedObject = object => Object.fromEntries(Object.entries(object || {}).sort(([a], [b]) => a.localeCompare(b)))

/**
 * 把「想要的状态」与现有 Key 比较，生成只含变化字段的请求。desired 里缺省的字段 = 不改。
 * desired: {name?, note?, enabled?, groups?, totalConcurrency?, groupConcurrency?, quota?: {totalUsd?,dailyUsd?,weeklyUsd?}, resetWindows?: []}
 */
export function keyUpdateItems(key, desired) {
  const items = []
  const label = key.name
  const base = `/api/keys/${key.id}`
  const body = {}
  const from = []
  const to = []
  if (desired.name !== undefined && desired.name !== key.name) {
    if (!String(desired.name).trim()) throw new UsageError('名称不能为空')
    body.name = desired.name; from.push(`名称 ${key.name}`); to.push(`名称 ${desired.name}`)
  }
  if (desired.note !== undefined && desired.note !== (key.note || '')) {
    body.note = desired.note; from.push(`备注 ${key.note || '-'}`); to.push(`备注 ${desired.note || '-'}`)
  }
  const groups = desired.groups ?? key.groups
  const total = desired.totalConcurrency ?? key.totalConcurrency
  const concurrency = sortedObject(Object.fromEntries(Object.entries(desired.groupConcurrency ?? key.groupConcurrency ?? {}).filter(([group]) => groups.includes(group))))
  const currentConcurrency = sortedObject(Object.fromEntries(Object.entries(key.groupConcurrency || {}).filter(([group]) => key.groups.includes(group))))
  const policyChanged = !sameJson([...groups].sort(), [...key.groups].sort()) || total !== key.totalConcurrency
    || (total > 0 && !sameJson(concurrency, currentConcurrency))
  if (policyChanged) {
    validatePolicy({ groups, totalConcurrency: total, groupConcurrency: concurrency })
    Object.assign(body, { groups, totalConcurrency: total, groupConcurrency: concurrency })
    from.push(`分组 ${describeGroups(key.groups, key.totalConcurrency ? currentConcurrency : {})} · 并发 ${key.totalConcurrency || '不限'}`)
    to.push(`分组 ${describeGroups(groups, total ? concurrency : {})} · 并发 ${total || '不限'}`)
  }
  if (desired.enabled !== undefined) {
    // 额度封禁（enabled=false + blockedReason）会被对账自动恢复；要真正停用必须显式发 enabled:false 清掉封禁标记
    const blocked = !key.enabled && Boolean(key.blockedReason)
    const change = desired.enabled === true ? !key.enabled : key.enabled || blocked
    if (change) {
      body.enabled = desired.enabled === true
      from.push(key.enabled ? '启用' : blocked ? '额度封禁' : '停用'); to.push(desired.enabled ? '启用' : '停用')
    }
  }
  if (Object.keys(body).length) {
    items.push({ area: 'Key', label, from: from.join('，'), to: to.join('，'), method: 'PATCH', path: base, body, target: label })
  }
  if (desired.quota) {
    const current = keyQuota(key)
    const merged = { ...current, ...Object.fromEntries(Object.entries(desired.quota).filter(([, value]) => value !== undefined)) }
    const changed = Object.fromEntries(Object.entries(merged).filter(([field, value]) => value !== current[field]))
    if (Object.keys(changed).length) {
      validateQuota(merged)
      const show = quota => `总 ${quota.totalUsd || '不限'} / 日 ${quota.dailyUsd || '不限'} / 周 ${quota.weeklyUsd || '不限'}`
      items.push({ area: '额度', label, from: show(current), to: show(merged), method: 'PATCH', path: `${base}/quota`, body: changed, target: label })
    }
  }
  for (const window of desired.resetWindows || []) {
    const name = { total: '总', daily: '日', weekly: '周' }[window]
    items.push({ area: '额度', label: `${label} 已用${name}额度`, from: '保留', to: '清零', method: 'POST', path: `${base}/quota/reset`, body: { window }, target: label })
  }
  return items
}

/**
 * 新建 Key 的计划项：POST /api/keys，给了非零额度时再 PATCH quota，spec.enabled === false 时再停用（服务端只会建出启用的 Key）。
 * run 返回 {key, item}（key 是完整明文，只交给调用方打印一次）；后续步骤失败时 error.createdKey 带着它，调用方必须打印。
 */
export function keyCreateItem(ctx, spec) {
  const policy = { groups: spec.groups, totalConcurrency: spec.totalConcurrency ?? 0, groupConcurrency: spec.groupConcurrency || {} }
  validatePolicy(policy)
  const quota = { totalUsd: 0, dailyUsd: 0, weeklyUsd: 0, ...Object.fromEntries(Object.entries(spec.quota || {}).filter(([, value]) => value !== undefined)) }
  validateQuota(quota)
  const body = { name: spec.name, note: spec.note || '', groups: policy.groups, totalConcurrency: policy.totalConcurrency, groupConcurrency: policy.groupConcurrency }
  if (spec.slug) body.slug = spec.slug
  const hasQuota = quota.totalUsd || quota.dailyUsd || quota.weeklyUsd
  const disabled = spec.enabled === false
  return {
    area: 'Key', label: `新建 ${spec.name}`, from: '-', to: `分组 ${describeGroups(policy.groups, policy.totalConcurrency ? policy.groupConcurrency : {})}${hasQuota ? ` · 额度 总 ${quota.totalUsd || '不限'} / 日 ${quota.dailyUsd || '不限'} / 周 ${quota.weeklyUsd || '不限'}` : ''}${disabled ? ' · 停用' : ''}`,
    method: 'POST', path: '/api/keys', body,
    async run() {
      const created = await request(ctx, 'POST', '/api/keys', { body })
      let item = created.item
      try {
        if (hasQuota) item = await request(ctx, 'PATCH', `/api/keys/${created.item.id}/quota`, { body: quota })
        if (disabled) item = (await request(ctx, 'PATCH', `/api/keys/${created.item.id}`, { body: { enabled: false } })).item
      } catch (error) {
        error.createdKey = { key: created.key, item }
        throw error
      }
      return { key: created.key, item }
    },
  }
}

/** 本地日期 YYYY-MM-DD */
export function localDate(now = Date.now()) {
  const date = new Date(now)
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

/** 只给出账号的非秘密字段（/api/monitor 会带 access_token / refresh_token，绝不能原样输出）。 */
export function publicAccount(credential, monitorAccount) {
  const quota = monitorAccount?.normalizedQuota
  return {
    name: credential.name,
    provider: credential.type,
    label: credential.label || '',
    status: credential.status || '',
    paused: Boolean(credential.disabled),
    modelCount: Number(credential.modelCount ?? credential.models?.length ?? 0),
    proxyUrl: redactUrl(credential.proxyUrl || ''),
    ...(monitorAccount ? {
      authIndex: monitorAccount.auth_index ?? null,
      quota: quota ? {
        plan: quota.plan || '', tier: quota.tier || '', error: quota.error || null, unsupported: Boolean(quota.unsupported),
        resetCredits: quota.resetCredits ? { available: quota.resetCredits.available, applicable: quota.resetCredits.applicable } : null,
        windows: (quota.windows || []).map(window => ({ id: window.id, label: window.label, usedPercent: window.usedPercent, resetsAt: window.resetsAt })),
      } : null,
    } : {}),
  }
}

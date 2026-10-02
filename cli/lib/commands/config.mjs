// config：导出整套（非秘密）配置 / 一键应用配置文件。apply 只调和文件里出现的条目，从不删除。
import fs from 'node:fs'
import path from 'node:path'
import { UsageError } from '../args.mjs'
import {
  channelToggleItem, compatModels, credentialProxyItem, credentialToggleItem, getBootstrap, getChannels, getModelIndex, getRtk,
  keyCreateItem, keyQuota, keyUpdateItems, modelToggleItems, providerModels, providersOf, rtkItem,
} from '../ops.mjs'
import { runPlan } from '../plan.mjs'
import { isRedactedUrl, redactUrl, validateProxy } from '../resolve.mjs'
import { collectSettings } from './settings.mjs'

const HELP = `cradmin config <动作> [参数]

一键导出 / 应用中转站配置（渠道开关与启用的模型、账号池模型、账号启停与代理、Key 元数据、RTK）。
文件里没有任何秘密：没有 Key 明文、上游 Key、密码；代理地址里的 user:pass@ 打码成 ***@。

动作：
  export [--out <文件>]      导出到 stdout（--out 写文件，权限 0600）
  apply <文件>               对比文件与服务端，打印计划后按固定顺序应用
      --dry-run              只预览计划
      --yes                  跳过确认（脚本用）
      --create-keys          文件里有、服务端匹配不到的 Key 改为新建（完整 Key 在结尾统一打印一次）

规则：
  只调和文件里出现的段和条目，没出现的一律不动；从不删除任何东西。
  Key 有 id 前缀时按前缀匹配，匹配不到再按唯一名称匹配（跨控制台应用、重跑都不会重复新建）。
  要改成的名称已被另一把 Key 占用（例如轮换过）时，这一条跳过并警告。
  服务端不存在的渠道 / 模型 / 账号 / Key 跳过并警告（不算失败）。
  打码的代理地址与服务端一致时视为未改；不一致时跳过并警告（用 cradmin accounts proxy 设置）。
  执行顺序：启用渠道 → 渠道模型 → 账号池模型 → 账号启停与代理 → Key → 停用渠道 → RTK
  （同一文件里既改模型又停用的渠道：先改模型再停用）。
  重跑幂等：导出后立即应用应得到「没有需要改动的配置」。

示例：
  cradmin config export > crosery.json
  cradmin config apply crosery.json --dry-run
`

const manualEnabled = key => Boolean(key.enabled || key.blockedReason)

export function buildExport(state, { source, now = Date.now(), info = null } = {}) {
  const channels = {}
  for (const channel of state.channels.channels || []) {
    if (channel.stale) continue
    channels[channel.name] = { enabled: Boolean(channel.enabled), models: Object.fromEntries(compatModels(channel).map(model => [model.id, model.enabled])) }
  }
  const providers = {}
  for (const provider of providersOf(state.channels)) {
    providers[provider.id] = { models: Object.fromEntries(providerModels(state.modelIndex, provider.id).map(model => [model.id, model.enabled])) }
  }
  const accounts = {}
  for (const credential of state.channels.credentials || []) {
    accounts[credential.name] = { enabled: !credential.disabled, proxyUrl: redactUrl(credential.proxyUrl || '') }
  }
  const keys = (state.bootstrap.keys || []).map(key => ({
    id: key.id.slice(0, 12), name: key.name, note: key.note || '', enabled: manualEnabled(key), groups: [...(key.groups || [])],
    totalConcurrency: key.totalConcurrency || 0, groupConcurrency: { ...(key.groupConcurrency || {}) }, quota: keyQuota(key),
  }))
  return {
    cradmin: 1,
    exportedAt: new Date(now).toISOString(),
    source,
    channels,
    providers,
    accounts,
    keys,
    rtk: { on: state.rtk?.on ?? null },
    ...(info ? { info } : {}),
  }
}

const sameSet = (a = [], b = []) => JSON.stringify([...new Set(a)].sort()) === JSON.stringify([...new Set(b)].sort())

/** Key 条目的类型校验：类型不对时退出 2，绝不把 "true" 这类字符串推导成布尔值。 */
function checkKeyEntry(entry, label) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new UsageError(`Key ${label} 必须是对象`)
  const bad = field => new UsageError(`Key ${label} 的 ${field} 类型不对`)
  if (entry.id !== undefined && (typeof entry.id !== 'string' || !/^[0-9a-f]{8,64}$/i.test(entry.id))) throw new UsageError(`Key ${label} 的 id 必须是至少 8 位十六进制前缀`)
  for (const field of ['name', 'note']) if (entry[field] !== undefined && typeof entry[field] !== 'string') throw bad(field)
  if (entry.enabled !== undefined && typeof entry.enabled !== 'boolean') throw new UsageError(`Key ${label} 的 enabled 必须是 true/false`)
  if (entry.groups !== undefined && (!Array.isArray(entry.groups) || entry.groups.some(group => typeof group !== 'string'))) throw bad('groups')
  if (entry.totalConcurrency !== undefined && !Number.isInteger(entry.totalConcurrency)) throw bad('totalConcurrency')
  const isObject = value => value && typeof value === 'object' && !Array.isArray(value)
  if (entry.groupConcurrency !== undefined && (!isObject(entry.groupConcurrency) || Object.values(entry.groupConcurrency).some(value => !Number.isInteger(value)))) throw bad('groupConcurrency')
  if (entry.quota !== undefined) {
    if (!isObject(entry.quota)) throw bad('quota')
    for (const field of ['totalUsd', 'dailyUsd', 'weeklyUsd']) {
      if (entry.quota[field] !== undefined && (typeof entry.quota[field] !== 'number' || !Number.isFinite(entry.quota[field]))) throw bad(`quota.${field}`)
    }
  }
}

function modelChanges(current, wanted, owner, warnings) {
  const byId = new Map(current.map(model => [model.id, model.enabled]))
  const changes = []
  for (const [id, enabled] of Object.entries(wanted || {})) {
    if (typeof enabled !== 'boolean') throw new UsageError(`${owner} 的模型 ${id} 必须是 true/false`)
    if (!byId.has(id)) { warnings.push(`${owner}：服务端没有模型 ${id}，已跳过（新模型用 cradmin models sync 拉取）`); continue }
    if (byId.get(id) !== enabled) changes.push({ id, from: byId.get(id), to: enabled })
  }
  return changes
}

/**
 * 文件 → 计划项（顺序固定）。state = {channels, modelIndex, bootstrap, rtk}。纯函数：ctx 只被写入 run 闭包。
 */
/** 文件里某把 Key 的值不合法：报出是哪一条，提示改文件（共用校验的提示是命令行参数，这里不适用）。计划阶段抛出，还没有任何写请求。 */
function fileEntry(label, build) {
  try {
    return build()
  } catch (error) {
    if (!(error instanceof UsageError)) throw error
    throw new UsageError(`Key ${label}：${error.message}`, '改配置文件里这把 Key 的 totalConcurrency / groupConcurrency / quota 后重跑；还没有发出任何写请求')
  }
}

export function planApply(file, state, { ctx = {}, createKeys = false } = {}) {
  if (!file || typeof file !== 'object' || file.cradmin !== 1) throw new UsageError('不是 cradmin 导出的配置文件（缺少 "cradmin": 1）')
  const warnings = []
  const phase = { enable: [], models: [], providers: [], accounts: [], keys: [], disable: [], rtk: [] }
  const channelList = state.channels.channels || []

  for (const [name, entry] of Object.entries(file.channels || {})) {
    const channel = channelList.find(item => item.name === name)
    if (!channel) { warnings.push(`渠道 ${name} 在服务端不存在，已跳过（用 cradmin channels add 创建）`); continue }
    if (channel.stale) { warnings.push(`渠道 ${name} 已失效，已跳过`); continue }
    if (entry.enabled !== undefined) {
      if (typeof entry.enabled !== 'boolean') throw new UsageError(`渠道 ${name} 的 enabled 必须是 true/false`)
      if (entry.enabled !== Boolean(channel.enabled)) (entry.enabled ? phase.enable : phase.disable).push(channelToggleItem(name, Boolean(channel.enabled), entry.enabled))
    }
    if (entry.models) {
      // 模型阶段在「启用渠道」之后、「停用渠道」之前：此刻渠道可用 = 本来启用或本次要启用
      const usable = Boolean(channel.enabled) || entry.enabled === true
      const changes = modelChanges(compatModels(channel), entry.models, `渠道 ${name}`, warnings)
      if (changes.length && !usable) warnings.push(`渠道 ${name} 处于停用状态，模型开关已跳过`)
      else phase.models.push(...modelToggleItems(ctx, { kind: 'compat', name, channel }, changes))
    }
  }

  const providerIds = new Set((state.channels.credentials || []).map(credential => credential.type))
  for (const [provider, entry] of Object.entries(file.providers || {})) {
    if (!providerIds.has(provider)) { warnings.push(`账号池 ${provider} 没有账号，已跳过`); continue }
    const changes = modelChanges(providerModels(state.modelIndex, provider), entry?.models, `账号池 ${provider}`, warnings)
    phase.providers.push(...modelToggleItems(ctx, { kind: 'oauth', name: provider }, changes))
  }

  for (const [name, entry] of Object.entries(file.accounts || {})) {
    const credential = (state.channels.credentials || []).find(item => item.name === name)
    if (!credential) { warnings.push(`账号 ${name} 不存在，已跳过（用 cradmin accounts add 添加）`); continue }
    if (entry.enabled !== undefined) {
      if (typeof entry.enabled !== 'boolean') throw new UsageError(`账号 ${name} 的 enabled 必须是 true/false`)
      if (entry.enabled === Boolean(credential.disabled)) phase.accounts.push(credentialToggleItem(credential, entry.enabled))
    }
    if (entry.proxyUrl !== undefined) {
      if (typeof entry.proxyUrl !== 'string') throw new UsageError(`账号 ${name} 的 proxyUrl 必须是字符串`)
      const current = credential.proxyUrl || ''
      if (entry.proxyUrl === current || entry.proxyUrl === redactUrl(current)) { /* 未改（含打码后相同） */ }
      else if (isRedactedUrl(entry.proxyUrl)) warnings.push(`账号 ${name} 的代理地址凭据已打码，无法应用，已跳过（用 cradmin accounts proxy 设置）`)
      else {
        const proxyUrl = validateProxy(entry.proxyUrl)
        if (proxyUrl !== current) phase.accounts.push(credentialProxyItem(ctx, credential, proxyUrl))
      }
    }
  }

  const keys = state.bootstrap.keys || []
  const groupIds = new Set([...(state.bootstrap.groups || []).map(group => group.id), ...phase.enable.map(item => item.label)])
  const created = []
  for (const [index, entry] of (Array.isArray(file.keys) ? file.keys : []).entries()) {
    const label = entry?.name || entry?.id || `#${index + 1}`
    checkKeyEntry(entry, label)
    let key = null
    if (entry.id) {
      const hits = keys.filter(item => item.id.startsWith(entry.id.toLowerCase()))
      if (hits.length > 1) throw new UsageError(`Key ${label} 的 id 前缀对应多把 Key`)
      key = hits[0] || null
    }
    if (!key && entry.name) {
      const hits = keys.filter(item => item.name === entry.name)
      if (hits.length > 1) throw new UsageError(`有多把 Key 叫「${entry.name}」，请在文件里加 id 前缀`)
      key = hits[0] || null
      if (key && entry.id) warnings.push(`Key ${label} 的 id 在服务端找不到，按名称匹配到 ${key.id.slice(0, 12)}`)
    }
    const unknownGroups = (entry.groups || []).filter(group => !groupIds.has(group))
    const quota = entry.quota ? { totalUsd: entry.quota.totalUsd, dailyUsd: entry.quota.dailyUsd, weeklyUsd: entry.quota.weeklyUsd } : undefined
    if (key) {
      if (entry.name !== undefined && entry.name !== key.name && keys.some(other => other !== key && other.name === entry.name)) {
        warnings.push(`Key ${label}：名称「${entry.name}」已被另一把 Key 使用（可能轮换过），这一条已跳过`)
        continue
      }
      const desired = { name: entry.name, note: entry.note, groups: entry.groups, totalConcurrency: entry.totalConcurrency, groupConcurrency: entry.groupConcurrency, quota }
      if (unknownGroups.length) {
        const same = sameSet(entry.groups, key.groups)
        if (!same) warnings.push(`Key ${label} 引用了不存在的分组 ${unknownGroups.join('、')}，分组与并发改动已跳过`)
        delete desired.groups; delete desired.totalConcurrency; delete desired.groupConcurrency
      }
      if (entry.enabled !== undefined && entry.enabled !== manualEnabled(key)) desired.enabled = entry.enabled
      phase.keys.push(...fileEntry(label, () => keyUpdateItems(key, desired)))
      continue
    }
    if (unknownGroups.length) { warnings.push(`Key ${label} 引用了不存在的分组 ${unknownGroups.join('、')}，已跳过`); continue }
    if (!createKeys) { warnings.push(`Key ${label} 在服务端匹配不到，已跳过（加 --create-keys 改为新建）`); continue }
    if (!entry.name || !Array.isArray(entry.groups) || !entry.groups.length) { warnings.push(`Key ${label} 缺少 name 或 groups，不能新建，已跳过`); continue }
    const item = fileEntry(label, () => keyCreateItem(ctx, { name: entry.name, note: entry.note, groups: entry.groups, totalConcurrency: entry.totalConcurrency ?? 0, groupConcurrency: entry.groupConcurrency || {}, quota, enabled: entry.enabled }))
    const run = item.run
    item.run = async () => {
      let result
      try {
        result = await run()
      } catch (error) {
        // Key 已建出来但后续步骤失败：完整 Key 仍要在结尾打印，否则这把 Key 就找不回来了
        if (error?.createdKey) created.push({ name: entry.name, key: error.createdKey.key, id: error.createdKey.item.id, incomplete: true })
        throw error
      }
      created.push({ name: entry.name, key: result.key, id: result.item.id })
      return { id: result.item.id, name: result.item.name }
    }
    phase.keys.push(item)
  }

  if (file.rtk && typeof file.rtk.on === 'boolean' && file.rtk.on !== (state.rtk?.on ?? null)) {
    if (state.rtk && state.rtk.writable === false) warnings.push(`RTK 当前不可写（${state.rtk.reason || '未知原因'}），已跳过`)
    else phase.rtk.push(rtkItem(state.rtk?.on ?? null, file.rtk.on, ctx))
  }

  const items = [...phase.enable, ...phase.models, ...phase.providers, ...phase.accounts, ...phase.keys, ...phase.disable, ...phase.rtk]
  return { items, warnings, created }
}

async function loadState(ctx) {
  await ctx.session.cookie()
  const [channels, modelIndex, bootstrap, rtk] = await Promise.all([getChannels(ctx), getModelIndex(ctx), getBootstrap(ctx), getRtk(ctx).catch(() => null)])
  return { channels, modelIndex, bootstrap, rtk }
}

export default {
  name: 'config',
  aliases: [],
  summary: '导出整套配置 / 一键应用配置文件',
  help: HELP,
  options: { out: { type: 'string' }, 'create-keys': { type: 'boolean' } },
  async run(ctx) {
    const [action, file, ...extra] = ctx.positionals
    if (extra.length) throw new UsageError(`多余的参数：${extra.join(' ')}`)
    if (action === 'export') {
      if (file) throw new UsageError('export 不接位置参数；写文件用 --out')
      const state = await loadState(ctx)
      const settings = await collectSettings(ctx)
      const info = { retentionDays: settings.retentionDays, quotaTimeZone: settings.quotaTimeZone, gateway: settings.gateway?.baseUrl ?? null, globalProxy: redactUrl(settings.globalProxy), versions: settings.versions, sync: (await ctx.get('/api/sync/status')).jobs?.map(job => ({ id: job.id, state: job.state })) || [] }
      const data = buildExport(state, { source: ctx.target.base, now: ctx.now(), info })
      const text = `${JSON.stringify(data, null, 2)}\n`
      if (ctx.values.out) {
        const out = path.resolve(ctx.cwd, ctx.values.out)
        fs.writeFileSync(out, text, { mode: 0o600 })
        fs.chmodSync(out, 0o600)
        ctx.ui.success(`已导出到 ${out}（${Object.keys(data.channels).length} 个渠道 · ${data.keys.length} 把 Key · ${Object.keys(data.accounts).length} 个账号）`)
        return
      }
      ctx.io.stdout.write(text)
      return
    }
    if (action === 'apply') {
      if (!file) throw new UsageError('缺少 <文件>')
      let parsed
      try { parsed = JSON.parse(fs.readFileSync(path.resolve(ctx.cwd, file), 'utf8').replace(/^﻿/, '')) } catch (error) {
        throw new UsageError(error?.code === 'ENOENT' ? `找不到文件：${file}` : `文件不是合法 JSON：${file}`)
      }
      const state = await loadState(ctx)
      const plan = planApply(parsed, state, { ctx, createKeys: Boolean(ctx.values['create-keys']) })
      if (parsed.source && parsed.source !== ctx.target.base) ctx.ui.warnErr(`文件来自 ${parsed.source}，目标是 ${ctx.target.base}`)
      for (const warning of plan.warnings) ctx.ui.warnErr(warning)
      let result
      try {
        result = await runPlan(ctx, { level: 'C', title: '应用配置', items: plan.items, empty: '没有需要改动的配置' })
      } finally {
        if (plan.created.length && !ctx.json) {
          ctx.ui.noteErr('新建的 Key（唯一一次显示完整 Key，请现在保存）：')
          for (const entry of plan.created) ctx.ui.data(`${entry.name}  ${entry.key}`)
          if (plan.created.some(entry => entry.incomplete)) ctx.ui.warnErr('有 Key 已创建但额度或停用没有设置成功；重跑 apply 会补上')
        } else if (plan.created.length && !result) {
          ctx.ui.data(JSON.stringify({ createdKeys: plan.created }, null, 2))
        }
      }
      ctx.output({ ...result, warnings: plan.warnings, ...(plan.created.length ? { createdKeys: plan.created } : {}) })
      return
    }
    throw new UsageError(action ? `未知动作：config ${action}` : '缺少动作：export 或 apply', '运行 cradmin config -h 查看用法')
  },
}

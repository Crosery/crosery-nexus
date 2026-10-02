// proxy：代理池（出口列表、导入、连通性检测、分配给账号、从现有账号迁移、导出）。所有输出都是服务端脱敏后的数据。
import fs from 'node:fs'
import path from 'node:path'
import { CancelError, CliError, UsageError, listValue } from '../args.mjs'
import { runPlan } from '../plan.mjs'
import { time } from '../ui.mjs'

const HELP = `cradmin proxy <动作> [参数]

代理池：账号可用的出口（http/https/socks5 地址，或由控制台托管的 mihomo 把 ss/vmess/trojan/vless/hysteria2/tuic…
节点开成本机 socks5 端口），以及它们访问 Claude / OpenAI / Google 的连通性。账号的代理设置仍以账号自身为准。

动作：
  ls [--tag <标签>]                  出口、出口 IP/国家、三家服务连通性、在用账号数、内核状态（默认）
  import <文件|订阅链接|->           解析 Clash 配置、订阅链接、分享链接、Base64 订阅或代理池导出文件，预览后导入
      --tags a,b                     给导入的出口打标签
  test <出口…>                       立即检测（每个出口 8 个请求；1 分钟内重复检测直接返回上次结果）
  test --in-use                      后台检测所有在用出口（同 --all；10 分钟冷却）
  assign <账号…> <出口|inherit|direct>   把账号改走这个出口（最后一个参数是目标；会记下原出口）
  unassign <账号…> [--restore]       改回继承全局；--restore 还原分配前记下的出口
  default <出口|inherit|direct>      CPA 全局代理（继承全局的账号都会跟着改）
  rm <出口> [--reassign <出口|inherit|direct|keep>]   删除；还有账号在用时必须先指定把它们换到哪里
  migrate [--dry-run]                扫描账号里已配置的代理出口，导入代理池（只读账号，不改账号设置）
  export [--out <文件>]              脱敏导出（密码换成 ***），不给 --out 打印到 stdout
  export --with-secrets [--out <文件>] [--force]   含密码的迁移文件，写成 0600，只打印路径和数量
  kernel [status|start|stop|restart] 托管 mihomo 内核
  subscriptions [ls] | refresh <订阅> | rm <订阅> [--keep-nodes]   订阅（别名 subs）

<出口> 是 id（px_…）或名称/地址里唯一的子串；<账号> 是凭据名，或名称/邮箱里唯一的子串。

示例：
  cradmin proxy import clash.yaml --tags 日本
  cradmin proxy assign claude-a.json claude-b.json px_k7q2m4x9ab
  cradmin proxy migrate --dry-run
  cradmin proxy export --with-secrets --out pool.json
`

const CHECK_WORD = {
  ok: '正常', 'auth-expected': '正常', 'region-blocked': '地区限制', challenge: '人机验证', blocked: '被拦截', 'service-error': '服务异常',
  'proxy-auth-failed': '代理认证失败', 'proxy-down': '代理不可达', upstream: '节点不通', dns: '解析失败', tls: 'TLS 异常', timeout: '超时',
}
const SERVICES = [['claude', 'Claude'], ['openai', 'OpenAI'], ['google', 'Google']]
const KERNEL_WORD = { unavailable: '未安装', idle: '未启动', starting: '启动中', running: '运行中', degraded: '部分异常', failed: '出错', stopped: '已停止' }
const ACTION_WORD = { create: '新建', link: '关联', unchanged: '已在池中', skip: '跳过' }
const reachable = state => state === 'ok' || state === 'auth-expected'
const MAX_IMPORT_BYTES = 1024 * 1024

function cell(health, service) {
  const item = health?.services?.[service]
  if (!item?.state) return { text: '-', tone: 'muted' }
  if (reachable(item.state)) return { text: `✓${item.ms != null ? ` ${item.ms}ms` : ''}`, tone: 'ok' }
  return { text: `✗ ${CHECK_WORD[item.state] ?? item.state}`, tone: 'err' }
}

function exitText(health) {
  const exit = health?.exit
  if (!exit) return { text: '-', tone: 'muted' }
  if (exit.ip) return { text: `${exit.ip}${exit.country ? ` ${exit.country}` : ''}`, tone: null }
  if (exit.state && !reachable(exit.state)) return { text: `✗ ${CHECK_WORD[exit.state] ?? exit.state}`, tone: 'err' }
  return { text: '-', tone: 'muted' }
}

const lastAt = health => health?.lastAt || health?.exit?.at || null

function kernelText(kernel) {
  const word = KERNEL_WORD[kernel?.state] ?? String(kernel?.state || '未知')
  const version = kernel?.version ? ` v${String(kernel.version).replace(/^v/, '')}` : ''
  return `${word}${kernel?.state === 'running' || kernel?.state === 'degraded' ? version : ''}${kernel?.reason ? `（${kernel.reason}）` : ''}`
}

function healthLine(health) {
  if (!health) return '没有结果'
  const exit = exitText(health)
  return [`出口 ${exit.text}`, ...SERVICES.map(([key, label]) => `${label} ${cell(health, key).text}`)].join(' · ')
}

/** <出口>: id, exact name, or a unique substring of name / host. */
export function resolveEntry(entries, ref) {
  const raw = String(ref || '').trim()
  if (!raw) throw new UsageError('缺少 <出口>')
  const exact = entries.find(entry => entry.id === raw) || entries.filter(entry => entry.name === raw)
  if (exact && !Array.isArray(exact)) return exact
  if (exact.length === 1) return exact[0]
  const needle = raw.toLowerCase()
  const hits = entries.filter(entry => entry.name.toLowerCase().includes(needle) || String(entry.server).toLowerCase().includes(needle))
  if (hits.length === 1) return hits[0]
  if (!hits.length) throw new UsageError(`没有这个出口：${raw}`, '用 cradmin proxy ls 查看 id')
  throw new UsageError(`「${raw}」匹配到 ${hits.length} 个出口`, hits.slice(0, 6).map(entry => `${entry.id}  ${entry.name}`).join('\n  '))
}

/** <账号>: account ref (`cpa:…`), credential name (with or without .json), or a unique substring of name / label. */
export function resolveAccountRow(rows, ref) {
  const raw = String(ref || '').trim()
  if (!raw) throw new UsageError('缺少 <账号>')
  const usable = rows.filter(row => row.kind !== 'global')
  const exact = usable.find(row => row.ref === raw || row.ref === `cpa:${raw}` || row.name === raw || row.name === `${raw}.json`)
  if (exact) return exact
  const needle = raw.toLowerCase()
  const hits = usable.filter(row => row.name.toLowerCase().includes(needle) || String(row.label).toLowerCase().includes(needle))
  if (hits.length === 1) return hits[0]
  if (!hits.length) throw new UsageError(`没有这个账号：${raw}`, '用 cradmin accounts ls 查看凭据名')
  throw new UsageError(`「${raw}」匹配到 ${hits.length} 个账号`, hits.slice(0, 6).map(row => row.name).join('、'))
}

const accountExit = row => row.entryName || { inherit: '继承全局', direct: '直连', url: row.masked || '自定义地址', invalid: '地址无效' }[row.mode] || '未读取'

function targetOf(entries, raw) {
  const value = String(raw || '').trim()
  if (value === 'inherit' || value === '') return { id: 'inherit', name: '继承全局' }
  if (value === 'direct' || value === 'none') return { id: 'direct', name: '直连' }
  const entry = resolveEntry(entries, value)
  return { id: entry.id, name: entry.name, entry }
}

async function readSource(ctx, source) {
  if (!source) throw new UsageError('缺少 <文件|订阅链接|->')
  if (source === '-') {
    let text = ''
    for await (const chunk of ctx.io.stdin) {
      text += chunk
      if (text.length > MAX_IMPORT_BYTES) throw new UsageError('stdin 超过 1 MB', '订阅链接直接作为参数，由服务端拉取')
    }
    return text
  }
  const file = path.resolve(ctx.cwd, source)
  let stat = null
  try { stat = fs.statSync(file) } catch { /* not a file */ }
  if (stat?.isFile()) {
    if (stat.size > MAX_IMPORT_BYTES) throw new UsageError('文件超过 1 MB', '只保留 proxies / proxy-providers 段，或改用订阅链接')
    return fs.readFileSync(file, 'utf8')
  }
  // a subscription URL, a share link or a proxy address given inline
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(source)) return source
  throw new UsageError(`找不到文件：${source}`)
}

function printPreview(ctx, preview, rows) {
  const { ui } = ctx
  const counts = preview.counts || {}
  const words = [['new', '新'], ['update', '更新'], ['duplicate', '已存在'], ['unsupported', '不支持'], ['invalid', '无效'], ['info', '提示行']]
  ui.section('导入预览', `${{ export: '代理池导出文件', clash: 'Clash 配置', uri: '分享链接', base64: 'Base64 订阅内容', subscription: '订阅链接' }[preview.format] || preview.format}`)
  ui.kv('数量', words.filter(([key]) => counts[key]).map(([key, word]) => `${word} ${counts[key]}`).join(' · ') || '没有找到代理')
  for (const sub of preview.subscriptions || []) {
    ui.kv('订阅', `${sub.name}  ${sub.maskedUrl}  ${sub.ok ? `${sub.nodeCount} 个节点` : `拉取失败：${sub.error || ''}`}`)
  }
  if (!preview.kernelAvailable && preview.needsKernel) ui.warn(`其中 ${preview.needsKernel} 个需要 mihomo 内核：可先保存，暂不可用`)
  for (const note of preview.notes || []) ui.note(note)
  if (rows.length) {
    ui.table(['名称', '类型', '地址', '状态'], rows.slice(0, 30).map(row => [
      row.name || '-', row.protocol || row.type, row.server ? `${row.server}${row.serverPort ? `:${row.serverPort}` : ''}` : '-', row.status === 'update' ? '更新' : '新',
    ]))
    if (rows.length > 30) ui.note(`… 还有 ${rows.length - 30} 个`)
  }
  const skipped = (preview.rows || []).filter(row => ['unsupported', 'invalid'].includes(row.status))
  for (const row of skipped.slice(0, 8)) ui.note(`跳过 ${row.name || row.type}：${row.reason || row.status}`)
}

function writeSecretFile(file, text, force) {
  if (force) {
    const fd = fs.openSync(file, 'w', 0o600)
    try { fs.fchmodSync(fd, 0o600); fs.writeSync(fd, text) } finally { fs.closeSync(fd) }
    return
  }
  let fd
  try { fd = fs.openSync(file, 'wx', 0o600) } catch (error) {
    if (error?.code === 'EEXIST') throw new UsageError(`文件已存在：${file}`, '换一个 --out，或加 --force 覆盖')
    throw new CliError(`无法写入 ${file}：${error?.code || '错误'}`)
  }
  try { fs.writeSync(fd, text) } finally { fs.closeSync(fd) }
}

/** 单次分配请求：服务端按账号返回结果；有失败就停（runPlan 汇报已完成 / 失败 / 未执行）。 */
async function assignOne(ctx, pathname, body) {
  const result = await ctx.send('POST', pathname, body)
  if (result?.failed) {
    const reason = result.results?.find(item => item.status === 'failed')?.error || '失败'
    throw new CliError(reason)
  }
  return result
}

/**
 * An export file carries `assignments` (which account used which exit). After the import the server returns them as a
 * plan: accounts already on the entry are linked, the rest are pending and need an explicit assign — asked here
 * (or applied with --yes); accounts this console does not have are counted and skipped.
 */
async function restoreAssignments(ctx, plan) {
  const pending = plan.filter(item => item.status === 'pending')
  const linked = plan.length - pending.length
  if (!pending.length) {
    if (linked && !ctx.json) ctx.ui.note(`${linked} 个账号已经在用导入的出口`)
    return plan.length ? { linked, applied: 0, missing: 0, skipped: 0 } : null
  }
  const [accounts, data] = await Promise.all([ctx.get('/api/proxies/accounts'), ctx.get('/api/proxies')])
  const known = new Map((accounts.accounts || []).map(row => [row.ref, row]))
  const names = new Map((data.entries || []).map(entry => [entry.id, entry.name]))
  const doable = pending.filter(item => known.get(item.accountRef)?.assignable)
  const missing = pending.length - doable.length
  if (missing && !ctx.json) ctx.ui.note(`${missing} 个账号在这台控制台上不存在或只读，跳过`)
  if (!doable.length) return { linked, applied: 0, missing, skipped: 0 }
  if (!ctx.yes && !ctx.interactive) {
    if (!ctx.json) ctx.ui.warn(`文件里有 ${doable.length} 个账号的分配还没恢复：加 --yes 重跑导入，或用 cradmin proxy assign`)
    return { linked, applied: 0, missing, skipped: doable.length }
  }
  const result = await runPlan(ctx, {
    level: 'C', title: '按导出文件恢复账号的出口',
    items: doable.map((item) => {
      const row = known.get(item.accountRef)
      const body = { target: item.entryId, accounts: [item.accountRef], confirm: true }
      return { area: '账号', label: row.name, from: accountExit(row), to: names.get(item.entryId) || item.entryId, method: 'POST', path: '/api/proxies/assign', body, run: () => assignOne(ctx, '/api/proxies/assign', body) }
    }),
  })
  return { linked, applied: result.results.length, missing, skipped: 0 }
}

async function listView(ctx) {
  const data = await ctx.get('/api/proxies')
  const tag = ctx.values.tag
  const entries = (data.entries || []).filter(entry => !tag || (entry.tags || []).includes(tag))
  return { data, entries }
}

export default {
  name: 'proxy',
  aliases: ['proxies'],
  summary: '代理池与出口',
  help: HELP,
  options: {
    tag: { type: 'string' },
    tags: { type: 'string', multiple: true },
    'in-use': { type: 'boolean' },
    all: { type: 'boolean' },
    restore: { type: 'boolean' },
    reassign: { type: 'string' },
    'with-secrets': { type: 'boolean' },
    out: { type: 'string', short: 'o' },
    force: { type: 'boolean' },
    'keep-nodes': { type: 'boolean' },
  },
  async run(ctx) {
    const [action = 'ls', ...args] = ctx.positionals
    const { ui, values } = ctx

    if (action === 'ls' || action === 'list') {
      if (args.length) throw new UsageError(`多余的参数：${args.join(' ')}`)
      const { data, entries } = await listView(ctx)
      return void ctx.output({ ...data, entries }, () => {
        const ports = data.ports ? `${data.ports.base}–${data.ports.last}` : '-'
        ui.kv('内核', `${kernelText(data.kernel)}${data.summary?.mihomo ? ` · 本机端口 ${ports}` : ''}`)
        if (data.default && !['unsupported', 'unknown'].includes(data.default.mode)) {
          const named = data.default.entryId ? (data.entries || []).find(entry => entry.id === data.default.entryId)?.name : null
          ui.kv('默认出口', named || (data.default.mode === 'direct' ? '直连' : data.default.mode === 'inherit' ? '未设置' : data.default.masked || '-'))
        }
        if (!data.cpaSameHost) ui.note('CPA 不在本机：本机端口类出口不能分配给 CPA 账号')
        if (data.readOnly) ui.warn(`代理池只读：${data.readOnly}`)
        if (data.migration?.pending?.exits) ui.warn(`发现 ${data.migration.pending.accounts} 个账号的代理还没进代理池（${data.migration.pending.exits} 个出口）：cradmin proxy migrate --dry-run`)
        if (!entries.length) {
          ui.note(tag ? `没有带标签「${tag}」的出口` : '代理池还是空的：cradmin proxy import <文件|订阅链接> 或 cradmin proxy migrate')
          return
        }
        ui.table(['ID', '名称', '类型', '出口', 'Claude', 'OpenAI', 'Google', '在用', '检查于'], entries.map(entry => [
          entry.id,
          `${entry.name}${entry.enabled ? '' : ' [停用]'}${entry.validity === 'invalid' ? ' [无效]' : ''}${entry.external ? ' [外部本机]' : ''}${entry.stale ? ' [订阅中已移除]' : ''}`,
          `${entry.protocol}${entry.port ? ` :${entry.port}` : ''}`,
          exitText(entry.health),
          ...SERVICES.map(([key]) => cell(entry.health, key)),
          String(entry.usedBy?.total ?? 0),
          time(lastAt(entry.health)),
        ]), { align: ['left', 'left', 'left', 'left', 'left', 'left', 'left', 'right', 'left'] })
        ui.note(`${data.summary?.entries ?? entries.length} 个出口 · ${data.summary?.accountsLinked ?? 0} 个账号在用${data.summary?.subscriptions ? ` · ${data.summary.subscriptions} 个订阅` : ''}`)
      })
    }

    if (action === 'import') {
      if (args.length !== 1) throw new UsageError(args.length ? `多余的参数：${args.slice(1).join(' ')}` : '缺少 <文件|订阅链接|->')
      const text = await readSource(ctx, args[0])
      if (!text.trim()) throw new UsageError('内容是空的')
      // 解析不写入（订阅链接由服务端拉取一次）；--dry-run 下也照常解析
      const preview = await ctx.send('POST', '/api/proxies/parse', { text }, { allowInDryRun: true, label: '解析' })
      const failed = new Set((preview.subscriptions || []).filter(sub => !sub.ok).map(sub => sub.key))
      const rows = (preview.rows || []).filter(row => (row.status === 'new' || row.status === 'update') && (!row.subscriptionKey || !failed.has(row.subscriptionKey)))
      if (!ctx.json) printPreview(ctx, preview, rows)
      const tags = listValue(values.tags)
      const result = await runPlan(ctx, {
        level: 'A', title: '导入代理', empty: '没有可导入的新出口',
        // an export file whose exits are all here already still goes through import: that is what maps its assignments
        items: rows.length || preview.assignments ? [{ area: '代理', label: rows.length ? `导入 ${rows.length} 个出口${tags.length ? `（标签 ${tags.join('、')}）` : ''}` : `出口都已在代理池，核对文件里的 ${preview.assignments} 条账号分配`, method: 'POST', path: '/api/proxies/import', body: { previewId: preview.previewId, ...(tags.length ? { tags } : {}) } }] : [],
      })
      const imported = result.results?.[0]?.result
      if (imported && rows.length && !ctx.json) ui.note(`新增 ${imported.added} · 更新 ${imported.updated}${imported.subscriptions?.length ? ` · ${imported.subscriptions.length} 个订阅` : ''}`)
      if (ctx.dryRun && preview.assignments) ui.note(`文件里有 ${preview.assignments} 条账号分配：导入后列出需要确认的`)
      const restored = imported ? await restoreAssignments(ctx, imported.assignPlan || []) : null
      return void ctx.output({ ...result, preview: { counts: preview.counts, subscriptions: preview.subscriptions }, imported: imported ? { added: imported.added, updated: imported.updated, ids: imported.ids, subscriptions: imported.subscriptions } : null, assignments: restored })
    }

    if (action === 'test') {
      if (values['in-use'] || values.all) {
        if (args.length) throw new UsageError('--in-use 不接受出口参数')
        const result = await runPlan(ctx, {
          level: 'A', title: '检测在用出口',
          items: [{ area: '代理', label: '后台检测所有在用出口（代理巡检）', method: 'POST', path: '/api/proxies/test', body: {}, taskLabel: '检测在用' }],
        })
        return void ctx.output(result, () => { if (!result.dryRun) ui.note('结果写进代理池，稍后用 cradmin proxy ls 查看') })
      }
      if (!args.length) throw new UsageError('缺少 <出口>', '或用 --in-use 检测所有在用出口')
      const { data } = await listView(ctx)
      const entries = args.map(ref => resolveEntry(data.entries || [], ref))
      const outcomes = []
      const result = await runPlan(ctx, {
        level: 'A', title: '立即检测',
        items: entries.map(entry => ({
          area: '代理', label: entry.name, method: 'POST', path: `/api/proxies/${entry.id}/test`,
          run: async () => {
            const outcome = await ctx.send('POST', `/api/proxies/${entry.id}/test`, {}, { label: '检测', target: entry.name })
            outcomes.push({ id: entry.id, name: entry.name, ...outcome })
            return outcome
          },
        })),
      })
      return void ctx.output({ ...result, results: outcomes }, () => {
        for (const item of outcomes) {
          if (item.skipped) ui.note(`${item.name}：未检测（${item.skipped}）`)
          else ui.kv(item.name, `${healthLine(item.health)}${item.cached ? '（1 分钟内的结果）' : ''}`)
        }
      })
    }

    if (action === 'assign') {
      if (args.length < 2) throw new UsageError('用法：cradmin proxy assign <账号…> <出口|inherit|direct>')
      const [{ data }, accounts] = await Promise.all([listView(ctx), ctx.get('/api/proxies/accounts')])
      const target = targetOf(data.entries || [], args.at(-1))
      if (target.entry && !target.entry.assignable) throw new CliError(`这个出口不能分配：${target.entry.unassignableReason || '不可用'}`)
      const rows = [...new Map(args.slice(0, -1).map(ref => resolveAccountRow(accounts.accounts || [], ref)).map(row => [row.ref, row])).values()]
      for (const row of rows) if (!row.assignable) throw new UsageError(`账号 ${row.name} 的代理只能在网关里修改`)
      const todo = rows.filter(row => target.entry ? row.entryId !== target.entry.id : row.mode !== target.id)
      const result = await runPlan(ctx, {
        level: 'C', title: '分配出口', empty: '这些账号已经在用这个出口',
        items: todo.map(row => ({
          area: '账号', label: row.name, from: accountExit(row), to: target.name, method: 'POST', path: '/api/proxies/assign',
          body: { target: target.id, accounts: [row.ref], confirm: true },
          run: () => assignOne(ctx, '/api/proxies/assign', { target: target.id, accounts: [row.ref], confirm: true }),
        })),
      })
      const warnings = [...new Set(result.results.flatMap(item => item.result?.warnings || []))]
      return void ctx.output({ ...result, warnings }, () => {
        for (const warning of warnings) ui.warn(warning)
        if (result.results.length) ui.note('撤销：cradmin proxy unassign <账号…> --restore')
      })
    }

    if (action === 'unassign') {
      if (!args.length) throw new UsageError('缺少 <账号…>')
      const accounts = await ctx.get('/api/proxies/accounts')
      const rows = [...new Map(args.map(ref => resolveAccountRow(accounts.accounts || [], ref)).map(row => [row.ref, row])).values()]
      const restore = Boolean(values.restore)
      if (restore) for (const row of rows) if (!row.restorable) throw new UsageError(`账号 ${row.name} 没有可还原的原出口`, '不加 --restore 改回继承全局')
      const result = await runPlan(ctx, {
        level: 'C', title: restore ? '还原原出口' : '改回继承全局',
        items: rows.map(row => ({
          area: '账号', label: row.name, from: accountExit(row), to: restore ? '原出口' : '继承全局', method: 'POST', path: '/api/proxies/unassign',
          body: { accounts: [row.ref], restore, confirm: true },
          run: () => assignOne(ctx, '/api/proxies/unassign', { accounts: [row.ref], restore, confirm: true }),
        })),
      })
      return void ctx.output(result)
    }

    if (action === 'default') {
      if (args.length !== 1) throw new UsageError('用法：cradmin proxy default <出口|inherit|direct>')
      const { data } = await listView(ctx)
      if (data.default?.mode === 'unsupported') throw new CliError('Magpie 模式的默认出口还没有接入（改 CPA 全局代理只在 CPA 控制面可用）')
      const target = targetOf(data.entries || [], args[0])
      const current = data.default?.entryId ? (data.entries || []).find(entry => entry.id === data.default.entryId)?.name : { inherit: '未设置', direct: '直连' }[data.default?.mode] || data.default?.masked || '-'
      const result = await runPlan(ctx, {
        level: 'C', title: '默认出口（CPA 全局代理）', danger: '所有继承全局的账号都会跟着改',
        items: [{ area: '代理', label: 'CPA 全局', from: current, to: target.name, method: 'PUT', path: '/api/proxies/default', body: { target: target.id, confirm: true } }],
      })
      return void ctx.output(result, () => {
        const done = result.results[0]?.result
        if (done) ui.note(`${done.inheriting ?? 0} 个继承全局的账号改走这个出口`)
      })
    }

    if (action === 'rm' || action === 'remove') {
      if (args.length !== 1) throw new UsageError('用法：cradmin proxy rm <出口> [--reassign <出口|inherit|direct|keep>]')
      const { data } = await listView(ctx)
      const entry = resolveEntry(data.entries || [], args[0])
      let reassign = null
      if (values.reassign !== undefined) reassign = values.reassign === 'keep' ? { id: 'keep', name: '保持原样' } : targetOf((data.entries || []).filter(item => item.id !== entry.id), values.reassign)
      const inUse = entry.usedBy?.total ?? 0
      if (inUse && !reassign) throw new UsageError(`${entry.name} 还有 ${inUse} 个账号在用`, '加 --reassign <出口|inherit|direct> 先把它们换走')
      const query = new URLSearchParams()
      if (reassign) { query.set('reassign', reassign.id); query.set('confirm', '1') }
      const suffix = query.toString() ? `?${query}` : ''
      const result = await runPlan(ctx, {
        level: 'D', title: '删除出口', danger: inUse ? `${inUse} 个账号先改走「${reassign.name}」` : '',
        items: [{ area: '代理', label: entry.name, from: `在用 ${inUse}`, to: '删除', method: 'DELETE', path: `/api/proxies/${entry.id}${suffix}` }],
      })
      return void ctx.output(result)
    }

    if (action === 'migrate') {
      if (args.length) throw new UsageError(`多余的参数：${args.join(' ')}`)
      const scan = await ctx.send('POST', '/api/proxies/migrate', { dryRun: true }, { allowInDryRun: true, label: '扫描' })
      const exits = scan.exits || []
      const changes = exits.filter(exit => exit.action === 'create' || exit.action === 'link')
      if (!ctx.json) {
        const t = scan.totals || {}
        ui.section('账号里的代理出口', '只读取，不改账号设置')
        ui.kv('账号', `${t.accounts ?? 0} 个 · 出口 ${t.exits ?? 0} 个${t.inherit ? ` · 继承全局 ${t.inherit}` : ''}${t.direct ? ` · 直连 ${t.direct}` : ''}${t.invalid ? ` · 地址无效 ${t.invalid}` : ''}`)
        if (scan.sources?.readErrors) ui.warn(`${scan.sources.readErrors} 个凭据读取失败`)
        if (exits.length) {
          ui.table(['出口', '动作', '账号', '来源'], exits.map(exit => [
            exit.maskedUrl, { text: ACTION_WORD[exit.action] || exit.action, tone: exit.action === 'create' || exit.action === 'link' ? 'accent' : 'muted' },
            String(exit.accounts?.total ?? 0),
            [Object.entries(exit.accounts?.byProvider || {}).map(([provider, n]) => `${provider} ${n}`).join(' '), ...(exit.others || []), exit.reason || ''].filter(Boolean).join(' · ') || '-',
          ]), { align: ['left', 'left', 'right', 'left'] })
        }
      }
      if (ctx.dryRun) return void ctx.output({ dryRun: true, scan })
      const result = await runPlan(ctx, {
        level: 'A', title: '导入代理池', empty: '代理池已包含这些出口',
        items: changes.length ? [{ area: '代理', label: `新建 ${scan.totals.create} · 关联 ${scan.totals.link}（不改账号设置）`, method: 'POST', path: '/api/proxies/migrate', body: { dryRun: false, ...(scan.scanId ? { scanId: scan.scanId } : {}) } }] : [],
      })
      return void ctx.output({ ...result, scan }, () => {
        const done = result.results[0]?.result
        if (done?.summary) ui.note(done.summary)
      })
    }

    if (action === 'export') {
      if (args.length) throw new UsageError(`多余的参数：${args.join(' ')}`)
      if (!values['with-secrets']) {
        if (ctx.dryRun) return void ctx.output({ dryRun: true, plan: [{ call: 'GET /api/proxies/export', out: values.out || 'stdout' }] })
        const file = await ctx.get('/api/proxies/export')
        const text = `${JSON.stringify(file, null, 2)}\n`
        if (!values.out) return void ui.data(text.trimEnd())
        const out = path.resolve(ctx.cwd, values.out)
        writeSecretFile(out, text, Boolean(values.force))
        return void ctx.output({ path: out, entries: (file.entries || []).length, masked: true }, () => ui.success(`已导出（脱敏）：${out} · ${(file.entries || []).length} 个出口`))
      }
      const out = path.resolve(ctx.cwd, values.out || `crosery-proxy-pool-${new Date(ctx.now()).toISOString().slice(0, 10)}.secret.json`)
      if (!values.force && fs.existsSync(out)) throw new UsageError(`文件已存在：${out}`, '换一个 --out，或加 --force 覆盖')
      ui.section('导出含密码的代理池', '文件里有代理密码、节点密钥和订阅地址')
      ui.kv('文件', `${out}（0600）`)
      if (ctx.dryRun) return void ctx.output({ dryRun: true, plan: [{ call: 'POST /api/proxies/export', out }] })
      if (!ctx.yes) {
        if (!ctx.interactive) throw new UsageError('非交互环境执行此操作需要 --yes')
        if (ctx.target.remote) ui.warnErr(`目标是远程控制台 ${ctx.target.host}`)
        if (!(await ctx.prompter.confirm('导出含密码的文件？'))) throw new CancelError()
      }
      const file = await ctx.send('POST', '/api/proxies/export', { withSecrets: true, confirm: 'EXPORT-SECRETS' }, { label: '导出' })
      writeSecretFile(out, `${JSON.stringify(file, null, 2)}\n`, Boolean(values.force))
      const counts = { entries: (file.entries || []).length, subscriptions: (file.subscriptions || []).length, assignments: (file.assignments || []).length }
      return void ctx.output({ path: out, ...counts }, () => ui.success(`已写入 ${out} · ${counts.entries} 个出口 · ${counts.subscriptions} 个订阅 · ${counts.assignments} 条分配`))
    }

    if (action === 'kernel') {
      const [sub = 'status', ...extra] = args
      if (extra.length) throw new UsageError(`多余的参数：${extra.join(' ')}`)
      if (sub === 'status') {
        const data = await ctx.get('/api/proxies')
        return void ctx.output({ kernel: data.kernel, ports: data.ports }, () => {
          ui.kv('状态', kernelText(data.kernel))
          if (data.kernel?.pid) ui.kv('pid', String(data.kernel.pid))
          ui.kv('端口范围', data.ports ? `${data.ports.base}–${data.ports.last}` : '-')
          ui.kv('加密节点', `${data.summary?.mihomo ?? 0} 个`)
        })
      }
      if (!['start', 'stop', 'restart'].includes(sub)) throw new UsageError(`未知动作：proxy kernel ${sub}`, '可用：status、start、stop、restart')
      const word = { start: '启动', stop: '停止', restart: '重启' }[sub]
      const result = await runPlan(ctx, {
        level: sub === 'start' ? 'A' : 'C', title: `${word} mihomo 内核`, danger: sub === 'stop' ? '用本机端口的账号会连不上，直到再次启动' : '',
        items: [{ area: '内核', label: 'mihomo', to: word, method: 'POST', path: `/api/proxies/kernel/${sub}`, body: {} }],
      })
      return void ctx.output(result)
    }

    if (action === 'subscriptions' || action === 'subs') {
      const [sub = 'ls', ref, ...extra] = args
      if (extra.length) throw new UsageError(`多余的参数：${extra.join(' ')}`)
      const data = await ctx.get('/api/proxies')
      const subs = data.subscriptions || []
      if (sub === 'ls') {
        return void ctx.output({ subscriptions: subs }, () => {
          if (!subs.length) return void ui.note('没有订阅')
          ui.table(['ID', '名称', '地址', '节点', '间隔', '上次更新', '错误'], subs.map(item => [
            item.id, item.name, item.maskedUrl, String(item.nodeCount), `${item.intervalH}h`, time(item.lastFetchAt), item.error ? { text: item.error, tone: 'err' } : '-',
          ]))
        })
      }
      if (!ref) throw new UsageError('缺少 <订阅>')
      const hits = subs.filter(item => item.id === ref || item.name === ref || item.name.toLowerCase().includes(String(ref).toLowerCase()))
      const target = hits.find(item => item.id === ref || item.name === ref) || (hits.length === 1 ? hits[0] : null)
      if (!target) throw new UsageError(hits.length ? `「${ref}」匹配到 ${hits.length} 个订阅` : `没有这个订阅：${ref}`)
      if (sub === 'refresh') {
        const result = await runPlan(ctx, {
          level: 'A', title: '刷新订阅',
          items: [{ area: '订阅', label: target.name, method: 'POST', path: `/api/proxies/subscriptions/${target.id}/refresh`, body: {}, taskLabel: '刷新订阅' }],
        })
        return void ctx.output(result, () => {
          const done = result.results[0]?.result
          if (done) ui.note(`${done.nodeCount} 个节点 · 新增 ${done.added} · 更新 ${done.updated} · 移除 ${done.removed}${done.stale ? ` · 在用保留 ${done.stale}` : ''}`)
        })
      }
      if (sub === 'rm') {
        const keep = Boolean(values['keep-nodes'])
        const result = await runPlan(ctx, {
          level: 'D', title: '删除订阅', danger: keep ? '节点保留为手动出口' : '没在用的节点一并删除，在用的保留',
          items: [{ area: '订阅', label: target.name, from: `${target.nodeCount} 个节点`, to: '删除', method: 'DELETE', path: `/api/proxies/subscriptions/${target.id}${keep ? '?keepNodes=1' : ''}` }],
        })
        return void ctx.output(result)
      }
      throw new UsageError(`未知动作：proxy subscriptions ${sub}`, '可用：ls、refresh、rm')
    }

    throw new UsageError(`未知动作：proxy ${action}`, '运行 cradmin proxy -h 查看用法')
  },
}

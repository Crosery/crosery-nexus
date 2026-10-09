// 无参数 + 交互环境：编号菜单。每个动作最终拼出 argv，交给与命令行相同的 invoke() 执行（确认语义不变，菜单里永远走确认）。
import { CancelError, CliError } from './args.mjs'
import { request } from './client.mjs'
import { clock, createUi, pad } from './ui.mjs'

/** "1,3,5" / "1-4,9" → 去重后的 1 基编号；越界或格式错返回 null。 */
export function parseSelection(text, max) {
  const out = new Set()
  for (const part of String(text).split(/[,\s，]+/).filter(Boolean)) {
    const range = /^(\d+)-(\d+)$/.exec(part)
    if (range) {
      const [from, to] = [Number(range[1]), Number(range[2])]
      if (from < 1 || to > max || from > to) return null
      for (let n = from; n <= to; n += 1) out.add(n)
    } else if (/^\d+$/.test(part) && Number(part) >= 1 && Number(part) <= max) out.add(Number(part))
    else return null
  }
  return [...out]
}

/** 模型开关页输入：`+3 +5 -7` 或 `only 1-4,9`。返回 {enable:[], disable:[]} | {only:[]} | null。 */
export function parseToggleInput(text, max) {
  const trimmed = String(text).trim()
  if (!trimmed) return { back: true }
  const only = /^only\s+(.+)$/i.exec(trimmed)
  if (only) {
    const picked = parseSelection(only[1], max)
    return picked?.length ? { only: picked } : null
  }
  const enable = []
  const disable = []
  for (const token of trimmed.split(/\s+/)) {
    const match = /^([+-])(.+)$/.exec(token)
    if (!match) return null
    const picked = parseSelection(match[2], max)
    if (!picked) return null
    ;(match[1] === '+' ? enable : disable).push(...picked)
  }
  return enable.length || disable.length ? { enable, disable } : null
}

/** 任意编号输入处键入 q：退出整个菜单（规格 §7）。 */
class MenuQuit extends Error {}
const isQuit = text => String(text).trim().toLowerCase() === 'q'

const MAIN = [
  ['总览', 'status'], ['渠道与模型', 'channels'], ['API Key', 'keys'], ['账号池', 'accounts'], ['模型目录', 'models'],
  ['用量', 'usage'], ['同步任务', 'sync'], ['RTK', 'rtk'], ['设置', 'settings'],
  ['导出/应用配置', 'config'], ['诊断', 'doctor'],
]

export async function runMenu(rt, { invoke: run }) {
  const invoke = run
  // 菜单里每个写动作都要确认（runPlan 读 ctx.menu）
  rt.menu = true
  const ui = createUi({ stdout: rt.io.stdout, stderr: rt.io.stderr, env: rt.env, noColor: rt.globals['no-color'] })
  const ask = prompt => rt.prompter.ask(prompt)
  const get = pathname => request(rt, 'GET', pathname)

  const pause = async () => {
    try { await ask(`\n${ui.paintErr('muted', '按回车键返回主菜单...')}`) } catch (error) { if (!(error instanceof CancelError)) throw error }
  }
  const runArgv = async (argv, { pauseAfter = true } = {}) => {
    try {
      await invoke(rt, argv)
    } catch (error) {
      // 鉴权失败交给主循环退出：留在菜单里每个动作都会再撞一次登录限流
      if (error instanceof CliError && error.exitCode === 3) throw error
      if (error instanceof CancelError) ui.noteErr(error.message)
      else if (error instanceof CliError) {
        if (!error.reported) ui.fail(error.message)
        if (error.hint) ui.noteErr(error.hint)
      } else throw error
    }
    if (pauseAfter) await pause()
  }

  /** 编号列表单选/多选；空输入 = 返回上一级（返回 null），q = 退出菜单。 */
  const choose = async (title, items, describe, { multiple = false } = {}) => {
    if (!items.length) { ui.warn(`${title}：没有可选项`); await pause(); return null }
    ui.section(title)
    items.forEach((item, index) => ui.line(`  ${pad(String(index + 1), 3, 'right')}  ${describe(item)}`))
    for (;;) {
      const answer = String(await ask(multiple ? '请输入编号（可多选，如 1,3,5 或 1-4；回车返回，q 退出）：' : '请输入编号（回车返回，q 退出）：')).trim()
      if (!answer) return null
      if (isQuit(answer)) throw new MenuQuit()
      const picked = parseSelection(answer, items.length)
      if (picked?.length && (multiple || picked.length === 1)) return multiple ? picked.map(n => items[n - 1]) : items[picked[0] - 1]
      ui.warnErr('编号无效，请重新输入')
    }
  }
  const submenu = async (title, entries) => {
    const picked = await choose(title, entries, entry => entry[0])
    return picked ? picked[1] : null
  }

  const channelTargets = async () => {
    const payload = await get('/api/channels')
    const compat = (payload.channels || []).filter(channel => !channel.stale).map(channel => ({ name: channel.name, kind: 'compat', enabled: channel.enabled }))
    const providers = [...new Set((payload.credentials || []).map(credential => credential.type))].map(type => ({ name: type, kind: 'oauth', enabled: true }))
    return [...compat, ...providers]
  }

  const modelsPage = async target => {
    for (;;) {
      let models
      if (target.kind === 'compat') {
        const payload = await get('/api/channels')
        models = ((payload.channels || []).find(channel => channel.name === target.name)?.models || []).map(model => ({ id: model.id, enabled: Boolean(model.enabled) }))
      } else {
        const index = await get('/api/model-index')
        models = (index.models || []).flatMap(model => {
          const source = (model.sources || []).find(item => item.channel === target.name && item.kind === 'oauth')
          return source ? [{ id: model.id, enabled: Boolean(source.enabled) }] : []
        })
      }
      models.sort((a, b) => a.id.localeCompare(b.id))
      ui.section(`${target.name} 的模型`, `启用 ${models.filter(model => model.enabled).length} / 共 ${models.length}`)
      models.forEach((model, index) => ui.line(`  ${pad(String(index + 1), 3, 'right')}  ${model.enabled ? ui.paint('ok', 'on ') : ui.paint('muted', 'off')}  ${model.id}`))
      const input = await ask('输入 +3 +5 -7 开关，only 1-4,9 只启用这些，回车返回，q 退出：')
      if (isQuit(input)) throw new MenuQuit()
      const parsed = parseToggleInput(input, models.length)
      if (parsed?.back) return
      if (!parsed) { ui.warnErr('输入无效'); continue }
      const ids = list => list.map(n => models[n - 1].id).join(',')
      const argv = ['channels', 'models', target.name]
      if (parsed.only) argv.push('--only', ids(parsed.only))
      else {
        if (parsed.enable.length) argv.push('--enable', ids(parsed.enable))
        if (parsed.disable.length) argv.push('--disable', ids(parsed.disable))
      }
      await runArgv(argv, { pauseAfter: false })
    }
  }

  const keyChoice = async title => {
    const bootstrap = await get('/api/bootstrap')
    const key = await choose(title, bootstrap.keys || [], item => `${pad(item.name, 20)} ${item.maskedKey}  ${item.enabled ? '启用' : '停用'}`)
    return key ? key.id.slice(0, 16) : null
  }

  const actions = {
    status: () => runArgv(['status']),
    models: () => runArgv(['models', 'ls']),
    settings: () => runArgv(['settings']),
    doctor: () => runArgv(['doctor']),
    async channels() {
      const action = await submenu('渠道与模型', [['列出渠道', 'ls'], ['查看 / 开关某个渠道的模型', 'models'], ['启用渠道', 'enable'], ['停用渠道', 'disable']])
      if (!action) return
      if (action === 'ls') return runArgv(['channels', 'ls'])
      const targets = await channelTargets()
      if (action === 'models') {
        const target = await choose('选择渠道', targets, item => `${pad(item.name, 24)} ${item.kind === 'compat' ? '兼容渠道' : '账号池'}${item.enabled ? '' : '（停用）'}`)
        if (target) await modelsPage(target)
        return
      }
      const wanted = action === 'enable'
      const target = await choose(wanted ? '选择要启用的渠道' : '选择要停用的渠道', targets.filter(item => item.kind === 'compat' && item.enabled !== wanted), item => item.name)
      if (target) await runArgv(['channels', action, target.name])
    },
    async keys() {
      const action = await submenu('API Key', [['列出 Key', 'ls'], ['开通 Key', 'create'], ['启用 Key', 'enable'], ['停用 Key', 'disable'], ['轮换 Key', 'rotate'], ['删除 Key', 'delete'], ...(rt.platform === 'darwin' ? [['复制完整 Key 到剪贴板', 'copy']] : [])])
      if (!action) return
      if (action === 'ls') return runArgv(['keys', 'ls'])
      if (action === 'create') {
        const name = String(await ask('显示名称：')).trim()
        if (!name) return
        const bootstrap = await get('/api/bootstrap')
        const groups = await choose('选择分组', bootstrap.groups || [], group => `${pad(group.id, 20)} ${group.kind === 'oauth' ? '账号池' : '兼容渠道'} · ${(group.models || []).length} 个模型`, { multiple: true })
        if (!groups) return
        const argv = ['keys', 'create', '--name', name, '--groups', groups.map(group => group.id).join(',')]
        const concurrency = String(await ask('总并发（0 = 不限，回车 = 0）：')).trim()
        if (concurrency && concurrency !== '0') {
          argv.push('--concurrency', concurrency)
          for (const group of groups) {
            const limit = String(await ask(`${group.id} 分组并发（1-${concurrency}，回车 = ${concurrency}）：`)).trim() || concurrency
            argv.push('--group-concurrency', `${group.id}=${limit}`)
          }
        }
        const daily = String(await ask('日额度美元（回车 = 不限）：')).trim()
        if (daily) argv.push('--daily-usd', daily)
        return runArgv(argv)
      }
      const id = await keyChoice('选择 Key')
      if (id) await runArgv(['keys', action, id])
    },
    async accounts() {
      const action = await submenu('账号池', [['列出账号', 'ls'], ['列出账号与额度', 'quota'], ['暂停账号', 'pause'], ['恢复账号', 'resume'], ['OAuth 添加账号', 'add']])
      if (!action) return
      if (action === 'ls') return runArgv(['accounts', 'ls'])
      if (action === 'quota') return runArgv(['accounts', 'ls', '--quota'])
      if (action === 'add') {
        const provider = await choose('选择 provider', ['codex', 'claude', 'antigravity', 'kimi', 'xai', 'devin', 'meta', 'muse'], item => item)
        if (provider) await runArgv(['accounts', 'add', provider])
        return
      }
      const payload = await get('/api/channels')
      const picked = await choose('选择账号', (payload.credentials || []).filter(item => Boolean(item.disabled) === (action === 'resume')), item => `${pad(item.label || item.name, 36)} ${item.type}`, { multiple: true })
      if (picked) await runArgv(['accounts', action, ...picked.map(item => item.name)])
    },
    async usage() {
      const days = await choose('统计窗口', ['1', '7', '30', '90'], item => `最近 ${item} 天`)
      if (days) await runArgv(['usage', '--days', days])
    },
    async sync() {
      const action = await submenu('同步任务', [['列出任务', 'ls'], ['立即运行一个任务', 'run']])
      if (!action) return
      if (action === 'ls') return runArgv(['sync', 'ls'])
      const status = await get('/api/sync/status')
      const job = await choose('选择任务', (status.jobs || []).filter(item => item.kind !== 'external' && item.state !== 'disabled'), item => `${pad(item.id, 18)} ${item.label || ''}`)
      if (job) await runArgv(['sync', 'run', job.id, '--wait'])
    },
    async rtk() {
      const action = await submenu('RTK', [['查看状态', 'status'], ['打开', 'on'], ['关闭', 'off']])
      if (action) await runArgv(['rtk', action])
    },
    async config() {
      const action = await submenu('导出/应用配置', [['导出到文件', 'export'], ['预览应用文件', 'preview'], ['应用文件', 'apply']])
      if (!action) return
      const file = String(await ask(action === 'export' ? '导出到（回车 = crosery-config.json）：' : '配置文件路径（回车 = crosery-config.json）：')).trim() || 'crosery-config.json'
      if (action === 'export') return runArgv(['config', 'export', '--out', file])
      return runArgv(['config', 'apply', file, ...(action === 'preview' ? ['--dry-run'] : [])])
    },
  }

  const clear = () => { if (rt.io.stdout.isTTY) rt.io.stdout.write('\x1b[2J\x1b[H') }
  for (;;) {
    clear()
    ui.banner(`${ui.g.mark} cradmin  Crosery 中转站管理  ${rt.version}`, `${rt.target.base}（${rt.target.remote ? '远程' : '本地'}）`)
    const info = rt.session.info()
    ui.kv('账号', `${info.username}（${info.active ? `凭据：${info.tierLabel}${info.expiresAt ? ` · 会话到 ${clock(info.expiresAt)}` : ''}` : '尚未登录'}）`)
    if (rt.globals['dry-run']) ui.kv('模式', ui.paint('warn', '--dry-run：只预览，不发任何写请求'))
    ui.line()
    MAIN.forEach(([label, command], index) => ui.line(`  ${pad(String(index + 1), 3, 'right')}  ${pad(label, 16)}${ui.paint('muted', command)}`))
    ui.line(`  ${pad('0', 3, 'right')}  退出`)
    let answer
    try {
      answer = String(await ask('请输入编号：')).trim().toLowerCase()
    } catch (error) {
      if (error instanceof CancelError) return 0
      throw error
    }
    if (answer === '0' || answer === 'q') return 0
    const picked = parseSelection(answer, MAIN.length)
    if (!picked || picked.length !== 1) continue
    // 动作进行中按 Ctrl+C：入口的 SIGINT 处理调 rt.interrupt() 中止这个动作的请求，回到主菜单
    const controller = new AbortController()
    rt.signal = controller.signal
    rt.interrupt = () => {
      if (controller.signal.aborted) return false
      controller.abort()
      return true
    }
    try {
      await actions[MAIN[picked[0] - 1][1]]()
    } catch (error) {
      if (error instanceof MenuQuit) return 0
      if (error instanceof CancelError) continue
      if (error instanceof CliError) {
        if (!error.reported) ui.fail(error.message)
        if (error.hint) ui.noteErr(error.hint)
        if (error.exitCode === 3) return 3
        await pause()
        continue
      }
      throw error
    } finally {
      rt.signal = null
      rt.interrupt = null
    }
  }
}

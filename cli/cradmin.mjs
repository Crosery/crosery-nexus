#!/usr/bin/env node
// cradmin：Crosery 中转站（crosery-api-console）的管理员 CLI。只调控制台 HTTP API；不读写数据文件。
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { CancelError, CliError, UsageError, parseCommandArgs, splitCommand } from './lib/args.mjs'
import { request } from './lib/client.mjs'
import { createCredentialSource } from './lib/credentials.mjs'
import { loadProfiles, resolveTarget } from './lib/profile.mjs'
import { createPrompter } from './lib/prompt.mjs'
import { createSession, sessionCacheEnabled } from './lib/session.mjs'
import { createUi, pad } from './lib/ui.mjs'
import { COMMANDS, findCommand } from './lib/commands/index.mjs'

let activeRuntime = null
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

export function readVersion(fsImpl = fs) {
  const out = { version: '0.0.0', releaseId: '' }
  try { out.version = JSON.parse(fsImpl.readFileSync(path.join(REPO, 'package.json'), 'utf8')).version || out.version } catch { /* 缺省 */ }
  try { out.releaseId = JSON.parse(fsImpl.readFileSync(path.join(REPO, 'RELEASE.json'), 'utf8')).releaseId || '' } catch { /* 缺省 */ }
  return out
}

const EXAMPLES = [
  ["cradmin channels models <渠道> --only 'gpt-5*'", '只启用匹配的模型，其余关闭'],
  ['cradmin keys create --name <名称> --groups codex', '开一把 Key（完整 Key 只显示一次）'],
  ['cradmin config export > crosery.json', '导出当前配置'],
  ['cradmin config apply crosery.json --dry-run', '预览一键应用的改动'],
]

export function renderMainHelp(ui, version) {
  const lines = []
  lines.push(ui.paint(null, '用法', true))
  lines.push(`  cradmin <命令> [参数]           直接运行 cradmin 进入交互菜单`)
  lines.push('')
  for (const command of COMMANDS.filter(item => !item.hidden)) {
    lines.push(`  ${ui.paint('brand', pad(command.name, 9), true)} ${command.summary}`)
  }
  lines.push('')
  lines.push(ui.paint(null, '常用示例', true))
  for (const [example, note] of EXAMPLES) lines.push(`  ${ui.paint('accent', pad(example, 50))}  ${ui.paint('muted', note)}`)
  lines.push('')
  lines.push(ui.paint('muted', '每个命令都支持 -h。环境变量：CONSOLE_USERNAME、CONSOLE_PASSWORD、CONSOLE_PASSWORD_FILE、CRADMIN_BASE、CRADMIN_PROFILE、CRADMIN_GLYPHS=ascii。'))
  return { banner: [`${ui.g.mark} cradmin  Crosery 中转站管理  ${version}`, ''], text: lines.join('\n') }
}

function printMainHelp(ui, version) {
  const help = renderMainHelp(ui, version)
  ui.banner(help.banner[0])
  ui.line(`\n${help.text}`)
}

/** 进程级运行时：目标、凭据、会话、输入；菜单模式下所有动作共用。 */
export function createRuntime(io, globals) {
  const env = io.env
  const profiles = loadProfiles({ env, home: io.home })
  const target = resolveTarget(globals, env, profiles)
  const versionInfo = readVersion()
  const interactive = io.interactive ?? Boolean(io.stdin?.isTTY && io.stderr?.isTTY && !env.CI && !env.CRADMIN_NONINTERACTIVE)
  const prompter = io.prompter ?? createPrompter({ stdin: io.stdin, stderr: io.stderr })
  let credentials = null
  const rt = {
    env, io, target, profiles, interactive, prompter,
    platform: io.platform ?? process.platform,
    execute: io.execute ?? execFileSync,
    fetch: io.fetch ?? globalThis.fetch,
    cwd: io.cwd ?? process.cwd(),
    now: io.now ?? Date.now,
    version: versionInfo.version,
    releaseId: versionInfo.releaseId,
    userAgent: `cradmin/${versionInfo.version} (${process.platform}; ${process.arch})`,
    globals,
    /** 进程被 Ctrl+C 打断时要先做完的收尾（如取消进行中的 OAuth）；见入口的 SIGINT 处理。 */
    onExit: new Set(),
    async shutdown() {
      await Promise.allSettled([...rt.onExit].map(fn => fn()))
      await rt.session.close()
    },
    credentials() {
      if (!credentials) {
        credentials = createCredentialSource({
          env, values: globals, target, cwd: rt.cwd, platform: rt.platform, execute: rt.execute, fsImpl: io.fs ?? fs,
          interactive, promptSecret: prompt => prompter.secret(prompt),
        })
      }
      return credentials
    },
  }
  rt.cacheEnabled = sessionCacheEnabled({ platform: rt.platform, env, values: globals })
  rt.session = createSession(rt)
  return rt
}

/** 一次命令调用的上下文（菜单里每个动作一份，共用 runtime）。 */
function createContext(rt, values, positionals, command) {
  const ui = createUi({ stdout: rt.io.stdout, stderr: rt.io.stderr, env: rt.env, noColor: values['no-color'] || rt.globals['no-color'], json: Boolean(values.json) })
  const ctx = {
    ...rt,
    rt,
    command,
    values,
    positionals,
    ui,
    json: Boolean(values.json),
    yes: Boolean(values.yes),
    // 菜单模式下动作的 argv 不带全局 flag：`cradmin --dry-run` 进菜单时也必须只预览
    dryRun: Boolean(values['dry-run'] || rt.globals['dry-run']),
    get: (pathname, opts) => request(ctx, 'GET', pathname, opts),
    send: (method, pathname, body, opts = {}) => request(ctx, method, pathname, { ...opts, body }),
    output(data, render) {
      if (ctx.json) ui.data(JSON.stringify(data, null, 2))
      else render?.(data)
      return data
    },
    invoke: argv => invoke(rt, argv),
  }
  ctx.warn = msg => ui.warnErr(msg)
  rt.warn = ctx.warn
  return ctx
}

function parseFor(command, rest) {
  try {
    return parseCommandArgs(rest, command?.options || {})
  } catch (error) {
    if (command && error instanceof UsageError && !error.hint) error.hint = `运行 cradmin ${command.name} -h 查看用法`
    throw error
  }
}

/** 菜单与命令行共用的分发器：argv → 命令 → run。返回退出码；错误抛给调用方。 */
export async function invoke(rt, argv) {
  const { command: name, rest } = splitCommand(argv)
  const command = findCommand(name)
  if (!command) throw new UsageError(`未知命令：${name}`)
  const { values, positionals } = parseFor(command, rest)
  const ctx = createContext(rt, values, positionals, command)
  if (values.help) {
    ctx.ui.data(command.help.trimEnd())
    return 0
  }
  const code = await command.run(ctx)
  return typeof code === 'number' ? code : 0
}

function reportError(io, env, error, json) {
  const ui = createUi({ stdout: io.stdout, stderr: io.stderr, env, json })
  if (error instanceof CancelError) {
    ui.noteErr(error.message)
    return 130
  }
  if (error instanceof CliError) {
    if (!error.reported) ui.fail(error.message)
    if (error.hint) ui.noteErr(error.hint)
    return error.exitCode
  }
  // 非预期异常：只打类型与消息，不打 stack（可能带出上下文）
  ui.fail(`内部错误：${error?.name || 'Error'}：${error?.message || ''}`)
  return 1
}

/**
 * 入口。io 全部可注入：{env, stdin, stdout, stderr, cwd, platform, execute, fetch, interactive, home}
 * 返回退出码（不调用 process.exit）。
 */
export async function main(argv, ioInput = {}) {
  const io = {
    env: process.env, stdin: process.stdin, stdout: process.stdout, stderr: process.stderr, home: os.homedir(),
    ...ioInput,
  }
  const env = io.env
  let rt = null
  let json = false
  try {
    const { command: name, rest } = splitCommand(argv)
    const preview = parseFor(findCommand(name), rest)
    json = Boolean(preview.values.json)
    if (!name) {
      const { values } = parseCommandArgs(argv, {})
      const ui = createUi({ stdout: io.stdout, stderr: io.stderr, env, noColor: values['no-color'] })
      const { version } = readVersion()
      if (values.version) return await main(['version', ...argv.filter(item => item !== '-v' && item !== '--version')], ioInput)
      const interactive = io.interactive ?? Boolean(io.stdin?.isTTY && io.stderr?.isTTY && !env.CI && !env.CRADMIN_NONINTERACTIVE)
      if (values.help || !interactive) {
        printMainHelp(ui, version)
        return 0
      }
      rt = activeRuntime = createRuntime(io, values)
      const { runMenu } = await import('./lib/menu.mjs')
      return await runMenu(rt, { invoke })
    }
    if (!findCommand(name)) {
      const ui = createUi({ stdout: io.stdout, stderr: io.stderr, env })
      ui.fail(`未知命令：${name}`)
      io.stderr.write(`\n${renderMainHelp(ui, readVersion().version).text}\n`)
      return 2
    }
    if (preview.values.help) {
      io.stdout.write(`${findCommand(name).help.trimEnd()}\n`)
      return 0
    }
    rt = activeRuntime = createRuntime(io, preview.values)
    return await invoke(rt, argv)
  } catch (error) {
    return reportError(io, env, error, json)
  } finally {
    if (rt) {
      await rt.session.close().catch(() => {})
      rt.prompter.close()
      if (activeRuntime === rt) activeRuntime = null
    }
  }
}

const invokedDirectly = (() => {
  try { return fs.realpathSync(process.argv[1] || '') === fileURLToPath(import.meta.url) } catch { return false }
})()

if (invokedDirectly) {
  // `cradmin … | head`：读端提前关闭时丢弃剩余输出、照常收尾（注销会话等），不抛 EPIPE 栈
  process.stdout.on('error', error => {
    if (error?.code !== 'EPIPE' && error?.code !== 'ERR_STREAM_DESTROYED') throw error
  })
  let runtimeClosing = false
  process.on('SIGINT', () => {
    // 菜单里动作进行中：只中止这个动作、回到菜单（同一动作里第二次 Ctrl+C 才退出）
    if (!runtimeClosing && activeRuntime?.interrupt?.()) return
    if (runtimeClosing) process.exit(130)
    runtimeClosing = true
    if (process.stdin.isTTY && process.stdin.isRaw) process.stdin.setRawMode(false)
    process.stderr.write('\n')
    setTimeout(() => process.exit(130), 4500).unref()
    Promise.resolve(activeRuntime?.shutdown()).catch(() => {}).finally(() => process.exit(130))
  })
  process.exitCode = await main(process.argv.slice(2))
}

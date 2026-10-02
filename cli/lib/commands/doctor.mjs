// doctor：环境与连通性诊断。全程只读（登录会写一条 login 审计，除此之外没有写操作）。
import fs from 'node:fs'
import os from 'node:os'
import { CliError } from '../args.mjs'
import { rawRequest } from '../client.mjs'
import { keychainEntryExists, loadDotenv } from '../credentials.mjs'
import { configPath } from '../profile.mjs'
import { clock, pad } from '../ui.mjs'
import { probeAdmin } from './auth.mjs'

const HELP = `cradmin doctor [--json]

环境与连通性诊断：Node 版本、终端字形、配置文件、各凭据档位状态（只给结论，不读出值）；
然后依次检查控制台可达、登录、管理员角色、渠道、Key、同步任务。有 ✗ 时退出 1。
`

const nodeOk = version => {
  const major = Number(String(version).replace(/^v/, '').split('.')[0])
  return major === 24
}

export default {
  name: 'doctor',
  aliases: ['check'],
  summary: '环境与连通性诊断',
  help: HELP,
  options: {},
  async run(ctx) {
    const { ui, env, target } = ctx
    const creds = ctx.credentials()
    const dotenv = (() => {
      try { return loadDotenv({ envFile: ctx.values['env-file'] || ctx.globals['env-file'], cwd: ctx.cwd, target }) } catch { return null }
    })()
    const keychainState = creds.keychainOff ? '已关闭（CRADMIN_KEYCHAIN=off）'
      : ctx.platform !== 'darwin' ? '非 macOS，不可用'
        : !target.keychainService ? '不使用（目标不是 profile 地址或 profile 没配 service；需要时用 --keychain-service 指定）'
          : keychainEntryExists(target.keychainService, creds.username, { platform: ctx.platform, execute: ctx.execute }) ? '条目存在' : '没有条目'
    const cachedUntil = ctx.cacheEnabled ? ctx.session.cachedExpiry() : null
    const configFile = configPath(env, ctx.io.home || os.homedir())
    const environment = {
      node: { version: process.version, ok: nodeOk(process.version), required: '>=24 <25' },
      system: `${process.platform}/${process.arch}`,
      terminal: env.TERM_PROGRAM || env.TERM || '-',
      glyphs: ui.glyphMode,
      configFile: { path: configFile, exists: fs.existsSync(configFile) },
      profile: target.profile,
      base: target.base,
      remote: target.remote,
      username: creds.username,
      credentials: {
        CONSOLE_PASSWORD: env.CONSOLE_PASSWORD ? '已设置' : '未设置',
        CONSOLE_PASSWORD_FILE: env.CONSOLE_PASSWORD_FILE ? '已设置' : '未设置',
        dotenv: dotenv ? (dotenv.applies ? `已找到（${dotenv.file}）` : `已找到但端口不匹配（.env 端口 ${dotenv.port}，已跳过）`) : '未找到',
        keychain: creds.keychainOff || ctx.platform !== 'darwin' || !target.keychainService ? keychainState : `${keychainState}（service ${target.keychainService}）`,
        sessionCache: !ctx.cacheEnabled ? '关闭' : cachedUntil ? `有效，到 ${clock(cachedUntil)}` : '没有',
      },
    }
    const checks = []
    const check = async (name, fn) => {
      const started = Date.now()
      try {
        const detail = await fn()
        checks.push({ name, ok: true, detail, ms: Date.now() - started })
      } catch (error) {
        checks.push({ name, ok: false, detail: error instanceof CliError ? error.message : `${error?.name || 'Error'}`, ms: Date.now() - started })
      }
      return checks.at(-1).ok
    }
    const skip = name => checks.push({ name, ok: null, detail: '跳过', ms: 0 })
    const reachable = await check('控制台可达', async () => {
      const result = await rawRequest(ctx, 'GET', '/api/session')
      if (result.status >= 500) throw new CliError(`服务端返回 ${result.status}`)
      return result.body?.authenticated === false ? '匿名访问正常' : `HTTP ${result.status}`
    })
    const loggedIn = reachable && await check('登录', async () => {
      const info = await ctx.session.login()
      return `凭据来源：${info.tierLabel}`
    })
    if (loggedIn) {
      await check('管理员角色', async () => {
        const session = await probeAdmin(ctx)
        if (session?.role !== 'admin') throw new CliError(`角色是 ${session?.role || '未知'}，不是 admin`)
        return 'admin'
      })
      await check('渠道', async () => {
        const payload = await ctx.get('/api/channels')
        return `${(payload.channels || []).length} 个兼容渠道 · ${(payload.credentials || []).length} 个账号`
      })
      await check('Key', async () => {
        const bootstrap = await ctx.get('/api/bootstrap')
        return `${(bootstrap.keys || []).length} 把 Key${bootstrap.degraded ? ' · 控制面降级' : ''}`
      })
      await check('同步任务', async () => {
        const sync = await ctx.get('/api/sync/status')
        const failed = (sync.jobs || []).filter(job => job.state === 'error').length
        return `${(sync.jobs || []).length} 个任务${failed ? ` · ${failed} 个出错` : ''}`
      })
    } else {
      for (const name of reachable ? ['管理员角色', '渠道', 'Key', '同步任务'] : ['登录', '管理员角色', '渠道', 'Key', '同步任务']) skip(name)
    }
    const failed = checks.some(item => item.ok === false)
    ctx.output({ environment, checks, ok: !failed }, () => {
      ui.banner(`${ui.g.mark} cradmin doctor  ${ctx.version}`, target.base)
      ui.section('环境')
      ui.kv('Node', `${process.version}${environment.node.ok ? '' : ui.paint('warn', `（仓库要求 ${environment.node.required}）`)}`)
      ui.kv('系统', environment.system)
      ui.kv('终端', environment.terminal)
      ui.kv('界面字形', environment.glyphs === 'ascii' ? 'ASCII' : 'Unicode')
      ui.kv('中文测试', `Crosery ${ui.g.bullet} 你好，世界 ${ui.g.ok}`)
      ui.kv('配置文件', `${environment.configFile.path}（${environment.configFile.exists ? '存在' : '不存在，使用内置 profile'}）`)
      ui.kv('profile', environment.profile)
      ui.kv('目标', `${environment.base}（${environment.remote ? '远程' : '本地'}）`)
      ui.kv('用户名', environment.username)
      ui.section('凭据档位', '只给结论，不读出值')
      const c = environment.credentials
      ui.kv('环境变量', `CONSOLE_PASSWORD ${c.CONSOLE_PASSWORD} · CONSOLE_PASSWORD_FILE ${c.CONSOLE_PASSWORD_FILE}`)
      ui.kv('.env', c.dotenv)
      ui.kv('钥匙串', c.keychain)
      ui.kv('会话缓存', c.sessionCache)
      ui.section('连通性')
      for (const item of checks) {
        const mark = item.ok === null ? ui.paint('muted', '-') : item.ok ? ui.paint('ok', ui.g.ok) : ui.paint('err', ui.g.fail)
        ui.line(`${mark} ${pad(item.name, 14)}${item.detail}${item.ok === null ? '' : ` ${ui.paint('muted', `${item.ms}ms`)}`}`)
      }
    })
    return failed ? 1 : 0
  },
}

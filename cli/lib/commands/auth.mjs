// login / logout / whoami
import { spawnSync } from 'node:child_process'
import { CancelError, CliError, UsageError } from '../args.mjs'
import { keychainEntryExists } from '../credentials.mjs'
import { BUILTIN_PROFILES } from '../profile.mjs'
import { clock, time } from '../ui.mjs'

const targetLabel = ctx => `${ctx.target.base}（${ctx.target.remote ? '远程' : '本地'}）`

/**
 * GET /api/session。钥匙串缓存的会话在服务端重启（换了 SESSION_SECRET）后会失效，
 * 但这个接口对失效会话回 200 {authenticated:false} 而不是 401：这里识别出来、删缓存、重新登录一次。
 */
export async function probeAdmin(ctx) {
  let session = await ctx.get('/api/session')
  if (session?.authenticated === false && ctx.session.info().tier === 'cache') {
    await ctx.session.login({ fresh: true })
    session = await ctx.get('/api/session')
  }
  return session
}

export const login = {
  name: 'login',
  aliases: [],
  summary: '登录（--save 把密码存进钥匙串）',
  help: `cradmin login [--save]

登录控制台并验证管理员身份。macOS 上会把会话 token 缓存进钥匙串（到期前自动复用），
其它平台或 --no-session-cache 时每个进程登录一次、结束时注销。

参数：
  --save       （仅 macOS）先把管理员密码存进钥匙串，由 security 自己提示输入，密码不进命令行；
               已有条目时会先确认再覆盖。注意：local profile 的条目（${BUILTIN_PROFILES.profiles.local.keychainService}）
               同时是本地沙箱启动脚本读取的服务端密码，写错会在沙箱下次重启时改掉服务端密码
  --user <名>  管理员用户名（默认 admin）

示例：
  cradmin login --save
  cradmin --profile prod login
`,
  options: { save: { type: 'boolean' } },
  async run(ctx) {
    if (ctx.values.save) {
      if (ctx.platform !== 'darwin') throw new UsageError('--save 只支持 macOS 钥匙串')
      const service = ctx.target.keychainService
      if (!service) throw new UsageError('目标不是 profile 的地址，没有对应的钥匙串条目', '用 --keychain-service <service> 指定')
      const username = ctx.credentials().username
      if (ctx.dryRun) {
        ctx.ui.note(`--dry-run：不会写钥匙串（将写 service=${service}，account=${username}）`)
        return
      }
      if (service === BUILTIN_PROFILES.profiles.local.keychainService) {
        ctx.ui.warnErr('这个条目同时是本地沙箱启动脚本读取的服务端密码：写错会在沙箱下次重启时改掉服务端密码')
      }
      if (keychainEntryExists(service, username, { platform: ctx.platform, execute: ctx.execute }) && !ctx.yes) {
        if (!ctx.interactive) throw new UsageError('钥匙串里已有这个条目；非交互环境覆盖需要 --yes')
        if (!(await ctx.prompter.confirm(`覆盖钥匙串里 ${username} 已有的密码？`))) throw new CancelError()
      }
      ctx.ui.noteErr(`把 ${username} 的密码存进钥匙串 service=${service}（输入两次，不回显）`)
      const result = (ctx.io.spawnSync ?? spawnSync)('/usr/bin/security',
        ['add-generic-password', '-U', '-s', service, '-a', username, '-w'], { stdio: 'inherit' })
      if (result.status !== 0) throw new CliError('写入钥匙串失败或已取消', 1)
      ctx.ui.success('已存进钥匙串')
    }
    await ctx.session.login({ fresh: Boolean(ctx.values.save) })
    const session = await probeAdmin(ctx)
    if (session?.role !== 'admin') throw new CliError('登录了，但服务端返回的不是管理员会话', 3)
    const final = ctx.session.info()
    const data = { target: ctx.target.base, username: final.username, credentialSource: final.tierLabel, expiresAt: final.expiresAt ? new Date(final.expiresAt).toISOString() : null, cached: final.cached }
    ctx.output(data, () => {
      ctx.ui.success(`已登录 ${final.username}@${ctx.target.host}${final.expiresAt ? `（会话到 ${clock(final.expiresAt)}）` : ''}`)
      ctx.ui.note(`凭据来源：${final.tierLabel}${final.cached ? ' · 会话已缓存在钥匙串' : ' · 未缓存，本次进程结束即注销'}`)
    })
  },
}

export const logout = {
  name: 'logout',
  aliases: [],
  summary: '注销并清掉缓存会话',
  help: `cradmin logout

吊销钥匙串里缓存的会话 token（服务端注销）并删除缓存条目。没有缓存时什么都不做。
`,
  options: {},
  async run(ctx) {
    const done = await ctx.session.logoutCached()
    ctx.output({ loggedOut: done }, () => (done ? ctx.ui.success('已注销，缓存会话已删除') : ctx.ui.note('当前没有缓存会话')))
  },
}

export const whoami = {
  name: 'whoami',
  aliases: [],
  summary: '当前目标、账号、凭据来源、会话',
  help: `cradmin whoami

显示当前 profile、目标地址（本地/远程）、用户名、凭据来源档位、会话到期时间与服务端返回的角色。
`,
  options: {},
  async run(ctx) {
    const session = await probeAdmin(ctx)
    const info = ctx.session.info()
    const data = {
      profile: ctx.target.profile,
      target: ctx.target.base,
      remote: ctx.target.remote,
      username: info.username,
      credentialSource: info.tierLabel,
      sessionExpiresAt: info.expiresAt ? new Date(info.expiresAt).toISOString() : null,
      role: session?.role || null,
    }
    ctx.output(data, () => {
      const { ui } = ctx
      ui.kv('profile', ctx.target.profile)
      ui.kv('目标', targetLabel(ctx))
      ui.kv('用户名', info.username)
      ui.kv('凭据来源', info.tierLabel || '-')
      ui.kv('会话到', info.expiresAt ? time(info.expiresAt) : '-')
      ui.kv('角色', session?.role || '-')
    })
  },
}

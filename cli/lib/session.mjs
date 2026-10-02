// 会话：每进程最多登录一次；macOS 默认把会话 token 缓存进钥匙串（经 `security -i` 的 stdin 写入，不进 argv）。
import { execFileSync } from 'node:child_process'
import { CliError } from './args.mjs'
import { mapHttpError, rawRequest } from './client.mjs'
import { TIER_LABEL } from './credentials.mjs'

export const SESSION_SERVICE = 'com.crosery.cradmin.session'
export const COOKIE_NAME = 'crosery_console_session'
const TOKEN = /^\d+\.[A-Za-z0-9.-]{1,250}$/
const ACCOUNT = /^[A-Za-z0-9._@:/[\]-]{1,200}$/
const MIN_REMAINING_MS = 5 * 60 * 1000
/** 服务端第 5 次失败就封锁（网页登录一起）；本进程最多失败 3 次。 */
const MAX_FAILED_LOGINS = 3

export const tokenExpiry = token => {
  const ms = Number(String(token).split('.')[0])
  return Number.isFinite(ms) && ms > 0 ? ms : null
}

export function cookieFromHeaders(headers) {
  const list = typeof headers.getSetCookie === 'function' ? headers.getSetCookie() : [headers.get('set-cookie')].filter(Boolean)
  for (const entry of list) {
    const [pair] = String(entry).split(';')
    const index = pair.indexOf('=')
    if (index > 0 && pair.slice(0, index).trim() === COOKIE_NAME) return pair.slice(index + 1).trim()
  }
  return null
}

export function sessionCacheEnabled({ platform, env, values = {} }) {
  if (platform !== 'darwin') return false
  if (values['no-session-cache']) return false
  if (String(env.CRADMIN_SESSION_CACHE || '').toLowerCase() === 'off') return false
  if (String(env.CRADMIN_KEYCHAIN || '').toLowerCase() === 'off') return false
  return true
}

/** 钥匙串里的会话缓存。所有失败都静默：缓存只是优化，不能影响主流程，也不能带出 token。 */
export function createSessionCache({ account, execute = execFileSync, now = Date.now }) {
  const valid = ACCOUNT.test(account)
  return {
    account,
    usable: valid,
    read({ allowExpired = false } = {}) {
      if (!valid) return null
      let token
      try {
        token = String(execute('/usr/bin/security', ['find-generic-password', '-s', SESSION_SERVICE, '-a', account, '-w'],
          { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 10_000, maxBuffer: 16 * 1024 })).replace(/[\r\n]+$/u, '')
      } catch {
        return null
      }
      if (!TOKEN.test(token)) return null
      const expires = tokenExpiry(token)
      if (!allowExpired && (!expires || expires - now() < MIN_REMAINING_MS)) return null
      return token
    },
    write(token) {
      if (!valid || !TOKEN.test(token) || !tokenExpiry(token)) return false
      try {
        execute('/usr/bin/security', ['-i'], {
          input: `add-generic-password -U -s ${SESSION_SERVICE} -a ${account} -w ${token}\n`,
          stdio: ['pipe', 'ignore', 'ignore'], timeout: 10_000,
        })
        return true
      } catch {
        return false
      }
    },
    remove() {
      if (!valid) return false
      try {
        execute('/usr/bin/security', ['delete-generic-password', '-s', SESSION_SERVICE, '-a', account],
          { stdio: ['ignore', 'ignore', 'ignore'], timeout: 10_000 })
        return true
      } catch {
        return false
      }
    },
  }
}

/**
 * rt: {target, fetch, userAgent, credentials(): CredentialSource, cacheEnabled, execute, now, warn(msg)}
 * 登录与续期单飞：并发请求共用同一次登录；被服务端拒绝过的凭据本进程不再重发（失败计数会连网页登录一起锁）。
 */
export function createSession(rt) {
  let token = null
  let source = null
  let tier = null
  let username = null
  let cache = null
  let stored = false
  let pending = null
  let failure = null
  let failedLogins = 0
  const cacheFor = name => {
    if (!rt.cacheEnabled) return null
    if (!cache) cache = createSessionCache({ account: `${name}@${rt.target.origin}`, execute: rt.execute, now: rt.now })
    return cache.usable ? cache : null
  }
  const current = () => (token ? `${COOKIE_NAME}=${token}` : null)
  const single = fn => (pending ??= fn().finally(() => { pending = null }))
  const drop = () => { token = null; source = null; stored = false }

  async function login() {
    if (failure) throw failure()
    if (rt.target.remote && rt.target.base.startsWith('http:')) {
      throw new CliError(`拒绝经明文 http 把管理员密码发给远程地址 ${rt.target.host}`, 2, '改用 https:// 地址')
    }
    const creds = rt.credentials()
    username = creds.username
    let cred = await creds.password()
    for (;;) {
      if (!cred?.password) throw new CliError('密码不能为空', 3)
      const result = await rawRequest(rt, 'POST', '/api/login', { body: { username, password: cred.password } })
      if (result.status === 200) {
        const value = cookieFromHeaders(result.headers)
        if (!value) throw new CliError('登录成功但服务端没有下发会话 cookie', 1)
        token = value
        source = 'login'
        tier = cred.tier
        stored = cacheFor(username)?.write(value) === true
        return
      }
      const fail = () => mapHttpError(result.status, result.body, { tier: TIER_LABEL[cred.tier] || cred.tier, retryAfter: result.headers.get('retry-after') })
      if (result.status === 401) {
        failedLogins += 1
        if (cred.tier === 'prompt' && failedLogins < MAX_FAILED_LOGINS) {
          rt.warn?.('密码不对，请重新输入')
          const next = await creds.password({ retry: true })
          if (next) { cred = next; continue }
        }
        creds.forget?.()
      }
      if (result.status === 401 || result.status === 429) {
        failure = () => Object.assign(fail(), { hint: '本进程不再重试登录（连续失败会锁住网页登录）；确认密码后重新运行' })
      }
      throw fail()
    }
  }

  async function obtain() {
    const name = rt.credentials().username
    const cached = cacheFor(name)?.read()
    if (cached) {
      token = cached
      source = 'cache'
      tier = 'cache'
      username = name
      stored = true
      return
    }
    await login()
  }

  async function postLogout(value) {
    try {
      await rawRequest(rt, 'POST', '/api/logout', { cookie: `${COOKIE_NAME}=${value}`, timeoutMs: 1000, ignoreAbort: true })
    } catch { /* 尽力而为 */ }
  }

  return {
    async cookie() {
      for (let attempt = 0; !token && attempt < 3; attempt += 1) await single(obtain)
      if (!token) throw new CliError('会话已结束', 1)
      return current()
    },
    /**
     * 请求带着 used 收到 401：别的请求已经换过会话 → 直接重发；缓存会话被拒 → 删缓存、重新登录一次、重发。
     * 返回 false = 不重发（非缓存会话被拒就是真的被拒）。
     */
    async invalidate(used) {
      if (pending) { await pending; return Boolean(token) }
      if (used && token && used !== current()) return true
      if (source !== 'cache') return false
      cache?.remove()
      drop()
      await single(login)
      return true
    },
    async login({ fresh = false } = {}) {
      if (!fresh) {
        await this.cookie()
        return this.info()
      }
      if (pending) await pending.catch(() => {})
      if (source === 'cache') cache?.remove()
      else if (token && !stored) await postLogout(token)
      drop()
      await single(login)
      return this.info()
    },
    info() {
      return {
        username: username || rt.credentials().username,
        tier,
        tierLabel: this.tierLabel(),
        cached: Boolean(token) && stored,
        expiresAt: token ? tokenExpiry(token) : null,
        active: Boolean(token),
      }
    },
    tierLabel() {
      if (tier === 'cache') return '钥匙串缓存的会话'
      return TIER_LABEL[tier] || ''
    },
    cachedExpiry() {
      const name = rt.credentials().username
      const cached = cacheFor(name)?.read()
      return cached ? tokenExpiry(cached) : null
    },
    /** `cradmin logout`：吊销缓存的 token 并删条目；返回是否真的有会话被注销。 */
    async logoutCached() {
      const name = rt.credentials().username
      const store = cacheFor(name)
      const cached = store?.read({ allowExpired: true })
      const value = cached || token
      if (!value) return false
      await postLogout(value)
      store?.remove()
      if (value === token) drop()
      return true
    },
    /** 进程结束：会话没有成功存进钥匙串时尽力注销（最多等 1 秒）。 */
    async close() {
      if (token && !stored) await postLogout(token)
      drop()
    },
  }
}

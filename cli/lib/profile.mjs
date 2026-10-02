// profile：内置 local/prod + 可选的只读配置文件（只放非秘密：base、username、keychainService）。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { UsageError } from './args.mjs'
import { redactUrl } from './resolve.mjs'

export const BUILTIN_PROFILES = {
  defaultProfile: 'local',
  profiles: {
    local: { base: 'http://127.0.0.1:8791', username: 'admin', keychainService: 'com.crosery.console-magpie.local' },
    prod: { base: 'https://console.ai.crosery.com', username: 'admin', keychainService: 'com.crosery.cradmin.prod' },
  },
}

const PROFILE_KEYS = new Set(['base', 'username', 'keychainService'])
const SECRET_KEY = /pass|token|secret|api.?key|cookie|credential/i

export function configPath(env = process.env, home = os.homedir()) {
  if (env.CRADMIN_HOME) return path.join(env.CRADMIN_HOME, 'config.json')
  if (env.XDG_CONFIG_HOME) return path.join(env.XDG_CONFIG_HOME, 'cradmin', 'config.json')
  return path.join(home, '.config', 'cradmin', 'config.json')
}

/** 顶层键和每个 profile 里的键（profile 名本身不算）。 */
function findSecretKey(data) {
  if (!data || typeof data !== 'object') return null
  for (const key of Object.keys(data)) if (SECRET_KEY.test(key)) return key
  for (const [name, profile] of Object.entries(data.profiles && typeof data.profiles === 'object' ? data.profiles : {})) {
    for (const key of Object.keys(profile && typeof profile === 'object' ? profile : {})) {
      if (SECRET_KEY.test(key)) return `profiles.${name}.${key}`
    }
  }
  return null
}

/** 读配置文件（不存在 = 只用内置 profile）。CLI 从不创建或写入这个文件。 */
export function loadProfiles({ env = process.env, home = os.homedir(), fsImpl = fs } = {}) {
  const file = configPath(env, home)
  let data = null
  try {
    data = JSON.parse(fsImpl.readFileSync(file, 'utf8').replace(/^﻿/, ''))
  } catch (error) {
    if (error?.code === 'ENOENT') return { file, exists: false, ...structuredClone(BUILTIN_PROFILES) }
    throw new UsageError(`配置文件 ${file} 不是合法 JSON`)
  }
  const secret = findSecretKey(data)
  if (secret) throw new UsageError(`配置文件 ${file} 里不能放凭据（发现键 ${secret}）；密码放环境变量或钥匙串`)
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new UsageError(`配置文件 ${file} 必须是 JSON 对象`)
  for (const key of Object.keys(data)) {
    if (key !== 'defaultProfile' && key !== 'profiles') throw new UsageError(`配置文件 ${file} 有未知键 ${key}`)
  }
  const merged = structuredClone(BUILTIN_PROFILES)
  if (data.defaultProfile !== undefined) merged.defaultProfile = String(data.defaultProfile)
  for (const [name, profile] of Object.entries(data.profiles || {})) {
    if (!profile || typeof profile !== 'object') throw new UsageError(`配置文件 ${file} 的 profile ${name} 必须是对象`)
    for (const key of Object.keys(profile)) {
      if (!PROFILE_KEYS.has(key)) throw new UsageError(`配置文件 ${file} 的 profile ${name} 只能有 base、username、keychainService（发现 ${key}）`)
    }
    merged.profiles[name] = { ...(merged.profiles[name] || {}), ...profile }
  }
  return { file, exists: true, ...merged }
}

const LOOPBACK = new Set(['127.0.0.1', '::1', '[::1]', 'localhost'])

export function normalizeBase(raw) {
  const shown = redactUrl(String(raw))
  let url
  try { url = new URL(String(raw)) } catch { throw new UsageError(`控制台地址无效：${shown}`) }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new UsageError(`控制台地址必须是 http(s)：${shown}`)
  if (url.username || url.password) throw new UsageError('控制台地址里不能带用户名或密码')
  return url.origin + url.pathname.replace(/\/+$/, '')
}

export function isLoopback(base) {
  return LOOPBACK.has(new URL(base).hostname)
}

/** 同一台服务：协议、端口相同，主机相同或都是回环地址。 */
export function sameServer(a, b) {
  const x = new URL(a)
  const y = new URL(b)
  const port = url => url.port || (url.protocol === 'https:' ? '443' : '80')
  return x.protocol === y.protocol && port(x) === port(y) && (x.hostname === y.hostname || (LOOPBACK.has(x.hostname) && LOOPBACK.has(y.hostname)))
}

/** 命令行 > 环境变量 > profile > 内置默认值。 */
export function resolveTarget(values, env, profiles) {
  const profileName = values.profile || env.CRADMIN_PROFILE || profiles.defaultProfile || 'local'
  const profile = profiles.profiles[profileName]
  if (!profile) throw new UsageError(`没有这个 profile：${profileName}（可用：${Object.keys(profiles.profiles).join('、')}）`)
  const base = normalizeBase(values.base || env.CRADMIN_BASE || profile.base)
  const url = new URL(base)
  // profile 的钥匙串密码只发给 profile 自己的地址：--base / CRADMIN_BASE 指向别处时不用（除非显式给 service）
  const explicitService = values['keychain-service'] || env.CRADMIN_KEYCHAIN_SERVICE
  const profileBase = (() => { try { return normalizeBase(profile.base) } catch { return null } })()
  const ownAddress = Boolean(profileBase) && sameServer(base, profileBase)
  return {
    profile: profileName,
    base,
    origin: url.origin,
    host: url.host,
    port: Number(url.port || (url.protocol === 'https:' ? 443 : 80)),
    remote: !isLoopback(base),
    profileUsername: profile.username || 'admin',
    keychainService: explicitService || (ownAddress ? profile.keychainService || null : null),
  }
}

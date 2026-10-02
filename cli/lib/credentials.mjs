// 管理员凭据：环境变量 → .env → macOS 钥匙串 → 终端隐藏输入。第一个拿到值的档位胜出；各档单独判冲突。
// 密码只在内存里，不进 argv、URL、日志、错误文本或 --json 输出。
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { parseEnv } from 'node:util'
import { CliError } from './args.mjs'
import { isLoopback } from './profile.mjs'

export const TIER_LABEL = {
  env: '环境变量 CONSOLE_PASSWORD',
  'env-file': '环境变量 CONSOLE_PASSWORD_FILE',
  dotenv: '.env 文件',
  keychain: '钥匙串',
  prompt: '终端输入',
}

const PLACEHOLDER = /^replace-with-/

/** 与 server/config.ts fileBackedSecret 逐条对齐；任何失败只报统一文案。 */
export function readSecretFile(name, filename, { fsImpl = fs, platform = process.platform } = {}) {
  try {
    const stat = fsImpl.statSync(filename)
    if (!stat.isFile() || stat.size > 16 * 1024) throw new Error('invalid')
    if (platform !== 'win32' && (stat.mode & 0o077) !== 0) throw new Error('insecure')
    const value = fsImpl.readFileSync(filename, 'utf8').replace(/[\r\n]+$/u, '')
    if (!value) throw new Error('empty')
    return value
  } catch {
    throw new CliError(`${name}_FILE 必须是私有、可读且不超过 16 KiB 的普通文件`, 3)
  }
}

/** 一档里的 `X` / `X_FILE`：同时非空报冲突；占位符与空串视为未设置。返回 null 或 {value, via}。 */
export function pickSecret(name, direct, filename, deps = {}) {
  const hasDirect = Boolean(direct?.trim()) && !PLACEHOLDER.test(direct)
  const hasFile = Boolean(filename?.trim())
  if (hasDirect && hasFile) throw new CliError(`${name} 与 ${name}_FILE 不能同时设置`, 3)
  if (hasFile) return { value: readSecretFile(name, filename.trim(), deps), via: 'file' }
  if (hasDirect) return { value: direct, via: 'direct' }
  return null
}

export function findRepoRoot(cwd, fsImpl = fs) {
  let dir = path.resolve(cwd)
  for (;;) {
    try {
      if (fsImpl.existsSync(path.join(dir, 'server', 'config.ts'))) {
        const pkg = JSON.parse(fsImpl.readFileSync(path.join(dir, 'package.json'), 'utf8'))
        if (pkg?.name === 'crosery-cpe-console') return dir
      }
    } catch { /* 不是控制台仓库，继续向上 */ }
    const parent = path.dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

const DOTENV_KEYS = new Set(['CONSOLE_USERNAME', 'CONSOLE_PASSWORD', 'CONSOLE_PASSWORD_FILE', 'HOST', 'PORT'])

/** 只取五个键，不写 process.env。语法交给 Node 自带的 util.parseEnv（与 node --env-file 一致）。 */
export function parseDotenv(text) {
  const parsed = parseEnv(String(text))
  return Object.fromEntries(Object.entries(parsed).filter(([key]) => DOTENV_KEYS.has(key)))
}

/** 返回 {file, values, applies}；applies = base 是回环地址且端口等于这份 .env 的 PORT（缺省 8787）。 */
export function loadDotenv({ envFile, cwd, target, fsImpl = fs }) {
  let file = null
  if (envFile) file = path.resolve(cwd, envFile)
  else {
    const root = findRepoRoot(cwd, fsImpl)
    if (root && fsImpl.existsSync(path.join(root, '.env'))) file = path.join(root, '.env')
  }
  if (!file) return null
  let text
  try { text = fsImpl.readFileSync(file, 'utf8') } catch {
    if (envFile) throw new CliError(`读不到 --env-file 指定的文件`, 2)
    return null
  }
  const values = parseDotenv(text)
  const port = Number(values.PORT || 8787)
  const applies = Boolean(target) && isLoopback(target.base) && target.port === port
  return { file, values, port, applies }
}

/** 钥匙串读取：条目不存在返回 null；其它失败吞掉原始错误，抛固定文案、不带 cause。 */
export function readKeychain(service, account, { platform = process.platform, execute = execFileSync } = {}) {
  if (platform !== 'darwin') return null
  let value
  try {
    value = execute('/usr/bin/security', ['find-generic-password', '-s', service, '-a', account, '-w'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 10_000, maxBuffer: 16 * 1024 })
  } catch (error) {
    if (error?.status === 44) return null
    throw new CliError('无法从钥匙串读取管理员密码', 3)
  }
  const secret = String(value ?? '').replace(/[\r\n]+$/u, '')
  if (!secret || secret.includes('\0')) throw new CliError('钥匙串里的管理员密码无效', 3)
  return secret
}

/** 只判断条目在不在（不带 -w，不读值）。 */
export function keychainEntryExists(service, account, { platform = process.platform, execute = execFileSync } = {}) {
  if (platform !== 'darwin') return null
  try {
    execute('/usr/bin/security', ['find-generic-password', '-s', service, '-a', account],
      { stdio: ['ignore', 'ignore', 'ignore'], timeout: 10_000 })
    return true
  } catch {
    return false
  }
}

/**
 * 凭据来源。`username` 立即确定；密码按需取（只有真的要登录时才读钥匙串或提示输入）。
 * deps: {env, cwd, platform, execute, fsImpl, target, values, interactive, promptSecret}
 */
export function createCredentialSource(deps) {
  const { env, values = {}, target } = deps
  const keychainOff = String(env.CRADMIN_KEYCHAIN || '').toLowerCase() === 'off'
  const dotenv = loadDotenv({ envFile: values['env-file'], cwd: deps.cwd, target, fsImpl: deps.fsImpl })
  const dotenvValues = dotenv?.applies ? dotenv.values : {}
  // 显式设置但为空 = 服务端 `CONSOLE_USERNAME || 'admin'` 的结果，不再往下落到 profile
  const declared = source => (source.CONSOLE_USERNAME === undefined ? undefined : source.CONSOLE_USERNAME || 'admin')
  const username = values.user || declared(env) || declared(dotenvValues) || target.profileUsername || 'admin'
  const tried = []
  let promptAttempts = 0

  function fromTiers() {
    const fromEnv = pickSecret('CONSOLE_PASSWORD', env.CONSOLE_PASSWORD, env.CONSOLE_PASSWORD_FILE, deps)
    tried.push('环境变量')
    if (fromEnv) return { password: fromEnv.value, tier: fromEnv.via === 'file' ? 'env-file' : 'env' }
    if (dotenv) {
      tried.push(dotenv.applies ? '.env' : '.env（端口不匹配，已跳过）')
      if (dotenv.applies) {
        const fromFile = pickSecret('CONSOLE_PASSWORD', dotenvValues.CONSOLE_PASSWORD, dotenvValues.CONSOLE_PASSWORD_FILE
          && path.resolve(path.dirname(dotenv.file), dotenvValues.CONSOLE_PASSWORD_FILE), deps)
        if (fromFile) return { password: fromFile.value, tier: 'dotenv' }
      }
    }
    if (!keychainOff && (deps.platform ?? process.platform) === 'darwin') {
      if (!target.keychainService) tried.push('钥匙串（目标不是 profile 地址或没配 service，已跳过）')
      else {
        tried.push('钥匙串')
        const secret = readKeychain(target.keychainService, username, deps)
        if (secret) return { password: secret, tier: 'keychain' }
      }
    }
    return null
  }

  let cached = null
  return {
    username,
    dotenv,
    keychainOff,
    /** 第一次：按档位取；之后（仅 prompt 档）再次提示，最多 3 次。 */
    async password({ retry = false } = {}) {
      if (!retry && cached) return cached
      if (!retry) {
        tried.length = 0
        const found = fromTiers()
        if (found) return (cached = found)
      } else if (cached?.tier !== 'prompt') {
        return null
      }
      if (!deps.interactive) {
        throw new CliError(`拿不到管理员密码（已尝试：${tried.join('、') || '无'}）`, 3,
          '在终端里运行可以手动输入；脚本里用 CONSOLE_PASSWORD_FILE，或 cradmin login --save 存进钥匙串')
      }
      if (promptAttempts >= 3) return null
      promptAttempts += 1
      const secret = await deps.promptSecret(`管理员 ${username} 的密码：`)
      if (!secret) throw new CliError('密码不能为空', 3)
      return (cached = { password: secret, tier: 'prompt' })
    },
    /** 服务端拒绝了这份密码：不再复用它。 */
    forget() { cached = null },
    tierLabel: tier => TIER_LABEL[tier] || tier,
  }
}

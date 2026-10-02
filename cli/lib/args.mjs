// 参数解析：util.parseArgs 封装 + 全局 flag + 错误类型（退出码见 docs/cli.md）。
import { parseArgs } from 'node:util'

export class CliError extends Error {
  constructor(message, exitCode = 1, hint = '') {
    super(message)
    this.name = 'CliError'
    this.exitCode = exitCode
    this.hint = hint
  }
}

export class UsageError extends CliError {
  constructor(message, hint = '') {
    super(message, 2, hint)
    this.name = 'UsageError'
  }
}

export class CancelError extends CliError {
  constructor(message = '已取消') {
    super(message, 130)
    this.name = 'CancelError'
  }
}

export const GLOBAL_OPTIONS = {
  profile: { type: 'string' },
  base: { type: 'string' },
  user: { type: 'string' },
  'env-file': { type: 'string' },
  'keychain-service': { type: 'string' },
  json: { type: 'boolean' },
  yes: { type: 'boolean', short: 'y' },
  'dry-run': { type: 'boolean' },
  'no-session-cache': { type: 'boolean' },
  'no-color': { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
  version: { type: 'boolean', short: 'v' },
}

function translate(error) {
  const option = /'(-[^'\s]+)/.exec(String(error?.message || ''))?.[1] || ''
  switch (error?.code) {
    case 'ERR_PARSE_ARGS_UNKNOWN_OPTION': return new UsageError(`未知参数：${option}`)
    case 'ERR_PARSE_ARGS_INVALID_OPTION_VALUE':
      return /does not take an argument/.test(error.message) ? new UsageError(`参数 ${option} 不接受值`) : new UsageError(`参数 ${option} 需要一个值`)
    case 'ERR_PARSE_ARGS_UNEXPECTED_POSITIONAL': return new UsageError('多余的位置参数')
    default: return new UsageError('参数无法解析')
  }
}

/** 找出命令名（第一个位置参数），其余 token 原样留给命令自己的严格解析。 */
export function splitCommand(argv) {
  const { tokens } = parseArgs({ args: argv, options: GLOBAL_OPTIONS, strict: false, allowPositionals: true, tokens: true })
  const first = tokens.find(token => token.kind === 'positional' || token.kind === 'option-terminator')
  if (!first || first.kind === 'option-terminator') return { command: '', rest: [...argv] }
  const rest = [...argv]
  rest.splice(first.index, 1)
  return { command: String(first.value).toLowerCase(), rest }
}

export function parseCommandArgs(args, options = {}) {
  try {
    const { values, positionals } = parseArgs({ args, options: { ...GLOBAL_OPTIONS, ...options }, strict: true, allowPositionals: true })
    return { values, positionals }
  } catch (error) {
    throw translate(error)
  }
}

/** `--enable a,b --enable c` → ['a','b','c']；空段丢弃。 */
export function listValue(raw) {
  const items = Array.isArray(raw) ? raw : raw === undefined ? [] : [raw]
  return items.flatMap(item => String(item).split(',')).map(item => item.trim()).filter(Boolean)
}

export function numberValue(raw, label, { integer = false, min = -Infinity, max = Infinity } = {}) {
  if (raw === undefined) return undefined
  const text = String(raw).trim()
  const value = Number(text)
  if (text === '' || !Number.isFinite(value) || (integer && !Number.isInteger(value)) || value < min || value > max) {
    throw new UsageError(`${label} 必须是${integer ? '整数' : '数字'}${Number.isFinite(min) && Number.isFinite(max) ? `（${min} 到 ${max}）` : ''}`)
  }
  return value
}

/**
 * /login decisions without the DOM (DESIGN.md §6.1, §6.0 copy): what a failed sign-in says and under which field,
 * the 429 lock, and the checks that keep obviously wrong input from spending the per-IP attempt budget
 * (5 failures in 5 min block key login from that IP for 15 min, valid keys included).
 */
import { fmtCountdownClock } from '../../ui/composables/useNow.js'

/** Same union as `LoginMode` in ui/types.ts; local so the server test build (node16 resolution) skips the kit barrel. */
export type LoginMode = 'key' | 'admin'

export type LoginField = 'key' | 'username' | 'password'
/** `live` is the sentence announced once when `text` keeps changing (the countdown). */
export type FieldError = { field: LoginField; text: string; live?: string }
export type LoginPayload = { mode: LoginMode; key?: string; username?: string; password?: string }

/** The field an error lands on when no specific one is to blame. */
export const mainField = (mode: LoginMode | undefined): LoginField => (mode === 'admin' ? 'password' : 'key')

type ErrorLike = { status: number; code?: string | null; message?: string; retryAfterSec?: number | null }
const isApiError = (err: unknown): err is ErrorLike =>
  typeof err === 'object' && err !== null && typeof (err as { status?: unknown }).status === 'number'

/**
 * Same bounds as the server (`API_KEY_MIN_LENGTH` / `API_KEY_MAX_LENGTH` in server/keySession.ts). The server
 * accepts any key in that range: console-minted keys are `sk-<slug>-<random>`, but keys configured on the
 * gateway side (synced in) can have any shape, so `sk-` is only a hint after a failure, never a gate.
 */
export const KEY_MIN_LENGTH = 8
export const KEY_MAX_LENGTH = 512

/** Input that cannot succeed, caught before it costs an attempt. null = send it. */
export function precheck(payload: LoginPayload): FieldError | null {
  if (payload.mode === 'key') {
    const key = payload.key ?? ''
    if (!key) return { field: 'key', text: '◆ 粘贴你的 API Key' }
    if (/\s/.test(key)) return { field: 'key', text: '◆ Key 中间有空格或换行 · 重新复制' }
    if (key.length < KEY_MIN_LENGTH) return { field: 'key', text: '◆ Key 太短 · 检查是否复制完整' }
    if (key.length > KEY_MAX_LENGTH) return { field: 'key', text: '◆ Key 太长 · 检查是否只复制了 Key' }
    return null
  }
  if (!payload.username) return { field: 'username', text: '◆ 输入账号' }
  if (!payload.password) return { field: 'password', text: '◆ 输入密码' }
  return null
}

/** Seconds the server asked us to wait (429), or null when this failure is not a lock. */
export function lockSeconds(err: unknown): number | null {
  if (!isApiError(err) || err.status !== 429) return null
  const sec = err.retryAfterSec
  return typeof sec === 'number' && Number.isFinite(sec) && sec > 0 ? Math.ceil(sec) : 30
}

const spoken = (sec: number) => (sec < 90 ? `${sec} 秒` : `约 ${Math.ceil(sec / 60)} 分钟`)

/** `◆ 尝试过多 · 00:42 后再试`, ticking; the announcement is fixed at the start of the lock. */
export function lockError(mode: LoginMode, msLeft: number, totalSec: number): FieldError {
  return {
    field: mainField(mode),
    text: `◆ 尝试过多 · ${fmtCountdownClock(msLeft)} 后再试`,
    live: `◆ 尝试过多 · ${spoken(totalSec)}后再试`,
  }
}

/** A failed POST /api/login in the plate's words. Anything that is not an HTTP answer is a network failure. */
export function describeLoginError(err: unknown, mode: LoginMode, key?: string): FieldError {
  if (!isApiError(err)) return { field: mainField(mode), text: '◆ 连不上服务器 · 检查网络后重试' }
  // the soft `sk-` hint: only once the server said no, and only when the input does not look like a console key
  const invalidKey = key && !key.startsWith('sk-') ? '◆ Key 无效 · 控制台发的 Key 以 sk- 开头' : '◆ Key 无效 · 检查是否复制完整'
  if (err.code === 'key_invalid') return { field: 'key', text: invalidKey }
  if (err.code === 'key_disabled') return { field: 'key', text: '◆ Key 已被停用 · 找管理员恢复' }
  if (err.status === 401) return mode === 'key' ? { field: 'key', text: invalidKey } : { field: 'password', text: '◆ 账号或密码不对' }
  if (err.status >= 500) return { field: mainField(mode), text: `◆ 服务器出错 · 稍后再试 · ${err.status}` }
  const message = err.message?.trim()
  return { field: mainField(mode), text: `◆ ${message || `登录失败 · ${err.status}`}` }
}

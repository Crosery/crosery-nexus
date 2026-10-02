/**
 * API Key 用户登录（`role=key`）的数据访问：按 Key 找行、判断存活、展示用掩码。
 *
 * 只读 `api_keys`，不写任何上游（建 Key / 改 Key 的同步链路与本模块无关）。
 */
import { createHash } from 'node:crypto'
import { safeEqual, type KeySessionState } from './auth.js'
import { hashKey } from './cpa.js'
import { db } from './db.js'
import type { KeyQuotaRow } from './quotaEnforcer.js'

export type KeyRecord = KeyQuotaRow & {
  groups_json: string
  total_concurrency: number | null
  created_at: string
  updated_at: string
  last_used_at: string | null
}

/** 控制台生成的 Key 约 45 字符；CPA 同步来的 Key 形态不定，上限只防超长输入拖慢哈希。 */
export const API_KEY_MIN_LENGTH = 8
export const API_KEY_MAX_LENGTH = 512

/** 未命中时拿来做一次同长度级别的比较，让「Key 不存在」与「Key 存在」走同样的比较路径。 */
const DUMMY_KEY_VALUE = `sk-dummy-${'0'.repeat(32)}`

const byHash = db.prepare('SELECT * FROM api_keys WHERE key_hash = ?')

export function keyByHash(keyHash: string): KeyRecord | null {
  if (!/^[0-9a-f]{64}$/.test(keyHash)) return null
  return (byHash.get(keyHash) as KeyRecord | undefined) ?? null
}

/**
 * 用用户提交的明文 Key 找行。
 *
 * 不用 `WHERE key_value = ?`（SQLite 字符串比较会提前退出、且列上无索引）：
 * 先按 sha256 走主键，再用定长比较核对明文；未命中也做一次哑比较。
 * 长度界默认是控制台登录的准入界；`/v1/usage` 传更宽的界：它以前按 `key_value = ?` 精确匹配，
 * 任何已存的 Key 都查得到，不能因为换了查找方式就让过短/过长的存量 Key 失效。
 */
export function findKeyByPresentedValue(presented: string, bounds: { min?: number; max?: number } = {}): KeyRecord | null {
  if (presented.length < (bounds.min ?? API_KEY_MIN_LENGTH) || presented.length > (bounds.max ?? API_KEY_MAX_LENGTH)) {
    safeEqual(presented, DUMMY_KEY_VALUE)
    return null
  }
  const row = byHash.get(hashKey(presented)) as KeyRecord | undefined
  if (!row) {
    safeEqual(presented, DUMMY_KEY_VALUE)
    return null
  }
  return safeEqual(presented, String(row.key_value)) ? row : null
}

/** 人工停用（`enabled=0` 且不是额度超限自动停用）——这类 Key 不能登录，已有会话立即失效。 */
export const isManuallyDisabled = (key: Pick<KeyRecord, 'enabled' | 'quota_blocked_reason'>) =>
  !key.enabled && !key.quota_blocked_reason

/** 注入给 `auth.ts` 守卫的存活查询。 */
export function keySessionState(keyHash: string): KeySessionState {
  const key = keyByHash(keyHash)
  if (!key) return 'missing'
  return isManuallyDisabled(key) ? 'disabled' : 'active'
}

/**
 * 这把 Key 的不透明标识（16 位 hex，由 key_hash 派生、加域前缀）：前端用它判断「换了一把 Key」。
 * 名字 + 掩码不够——同名 Key 的前 5 位相同，后 4 位撞上就认不出来。不可逆推出 Key 或 key_hash。
 */
export const keyRef = (keyHash: string) => createHash('sha256').update(`crosery-console-key-ref|${keyHash}`).digest('hex').slice(0, 16)

/** 展示用掩码：只露前 5 位与后 4 位（`sk-cr…7f3a`）；短 Key 露得更少。 */
export function maskApiKey(value: string): string {
  const key = String(value || '')
  if (key.length >= 16) return `${key.slice(0, 5)}…${key.slice(-4)}`
  if (key.length >= 8) return `${key.slice(0, 2)}…${key.slice(-2)}`
  return '…'
}

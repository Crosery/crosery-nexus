/**
 * 截图前的隐私脱敏：html[data-mask="on"] 时，页面上的邮箱与人名换成掩码。
 * 掩码在渲染时就生成好（`<Pii>` 同时输出原文与掩码，CSS 按属性切换），切换不触发重新渲染，也不会漏掉
 * 没有订阅状态的组件。状态持久化在本机；仅影响显示，不影响任何请求。
 */
import { computed, ref } from 'vue'

export const MASK_STORAGE_KEY = 'cx-mask'
export const MASK_DOT = '•'

/** zhang.wei.ops@company.example → zh••••••s@•••（本地部分保留首两位与末位，域名整体隐去）。 */
export function maskEmail(email: string): string {
  const value = String(email ?? '')
  const at = value.lastIndexOf('@')
  const local = at > 0 ? value.slice(0, at) : value
  const masked = maskLocal(local)
  return at > 0 ? `${masked}@${MASK_DOT.repeat(3)}` : masked
}

function maskLocal(local: string): string {
  const chars = Array.from(local)
  if (chars.length === 0) return ''
  if (chars.length <= 3) return chars[0] + MASK_DOT.repeat(2)
  return chars.slice(0, 2).join('') + MASK_DOT.repeat(Math.min(6, chars.length - 3)) + chars[chars.length - 1]
}

/** 人名 / 账号名：保留首尾字符，中间换成圆点（单字名保留首字）。 */
export function maskName(name: string): string {
  const chars = Array.from(String(name ?? '').trim())
  if (chars.length === 0) return ''
  if (chars.length === 1) return chars[0] + MASK_DOT
  if (chars.length === 2) return chars[0] + MASK_DOT
  return chars[0] + MASK_DOT.repeat(Math.min(6, chars.length - 2)) + chars[chars.length - 1]
}

export type PiiKind = 'email' | 'name' | 'auto'

export function maskPii(value: string, kind: PiiKind = 'auto'): string {
  if (kind === 'email' || (kind === 'auto' && String(value ?? '').includes('@'))) return maskEmail(value)
  return maskName(value)
}

const hasDom = () => typeof window !== 'undefined' && typeof document !== 'undefined'

const maskOn = ref(false)

function apply() {
  if (!hasDom()) return
  if (maskOn.value) document.documentElement.dataset.mask = 'on'
  else delete document.documentElement.dataset.mask
}

let initialized = false

export function initPrivacy() {
  if (initialized || !hasDom()) return
  initialized = true
  try {
    maskOn.value = window.localStorage.getItem(MASK_STORAGE_KEY) === 'on'
  } catch {
    maskOn.value = false
  }
  apply()
}

export function setMask(on: boolean) {
  maskOn.value = Boolean(on)
  try {
    if (maskOn.value) window.localStorage.setItem(MASK_STORAGE_KEY, 'on')
    else window.localStorage.removeItem(MASK_STORAGE_KEY)
  } catch {
    /* 存不下时本次会话仍然生效 */
  }
  apply()
}

export function toggleMask() {
  setMask(!maskOn.value)
}

export function useMask() {
  return { on: computed(() => maskOn.value), set: setMask, toggle: toggleMask }
}

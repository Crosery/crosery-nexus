/**
 * 控制台标题：用户在 Minimal 皮肤下自定义的品牌名，用于侧栏品牌、面包屑首页与浏览器标签页标题。
 * 只保存在当前设备，不发到服务端；默认「Crosery」， blank 保存 / 重置也恢复为「Crosery」。
 * Telemetry 皮肤的品牌与浏览器标题保持原样，这里只管理 Minimal 的。
 */
import { computed, ref } from 'vue'

export const TITLE_STORAGE_KEY = 'cx-title'
/** 保存空白或重置时恢复的默认标题。 */
export const DEFAULT_TITLE = 'Crosery'

const titlePref = ref<string>(DEFAULT_TITLE)
const currentTitle = computed(() => titlePref.value)
let initialized = false

/** 将存储的原始值归一化为标题：空白 → 默认。 */
export function parseTitlePref(raw: unknown): string {
  const value = String(raw ?? '').trim()
  return value === '' ? DEFAULT_TITLE : value
}

export function initTitle() {
  if (initialized || typeof window === 'undefined') return
  initialized = true
  try {
    titlePref.value = parseTitlePref(window.localStorage.getItem(TITLE_STORAGE_KEY))
  } catch {
    titlePref.value = DEFAULT_TITLE
  }
}

export function setTitlePref(value: string) {
  const next = parseTitlePref(value)
  titlePref.value = next
  try {
    if (next === DEFAULT_TITLE) window.localStorage.removeItem(TITLE_STORAGE_KEY)
    else window.localStorage.setItem(TITLE_STORAGE_KEY, next)
  } catch {
    /* 隐私模式下写不进去时，本次会话仍然生效 */
  }
}

/** 重置为默认标题。 */
export function resetTitlePref() {
  setTitlePref(DEFAULT_TITLE)
}

export function useTitlePref() {
  return {
    pref: currentTitle,
    set: setTitlePref,
    reset: resetTitlePref,
  }
}
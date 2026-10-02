/**
 * 主题：浅色 / 深色 / 跟随系统 → html[data-theme]。默认跟随系统；选过就记住。
 * 切换时用 View Transitions 从按下的按钮画圆形擦除（DESIGN.md §3.2 #12）；不支持或减弱动效时立即切换，
 * 不支持时额外跑一次扫描线。首帧：index.html 内联脚本只写入已存储的明确选择；跟随系统时由 tokens.css 的
 * prefers-color-scheme 兜底刷深色纸面（index.html 需保持 <1KB，staticCompression 测试依赖）。
 */
import { computed, ref } from 'vue'
import { isReducedMotion, requestScan } from './motion.js'

export type ThemePref = 'system' | 'light' | 'dark'
export type ThemeName = 'light' | 'dark'

export const THEME_STORAGE_KEY = 'cx-theme'
/** 与 tokens.css 的 --paper 保持一致：浏览器地址栏 / iOS 状态栏颜色。 */
export const THEME_PAPER: Record<ThemeName, string> = { light: '#F2EFE7', dark: '#131311' }

const THEME_PREFS: readonly ThemePref[] = ['system', 'light', 'dark']

export function parseThemePref(raw: unknown): ThemePref {
  return THEME_PREFS.includes(raw as ThemePref) ? (raw as ThemePref) : 'system'
}

export function resolveTheme(pref: ThemePref, systemDark: boolean): ThemeName {
  if (pref === 'light' || pref === 'dark') return pref
  return systemDark ? 'dark' : 'light'
}

/** 擦除圆的半径：从原点到最远的视口角。 */
export function wipeRadius(x: number, y: number, width: number, height: number): number {
  return Math.hypot(Math.max(x, width - x), Math.max(y, height - y))
}

const hasDom = () => typeof window !== 'undefined' && typeof document !== 'undefined'

const themePref = ref<ThemePref>('system')
const systemDark = ref(false)
const appliedTheme = computed<ThemeName>(() => resolveTheme(themePref.value, systemDark.value))

function paint(theme: ThemeName) {
  if (!hasDom()) return
  document.documentElement.dataset.theme = theme
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', THEME_PAPER[theme])
}

let initialized = false

export function initTheme() {
  if (initialized || !hasDom()) return
  initialized = true
  try {
    themePref.value = parseThemePref(window.localStorage.getItem(THEME_STORAGE_KEY))
  } catch {
    themePref.value = 'system'
  }
  const media = window.matchMedia?.('(prefers-color-scheme: dark)')
  systemDark.value = Boolean(media?.matches)
  media?.addEventListener?.('change', (event) => {
    systemDark.value = event.matches
    if (themePref.value === 'system') paint(appliedTheme.value)
  })
  paint(appliedTheme.value)
}

export type WipeOrigin = { x: number; y: number } | Element | MouseEvent | PointerEvent | null | undefined

function originPoint(origin: WipeOrigin): { x: number; y: number } {
  if (origin && 'clientX' in origin) return { x: origin.clientX, y: origin.clientY }
  if (origin && typeof Element !== 'undefined' && origin instanceof Element) {
    const rect = origin.getBoundingClientRect()
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
  }
  if (origin && 'x' in origin) return origin
  return { x: window.innerWidth - 60, y: 26 }
}

type ViewTransitionDocument = Document & { startViewTransition?: (update: () => void) => unknown }

export function setThemePref(pref: ThemePref, origin?: WipeOrigin) {
  const next = parseThemePref(pref)
  const before = appliedTheme.value
  themePref.value = next
  try {
    if (next === 'system') window.localStorage.removeItem(THEME_STORAGE_KEY)
    else window.localStorage.setItem(THEME_STORAGE_KEY, next)
  } catch {
    /* 存不下时本次会话仍然生效 */
  }
  if (!hasDom()) return
  const after = appliedTheme.value
  if (after === before) return paint(after)

  const doc = document as ViewTransitionDocument
  if (isReducedMotion()) return paint(after)
  if (typeof doc.startViewTransition !== 'function') {
    paint(after)
    requestScan()
    return
  }
  const { x, y } = originPoint(origin)
  const root = document.documentElement
  root.style.setProperty('--vx', `${x}px`)
  root.style.setProperty('--vy', `${y}px`)
  root.style.setProperty('--vr', `${wipeRadius(x, y, window.innerWidth, window.innerHeight)}px`)
  doc.startViewTransition(() => paint(after))
}

/** 在浅色与深色之间切换（一旦按过，就不再跟随系统）。 */
export function toggleTheme(origin?: WipeOrigin) {
  setThemePref(appliedTheme.value === 'dark' ? 'light' : 'dark', origin)
}

export function useThemePref() {
  return {
    pref: computed(() => themePref.value),
    theme: appliedTheme,
    set: setThemePref,
    toggle: toggleTheme,
  }
}

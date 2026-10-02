/**
 * 动效偏好：跟随系统 / 完整 / 减弱 → html[data-motion="reduce"]（DESIGN.md §3.3 的唯一减弱开关）。
 * index.html 的内联启动脚本在首帧前用同一个存储键写入同一个属性，这里负责之后的同步。
 * 另外维护 html[data-hidden]（标签页隐藏时暂停循环动画）与 html[data-capture]（截图模式，动画落到终帧）。
 */
import { computed, ref } from 'vue'

export type MotionPref = 'system' | 'full' | 'reduce'
export type MotionMode = 'full' | 'reduce'

export const MOTION_STORAGE_KEY = 'cx-motion'
/** 主题切换在没有 View Transitions 时用一次扫描线代替擦除，事件由 ScanLine 监听。 */
export const SCAN_EVENT = 'cx:scan'

const MOTION_PREFS: readonly MotionPref[] = ['system', 'full', 'reduce']

export function parseMotionPref(raw: unknown): MotionPref {
  return MOTION_PREFS.includes(raw as MotionPref) ? (raw as MotionPref) : 'system'
}

export function resolveMotion(pref: MotionPref, systemReduce: boolean): MotionMode {
  if (pref === 'reduce') return 'reduce'
  if (pref === 'full') return 'full'
  return systemReduce ? 'reduce' : 'full'
}

/** `?capture=1` 或无头 Chrome：所有动画直接落到终帧，QA 截图才可复现。 */
export function detectCapture(search: string, userAgent: string): boolean {
  return /(?:^|[?&])capture=1(?:&|$)/.test(search) || /HeadlessChrome/.test(userAgent)
}

const hasDom = () => typeof window !== 'undefined' && typeof document !== 'undefined'

function readStored(): MotionPref {
  try {
    return parseMotionPref(window.localStorage.getItem(MOTION_STORAGE_KEY))
  } catch {
    return 'system'
  }
}

const motionPref = ref<MotionPref>('system')
const systemReduce = ref(false)
const motionMode = computed<MotionMode>(() => resolveMotion(motionPref.value, systemReduce.value))

function applyMotion() {
  if (!hasDom()) return
  const root = document.documentElement
  if (motionMode.value === 'reduce') root.dataset.motion = 'reduce'
  else delete root.dataset.motion
}

let initialized = false

export function initMotion() {
  if (initialized || !hasDom()) return
  initialized = true
  const root = document.documentElement
  motionPref.value = readStored()
  const media = window.matchMedia?.('(prefers-reduced-motion: reduce)')
  systemReduce.value = Boolean(media?.matches)
  media?.addEventListener?.('change', (event) => {
    systemReduce.value = event.matches
    applyMotion()
  })
  applyMotion()

  if (detectCapture(window.location.search, navigator.userAgent)) root.dataset.capture = '1'

  const syncHidden = () => {
    if (document.hidden) root.dataset.hidden = ''
    else delete root.dataset.hidden
  }
  document.addEventListener('visibilitychange', syncHidden)
  syncHidden()
}

export function setMotionPref(pref: MotionPref) {
  motionPref.value = parseMotionPref(pref)
  try {
    if (motionPref.value === 'system') window.localStorage.removeItem(MOTION_STORAGE_KEY)
    else window.localStorage.setItem(MOTION_STORAGE_KEY, motionPref.value)
  } catch {
    /* 隐私模式下写不进去时，本次会话仍然生效 */
  }
  applyMotion()
}

/** 当前是否应当减弱动效（读 DOM，所以在内联启动脚本之后、initMotion 之前也准确）。 */
export function isReducedMotion(): boolean {
  if (!hasDom()) return true
  const root = document.documentElement
  return root.dataset.motion === 'reduce' || root.dataset.capture !== undefined
}

export function isCaptureMode(): boolean {
  return hasDom() && document.documentElement.dataset.capture !== undefined
}

export function requestScan() {
  if (hasDom()) window.dispatchEvent(new CustomEvent(SCAN_EVENT))
}

export function useMotionPref() {
  return {
    pref: computed(() => motionPref.value),
    reduced: computed(() => motionMode.value === 'reduce'),
    set: setMotionPref,
  }
}

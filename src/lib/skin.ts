/**
 * 皮肤：默认 Telemetry Paper，另提供只使用 Tuffex 原生设计令牌的简约皮肤。
 * 选择只保存在当前设备，不发送到服务端；html[data-skin] 让首屏与 Vue 状态共用同一个事实来源。
 */
import { computed, ref } from 'vue'

export type SkinPref = 'telemetry' | 'minimal'

export const SKIN_STORAGE_KEY = 'cx-skin'

const SKINS: readonly SkinPref[] = ['telemetry', 'minimal']
const skinPref = ref<SkinPref>('telemetry')
let initialized = false
const currentSkin = computed(() => skinPref.value)
let styleLoad: Promise<unknown> | undefined
let selection = 0

export function loadSkinStyles(skin: SkinPref = skinPref.value): Promise<unknown> {
  if (skin !== 'minimal') return Promise.resolve()
  return styleLoad ??= import('../styles/minimal-layout.css')
}

export function parseSkinPref(raw: unknown): SkinPref {
  return SKINS.includes(raw as SkinPref) ? (raw as SkinPref) : 'telemetry'
}

function readStoredSkin(): SkinPref {
  try {
    return parseSkinPref(window.localStorage.getItem(SKIN_STORAGE_KEY))
  } catch {
    return 'telemetry'
  }
}
function syncSkinMeta() {
  if (typeof window === 'undefined' || typeof document === 'undefined') return
  const root = document.documentElement
  const color = getComputedStyle(root).getPropertyValue(root.dataset.skin === 'minimal' ? '--tx-bg-color-page' : '--paper').trim()
  if (color) document.querySelector('meta[name="theme-color"]')?.setAttribute('content', color)
}

export function initSkin() {
  if (initialized || typeof window === 'undefined' || typeof document === 'undefined') return
  initialized = true
  skinPref.value = readStoredSkin()
  document.documentElement.dataset.skin = skinPref.value
  syncSkinMeta()
}

export async function setSkinPref(skin: SkinPref) {
  const next = parseSkinPref(skin)
  const request = ++selection
  await loadSkinStyles(next)
  if (request !== selection) return
  skinPref.value = next
  try {
    if (skinPref.value === 'telemetry') window.localStorage.removeItem(SKIN_STORAGE_KEY)
    else window.localStorage.setItem(SKIN_STORAGE_KEY, skinPref.value)
  } catch {
    /* 隐私模式下写不进去时，本次会话仍然生效。 */
  }
  if (typeof window !== 'undefined' && typeof document !== 'undefined') {
    document.documentElement.dataset.skin = skinPref.value
    if (skinPref.value === 'minimal') {
      for (const name of ['--vx', '--vy', '--vr']) document.documentElement.style.removeProperty(name)
    }
    syncSkinMeta()
  }
}

export function useSkinPref() {
  return {
    pref: currentSkin,
    set: setSkinPref,
  }
}

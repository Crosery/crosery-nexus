import { computed, onBeforeUnmount, onMounted, ref } from 'vue'

/**
 * Keyboard shortcuts (DESIGN.md §4.4). Character keys follow WCAG 2.1.4: ignored inside editable fields, ignored
 * with any modifier held, and switchable off in 设置 · 外观 · 单键快捷键 (persisted, on by default).
 * Spec strings: 'mod+k' (⌘ on mac, Ctrl elsewhere), 'escape', '/', '?', 't', 'm', '1'…'8'.
 */
export const SHORTCUTS_STORAGE_KEY = 'cx-keys'

const singleKey = ref(true)
let loaded = false

function loadPref() {
  if (loaded || typeof window === 'undefined') return
  loaded = true
  try {
    singleKey.value = window.localStorage.getItem(SHORTCUTS_STORAGE_KEY) !== 'off'
  } catch {
    singleKey.value = true
  }
}

export function setSingleKeyShortcuts(on: boolean) {
  singleKey.value = on
  try {
    if (on) window.localStorage.removeItem(SHORTCUTS_STORAGE_KEY)
    else window.localStorage.setItem(SHORTCUTS_STORAGE_KEY, 'off')
  } catch {
    /* session only */
  }
}

export function useSingleKeyPref() {
  loadPref()
  return { on: computed(() => singleKey.value), set: setSingleKeyShortcuts }
}

type KeyLike = Pick<KeyboardEvent, 'key' | 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey'>

export function isEditableTarget(target: EventTarget | null): boolean {
  if (!target || typeof (target as HTMLElement).closest !== 'function') return false
  const el = target as HTMLElement
  if (el.isContentEditable) return true
  return Boolean(el.closest('input, textarea, select, [contenteditable=""], [contenteditable="true"], [role="textbox"]'))
}

/** True when a spec names a single printable key (subject to WCAG 2.1.4 rules). */
export function isCharacterSpec(spec: string): boolean {
  return !spec.includes('+') && spec.length === 1
}

export function matchShortcut(event: KeyLike, spec: string, isMac = false): boolean {
  const parts = spec.toLowerCase().split('+')
  const key = parts.pop() ?? ''
  const wantMod = parts.includes('mod')
  const wantShift = parts.includes('shift')
  if (event.key.toLowerCase() !== key) return false
  const mod = isMac ? event.metaKey : event.ctrlKey
  const otherMod = isMac ? event.ctrlKey : event.metaKey
  if (wantMod) return mod && !otherMod && !event.altKey && wantShift === event.shiftKey
  if (event.metaKey || event.ctrlKey || event.altKey) return false
  // letters must be typed without Shift ('T' ≠ 't'); '?' and '/' depend on the layout, so Shift is not checked
  return !(/^[a-z]$/.test(key) && event.shiftKey)
}

export type ShortcutMap = Record<string, (event: KeyboardEvent) => void>

/**
 * Register shortcuts for the lifetime of the calling component. `Escape` and `mod+` combos always fire;
 * character keys respect the rules above.
 */
export function useShortcuts(map: ShortcutMap | (() => ShortcutMap)) {
  loadPref()
  const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent)
  const onKey = (event: KeyboardEvent) => {
    if (event.defaultPrevented || event.isComposing) return
    const table = typeof map === 'function' ? map() : map
    for (const [spec, handler] of Object.entries(table)) {
      if (!matchShortcut(event, spec, isMac)) continue
      if (isCharacterSpec(spec.toLowerCase()) && (!singleKey.value || isEditableTarget(event.target))) continue
      event.preventDefault()
      handler(event)
      return
    }
  }
  onMounted(() => window.addEventListener('keydown', onKey))
  onBeforeUnmount(() => window.removeEventListener('keydown', onKey))
}

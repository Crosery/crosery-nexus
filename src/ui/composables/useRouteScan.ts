import { onBeforeUnmount, onMounted, watch, type Ref } from 'vue'
import { useRoute } from 'vue-router'
import { SCAN_EVENT, isReducedMotion } from '../../lib/motion'

/** Restart the CSS animation on the scanline element (`.ui-scan.go`). */
export function runScan(el: HTMLElement | null | undefined) {
  if (!el || isReducedMotion()) return
  el.classList.remove('go')
  void el.offsetWidth
  el.classList.add('go')
}

/**
 * DESIGN.md §3.2 #1: one orange hairline sweeps the viewport on every navigation (not on first load, not on
 * query-only changes such as filters). Also runs once when the theme swaps without View Transitions.
 */
export function useRouteScan(el: Ref<HTMLElement | null | undefined>) {
  const route = useRoute()
  watch(() => route.path, (next, prev) => {
    if (prev !== undefined && next !== prev) runScan(el.value)
  })
  const onScan = () => runScan(el.value)
  onMounted(() => window.addEventListener(SCAN_EVENT, onScan))
  onBeforeUnmount(() => window.removeEventListener(SCAN_EVENT, onScan))
}

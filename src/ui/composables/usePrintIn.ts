import { onMounted, type Ref } from 'vue'
import { isReducedMotion } from '../../lib/motion.js'

/** Header height the scanline starts from; mirrors --head. */
const HEAD = 52
/** The scanline crosses the viewport in ~380ms of its 720ms run (the rest is the fade). */
const SWEEP_MS = 380

/**
 * DESIGN.md §3.2 #1: a block prints in at the moment the route scanline passes it.
 * --pd = clamp(0, (top − head) / (vh − head), 1) × 380ms + 40ms.
 */
export function printDelay(top: number, viewportHeight: number, head = HEAD): number {
  const span = Math.max(1, viewportHeight - head)
  const at = Math.min(1, Math.max(0, (top - head) / span))
  return Math.round(at * SWEEP_MS + 40)
}

/**
 * Print a block in on mount. Blocks below the fold, reduced motion and capture mode get no animation;
 * interaction is never blocked (the element is interactive throughout).
 */
export function startPrint(el: HTMLElement | null | undefined) {
  if (!el || isReducedMotion()) return
  const rect = el.getBoundingClientRect()
  const vh = window.innerHeight
  if (rect.top >= vh || rect.bottom <= 0) return
  const pd = printDelay(rect.top, vh)
  el.dataset.print = ''
  el.style.setProperty('--pd', `${pd}ms`)
  el.classList.add('is-entering')
  // .is-entering also drives the [data-row] stagger inside the block, so it stays until the last row
  // (row 14: pd + 80 + 14 × 26 + 320ms) has landed, not just until the block's own animation ends.
  window.setTimeout(() => el.classList.remove('is-entering'), pd + 80 + 14 * 26 + 320 + 80)
}

export function usePrintIn(target: Ref<HTMLElement | null | undefined>, enabled: () => boolean = () => true) {
  onMounted(() => {
    if (enabled()) startPrint(target.value)
  })
}

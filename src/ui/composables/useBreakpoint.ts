import { computed, readonly, ref } from 'vue'

/** DESIGN.md §2.6: xl ≥1440 · lg 1180–1439 · md 960–1179 · sm 600–959 · xs <600. */
export type Breakpoint = 'xs' | 'sm' | 'md' | 'lg' | 'xl'
export const BREAKPOINTS = { sm: 600, md: 960, lg: 1180, xl: 1440 } as const

export function breakpointOf(width: number): Breakpoint {
  if (width >= BREAKPOINTS.xl) return 'xl'
  if (width >= BREAKPOINTS.lg) return 'lg'
  if (width >= BREAKPOINTS.md) return 'md'
  if (width >= BREAKPOINTS.sm) return 'sm'
  return 'xs'
}

const width = ref(typeof window === 'undefined' ? 1440 : window.innerWidth)
const coarse = ref(false)
let bound = false

function bind() {
  if (bound || typeof window === 'undefined') return
  bound = true
  let frame = 0
  window.addEventListener('resize', () => {
    if (frame) return
    frame = requestAnimationFrame(() => {
      frame = 0
      width.value = window.innerWidth
    })
  }, { passive: true })
  const pointer = window.matchMedia?.('(pointer: coarse)')
  coarse.value = Boolean(pointer?.matches)
  pointer?.addEventListener?.('change', (event) => { coarse.value = event.matches })
}

/** One shared resize listener for the whole app. `isMobile` = mobile chrome (<960), `isCompact` = phone (<600). */
export function useBreakpoint() {
  bind()
  const bp = computed(() => breakpointOf(width.value))
  return {
    width: readonly(width),
    bp,
    isMobile: computed(() => width.value < BREAKPOINTS.md),
    isCompact: computed(() => width.value < BREAKPOINTS.sm),
    isWide: computed(() => width.value >= BREAKPOINTS.lg),
    coarse: readonly(coarse),
  }
}

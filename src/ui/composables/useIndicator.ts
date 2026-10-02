import { nextTick, onBeforeUnmount, onMounted, watch, type Ref, type WatchSource } from 'vue'

/**
 * FLIP indicator for nav rails, tabs and segmented controls (DESIGN.md §3.2 #8): one element slides between
 * items. Sets --x / --w (and --y / --h for wrapped rows) on `indicator`, measured from the item matching
 * `activeSelector` inside `host`. `inset` trims the underline inside the item's horizontal padding.
 */
export function useIndicator(
  host: Ref<HTMLElement | null | undefined>,
  indicator: Ref<HTMLElement | null | undefined>,
  activeSelector: string,
  deps: WatchSource[] = [],
  inset = 0,
) {
  let observer: ResizeObserver | null = null

  function place() {
    const root = host.value
    const ind = indicator.value
    if (!root || !ind) return
    const active = root.querySelector<HTMLElement>(activeSelector)
    if (!active) {
      ind.style.setProperty('--w', '0px')
      return
    }
    const hostRect = root.getBoundingClientRect()
    const rect = active.getBoundingClientRect()
    ind.style.setProperty('--x', `${rect.left - hostRect.left + root.scrollLeft + inset}px`)
    ind.style.setProperty('--w', `${Math.max(0, rect.width - inset * 2)}px`)
    ind.style.setProperty('--y', `${rect.top - hostRect.top}px`)
    ind.style.setProperty('--h', `${rect.height}px`)
  }

  onMounted(() => {
    void nextTick(place)
    if (typeof ResizeObserver !== 'undefined' && host.value) {
      observer = new ResizeObserver(() => place())
      observer.observe(host.value)
    }
  })
  onBeforeUnmount(() => observer?.disconnect())
  watch(deps, () => void nextTick(place), { flush: 'post' })
  return { place }
}

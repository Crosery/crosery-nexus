import { onBeforeUnmount, ref, watch, type Ref } from 'vue'

/**
 * Content-box width of an element, kept current with a ResizeObserver (fluid charts / meters).
 * Follows the ref, so an element that appears later (after a loading/empty state) is picked up.
 */
export function useElementWidth(target: Ref<HTMLElement | null | undefined>, fallback = 0) {
  const width = ref(fallback)
  let ro: ResizeObserver | null = null
  const stop = watch(
    target,
    (el) => {
      ro?.disconnect()
      ro = null
      if (!el) return
      if (el.clientWidth) width.value = Math.floor(el.clientWidth)
      if (typeof ResizeObserver === 'undefined') return
      ro = new ResizeObserver((entries) => {
        const w = entries[0]?.contentRect.width
        if (w && Math.abs(w - width.value) >= 1) width.value = Math.floor(w)
      })
      ro.observe(el)
    },
    { flush: 'post', immediate: true },
  )
  onBeforeUnmount(() => {
    stop()
    ro?.disconnect()
  })
  return width
}

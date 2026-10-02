import { onScopeDispose, ref, watch, type Ref } from 'vue'

/**
 * DESIGN.md §3.2 #7: at most 6 pulse rings animate per screen; later live marks get a static halo.
 * Slots are claimed in mount order and released on unmount, so the page-head live mark (mounted first) and the
 * first five live rows keep the motion.
 */
export const MAX_LIVE_RINGS = 6
let claimed = 0

export function useLiveRing(active: Ref<boolean>) {
  const animated = ref(false)
  let holding = false
  const release = () => {
    if (!holding) return
    holding = false
    claimed -= 1
    animated.value = false
  }
  watch(active, (on) => {
    if (on && !holding && claimed < MAX_LIVE_RINGS) {
      holding = true
      claimed += 1
      animated.value = true
    } else if (!on) release()
  }, { immediate: true })
  onScopeDispose(release)
  return animated
}

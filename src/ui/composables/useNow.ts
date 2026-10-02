import { computed, onScopeDispose, readonly, ref, toValue, type MaybeRefOrGetter } from 'vue'

/*
 * One shared 1 s ticker for every countdown, cooldown pie and "3m 前" label (DESIGN.md §3.2 #15).
 * It runs only while something subscribes, pauses while the tab is hidden, and catches up on return.
 */
const now = ref(Date.now())
let subscribers = 0
let timer: ReturnType<typeof setTimeout> | null = null

function schedule() {
  if (timer || typeof window === 'undefined') return
  // align ticks to the wall-clock second so every countdown on screen changes together
  timer = setTimeout(() => {
    timer = null
    now.value = Date.now()
    if (subscribers > 0 && !document.hidden) schedule()
  }, 1000 - (Date.now() % 1000) + 5)
}

function onVisibility() {
  if (document.hidden) {
    if (timer) clearTimeout(timer)
    timer = null
    return
  }
  now.value = Date.now()
  if (subscribers > 0) schedule()
}

let visibilityBound = false

export function useNow() {
  if (typeof window !== 'undefined') {
    if (!visibilityBound) {
      visibilityBound = true
      document.addEventListener('visibilitychange', onVisibility)
    }
    subscribers += 1
    now.value = Date.now()
    schedule()
    onScopeDispose(() => {
      subscribers -= 1
      if (subscribers <= 0 && timer) {
        clearTimeout(timer)
        timer = null
      }
    })
  }
  return readonly(now)
}

export type Instant = string | number | Date | null | undefined

export function toMs(value: Instant): number | null {
  if (value === null || value === undefined || value === '') return null
  const ms = value instanceof Date ? value.getTime() : typeof value === 'number' ? value : Date.parse(value)
  return Number.isFinite(ms) ? ms : null
}

/** 04:12 under an hour, 1:27:52 above, 0:00 when elapsed. */
export function fmtCountdownClock(msLeft: number): string {
  const total = Math.max(0, Math.ceil(msLeft / 1000))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const pad = (n: number) => String(n).padStart(2, '0')
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`
}

/**
 * Countdown to `until`. `total` (ms) lets a cooldown pie compute how much is left (ratio 1 → 0).
 */
export function useCountdown(until: MaybeRefOrGetter<Instant>, total?: MaybeRefOrGetter<number | null | undefined>) {
  const tick = useNow()
  const target = computed(() => toMs(toValue(until)))
  const msLeft = computed(() => (target.value === null ? 0 : Math.max(0, target.value - tick.value)))
  const ratio = computed(() => {
    const span = toValue(total)
    if (!span || span <= 0) return msLeft.value > 0 ? 1 : 0
    return Math.max(0, Math.min(1, msLeft.value / span))
  })
  return {
    msLeft,
    ratio,
    done: computed(() => target.value !== null && msLeft.value <= 0),
    label: computed(() => fmtCountdownClock(msLeft.value)),
  }
}

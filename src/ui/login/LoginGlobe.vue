<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, useTemplateRef } from 'vue'
import { createGlobe, type GlobeHandle } from './globe.js'
import { isReducedMotion } from '../../lib/motion'

/**
 * Login stage (DESIGN.md §3.4, §6.1): plain paper, the glyph globe (design-assets
 * login-globe.v3.js: 1,700 glyphs / 520 compact, 30→15fps idle, rAF stopped when hidden, ONE static frame
 * under reduced motion or Save-Data), and the plate (default slot) docked right
 * (left edge ≈60%) or, stacked (≤760px, or <960px and ≥760px tall), at the bottom with the globe centred above it. The soft keyboard
 * (visualViewport shrink) fades the globe to 40%. Call `exit()` (exposed) and await it before router.replace:
 * the globe spins up ×9, swells and fades (520ms) while the plate lifts away, so
 * the console's scanline prints onto an empty sheet. Reduced motion: one 120ms fade.
 * Orbit labels are synthetic constants — never real data (pre-auth page).
 */
const stage = useTemplateRef<HTMLElement>('stage')
const back = useTemplateRef<HTMLCanvasElement>('back')
const front = useTemplateRef<HTMLCanvasElement>('front')
const wrap = useTemplateRef<HTMLElement>('wrap')
const dock = useTemplateRef<HTMLElement>('dock')
const keyboard = ref(false)
let globe: GlobeHandle | null = null

function onViewport() {
  const vv = window.visualViewport
  keyboard.value = Boolean(vv && vv.height < window.innerHeight * 0.78)
}

onMounted(() => {
  if (!back.value || !front.value || !wrap.value || !dock.value) return
  const plate = (dock.value.firstElementChild as HTMLElement | null) ?? dock.value
  try {
    globe = createGlobe({ back: back.value, front: front.value, plate, wrap: wrap.value })
  } catch {
    globe = null // canvas unavailable: the plate still works on plain paper
  }
  window.visualViewport?.addEventListener('resize', onViewport)
})
onBeforeUnmount(() => {
  globe?.destroy()
  window.visualViewport?.removeEventListener('resize', onViewport)
})

const EXIT_MS = 520
async function exit() {
  stage.value?.classList.add('is-leaving')
  const settle = new Promise<void>((resolve) => setTimeout(resolve, isReducedMotion() ? 120 : EXIT_MS))
  await Promise.all([globe?.exit(EXIT_MS), settle])
}
defineExpose({ exit })
</script>

<template>
  <div ref="stage" class="ui-login">
    <div ref="wrap" class="ui-login__globe" :class="{ 'is-kb': keyboard }" aria-hidden="true">
      <canvas ref="back" class="ui-login__cv" />
      <canvas ref="front" class="ui-login__cv" />
    </div>
    <div ref="dock" class="ui-login__dock">
      <slot />
    </div>
  </div>
</template>

<style>
.ui-login {
  position: relative; min-height: 100vh; min-height: 100dvh; overflow: hidden;
  background: var(--paper);
}
.ui-login::before { content: ""; position: absolute; inset: 0; background: var(--paper); opacity: .5; pointer-events: none;
  transition: opacity var(--dur-exit) var(--ease-exit); }
/* sign-in exit: the plate lifts away a beat after the globe starts to spin up */
.ui-login.is-leaving::before { opacity: 1; }
.ui-login.is-leaving .ui-login__dock > * { opacity: 0; transform: translateY(-8px);
  transition: opacity 340ms var(--ease-exit) 180ms, transform 340ms var(--ease-exit) 180ms; }
:root[data-motion="reduce"] .ui-login.is-leaving .ui-login__dock > * { transform: none; transition: opacity 120ms linear !important; }
.ui-login__globe { position: fixed; inset: 0; pointer-events: none; transition: opacity var(--dur-3) var(--ease-swift); }
.ui-login__globe.is-kb { opacity: .4; }
.ui-login__cv { position: absolute; inset: 0; display: block; }
/* plate left edge ≈60%, but never closer than 48px to the right edge (its crop marks need air at 960–1180) */
.ui-login__dock { position: relative; z-index: 1; min-height: 100vh; min-height: 100dvh; display: flex; align-items: center; padding: 24px 24px 24px clamp(24px, 60vw, calc(100vw - 468px)); }
/* stacked (globe.js isStacked): phones, and portrait tablets where side by side would shrink the sphere to a dot */
@media (max-width: 760px), (max-width: 959px) and (min-height: 760px) {
  .ui-login__dock { align-items: flex-end; justify-content: center; padding: 16px; padding-bottom: calc(16px + env(safe-area-inset-bottom)); }
}
</style>

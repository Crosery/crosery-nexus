<script setup lang="ts">
import { computed, ref } from 'vue'
import { TxDrawer } from '@talex-touch/tuffex/drawer'
import { TxIconButton } from '@talex-touch/tuffex/button'
import Icon from '../Icon.vue'
import { useBreakpoint } from '../composables/useBreakpoint'

/**
 * Sheet (DESIGN.md §5.2 feedback/Sheet, motion recipe 9) over TxDrawer: bottom sheet below 960px (grip,
 * drag-to-dismiss past 30% height or 0.5px/ms), right sheet 560px at ≥960; 2px ink edge, sheet surface,
 * scrim without blur. Spring in (600ms), ease-exit out (280ms), scrim 220ms; opacity-only ≤120ms under
 * reduced motion. TxDrawer supplies the dialog role (aria-label = title), focus trap, Esc and focus return
 * to the trigger; the head is ours (sticky inside the scrolling body) so the grip can drive drag-to-dismiss.
 * `en` is accepted for compatibility and not rendered (calm-down: Chinese title only).
 */
const props = withDefaults(
  defineProps<{
    title: string
    en?: string
    side?: 'auto' | 'bottom' | 'right'
    /** right-sheet width / bottom-sheet max height */
    size?: string
    /** bottom sheet height: 'auto' (content, max 92vh) or a fixed CSS length such as '92vh' */
    height?: string
    closeOnMask?: boolean
  }>(),
  { en: undefined, side: 'auto', size: '560px', height: 'auto', closeOnMask: true },
)
const open = defineModel<boolean>({ default: false })
const emit = defineEmits<{ close: [] }>()
const { isMobile } = useBreakpoint()
const bottom = computed(() => props.side === 'bottom' || (props.side === 'auto' && isMobile.value))

/* drag to dismiss (bottom sheets) */
const drag = ref<{ y0: number; t0: number; dy: number; panel: HTMLElement } | null>(null)
function onDown(event: PointerEvent) {
  if (!bottom.value || event.button !== 0) return
  const panel = (event.currentTarget as HTMLElement).closest<HTMLElement>('.tx-drawer__panel')
  if (!panel) return
  ;(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId)
  drag.value = { y0: event.clientY, t0: performance.now(), dy: 0, panel }
  panel.style.transition = 'none'
}
function onMove(event: PointerEvent) {
  const d = drag.value
  if (!d) return
  d.dy = Math.max(0, event.clientY - d.y0)
  d.panel.style.transform = `translate3d(0, ${d.dy}px, 0)`
}
function onUp() {
  const d = drag.value
  if (!d) return
  drag.value = null
  const velocity = d.dy / Math.max(1, performance.now() - d.t0)
  d.panel.style.transition = ''
  d.panel.style.transform = ''
  if (d.dy > d.panel.offsetHeight * 0.3 || velocity > 0.5) close()
}
function close() {
  open.value = false
  emit('close')
}
</script>

<template>
  <TxDrawer
    v-model:visible="open"
    :title="title"
    :direction="bottom ? 'bottom' : 'right'"
    :size="bottom ? height : size"
    :mobile-adapt="false"
    mask-effect="opacity"
    :show-header="false"
    :close-on-click-mask="closeOnMask"
    @close="emit('close')"
  >
    <div class="ui-sheet" :class="{ 'is-bottom': bottom }">
      <div
        class="ui-sheet__head"
        @pointerdown="onDown"
        @pointermove="onMove"
        @pointerup="onUp"
        @pointercancel="onUp"
      >
        <span v-if="bottom" class="ui-sheet__grip" aria-hidden="true" />
        <h2 class="ui-sheet__title">{{ title }}</h2>
        <slot name="head-extra" />
        <TxIconButton class="ui-sheet__x" label="关闭" title="关闭 (Esc)" size="sm" @pointerdown.stop @click="close"><Icon name="x" /></TxIconButton>
      </div>
      <div class="ui-sheet__body"><slot :close="close" /></div>
    </div>
    <template v-if="$slots.footer" #footer>
      <div class="ui-sheet__foot"><slot name="footer" :close="close" /></div>
    </template>
  </TxDrawer>
</template>

<style>
/* TxDrawer renders through a Teleport root, so a class on <TxDrawer> never reaches it: hook on :has(.ui-sheet). */
.tx-drawer:has(.ui-sheet) { --tx-drawer-transition: 280ms var(--ease-exit); --tx-drawer-mask-background: var(--scrim); }
.tx-drawer.tx-drawer--visible:has(.ui-sheet) { --tx-drawer-transition: var(--dur-sheet) var(--ease-spring); }
.tx-drawer:has(.ui-sheet) .tx-drawer__mask { backdrop-filter: none; -webkit-backdrop-filter: none; transition: opacity 220ms var(--ease-swift); }
.tx-drawer:has(.ui-sheet) .tx-drawer__panel { background: var(--sheet); color: var(--ink); max-width: 100vw; }
.tx-drawer--right:has(.ui-sheet) .tx-drawer__panel { border-left: 2px solid var(--ink); box-shadow: var(--shadow-sheet-x); }
.tx-drawer--bottom:has(.ui-sheet) .tx-drawer__panel { border-top: 2px solid var(--ink); border-radius: var(--r-2) var(--r-2) 0 0; box-shadow: var(--shadow-sheet); max-height: 92vh; padding-bottom: env(safe-area-inset-bottom); }
.tx-drawer--bottom:has(.ui-sheet) .tx-drawer__panel { transform: translate3d(0, 104%, 0); }
.tx-drawer--bottom.tx-drawer--visible:has(.ui-sheet) .tx-drawer__panel { transform: translateZ(0); }
.tx-drawer:has(.ui-sheet) .tx-drawer__divider { display: none; }
.tx-drawer:has(.ui-sheet) .tx-drawer__body { padding: 0; }
.tx-drawer:has(.ui-sheet) .tx-drawer__footer { padding: 0; }
.ui-sheet__head { position: sticky; top: 0; z-index: 1; display: flex; align-items: center; gap: 10px; min-height: 52px; padding: 0 12px 0 20px; border-bottom: 1px solid var(--rule); background: var(--sheet); }
.ui-sheet.is-bottom .ui-sheet__head { padding-top: 10px; touch-action: none; cursor: grab; }
.ui-sheet__grip { position: absolute; top: 6px; left: 50%; width: 36px; height: 4px; margin-left: -18px; border-radius: 2px; background: var(--rule-2); }
.ui-sheet__title { flex: 1; min-width: 0; margin: 0; font-size: var(--fs-md); font-weight: 650; display: flex; align-items: baseline; gap: 8px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ui-sheet__body { padding: 16px 20px 20px; }
.ui-sheet__foot { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 8px; padding: 12px 20px; border-top: 1px solid var(--rule); }
@media (pointer: coarse) { .ui-sheet__foot :is(.ui-btn, .tx-button) { min-height: var(--tap); } }
:root[data-motion="reduce"] .tx-drawer:has(.ui-sheet) .tx-drawer__panel { transform: none !important; opacity: 0; transition: opacity 120ms linear !important; }
:root[data-motion="reduce"] .tx-drawer.tx-drawer--visible:has(.ui-sheet) .tx-drawer__panel { opacity: 1; }
</style>

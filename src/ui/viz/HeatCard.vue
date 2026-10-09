<script setup lang="ts">
import { computed, nextTick, ref, shallowRef, watch } from 'vue'
import { TxPopover } from '@talex-touch/tuffex/popover'
import Sheet from '../feedback/Sheet.vue'

/**
 * Frame of the heatmap's day / span card. Desktop: TxPopover anchored to the cell through a virtual reference
 * (portal to body, floating-ui keeps it in the viewport and follows scroll / resize), solid surface, one hairline,
 * soft shadow, no arrow. Phones: the kit bottom Sheet (TxDrawer). The Heatmap owns open / close, Esc and outside
 * clicks (so clicking another cell moves the card instead of closing it) and returns focus to the cell.
 * The slot gets `bare` = true inside the sheet, whose head already shows the title.
 */
const props = defineProps<{ open: boolean; anchor: HTMLElement | null; title: string; sheet: boolean }>()
const emit = defineEmits<{ close: [] }>()

// A refresh can re-render the cell, leaving a detached element whose rect is all zeros (the card then jumps to
// the viewport corner): follow the live cell with the same date, else keep the last real rect.
let lastRect: DOMRect | null = null
function liveAnchor(el: HTMLElement): HTMLElement | null {
  if (el.isConnected) return el
  const date = el.dataset.date
  return date ? document.querySelector<HTMLElement>(`[data-date="${date}"]:not([data-void])`) : null
}
// One virtual reference for the card's whole life, reading whichever cell is current. Swapping it per anchor (and
// unsetting it on close) let TxPopover fall back to its hidden 0×0 reference at the heatmap's left edge, and every
// card opened after a close was placed there.
const current = shallowRef<HTMLElement | null>(props.anchor)
watch(() => props.anchor, (el) => {
  if (el) current.value = el
})
const reference = {
  getBoundingClientRect: () => {
    const live = current.value ? liveAnchor(current.value) : null
    if (live) lastRect = live.getBoundingClientRect()
    return lastRect ?? new DOMRect()
  },
  get contextElement() {
    return current.value ?? undefined
  },
}
const shown = computed(() => props.open && Boolean(props.anchor))

// TxPopover places a virtual reference only on open / scroll / resize; moving to another cell while the card
// stays open must re-run the placement, or the card stays at the previous cell.
const popover = ref<{ updatePosition?: () => void } | null>(null)
watch(() => props.anchor, async (el) => {
  if (!el || !shown.value) return
  await nextTick()
  popover.value?.updatePosition?.()
}, { flush: 'post' })
</script>

<template>
  <Sheet v-if="sheet" :model-value="open" :title="title" side="bottom" @update:model-value="(v: boolean) => { if (!v) emit('close') }">
    <slot :bare="true" />
  </Sheet>
  <TxPopover
    v-else
    ref="popover"
    :model-value="shown"
    trigger="manual"
    :virtual-reference="reference"
    placement="bottom"
    :offset="8"
    :width="288"
    :max-width="288"
    :show-arrow="false"
    panel-variant="solid"
    panel-background="pure"
    panel-shadow="soft"
    :panel-radius="4"
    :panel-padding="0"
    :close-on-click-outside="false"
    :close-on-esc="false"
    :animation="{ type: 'opacity', duration: 140 }"
    @update:model-value="(v: boolean) => { if (!v && shown) emit('close') }"
  >
    <template #reference><span class="ui-hcard__ref" aria-hidden="true" /></template>
    <div class="ui-hcard" :aria-label="title" role="group" tabindex="-1" data-heat-card><slot :bare="false" /></div>
  </TxPopover>
</template>

<style>
.ui-hcard__ref { display: block; width: 0; height: 0; }
.ui-hcard { padding: 14px 14px 12px; background: var(--sheet); color: var(--ink); outline: none; }
</style>

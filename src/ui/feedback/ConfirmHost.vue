<script setup lang="ts">
import { defineAsyncComponent, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { clearConfirmTrigger, confirmState, getConfirmTrigger, settleConfirm } from '../../lib/confirm'

/**
 * The one global confirm host (mount once in App.vue, replaces src/components/ConfirmHost.vue).
 * Keeps the lib/confirm contract: mask / Esc / close all settle as 取消, initial focus on 取消, focus returns
 * to the element that called confirm() (falls back to <main>). The dialog itself (TxModal ≥960, bottom
 * Sheet <960) is loaded on first use, so the entry chunk carries none of its CSS.
 */
const ConfirmSheet = defineAsyncComponent(() => import('./ConfirmSheet.vue'))
const used = ref(confirmState.open)

async function restoreFocus() {
  const trigger = getConfirmTrigger()
  clearConfirmTrigger()
  await nextTick()
  await nextTick()
  if (trigger && trigger.isConnected) {
    trigger.focus()
    if (document.activeElement === trigger) return
  }
  document.querySelector<HTMLElement>('main')?.focus()
}

watch(
  () => confirmState.open,
  (open) => {
    if (open) used.value = true
    else void restoreFocus()
  },
  { flush: 'post' },
)

/* Esc settles as 取消 wherever focus is (TxModal binds Esc to its overlay only). Capture phase + stop so the
   overlay / drawer does not close a second time. */
function onKeydown(event: KeyboardEvent) {
  if (event.key !== 'Escape' || !confirmState.open) return
  event.preventDefault()
  event.stopPropagation()
  settleConfirm(false)
}
onMounted(() => window.addEventListener('keydown', onKeydown, true))
onBeforeUnmount(() => window.removeEventListener('keydown', onKeydown, true))
</script>

<template>
  <ConfirmSheet v-if="used" />
</template>

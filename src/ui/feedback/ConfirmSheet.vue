<script setup lang="ts">
import { computed, nextTick, useTemplateRef, watch } from 'vue'
import { TxModal } from '@talex-touch/tuffex/modal'
import { TxButton } from '@talex-touch/tuffex/button'
import Sheet from './Sheet.vue'
import { confirmState, settleConfirm } from '../../lib/confirm'
import { focusInModal } from '../../lib/focus'
import { useBreakpoint } from '../composables/useBreakpoint'
import type { ConfirmSheetOptions } from './confirmSheet'

/**
 * Confirm dialog body (rendered by ConfirmHost): title, optional body line, facts table, `◆ consequence`,
 * then 取消 + the confirm button. ≥960 a 440px TxModal, <960 a bottom Sheet with 40px actions.
 * Buttons are TxButton: confirm is ink primary; `danger` makes it a signal outline (orange is never a filled button).
 */
const { isMobile } = useBreakpoint()
const opts = computed(() => confirmState.options as ConfirmSheetOptions)
const cancelBtn = useTemplateRef<{ $el?: HTMLElement }>('cancel')

watch(
  () => confirmState.open,
  async (open) => {
    if (!open) return
    await nextTick()
    // TxModal hard-codes aria-label="Close" on its × button
    document.querySelector('.tx-modal__close')?.setAttribute('aria-label', '关闭')
    void focusInModal(cancelBtn.value?.$el, '.ui-confirm__actions button')
  },
  { immediate: true, flush: 'post' },
)

function onVisible(value: boolean) {
  if (!value && confirmState.open) settleConfirm(false)
}
</script>

<template>
  <Sheet v-if="isMobile" :model-value="confirmState.open" :title="opts.title" side="bottom" @update:model-value="onVisible">
    <div class="ui-confirm">
      <p v-if="opts.body" class="ui-confirm__body">{{ opts.body }}</p>
      <dl v-if="opts.facts?.length" class="ui-confirm__facts">
        <template v-for="f in opts.facts" :key="f.k"><dt>{{ f.k }}</dt><dd>{{ f.v }}</dd></template>
      </dl>
      <p v-if="opts.consequence" class="ui-confirm__cons"><span aria-hidden="true">◆</span> {{ opts.consequence }}</p>
      <div class="ui-confirm__actions">
        <TxButton ref="cancel" variant="secondary" @click="settleConfirm(false)">{{ opts.cancelText ?? '取消' }}</TxButton>
        <TxButton :variant="opts.danger ? 'danger' : 'primary'" @click="settleConfirm(true)">{{ opts.confirmText ?? '确定' }}</TxButton>
      </div>
    </div>
  </Sheet>
  <TxModal v-else :model-value="confirmState.open" :title="opts.title" width="min(92vw, 440px)" @update:model-value="onVisible">
    <div class="ui-confirm">
      <p v-if="opts.body" class="ui-confirm__body">{{ opts.body }}</p>
      <dl v-if="opts.facts?.length" class="ui-confirm__facts">
        <template v-for="f in opts.facts" :key="f.k"><dt>{{ f.k }}</dt><dd>{{ f.v }}</dd></template>
      </dl>
      <p v-if="opts.consequence" class="ui-confirm__cons"><span aria-hidden="true">◆</span> {{ opts.consequence }}</p>
    </div>
    <template #footer>
      <div class="ui-confirm__actions">
        <TxButton ref="cancel" variant="secondary" @click="settleConfirm(false)">{{ opts.cancelText ?? '取消' }}</TxButton>
        <TxButton :variant="opts.danger ? 'danger' : 'primary'" @click="settleConfirm(true)">{{ opts.confirmText ?? '确定' }}</TxButton>
      </div>
    </template>
  </TxModal>
</template>

<style>
.ui-confirm { display: grid; gap: 12px; }
.ui-confirm__body { margin: 0; font-size: var(--fs-base); line-height: 1.6; color: var(--ink-2); white-space: pre-line; }
.ui-confirm__facts { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 0; margin: 0; border-top: 1px solid var(--rule); font-size: var(--fs-sm); }
.ui-confirm__facts dt, .ui-confirm__facts dd { margin: 0; padding: 7px 0; border-bottom: 1px solid var(--rule); }
.ui-confirm__facts dt { padding-right: 16px; color: var(--ink-3); white-space: nowrap; }
.ui-confirm__facts dd { color: var(--ink); font-family: var(--font-mono); font-size: var(--fs-sm); overflow-wrap: anywhere; }
.ui-confirm__cons { margin: 0; font-size: var(--fs-sm); color: var(--ink); }
.ui-confirm__cons span { color: var(--signal); }
.ui-confirm__actions { display: flex; justify-content: flex-end; gap: 8px; }
@media (max-width: 959px) {
  .ui-confirm__actions { margin-top: 4px; }
  html:root .ui-confirm__actions .tx-button { flex: 1; min-height: var(--tap); }
}
</style>

<script setup lang="ts">
import { ref, watch } from 'vue'
import { TxModal } from '@talex-touch/tuffex/modal'
import { TxButton } from '@talex-touch/tuffex/button'
import { confirmState, settleConfirm } from '../lib/confirm'
import { focusInModal } from '../lib/focus'

/**
 * 全局唯一的确认框（挂在 App.vue，全站只有一份）。
 *
 * 对照参考实现 `geek_main/app/console/src/components/ConfirmHost.vue:1-38`：
 * - 遮罩点击、Esc、右上角关闭一律按「取消」结束，调用方 `await confirm()` 不会永远挂起；
 * - 初始焦点落在「取消」，破坏性操作不会因为一次回车就执行；
 * - 焦点归还给触发元素由 TxModal 自己完成（`modal/src/TxModal2.vue.js:39-58`）。
 */
const cancelRef = ref<unknown>(null)

watch(
  () => confirmState.open,
  (open) => {
    if (!open) return
    // 遮罩的自动 focus 排在挂载后的 nextTick，这里排在它之后（见 src/lib/focus.ts）。
    void focusInModal(cancelRef.value, '.tx-modal__overlay .confirm-actions button')
  },
  { flush: 'post' },
)

function onVisible(value: boolean) {
  if (!value && confirmState.open) settleConfirm(false)
}
</script>

<template>
  <TxModal
    :model-value="confirmState.open"
    :title="confirmState.options.title"
    width="min(92vw, 440px)"
    @update:model-value="onVisible"
  >
    <p v-if="confirmState.options.body" class="confirm-body">{{ confirmState.options.body }}</p>
    <template #footer>
      <div class="confirm-actions">
        <TxButton ref="cancelRef" variant="secondary" @click="settleConfirm(false)">
          {{ confirmState.options.cancelText ?? '取消' }}
        </TxButton>
        <TxButton
          :variant="confirmState.options.danger ? 'danger' : 'primary'"
          @click="settleConfirm(true)"
        >
          {{ confirmState.options.confirmText ?? '确定' }}
        </TxButton>
      </div>
    </template>
  </TxModal>
</template>

<style scoped>
.confirm-body {
  margin: 0;
  line-height: 22px;
  color: var(--tx-text-color-regular);
  white-space: pre-line;
}
.confirm-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}
</style>

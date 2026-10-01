<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { TxModal } from '@talex-touch/tuffex/modal'
import { TxButton } from '@talex-touch/tuffex/button'
import { clearConfirmTrigger, confirmState, getConfirmTrigger, settleConfirm } from '../lib/confirm'
import { focusInModal } from '../lib/focus'

/**
 * 全局唯一的确认框（挂在 App.vue，全站只有一份）。
 *
 * 对照参考实现 `geek_main/app/console/src/components/ConfirmHost.vue:1-38`：
 * - 遮罩点击、Esc、右上角关闭一律按「取消」结束，调用方 `await confirm()` 不会永远挂起；
 * - 初始焦点落在「取消」，破坏性操作不会因为一次回车就执行；
 * - 关闭后焦点回到**触发元素**（Lead 验收发现：TxModal 自带的还原在部分路径下落到了 body/顶栏，
 *   所以这里用 `confirm()` 同步调用点抓到的元素显式还原；元素已移除时退回页面主区）。
 */
const cancelRef = ref<unknown>(null)

/** 兜底落点：页面主区（ConsoleShell 给了 tabindex="-1"）里的第一个可聚焦控件。 */
function fallbackFocusTarget(): HTMLElement | null {
  const main = document.querySelector<HTMLElement>('.shell__content')
  const focusable = main?.querySelector<HTMLElement>(
    'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
  )
  return focusable ?? main ?? null
}

async function restoreFocus() {
  const trigger = getConfirmTrigger()
  clearConfirmTrigger()
  // 等弹窗卸载后再还焦点，避免被遮罩的收尾逻辑再抢走。
  await nextTick()
  await nextTick()
  if (trigger && trigger.isConnected && typeof trigger.focus === 'function') {
    trigger.focus()
    if (document.activeElement === trigger) return
  }
  fallbackFocusTarget()?.focus()
}

watch(
  () => confirmState.open,
  (open) => {
    if (open) {
      // 遮罩的自动 focus 排在挂载后的 nextTick，这里排在它之后（见 src/lib/focus.ts）。
      void focusInModal(cancelRef.value, '.tx-modal__overlay .confirm-actions button')
    } else {
      void restoreFocus()
    }
  },
  { flush: 'post' },
)

function onVisible(value: boolean) {
  if (!value && confirmState.open) settleConfirm(false)
}

/**
 * Tuffex 的 `TxModal` 把 Escape 绑在遮罩元素上（`node_modules/@talex-touch/tuffex/dist/es/modal/src/TxModal2.vue.js:36-58`）：
 * 焦点一旦不在遮罩子树内（例如 TxModal 自己先把焦点还给了触发按钮），Escape 就不再触发关闭。
 * Lead 实测：同一确认框连按三次 Escape，只有第一次能关，第二、三次焦点已在触发按钮上、弹窗留在原地。
 *
 * 这里在「打开期间」于 window 捕获阶段自行处理 Escape，与焦点落在哪里无关；
 * 捕获阶段处理并 stopPropagation，避免同时触发遮罩的默认关闭导致 settleConfirm 被调用两次。
 */
function onWindowKeydown(event: KeyboardEvent) {
  if (event.key !== 'Escape' || !confirmState.open) return
  event.preventDefault()
  event.stopPropagation()
  settleConfirm(false)
}

onMounted(() => window.addEventListener('keydown', onWindowKeydown, true))
onBeforeUnmount(() => window.removeEventListener('keydown', onWindowKeydown, true))
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

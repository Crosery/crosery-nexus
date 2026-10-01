<script setup lang="ts">
import { computed } from 'vue'
import { TxErrorState } from '@talex-touch/tuffex/error-state'
import { describeError, errorAction } from '../lib/errors'

/**
 * 读取失败时的统一错误态：说清出了什么事、下一步做什么，并给「重试」。
 *
 * 对照参考实现 `geek_main/app/console/src/components/ErrorPanel.vue:1-66`：
 * 参考实现按 ApiError 的 status/code 分类并区分权限不足；本仓库 api 只抛 Error，
 * 分类逻辑收在 `src/lib/errors.ts`，组件只负责渲染与把「重试」接到 `retry` 上。
 */
const props = withDefaults(
  defineProps<{
    error: unknown
    retry?: () => unknown
    /** 覆盖标题（例如「渠道列表加载失败」），正文仍用统一解释。 */
    title?: string
    size?: 'small' | 'medium' | 'large'
  }>(),
  { retry: undefined, title: undefined, size: 'medium' },
)

const view = computed(() => describeError(props.error))
const action = computed(() => errorAction(view.value, Boolean(props.retry)))
const primaryAction = computed(() =>
  action.value ? { label: action.value.label, variant: (action.value.kind === 'retry' ? 'primary' : 'secondary') as 'primary' | 'secondary' } : undefined,
)

function onPrimary() {
  if (action.value?.kind === 'retry') props.retry?.()
  else window.location.reload()
}
</script>

<template>
  <div class="error-panel" role="alert">
    <TxErrorState
      :title="title ?? view.title"
      :description="view.detail"
      :size="size"
      surface="card"
      :primary-action="primaryAction"
      @primary="onPrimary"
    >
      <template v-if="!action" #actions>
        <span class="mono error-panel__trace">{{ view.trace }}</span>
      </template>
    </TxErrorState>
    <p v-if="action" class="mono error-panel__trace error-panel__trace--below">{{ view.trace }}</p>
  </div>
</template>

<style scoped>
.error-panel {
  width: 100%;
}
.error-panel__trace {
  color: var(--tx-text-color-secondary);
  font-size: 12px;
  overflow-wrap: anywhere;
}
.error-panel__trace--below {
  margin: 6px 0 0;
  text-align: center;
}
</style>

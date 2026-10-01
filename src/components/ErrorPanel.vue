<script setup lang="ts">
import { computed } from 'vue'
import { TxErrorState } from '@talex-touch/tuffex/error-state'
import { TxAlert } from '@talex-touch/tuffex/alert'
import { TxButton } from '@talex-touch/tuffex/button'
import { describeError, errorAction } from '../lib/errors'

/**
 * 读取失败时的统一错误态：说清出了什么事、下一步做什么，并给「重试」。
 *
 * 对照参考实现 `geek_main/app/console/src/components/ErrorPanel.vue:1-66`：
 * 参考实现按 ApiError 的 status/code 分类并区分权限不足；本仓库 api 只抛 Error，
 * 分类逻辑收在 `src/lib/errors.ts`，组件只负责渲染与把「重试」接到 `retry` 上。
 *
 * `inline` 变体（第三轮 R2，**有意偏离 TUF**）：TUF 是阻断式的——失败就把内容换成错误卡片。
 * 但运维面板里「刷新失败」时把「最后一次已知良好数据」藏起来，比展示一份带时间戳的陈旧数据更危险，
 * 所以有旧数据时改用顶部非阻断横幅：数据留在原地，横幅说明这次刷新失败并可重试。
 */
const props = withDefaults(
  defineProps<{
    error: unknown
    retry?: () => unknown
    /** 覆盖标题（例如「渠道列表加载失败」），正文仍用统一解释。 */
    title?: string
    size?: 'small' | 'medium' | 'large'
    /** true：非阻断横幅（用于「已有旧数据、本次刷新失败」）。 */
    inline?: boolean
    /** 横幅文案里点名数据的时间口径，例如「上方数据为最近一次成功读取」。 */
    staleHint?: string
  }>(),
  { retry: undefined, title: undefined, size: 'medium', inline: false, staleHint: undefined },
)

const view = computed(() => describeError(props.error))
const action = computed(() => errorAction(view.value, Boolean(props.retry)))
const primaryAction = computed(() =>
  action.value ? { label: action.value.label, variant: (action.value.kind === 'retry' ? 'primary' : 'secondary') as 'primary' | 'secondary' } : undefined,
)
const retryLabel = computed(() => action.value?.label ?? '重试')

function onPrimary() {
  if (action.value?.kind === 'retry') props.retry?.()
  else window.location.reload()
}
</script>

<template>
  <!-- 非阻断横幅：旧数据留在页面上，这里只说清「这次刷新为什么没成功」 -->
  <TxAlert
    v-if="inline"
    type="warning"
    :title="title ?? `本次刷新失败：${view.title}`"
    :closable="false"
    class="error-panel error-panel--inline"
    role="alert"
  >
    <div class="error-panel__inline-body">
      <span>
        {{ view.detail }}<template v-if="staleHint"> {{ staleHint }}</template>
      </span>
      <TxButton v-if="retry" variant="secondary" size="sm" @click="retry">{{ retryLabel }}</TxButton>
    </div>
    <p class="mono error-panel__trace">{{ view.trace }}</p>
  </TxAlert>

  <div v-else class="error-panel" role="alert">
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
.error-panel__inline-body {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px 12px;
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
.error-panel__inline-body + .error-panel__trace {
  margin: 6px 0 0;
}
</style>

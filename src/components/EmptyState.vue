<script setup lang="ts">
import { useRouter } from 'vue-router'
import { TxEmptyState } from '@talex-touch/tuffex/empty-state'

/**
 * 空态：解释「为什么这里是空的」，并给出下一步动作（而不是只留一句「暂无数据」）。
 *
 * 对照参考实现 `geek_main/app/console/src/components/EmptyState` 的使用约定
 * （`geek_main/app/console/src/pages/github/Repos.vue` 等列表页的空态 + 主按钮）。
 * 传了 `to` 就走站内路由，否则把点击交给父组件（`@action`）。
 */
const props = withDefaults(
  defineProps<{
    title: string
    description?: string
    icon?: string
    actionLabel?: string
    /** 站内路由目标；给了就由组件自己跳转。 */
    to?: string
    size?: 'small' | 'medium' | 'large'
    /** 搜索无结果时用它区分「筛掉了」和「本来就没有」。 */
    variant?: 'empty' | 'no-data' | 'search-empty'
  }>(),
  { description: undefined, icon: undefined, actionLabel: undefined, to: undefined, size: 'medium', variant: 'empty' },
)

const emit = defineEmits<{ (e: 'action'): void }>()
const router = useRouter()

const primaryAction = () => (props.actionLabel ? { label: props.actionLabel, variant: 'primary' as const } : undefined)

function onPrimary() {
  if (props.to) void router.push(props.to)
  emit('action')
}
</script>

<template>
  <TxEmptyState
    :variant="variant"
    :title="title"
    :description="description"
    :icon="icon ?? null"
    :size="size"
    surface="plain"
    :primary-action="primaryAction()"
    @primary="onPrimary"
  />
</template>

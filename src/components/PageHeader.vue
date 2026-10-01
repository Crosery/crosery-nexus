<script setup lang="ts">
import { computed } from 'vue'
import { useRouter } from 'vue-router'
import { TxBreadcrumb } from '@talex-touch/tuffex/breadcrumb'

/**
 * 页头：面包屑 + 标题 + 一句说明 + 右侧操作槽。
 *
 * 对照参考实现 `geek_main/app/console/src/components/PageHeader.vue:1-37`：面包屑走站内路由，
 * 不给 TxBreadcrumb 传 href，点击后由 click 事件 router.push，避免整页刷新。
 * 样式复用全局 `src/styles/layout.css:14-48` 的 `.page-head` 规范，页面里不再各写一套标题排版。
 */
export type Crumb = { label: string; to?: string }

const props = defineProps<{
  title: string
  description?: string
  crumbs?: Crumb[]
}>()

const router = useRouter()
const items = computed(() => (props.crumbs ?? []).map((crumb) => ({ label: crumb.label })))

function onCrumb(_item: unknown, index: number) {
  const to = props.crumbs?.[index]?.to
  if (to) void router.push(to)
}
</script>

<template>
  <header class="page-head">
    <div class="page-head__text">
      <TxBreadcrumb v-if="items.length" class="page-head__crumbs" :items="items" @click="onCrumb" />
      <h1>{{ title }}</h1>
      <p v-if="description">{{ description }}</p>
      <slot name="meta" />
    </div>
    <div v-if="$slots.actions" class="page-head__actions">
      <slot name="actions" />
    </div>
  </header>
</template>

<style scoped>
.page-head__crumbs {
  margin-bottom: 6px;
}
</style>

<script lang="ts">
import type { InjectionKey } from 'vue'

/**
 * 「本页被内嵌在别的页面里」的上下文键（R10-F）。
 *
 * 由宿主页面（目前只有 A/B 实验台）`provide(true)`，`PageHeader` 注入后把标题**降级为 h2** ——
 * 一个文档里只能有一个 `<h1>`：`/ab` 内嵌了两个整页变体，如果它们各自还产出 `<h1>`，
 * 屏幕阅读器会在实验台里念出「一级标题：API Key 管理」。
 *
 * 键定义在**组件**里、由 lab 反向 import：依赖方向是「实验台 → 共享组件」，
 * 组件不需要知道实验台的存在。
 */
export const EMBEDDED_HEADING_KEY: InjectionKey<boolean> = Symbol('crosery-embedded-heading')
</script>

<script setup lang="ts">
import { computed, inject } from 'vue'
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
  /**
   * 标题层级（默认 1）。显式传值时**优先于**内嵌上下文：
   * 宿主页面自己那一份页头要写 `:level="1"`，否则会被自己 provide 的降级规则影响。
   */
  level?: number
}>()

/** 被内嵌时自动降级为 h2（见 EMBEDDED_HEADING_KEY）；显式 `level` 优先。 */
const embedded = inject(EMBEDDED_HEADING_KEY, false)
const headingTag = computed(() => `h${props.level ?? (embedded ? 2 : 1)}`)

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
      <component :is="headingTag" class="page-head__title">{{ title }}</component>
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

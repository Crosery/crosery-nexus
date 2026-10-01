<script setup lang="ts">
import { computed, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { TxSidebarNav } from '@talex-touch/tuffex/sidebar-nav'
import type { SidebarNavItem } from '@talex-touch/tuffex/sidebar-nav'
import { TxCardItem } from '@talex-touch/tuffex/card-item'
import { TxButton } from '@talex-touch/tuffex/button'
import { TxAvatar } from '@talex-touch/tuffex/avatar'
import { NAV_AS_SIDEBAR_ITEMS, NAV_GROUPS, NAV_ITEMS } from '../lib/nav'

const emit = defineEmits<{
  navigate: []
  signout: []
}>()

const route = useRoute()
const router = useRouter()
const query = ref('')

/**
 * 分组与条目都来自 `lib/nav.ts`（单一真源）。
 *
 * 这里曾经传 `{ id, label }` 给 `groups`，而 tuffex 的契约是 `SidebarNavGroup = { key, label }`，
 * 条目靠 `item.group === group.key` 归组 ⇒ 一条都匹配不上 ⇒ 五个分类标题全不渲染
 * （用户报的"之前的 tab 分类没了"）。别再改回 `id`。
 */
const groups = NAV_GROUPS
const navEntries = NAV_ITEMS

const items = computed<SidebarNavItem[]>(() => NAV_AS_SIDEBAR_ITEMS)

const active = computed(() => {
  const currentPath = route.path.replace(/^\//, '') || 'dashboard'
  const found = navEntries.find(e => e.id === currentPath)
  // 红队 D32：没有匹配项时**不高亮任何一条**。原来的 `: 'dashboard'` 兜底会让
  // 未登记的路由（或将来新增但忘了加导航的页面）都显示成「运行概览已选中」，
  // 用户会以为自己在这个页面上，是典型的假状态。
  return found ? found.id : ''
})

const workspace = {
  name: 'Crosery API',
  description: 'API Console',
}

function onSelect(item: SidebarNavItem) {
  const target = navEntries.find(entry => entry.id === String(item.value))
  if (!target) return
  void router.push(target.to)
  emit('navigate')
}

function openDocs() {
  window.open('/docs', '_blank')
}
</script>

<template>
  <div class="console-nav">
    <TxSidebarNav
      v-model:query="query"
      :model-value="active"
      :items="items"
      :groups="groups"
      :workspace="workspace"
      aria-label="控制台导航"
      @select="onSelect"
    >
      <template #workspace>
        <TxCardItem
          clickable
          role="link"
          :title="workspace.name"
          :subtitle="workspace.description"
          class="console-nav__brand"
          @click="onSelect({ value: 'dashboard', label: '运行概览' })"
        >
          <template #avatar>
            <div class="console-nav__logo-wrap">
              <i class="i-carbon-cloud-services console-nav__brand-icon" />
            </div>
          </template>
        </TxCardItem>
      </template>

      <template #item-icon="{ item }">
        <i v-if="item.icon" :class="item.icon" aria-hidden="true" />
      </template>

      <template #footer>
        <div class="console-nav__footer">
          <div class="console-nav__me">
            <TxAvatar name="Admin" :size="34" />
            <div class="console-nav__me-text">
              <span class="mono console-nav__login">admin</span>
              <span class="console-nav__role">系统管理员</span>
            </div>
          </div>
          <div class="console-nav__links">
            <TxButton variant="ghost" size="sm" icon="i-carbon-document" @click="openDocs">文档</TxButton>
            <TxButton variant="ghost" size="sm" icon="i-carbon-logout" class="console-nav__signout" @click="emit('signout')">退出</TxButton>
          </div>
        </div>
      </template>
    </TxSidebarNav>
  </div>
</template>

<style scoped>
.console-nav {
  height: 100%;
  --tx-bui-sidebar-nav-width: 100%;
}

.console-nav :deep(.tx-bui-sidebar-nav) {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
}

/*
 * 分组标题（总览 / 接入管理 / …，第 34 轮才真正渲染出来）。
 * tuffex 默认色是 rgb(111,118,153)，在白底上只有 **4.44:1**，差 0.06 不满足 4.5:1；
 * 换成 --tx-text-color-secondary(#535b85) = **6.56:1**。别改回默认色——
 * 那个 4.44 是扫描器 `qa-contrast` 会红的值。
 */
.console-nav :deep(.tx-bui-sidebar-nav__group-label) {
  color: var(--tx-text-color-secondary, #535b85);
}

.console-nav :deep(.tx-bui-sidebar-nav__body) {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  overscroll-behavior: contain;
}

.console-nav__brand {
  margin-bottom: 8px;
  --tx-card-item-gap: 10px;
  --tx-card-item-padding: 6px;
}

.console-nav__logo-wrap {
  width: 32px;
  height: 32px;
  border-radius: 8px;
  background: var(--tx-color-primary);
  color: var(--tx-color-on-primary);
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 18px;
}

.console-nav__brand-icon {
  font-size: 18px;
}

.console-nav__footer {
  flex: none;
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-top: 8px;
  padding: 12px 4px 2px;
  border-top: 1px solid var(--tx-border-color-light);
}

.console-nav__me {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
}

.console-nav__me-text {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 2px;
  min-width: 0;
}

.console-nav__login {
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-weight: 600;
  color: var(--tx-text-color-primary);
}

.console-nav__role {
  font-size: 11px;
  color: var(--tx-text-color-secondary);
}

.console-nav__links {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 4px;
}

.console-nav__links :deep(.tx-button) {
  justify-content: center;
  min-width: 0;
  width: 100%;
}

.console-nav__signout {
  color: var(--tx-text-color-secondary);
}
</style>

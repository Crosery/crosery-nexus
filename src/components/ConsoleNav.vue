<script setup lang="ts">
import { computed, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { TxSidebarNav } from '@talex-touch/tuffex/sidebar-nav'
import type { SidebarNavItem } from '@talex-touch/tuffex/sidebar-nav'
import { TxCardItem } from '@talex-touch/tuffex/card-item'
import { TxButton } from '@talex-touch/tuffex/button'
import { TxAvatar } from '@talex-touch/tuffex/avatar'

const emit = defineEmits<{
  navigate: []
  signout: []
}>()

const route = useRoute()
const router = useRouter()
const query = ref('')

const groups = [
  { id: 'overview', label: '总览' },
  { id: 'access', label: '接入管理' },
  { id: 'analytics', label: '用量分析' },
  { id: 'monitor', label: '运行监控' },
  { id: 'help', label: '帮助' },
]

const navEntries = [
  { value: 'dashboard', label: '运行概览', group: 'overview', icon: 'i-carbon-dashboard', to: '/dashboard' },
  { value: 'keys', label: 'API Key', group: 'access', icon: 'i-carbon-password', to: '/keys' },
  { value: 'channels', label: '渠道账号', group: 'access', icon: 'i-carbon-connection-signal', to: '/channels' },
  { value: 'oauth', label: 'OAuth 登录', group: 'access', icon: 'i-carbon-globe', to: '/oauth' },
  { value: 'models', label: '模型总览', group: 'access', icon: 'i-carbon-chip', to: '/models' },
  { value: 'usage', label: '统计和使用情况', group: 'analytics', icon: 'i-carbon-gauge', to: '/usage' },
  { value: 'charts', label: '图表分析', group: 'analytics', icon: 'i-carbon-chart-line', to: '/charts' },
  { value: 'analytics', label: '请求明细', group: 'analytics', icon: 'i-carbon-data-table', to: '/analytics' },
  { value: 'cache', label: '缓存命中率', group: 'analytics', icon: 'i-carbon-flash', to: '/cache' },
  { value: 'monitor', label: '账号监控', group: 'monitor', icon: 'i-carbon-activity', to: '/monitor' },
  { value: 'help', label: '接入帮助', group: 'help', icon: 'i-carbon-help', to: '/help' },
]

const items = computed<SidebarNavItem[]>(() => {
  return navEntries.map(entry => ({
    value: entry.value,
    label: entry.label,
    group: entry.group,
    icon: entry.icon,
  }))
})

const active = computed(() => {
  const currentPath = route.path.replace(/^\//, '') || 'dashboard'
  const found = navEntries.find(e => e.value === currentPath)
  return found ? found.value : 'dashboard'
})

const workspace = {
  name: 'Crosery API',
  description: 'API Console',
}

function onSelect(item: SidebarNavItem) {
  const target = navEntries.find(entry => entry.value === item.value)
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

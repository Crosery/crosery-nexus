<script setup lang="ts">
import { ref, computed, watch } from 'vue'
import { RouterView, useRoute, useRouter } from 'vue-router'
import { TxDrawer } from '@talex-touch/tuffex/drawer'
import { TxButton } from '@talex-touch/tuffex/button'
import { TxBreadcrumb } from '@talex-touch/tuffex/breadcrumb'
import ConsoleNav from './ConsoleNav.vue'
import VersionWidget from './VersionWidget.vue'
import { api } from '../api'
import { updateAuthState } from '../router'
import { useMediaQuery } from '../lib/viewport'
import { crumbsForPath } from '../lib/breadcrumbs'

const route = useRoute()
const router = useRouter()
const drawerOpen = ref(false)
/**
 * 桌面外壳与移动外壳只挂载一份 VersionWidget：用 `display:none` 藏起来的那份照样会挂载、
 * 照样会打 /api/version，所以按断点条件渲染（`src/lib/viewport.ts`）。
 */
const isMobile = useMediaQuery('(max-width: 900px)')

/**
 * 面包屑来自当前路由（`src/lib/breadcrumbs.ts` 的纯函数），填掉原来只剩注释的
 * `<!-- reserved for breadcrumb or context -->` 位置（红队 D18）。
 */
const crumbs = computed(() => crumbsForPath(route.path).map((crumb) => ({ label: crumb.label })))

function onCrumb(_item: unknown, index: number) {
  const to = crumbsForPath(route.path)[index]?.to
  if (to) void router.push(to)
}

watch(() => route.fullPath, () => {
  drawerOpen.value = false
})

async function signOut() {
  drawerOpen.value = false
  try {
    await api.logout()
  } catch {
    // ignore
  }
  updateAuthState(false)
  void router.replace('/login')
}
</script>

<template>
  <div class="shell">
    <aside class="shell__sidebar">
      <ConsoleNav @signout="signOut" />
    </aside>

    <header class="shell__topbar">
      <TxButton
        variant="ghost"
        icon="i-carbon-menu"
        aria-label="菜单：打开导航"
        @click="drawerOpen = true"
      >
        菜单
      </TxButton>
      <span class="shell__topbar-brand">
        <i class="i-carbon-cloud-services text-lg text-[var(--tx-color-primary)]" aria-hidden="true" />
        <span>Crosery API</span>
      </span>
      <div v-if="isMobile" class="shell__topbar-right">
        <VersionWidget />
      </div>
    </header>

    <TxDrawer
      v-model:visible="drawerOpen"
      title="导航"
      direction="left"
      size="min(300px, 84vw)"
      :mobile-adapt="false"
      :show-footer="false"
    >
      <ConsoleNav @navigate="drawerOpen = false" @signout="signOut" />
    </TxDrawer>

    <main class="shell__main console-ground">
      <header v-if="!isMobile" class="shell__desktop-header">
        <div class="shell__header-left">
          <!-- 面包屑（原来是空注释占位；现在由当前路由推导，站内路由跳转） -->
          <TxBreadcrumb v-if="crumbs.length" :items="crumbs" aria-label="当前位置" @click="onCrumb" />
        </div>
        <div class="shell__header-right">
          <VersionWidget />
        </div>
      </header>

      <div class="shell__content">
        <RouterView />
      </div>
    </main>
  </div>
</template>

<style scoped>
.shell {
  display: grid;
  grid-template-columns: var(--console-sidebar-width) minmax(0, 1fr);
  min-height: 100vh;
}

.shell__sidebar {
  position: sticky;
  top: 0;
  height: 100vh;
  overflow-y: auto;
  padding: 12px 0 12px 12px;
  background: var(--tx-bg-color);
  border-right: 1px solid var(--tx-border-color-light);
}

.shell__topbar {
  display: none;
}

.shell__desktop-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  /* 列向 flex 里 margin:0 auto 会把盒子缩成 fit-content（红队 D20 实测 257px 居中悬浮），
     这里显式撑满并与页面内容同宽同内边距。 */
  width: 100%;
  max-width: 1360px;
  margin: 0 auto;
  padding: 12px 32px;
}

.shell__header-left {
  display: flex;
  align-items: center;
  min-width: 0;
}

.shell__header-right {
  display: flex;
  align-items: center;
  flex: 0 0 auto;
}

.shell__main {
  min-width: 0;
  min-height: 100vh;
  display: flex;
  flex-direction: column;
}

.shell__content {
  flex: 1 1 auto;
  min-width: 0;
}

@media (max-width: 900px) {
  .shell {
    grid-template-columns: minmax(0, 1fr);
  }

  .shell__sidebar {
    display: none;
  }

  .shell__desktop-header {
    display: none;
  }

  .shell__topbar {
    position: sticky;
    top: 0;
    z-index: 50;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    min-height: 52px;
    padding: 6px 14px;
    background: var(--tx-bg-color);
    border-bottom: 1px solid var(--tx-border-color-light);
  }

  .shell__topbar-brand {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    font-weight: 600;
    white-space: nowrap;
    color: var(--tx-text-color-primary);
  }

  .shell__topbar-right {
    display: flex;
    align-items: center;
  }
}
</style>

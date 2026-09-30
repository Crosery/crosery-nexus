<script setup lang="ts">
import { ref, watch } from 'vue'
import { RouterView, useRoute, useRouter } from 'vue-router'
import { TxDrawer } from '@talex-touch/tuffex/drawer'
import { TxButton } from '@talex-touch/tuffex/button'
import ConsoleNav from './ConsoleNav.vue'
import VersionWidget from './VersionWidget.vue'
import { api } from '../api'

const route = useRoute()
const router = useRouter()
const drawerOpen = ref(false)

watch(() => route.fullPath, () => {
  drawerOpen.value = false
})

async function signOut() {
  drawerOpen.value = false
  try {
    await api.login('', '') // clear or invalidate session
  } catch {
    // ignore
  }
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
        aria-label="打开导航"
        @click="drawerOpen = true"
      >
        菜单
      </TxButton>
      <span class="shell__topbar-brand">
        <i class="i-carbon-cloud-services text-lg text-[var(--tx-color-primary)]" />
        <span>Crosery API</span>
      </span>
      <div class="shell__topbar-right">
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
      <header class="shell__desktop-header">
        <div class="shell__header-left">
          <!-- reserved for breadcrumb or context -->
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
  padding: 12px 32px;
  max-width: 1360px;
  margin: 0 auto;
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

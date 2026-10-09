<script setup lang="ts">
import { computed } from 'vue'
import { TxButton } from '@talex-touch/tuffex/button'
import Plate from '../../ui/data/Plate.vue'
import type { DataState } from '../../ui/types'
import type { VersionsData } from '../../types'
import KernelsPanel from './KernelsPanel.vue'

/**
 * 网关 (#gateway; #version still lands here): the relay's kernels (KernelsPanel, `/api/kernels`), or off the relay the
 * one line `/api/version` can say (the shell's 5-minute read, re-read with 刷新), plus the console's own version.
 */
const props = defineProps<{ data: VersionsData | undefined; state: DataState; error: unknown; lastAt: number | null; checking: boolean }>()
const emit = defineEmits<{ retry: []; recheck: [] }>()

const cpa = computed(() => props.data?.cpa ?? null)

const kernelLine = computed(() => {
  const c = cpa.value
  if (!c) return null
  if (c.version === 'offline') return 'CPA · 离线'
  return `CPA ${c.commit && c.commit !== 'unknown' ? c.commit.slice(0, 7) : c.version}`
})

const otherVersions = computed(() => {
  const c = props.data?.console
  return c ? ['Console', c.version, c.releaseId].filter(Boolean).join(' ') : ''
})
</script>

<template>
  <Plate id="gateway" title="网关" class="set-sec set-gw" :state="state" :error="error" :stale-at="lastAt" :rows="6" @retry="emit('retry')">
    <template #actions>
      <TxButton variant="ghost" size="sm" :loading="checking" :disabled="checking" @click="emit('recheck')">刷新</TxButton>
    </template>
    <!-- old deep links (#version, the 概览 to-dos before this section existed) land on the same plate -->
    <span id="version" class="set-gw__anchor" aria-hidden="true" />

    <KernelsPanel>
      <template #fallback>
        <dl class="set-gw__facts">
          <dt>网关内核</dt>
          <dd><span class="num">{{ kernelLine ?? '—' }}</span></dd>
        </dl>
      </template>
    </KernelsPanel>

    <p v-if="otherVersions" class="set-gw__other num">{{ otherVersions }}</p>
  </Plate>
</template>

<style>
/* a text button: no resting fill (tuffex's fake-background layer), the fill only on hover */
.set-gw .tx-button.variant-ghost { --fake-opacity: 0; }
.set-gw__anchor { display: block; height: 0; scroll-margin-top: calc(var(--head) + 16px); }
.set-gw__facts { display: grid; grid-template-columns: 72px minmax(0, 1fr); gap: 2px 20px; margin: 0; padding: 4px 0 2px; font-size: var(--fs-sm); }
.set-gw__facts dt, .set-gw__facts dd { margin: 0; min-height: 30px; display: flex; align-items: center; min-width: 0; }
.set-gw__facts dt { color: var(--ink-3); white-space: nowrap; }
.set-gw__facts dd { flex-wrap: wrap; gap: 2px 14px; color: var(--ink); }
.set-gw__other { margin: 10px 0 0; padding-top: 10px; border-top: 1px solid var(--rule); font-size: var(--fs-xs); color: var(--ink-3); overflow-wrap: anywhere; }

@media (max-width: 959px) {
  .set-gw__anchor { scroll-margin-top: calc(var(--head) + var(--ticker) + 12px); }
}
@media (max-width: 599px) {
  .set-gw__facts { grid-template-columns: minmax(0, 1fr); gap: 0; }
  .set-gw__facts dt { min-height: 0; padding-top: 10px; font-size: var(--fs-xs); }
  .set-gw__facts dd { min-height: 26px; }
}
</style>

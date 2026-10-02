<script setup lang="ts">
import { TxButton } from '@talex-touch/tuffex/button'
import Icon from '../../ui/Icon.vue'
import { fmtCountdownClock } from '../../ui/composables/useNow'
import type { SyncJob } from '../../types'
import type { JobAction } from './settingsModel'

/**
 * The one control per sync job (DESIGN §6.8): 立即同步 · 冷却 mm:ss (disabled, says why) · 运行中 / 已提交
 * (disabled) · a quiet word for jobs the console cannot trigger. Shared by the table row and the phone card.
 */
defineProps<{ job: SyncJob; label: string; action: JobAction; pending: boolean; now: number }>()
const emit = defineEmits<{ run: [] }>()
</script>

<template>
  <TxButton
    v-if="action.kind === 'run'"
    class="set-act"
    size="sm"
    variant="secondary"
    :disabled="pending"
    :aria-label="`立即同步 ${label}`"
    @click="emit('run')"
  >
    <Icon name="refresh" :size="13" />{{ pending ? '请求中' : action.label }}
  </TxButton>
  <TxButton
    v-else-if="action.kind === 'cooldown'"
    class="set-act"
    size="sm"
    variant="secondary"
    disabled
    title="手动同步冷却中 · 避免频繁请求上游"
    :aria-label="`${label} 手动同步冷却中，剩余 ${fmtCountdownClock(action.until - now)}`"
  >
    {{ action.label }} <span class="num">{{ fmtCountdownClock(action.until - now) }}</span>
  </TxButton>
  <TxButton v-else-if="action.kind === 'running'" class="set-act" size="sm" variant="secondary" disabled>{{ action.label }}</TxButton>
  <!-- disabled jobs: the status already says 停用, so no second word here -->
  <span v-else-if="job.state !== 'disabled'" class="set-act-ro" :title="job.kind === 'external' ? '外部任务 · 由系统定时运行，控制台只读' : undefined">
    {{ job.kind === 'external' ? '只读' : action.label }}
  </span>
</template>

<style>
html:root .tx-button.set-act { min-width: 88px; }
html:root .tx-button.set-act .num { font-size: var(--fs-xs); }
.set-act-ro { font-size: var(--fs-xs); color: var(--ink-3); white-space: nowrap; }
</style>

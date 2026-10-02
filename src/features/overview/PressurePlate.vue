<script setup lang="ts">
import { computed } from 'vue'
import { RouterLink, useRouter } from 'vue-router'
import Plate from '../../ui/data/Plate.vue'
import RowTable from '../../ui/data/RowTable.vue'
import StatusMark from '../../ui/data/StatusMark.vue'
import EmailIdentity from '../../ui/data/EmailIdentity.vue'
import ProviderMark from '../../ui/data/ProviderMark.vue'
import TickMeter from '../../ui/viz/TickMeter.vue'
import CountdownPie from '../../ui/viz/CountdownPie.vue'
import { useBreakpoint } from '../../ui/composables/useBreakpoint'
import { fmtInt, fmtTime } from '../../ui/fmt'
import type { DataState, RowColumn } from '../../ui/types'
import type { PressureRow } from './model'

/**
 * 账号额度压力 (DESIGN §6.2): each account's tightest window, tightest first. A cooldown is an ink pie with
 * its countdown (self-healing → never orange); exhausted windows and auth failures carry the signal mark.
 */
const props = defineProps<{ rows: PressureRow[]; state: DataState; error?: unknown; staleAt?: number | null }>()
const emit = defineEmits<{ retry: [] }>()
const router = useRouter()
const { width, isMobile } = useBreakpoint()
/** md (960–1179) keeps the identity readable: 56px meter instead of 84 (both multiples of 4) */
const meterW = computed(() => (width.value >= 960 && width.value < 1180 ? 56 : 84))

const shown = computed(() => props.rows.slice(0, isMobile.value ? 5 : 8))
const plan = (r: PressureRow) => [r.provider, r.plan, r.credits ? `重置 ${r.credits} 次` : ''].filter(Boolean).join(' · ')
const toneOf = (r: PressureRow) => (r.state === 'bad' ? 'attn' : r.state === 'cool' ? 'cool' : r.disabled ? 'off' : null)
/** three columns: who (provider mark + identity), the tightest window's meter (window code as its label), state */
const columns = computed<RowColumn<PressureRow>[]>(() => [
  { key: 'email', title: '账号', minWidth: 120 },
  { key: 'meter', title: '最紧窗口', width: meterW.value + 80 },
  { key: 'tail', title: '状态', width: 100, align: 'right' },
])
</script>

<template>
  <Plate title="账号额度压力" class="ov-press" :state="state" :error="error" :stale-at="staleAt" :rows="6" :cols="['1fr', '170px', '96px']" empty-text="没有接入账号" empty-action="添加账号" @retry="emit('retry')" @empty-action="router.push('/accounts?add=1')">
    <template #meta>
      <RouterLink to="/accounts" class="ui-link">{{ fmtInt(rows.length) }} 个账号 →</RouterLink>
    </template>
    <RowTable :columns="columns" :data="shown" row-key="id" density="dense" :row-tone="toneOf" caption="账号额度压力">
      <template #cell-email="{ row }">
        <span class="ov-press__who">
          <ProviderMark :provider="row.provider" :size="18" :label="row.provider" />
          <EmailIdentity class="ov-press__id" :email="row.email" :struck="row.state === 'bad' && row.stateLabel === '失效'" />
        </span>
      </template>
      <template #cell-meter="{ row }">
        <TickMeter v-if="row.window" class="ov-press__meter" :value="row.window.ratio" :label="row.window.short" :width="meterW" :aria-label="`${row.email} ${row.window.label}`" />
        <span v-else class="dim">{{ row.error ? '额度读取失败' : '无窗口' }}</span>
      </template>
      <template #cell-tail="{ row }">
        <span class="ov-press__tail">
          <CountdownPie v-if="row.coolUntil" :until="row.coolUntil" />
          <StatusMark v-else-if="row.state !== 'run'" :state="row.state" :label="row.stateLabel" />
          <span v-else-if="row.window?.resetsAt" class="num dim">↻ {{ fmtTime(row.window.resetsAt) }}</span>
        </span>
      </template>

      <template #card="{ row }">
        <div class="ui-rcard__l1">
          <span class="ui-rcard__primary ov-press__cardid">
            <ProviderMark :provider="row.provider" :size="18" :label="row.provider" />
            <EmailIdentity class="ov-press__id" :email="row.email" :line2="plan(row)" :struck="row.state === 'bad' && row.stateLabel === '失效'" />
          </span>
          <span class="ov-press__tail">
            <CountdownPie v-if="row.coolUntil" :until="row.coolUntil" />
            <StatusMark v-else-if="row.state !== 'run'" :state="row.state" :label="row.stateLabel" />
            <span v-else-if="row.window?.resetsAt" class="num dim">↻ {{ fmtTime(row.window.resetsAt) }}</span>
          </span>
        </div>
        <div class="ui-rcard__ln ov-press__cardln">
          <TickMeter v-if="row.window" class="ov-press__meter" :value="row.window.ratio" :label="row.window.short" fluid :aria-label="`${row.email} ${row.window.label}`" />
          <span v-else class="dim">{{ row.error ? '额度读取失败' : '无窗口' }}</span>
        </div>
      </template>
    </RowTable>
  </Plate>
</template>

<style>
.ov-press__who { display: flex; align-items: center; gap: 10px; min-width: 0; }
.ov-press__id { min-width: 0; }
.ov-press__meter .ui-tm__k { min-width: 4ch; text-align: right; }
.ov-press__tail { display: inline-flex; justify-content: flex-end; font-size: var(--fs-xs); white-space: nowrap; }
.ov-press__cardid { gap: 10px; }
.ov-press__cardln { padding-left: 28px; }
</style>

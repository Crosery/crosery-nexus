<script setup lang="ts">
/**
 * Magpie 内核更新：检查（只读）→ 临时目录演练 → 显式确认替换。
 *
 * 状态来自 `scripts/magpie-update.mjs status`（经 `/api/magpie/update-status`）。**真替换需要显式确认**：`apply`
 * 只在 ConfirmSheet 确认后才发出，且只有发布源的版本与当前不同才可点；能力不可用、或没有配置发布源（三步一定以
 * 「缺少发布源」失败）时三步全部禁用并说明原因。上游最新 / 上次检查由上方的事实行给出（上游检查器），这里只报
 * 更新脚本自己做过的事，两边不会各说各的。
 */
import { computed } from 'vue'
import { TxButton } from '@talex-touch/tuffex/button'
import StatusMark from '../../ui/data/StatusMark.vue'
import { confirmSheet } from '../../ui/feedback/confirmSheet'
import { fmtTime } from '../../ui/fmt'
import type { StatusKind } from '../../ui/types'
import type { MagpieUpdateStatus } from '../../types'
import { UPDATE_RESULT_WORD, shortRev } from './settingsModel'

const props = defineProps<{
  /** `/api/magpie/update-status`；null = 还没读过 */
  status: MagpieUpdateStatus | null
  /** 服务端能力是否可用（脚本存在 + 能读状态）；false 时禁用所有按钮并说明原因 */
  available?: boolean
  /** 能力不可用的原因（服务端原文） */
  reason?: string | null
  /** 正在执行的动作；null = 空闲 */
  busy?: 'check' | 'rehearse' | 'apply' | null
}>()

const emit = defineEmits<{ check: []; rehearse: []; apply: [] }>()

/** `releaseSource: null` = the server said no source is configured; a missing field (older server) is not a no */
const noSource = computed(() => props.status?.releaseSource === null)
const off = computed(() => props.available === false || noSource.value)
const current = computed(() => shortRev(props.status?.currentVersion) ?? '未知')
const target = computed(() => shortRev(props.status?.latestVersion))
const updateAvailable = computed(() => Boolean(props.status?.latestVersion && props.status.currentVersion && props.status.latestVersion !== props.status.currentVersion))

/** what the update script itself last did; nothing when it never ran (the facts above already say what upstream has) */
const last = computed<{ state: StatusKind; label: string; detail: string } | null>(() => {
  const value = props.status?.lastResult
  if (!value) return null
  const label = UPDATE_RESULT_WORD[value] ?? value
  const at = props.status?.lastCheckedAt ? fmtTime(props.status.lastCheckedAt) : ''
  const detail = [at, target.value ? `发布源 ${target.value}` : ''].filter(Boolean).join(' · ')
  if (value === 'failed-before-swap' || value === 'rolled-back') return { state: 'bad', label, detail }
  if (value === 'update-available') return { state: 'pause', label, detail }
  return { state: 'run', label, detail }
})

const steps = computed(() => [
  { id: 'check' as const, label: '检查', note: '只读 · 对比发布源的版本', disabled: off.value || props.busy != null, danger: false },
  { id: 'rehearse' as const, label: '演练', note: '临时目录跑完整流程 · 不动运行中的内核', disabled: off.value || props.busy != null, danger: false },
  {
    id: 'apply' as const,
    label: '替换…',
    note: updateAvailable.value ? '先备份 · 失败自动回滚 · 需确认' : '发布源有新版本后才可替换',
    disabled: off.value || props.busy != null || !updateAvailable.value,
    danger: true,
  },
])

async function act(id: 'check' | 'rehearse' | 'apply') {
  if (id !== 'apply') return emit(id)
  const ok = await confirmSheet({
    title: '替换正在运行的内核？',
    facts: [
      { k: '当前', v: current.value },
      { k: '目标', v: target.value ?? '未知' },
      { k: '备份', v: '替换前备份当前二进制' },
      { k: '失败', v: '自动回滚到备份' },
    ],
    consequence: '替换期间网关会短暂重启 · 正在进行的请求可能中断',
    confirmText: '替换内核',
    danger: true,
  })
  if (ok) emit('apply')
}
</script>

<template>
  <div class="set-upd">
    <div class="set-upd__row">
      <TxButton
        v-for="s in steps"
        :key="s.id"
        size="sm"
        :variant="s.danger && !s.disabled ? 'danger' : 'secondary'"
        :disabled="s.disabled"
        :loading="busy === s.id"
        :title="s.note"
        :aria-label="`${s.label.replace('…', '')}：${s.note}`"
        @click="act(s.id)"
      >
        {{ s.label }}
      </TxButton>
      <span v-if="last" class="set-upd__last">
        <StatusMark :state="last.state" :label="last.label" />
        <span v-if="last.detail" class="num dim">{{ last.detail }}</span>
      </span>
    </div>
    <p v-if="available === false" class="set-upd__line"><span aria-hidden="true">⊘</span> 这台机器不能更新内核{{ reason ? ` · ${reason}` : '' }}</p>
    <p v-else-if="noSource" class="set-upd__line"><span aria-hidden="true">⊘</span> 没有配置发布源（MAGPIE_RELEASE_SOURCE 或 MAGPIE_SOURCE）· 三步暂不可用 · 上游检查照常</p>
    <p v-if="status?.backupPath" class="set-upd__line"><span class="dim">回滚备份</span><code>{{ status.backupPath }}</code></p>
    <p v-if="status?.error" class="set-upd__line is-hot"><span aria-hidden="true">◆</span> 上次失败 · {{ status.error }} · 旧版本仍在运行</p>
  </div>
</template>

<style>
.set-upd { display: grid; gap: 6px; min-width: 0; }
.set-upd__row { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 8px; }
.set-upd__last { display: inline-flex; align-items: center; gap: 8px; margin-left: 8px; font-size: var(--fs-xs); }
.set-upd__line { margin: 0; display: flex; gap: 6px; align-items: baseline; font-size: var(--fs-xs); color: var(--ink-2); min-width: 0; overflow-wrap: anywhere; }
.set-upd__line code { font-family: var(--font-mono); font-size: var(--fs-xs); color: var(--ink-2); background: none; padding: 0; overflow-wrap: anywhere; }
.set-upd__line.is-hot { color: var(--signal-ink); }
</style>

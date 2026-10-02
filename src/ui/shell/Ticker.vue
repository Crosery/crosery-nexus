<script setup lang="ts">
import { computed } from 'vue'
import { useNow } from '../composables/useNow'
import { clockParts, fmtInt, fmtPct } from '../fmt'
import type { ShellRole, ShellStatus } from '../types'

/**
 * Mobile ticker (DESIGN.md §4.2, <960): 24px sticky line under the top bar, mono 11px on paper-2.
 *   admin: ADMIN · 网关 94.8 rpm · 99.41% · 同步 ●4 ◇1 · 14:32:08
 *   key:   KEY · growth-team-batch · 今日 $38.20/$50 · 14:32:11   (keeps spend vs limit visible)
 * It never scrolls sideways: the middle segment truncates with an ellipsis, role and clock stay. For a key the
 * name is what gives way — today's spend vs. the limit always stays readable.
 */
const props = withDefaults(defineProps<{ role: ShellRole; status?: ShellStatus }>(), { status: () => ({}) })
const now = useNow()
const clock = computed(() => {
  const p = clockParts(now.value)
  return p ? `${p.hour}:${p.minute}:${p.second}` : ''
})
const keySpend = computed(() => {
  const k = props.status.key
  if (!k?.today) return ''
  return `今日 ${k.today}${k.limit ? `/${k.limit}` : ''}`
})
const keyBad = computed(() => {
  const st = props.status.key?.state
  return st === 'bad' || st === 'off' ? props.status.key?.stateLabel ?? '' : ''
})
const middle = computed(() => {
  const s = props.status
  if (props.role === 'key') return ''
  const parts: string[] = []
  if (s.gateway) {
    parts.push(`网关 ${s.gateway.rpm == null ? '—' : fmtInt(s.gateway.rpm)} rpm${s.gateway.successRate != null ? ` · ${fmtPct(s.gateway.successRate, 2)}` : ''}`)
  }
  if (s.sync?.length) {
    const ok = s.sync.filter((j) => j.state === 'ok' || j.state === 'running').length
    const bad = s.sync.filter((j) => j.state === 'backoff' || j.state === 'failed').length
    parts.push(`同步 ●${ok}${bad ? ` ◇${bad}` : ''}`)
  }
  return parts.join(' · ')
})
</script>

<template>
  <div class="ui-ticker" role="status" aria-live="off">
    <span class="ui-ticker__role">{{ role === 'admin' ? 'ADMIN' : 'KEY' }}</span>
    <template v-if="role === 'key'">
      <span class="ui-ticker__mid is-key">{{ status.key?.name ?? '' }}</span>
      <span v-if="keyBad" class="ui-ticker__bad"><span aria-hidden="true">◆</span> {{ keyBad }}</span>
      <span v-if="keySpend" class="ui-ticker__keep">· {{ keySpend }}</span>
    </template>
    <span v-else class="ui-ticker__mid">{{ middle }}</span>
    <span class="ui-ticker__clock">{{ clock }}</span>
  </div>
</template>

<style>
.ui-ticker {
  position: sticky; top: calc(var(--head) + env(safe-area-inset-top)); z-index: calc(var(--z-head) - 1); height: var(--ticker);
  display: flex; align-items: center; gap: 8px; padding: 0 var(--page-x); overflow: hidden;
  background: var(--paper-2); border-bottom: 1px solid var(--rule);
  font-family: var(--font-mono); font-size: var(--fs-xs); color: var(--ink-2); white-space: nowrap;
}
.ui-ticker__role { flex: none; padding: 0 5px; background: var(--ink); color: var(--paper); font-weight: 600; letter-spacing: .06em; line-height: 16px; }
.ui-ticker__mid { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; }
.ui-ticker__mid.is-key { flex: 0 1 auto; color: var(--ink); }
.ui-ticker__keep { flex: none; color: var(--ink); }
.ui-ticker__bad { flex: none; color: var(--signal-ink); }
.ui-ticker__clock { flex: none; margin-left: auto; color: var(--ink-3); }
</style>

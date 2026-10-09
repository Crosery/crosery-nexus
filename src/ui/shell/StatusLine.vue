<script setup lang="ts">
import { computed } from 'vue'
import { RouterLink } from 'vue-router'
import { useNow } from '../composables/useNow'
import { clockParts, fmtDuration, fmtInt } from '../fmt'
import Kbd from '../form/Kbd.vue'
import type { ShellRole, ShellStatus } from '../types'

/**
 * Statusline (DESIGN.md §4.1, desktop ≥960): 24px fixed bottom bar, paper-2, top rule, mono 11px ink-3 with
 * ink-2 values; segments split by │. Admin:
 *   ADMIN │ 网关 ● 94.8 rpm · p95 6.41s │ 同步 ▮▮▯▮▮ … │ cpa v8.0.21 · RTK 开 │ ⌘K 命令 · 1–7 跳转 · T 主题 · M 脱敏 │ 14:32:08 CST
 * Key: KEY │ name │ 今日 $38.20 / $50.00 · 本周 85% · 可用模型 24 │ 1–4 跳转 · T 主题 │ 14:32:11 CST
 * Sync squares: ok ink-3, running blinks, backoff orange, failed an orange diamond; each links to
 * /settings#sync and carries its detail as title.
 */
const props = withDefaults(defineProps<{ role: ShellRole; status?: ShellStatus; syncTo?: string }>(), { status: () => ({}), syncTo: '/settings#sync' })
const now = useNow()
const clock = computed(() => {
  const p = clockParts(now.value)
  return p ? `${p.hour}:${p.minute}:${p.second} CST` : ''
})
const gw = computed(() => props.status.gateway ?? null)
</script>

<template>
  <footer class="ui-sl" aria-label="状态栏">
    <span class="ui-sl__role">{{ role === 'admin' ? 'ADMIN' : 'KEY' }}</span>
    <template v-if="role === 'admin'">
      <span v-if="gw" class="ui-sl__seg" :class="{ 'is-stale': gw.stale }">
        网关 <i class="ui-sl__dot" aria-hidden="true" />
        <b>{{ gw.rpm == null ? '—' : fmtInt(gw.rpm) }}</b> rpm<template v-if="gw.p95Ms != null"> · p95 <b>{{ fmtDuration(gw.p95Ms) }}</b></template>
      </span>
      <span v-if="status.sync?.length || status.syncText" class="ui-sl__seg">
        同步
        <span v-if="status.sync?.length" class="ui-sl__sync">
          <RouterLink v-for="j in status.sync" :key="j.id" :to="syncTo" class="ui-sl__sq" :class="`is-${j.state}`" :title="`${j.label}${j.detail ? ' · ' + j.detail : ''}`" :aria-label="`${j.label} ${({ ok: '正常', running: '同步中', backoff: '退避', failed: '失败', idle: '空闲' })[j.state]}`" />
        </span>
        <span v-if="status.syncText" class="ui-sl__txt">{{ status.syncText }}</span>
      </span>
      <span v-if="status.kernel || status.rtk != null" class="ui-sl__seg">
        <template v-if="status.kernel">{{ status.kernel }}</template>
        <template v-if="status.kernel && status.rtk != null"> · </template><template v-if="status.rtk != null">RTK <b>{{ status.rtk ? '开' : '关' }}</b></template>
      </span>
      <span class="ui-sl__seg ui-sl__keys"><Kbd keys="mod+k" /> 命令 · 1–7 跳转 · T 主题 · M 脱敏</span>
    </template>
    <template v-else>
      <span v-if="status.key" class="ui-sl__seg"><b>{{ status.key.name }}</b></span>
      <span v-if="status.key" class="ui-sl__seg">
        <template v-if="status.key.today">今日 <b>{{ status.key.today }}</b><template v-if="status.key.limit"> / {{ status.key.limit }}</template></template>
        <template v-if="status.key.week"> · 本周 <b>{{ status.key.week }}</b></template>
        <template v-if="status.key.models != null"> · 可用模型 <b>{{ status.key.models }}</b></template>
      </span>
      <span class="ui-sl__seg ui-sl__keys">1–4 跳转 · T 主题</span>
    </template>
    <span class="ui-sl__seg ui-sl__clock">{{ clock }}</span>
  </footer>
</template>

<style>
.ui-sl {
  position: fixed; left: 0; right: 0; bottom: 0; z-index: var(--z-head); height: var(--statusline);
  display: flex; align-items: center; gap: 0; padding: 0 0 0 0; overflow: hidden;
  background: var(--paper-2); border-top: 1px solid var(--rule);
  font-family: var(--font-mono); font-size: var(--fs-xs); color: var(--ink-3); white-space: nowrap;
}
.ui-sl b { font-weight: 500; color: var(--ink-2); }
.ui-sl__role { flex: none; align-self: stretch; display: inline-flex; align-items: center; padding: 0 10px; background: var(--ink); color: var(--paper); font-weight: 600; letter-spacing: .08em; }
.ui-sl__seg { flex: 0 1 auto; display: inline-flex; align-items: center; gap: 5px; padding: 0 12px; border-right: 1px solid var(--rule-2); min-width: 0; overflow: hidden; }
.ui-sl__seg > * { flex: none; }
.ui-sl__seg.is-stale b { color: var(--ink-3); }
.ui-sl__dot { width: 6px; height: 6px; border-radius: 50%; background: var(--ink); }
.ui-sl__seg.is-stale .ui-sl__dot { background: transparent; border: 1px dashed var(--ink-3); }
.ui-sl__sync { display: inline-flex; gap: 2px; }
.ui-sl__sq { width: 6px; height: 9px; background: var(--ink-3); display: inline-block; }
.ui-sl__sq.is-idle { background: var(--rule-2); }
.ui-sl__sq.is-running { background: var(--ink); animation: ui-blink 1.2s steps(1) infinite; }
.ui-sl__sq.is-backoff { background: var(--signal); }
.ui-sl__sq.is-failed { width: 7px; height: 7px; margin: 0 1px; background: var(--signal); transform: rotate(45deg); }
.ui-sl__sq:focus-visible { outline-offset: 1px; }
.ui-sl__seg > .ui-sl__txt { flex: 0 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ui-sl__keys .ui-kbd { height: 15px; border-bottom-width: 1px; }
.ui-sl__clock { flex: none; margin-left: auto; border-right: 0; color: var(--ink-2); }
:root[data-hidden] .ui-sl__sq.is-running { animation-play-state: paused; }
@media (max-width: 1279px) { .ui-sl__keys { display: none; } }
</style>

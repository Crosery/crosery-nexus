<script setup lang="ts">
import { computed, toRef } from 'vue'
import { TxDotIndicator } from '@talex-touch/tuffex/dot-indicator'
import { useLiveRing } from '../composables/useLiveRing'
import type { StatusKind } from '../types'

/**
 * Status = shape + word, never colour alone (DESIGN.md §2.2), on TxDotIndicator (a naked dot + label; the
 * shape is CSS on its dot — TxStatusBadge's tinted chip would be decoration).
 *   run  ● filled ink (live: one ring / 2.4s, ≤6 rings per screen)   busy ◜ spinning arc
 *   pause ○ hollow ink-3   idle/off ◌ dashed ink-4   cool ◔ ink-2 pie draining (self-healing → not orange)
 *   warn ◇ hollow signal diamond   bad ◆ filled signal diamond   stale ◌ dashed ink-3
 */
const props = withDefaults(
  defineProps<{
    state: StatusKind
    label?: string
    live?: boolean
    /** cooldown time left as a ratio 1 → 0 (CountdownPie semantics) */
    progress?: number
    /** mark only (the word goes to aria-label) */
    bare?: boolean
  }>(),
  { label: undefined, live: false, progress: 1, bare: false },
)

const WORDS: Record<StatusKind, string> = {
  run: '运行', busy: '同步中', pause: '暂停', idle: '空闲', off: '停用', cool: '冷却', warn: '注意', bad: '失效', stale: '陈旧',
}
const word = computed(() => props.label ?? WORDS[props.state])
const liveOn = computed(() => props.live && props.state === 'run')
const animated = useLiveRing(toRef(() => liveOn.value))
const pie = computed(() => `${Math.round(Math.max(0, Math.min(1, props.progress)) * 360)}deg`)
</script>

<template>
  <TxDotIndicator
    class="ui-st"
    :class="[`ui-st--${state}`, { 'is-bare': bare, 'is-live': liveOn && animated, 'is-halo': liveOn && !animated }]"
    :size="7"
    color="var(--ink)"
    :label="bare ? undefined : word"
    :aria-label="bare ? word : undefined"
    :style="state === 'cool' ? { '--pie': pie } : undefined"
  />
</template>

<style>
html:root .ui-st { display: inline-flex; align-items: center; gap: 6px; font-size: var(--fs-sm); line-height: 1.4; white-space: nowrap; color: var(--ink-2); min-width: 0; }
html:root .ui-st .tx-bui-dot-indicator__label { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
html:root .ui-st .tx-bui-dot-indicator__dot { position: relative; box-sizing: border-box; background: var(--ink); color: var(--ink); }
html:root .ui-st--busy .tx-bui-dot-indicator__dot { background: transparent; border: 1.25px solid var(--ink); border-right-color: transparent; animation: ui-spin .9s linear infinite; }
html:root .ui-st--pause { color: var(--ink-3); }
html:root .ui-st--pause .tx-bui-dot-indicator__dot { background: transparent; border: 1.25px solid var(--ink-3); }
html:root .ui-st--idle, html:root .ui-st--off, html:root .ui-st--stale { color: var(--ink-3); }
html:root :is(.ui-st--idle, .ui-st--off) .tx-bui-dot-indicator__dot { background: transparent; border: 1.25px dashed var(--ink-4); }
html:root .ui-st--stale .tx-bui-dot-indicator__dot { background: transparent; border: 1.25px dashed var(--ink-3); }
html:root .ui-st--cool .tx-bui-dot-indicator__dot { background: conic-gradient(var(--ink-2) 0 var(--pie, 360deg), transparent var(--pie, 360deg) 360deg); border: 1.25px solid var(--ink-2); }
html:root .ui-st--warn, html:root .ui-st--bad { color: var(--signal-ink); }
html:root :is(.ui-st--warn, .ui-st--bad) .tx-bui-dot-indicator__dot { width: 6.5px; height: 6.5px; border-radius: 1px; transform: rotate(45deg); }
html:root .ui-st--warn .tx-bui-dot-indicator__dot { background: transparent; border: 1.25px solid var(--signal); }
html:root .ui-st--bad .tx-bui-dot-indicator__dot { background: var(--signal); }
/* live ring (run + live): same recipe as motion.css .ui-live / .ui-halo, drawn on the tuffex dot */
html:root .ui-st.is-live .tx-bui-dot-indicator__dot::after { content: ""; position: absolute; inset: -1px; border-radius: 50%; border: 1px solid var(--ink); animation: ui-pulse 2.4s var(--ease-swift) infinite; }
html:root .ui-st.is-halo .tx-bui-dot-indicator__dot::after { content: ""; position: absolute; inset: -3px; border-radius: 50%; background: var(--ink); opacity: .14; }
:root[data-hidden] .ui-st.is-live .tx-bui-dot-indicator__dot::after { animation-play-state: paused; }
:root:is([data-motion="reduce"], [data-capture]) .ui-st.is-live .tx-bui-dot-indicator__dot::after { animation: none !important; inset: -3px; border: 0; background: var(--ink); opacity: .14; }
</style>

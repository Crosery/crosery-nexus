<script setup lang="ts">
import { computed, useTemplateRef } from 'vue'
import { useElementWidth } from '../../ui/composables/useElementWidth'
import { fmtDuration, fmtTime } from '../../ui/fmt'
import { lanePulses, laneX, type SyncJobLike } from './settingsModel'

/**
 * One job's timing lane (DESIGN §6.8), drawn quiet so only what needs a look stands out: a healthy run is a
 * short ink-3 tick on one hairline, partial/failed runs are taller (partial ink, failed signal), skipped is a
 * stub, the next run is a hollow ghost, a backoff window is a signal segment on the line and the now-cursor is
 * the only signal rule. No hatch, no dotted baseline. Local because the kit TimingLanes draws every job in one
 * block with its own axis.
 */
const props = withDefaults(defineProps<{ job: SyncJobLike; from: number; to: number; now: number; height?: number }>(), { height: 16 })

const host = useTemplateRef<HTMLElement>('host')
const width = useElementWidth(host, 240)
const H = computed(() => props.height)
const mid = computed(() => props.height / 2)
const nowX = computed(() => laneX(props.now, props.from, props.to, width.value) ?? width.value)
const pulses = computed(() => lanePulses(props.job.history, props.from, props.to, width.value))
const ghost = computed(() => {
  const at = props.job.nextRunAt ? Date.parse(props.job.nextRunAt) : null
  return at !== null && at > props.now ? laneX(at, props.from, props.to, width.value) : null
})
const backoff = computed(() => {
  const until = props.job.backoffUntil ? Date.parse(props.job.backoffUntil) : null
  if (until === null || !(until > props.now)) return null
  const x1 = laneX(Math.min(until, props.to), props.from, props.to, width.value)
  return x1 === null ? null : { x0: nowX.value, x1 }
})
/** pulse height by result: the eye should land on partial / failed runs, not on the healthy rhythm */
const TALL = { ok: 0.5, partial: 0.8, error: 0.8, skipped: 0.25 } as const
const WORD = { ok: '成功', partial: '部分成功', error: '失败', skipped: '跳过' } as const
const summary = computed(() => {
  const runs = pulses.value
  const bad = runs.filter((run) => run.result === 'error').length
  const hours = Math.round((props.now - props.from) / 3_600_000)
  return `${props.job.label}：近 ${hours} 小时 ${runs.length} 次运行${bad ? `，失败 ${bad} 次` : ''}`
})
</script>

<template>
  <div ref="host" class="set-lane">
    <svg :width="width" :height="H" :viewBox="`0 0 ${width} ${H}`" role="img" :aria-label="summary">
      <line class="set-lane__base" x1="0" :x2="width" :y1="mid" :y2="mid" />
      <line v-if="backoff" class="set-lane__bo" :x1="backoff.x0" :x2="backoff.x1" :y1="mid" :y2="mid" />
      <rect
        v-for="(p, k) in pulses"
        :key="k"
        :class="`is-${p.result}`"
        :x="p.x"
        :y="mid - (H * TALL[p.result]) / 2"
        :width="p.result === 'ok' ? 1 : p.w"
        :height="H * TALL[p.result]"
      ><title>{{ fmtTime(p.at, now) }} · {{ WORD[p.result] }}{{ p.durationMs != null ? ` · ${fmtDuration(p.durationMs)}` : '' }}</title></rect>
      <rect v-if="job.state === 'running'" class="is-running" :x="Math.max(0, nowX - 3)" :y="mid - H * 0.4" width="3" :height="H * 0.8"><title>进行中</title></rect>
      <rect v-if="ghost !== null" class="set-lane__ghost" :x="ghost - 1.5" :y="mid - H * 0.25" width="3" :height="H * 0.5"><title>下次 {{ fmtTime(job.nextRunAt, now) }}</title></rect>
      <line class="set-lane__now" :x1="nowX" :x2="nowX" y1="0" :y2="H" />
    </svg>
  </div>
</template>

<style>
.set-lane { min-width: 0; width: 100%; }
.set-lane svg { display: block; overflow: visible; }
.set-lane__base { stroke: var(--rule); stroke-width: 1; }
.set-lane rect.is-ok { fill: var(--ink-3); }
.set-lane rect.is-partial { fill: var(--ink); }
.set-lane rect.is-error { fill: var(--signal); }
.set-lane rect.is-skipped { fill: var(--ink-4); }
.set-lane rect.is-running { fill: var(--ink); animation: ui-blink 1.2s steps(1) infinite; }
:root[data-hidden] .set-lane rect.is-running { animation-play-state: paused; }
.set-lane__ghost { fill: var(--sheet); stroke: var(--ink-3); stroke-width: 1; }
.set-lane__bo { stroke: var(--signal); stroke-width: 2; }
.set-lane__now { stroke: var(--signal); stroke-width: 1; }
</style>

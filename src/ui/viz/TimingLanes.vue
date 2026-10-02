<script setup lang="ts">
import { computed, useTemplateRef } from 'vue'
import { fmtDuration, fmtInt, fmtTime } from '../fmt'
import { toMs, useNow } from '../composables/useNow'
import { useElementWidth } from '../composables/useElementWidth'
import StatusMark from '../data/StatusMark.vue'
import { timeX } from './model'
import type { LaneJob, LaneRun } from '../types'

/**
 * Sync timing lanes (DESIGN.md §5.2 viz/TimingLanes, /settings#sync): one 28px lane per job over −24h → +2h.
 * Each run is a 10px pulse whose width is its duration (min 2px): ok ink-2, partial ink with a signal cap,
 * error signal, skipped ink-4, running ink + blink. The next run is a dashed ghost, the future a quiet tonal band,
 * a backoff window is a signal bracket, and the now-cursor is the one signal line. Native <title> per pulse.
 */
const props = withDefaults(
  defineProps<{
    jobs: LaneJob[]
    /** window start / end relative to now, in hours */
    fromHours?: number
    toHours?: number
    /** fixed "now" (ms) for captures; default = shared ticker */
    now?: number | null
    /** job names become buttons that emit `select` (open the job's detail) */
    selectable?: boolean
    emptyText?: string
  }>(),
  { fromHours: 24, toHours: 2, now: null, selectable: false, emptyText: '— 没有同步任务' },
)
const emit = defineEmits<{ select: [job: LaneJob] }>()

const tick = useNow()
const nowMs = computed(() => props.now ?? Math.floor(tick.value / 10_000) * 10_000)
const from = computed(() => nowMs.value - props.fromHours * 3_600_000)
const to = computed(() => nowMs.value + props.toHours * 3_600_000)
const host = useTemplateRef<HTMLElement>('host')
const width = useElementWidth(host, 600)
const H = 28
const nowX = computed(() => timeX(nowMs.value, from.value, to.value, width.value) ?? width.value)

const RESULT_WORD: Record<LaneRun['result'], string> = { ok: '成功', partial: '部分成功', error: '失败', skipped: '跳过', running: '运行中' }

function pulses(job: LaneJob) {
  const span = to.value - from.value
  return job.runs
    .map((run) => {
      const at = toMs(run.at)
      if (at === null) return null
      const end = at + (run.durationMs ?? 0)
      const x0 = timeX(Math.max(at, from.value), from.value, to.value, width.value)
      if (x0 === null || end < from.value) return null
      const w = Math.max(2, ((run.durationMs ?? 0) / span) * width.value)
      const title = `${fmtTime(at)} · ${RESULT_WORD[run.result]}${run.durationMs != null ? ` · ${fmtDuration(run.durationMs)}` : ''}`
      return { x: x0, w, result: run.result, title }
    })
    .filter((p): p is NonNullable<typeof p> => p !== null)
}
function ghost(job: LaneJob) {
  const at = toMs(job.nextAt)
  return at === null ? null : timeX(at, from.value, to.value, width.value)
}
function backoff(job: LaneJob) {
  const until = toMs(job.backoffUntil)
  if (until === null || until <= nowMs.value) return null
  const x1 = timeX(Math.min(until, to.value), from.value, to.value, width.value)
  return x1 === null ? null : { x0: nowX.value, x1 }
}
const lanes = computed(() => props.jobs.map((job) => ({ job, pulses: pulses(job), ghost: ghost(job), backoff: backoff(job) })))
const axis = computed(() => {
  const marks = [-props.fromHours, -props.fromHours / 2, -props.fromHours / 4, 0, props.toHours]
  return marks.map((hh) => ({ x: timeX(nowMs.value + hh * 3_600_000, from.value, to.value, width.value) ?? 0, text: hh === 0 ? '现在' : `${hh > 0 ? '+' : '−'}${Math.abs(hh)}h` }))
})
</script>

<template>
  <div v-if="jobs.length" class="ui-lanes">
    <div v-for="(l, i) in lanes" :key="l.job.id" class="ui-lanes__row" data-row :style="{ '--r': i }">
      <div class="ui-lanes__k">
        <button v-if="selectable" type="button" class="ui-lanes__name ellip" @click="emit('select', l.job)">{{ l.job.label }}</button>
        <span v-else class="ui-lanes__name ellip">{{ l.job.label }}</span>
        <span class="ui-lanes__every">{{ l.job.every ?? '' }}</span>
      </div>
      <div class="ui-lanes__lane">
        <svg :width="width" :height="H" :viewBox="`0 0 ${width} ${H}`" role="img" :aria-label="`${l.job.label}：近 ${fromHours} 小时 ${l.job.runs.length} 次运行${l.job.summary ? '，' + l.job.summary : ''}`">
          <line class="ui-lanes__base" x1="0" :x2="width" :y1="H / 2" :y2="H / 2" />
          <rect class="ui-lanes__fut" :x="nowX" y="2" :width="Math.max(0, width - nowX)" :height="H - 4" />
          <g v-if="l.backoff" class="ui-lanes__bo">
            <line :x1="l.backoff.x0" :x2="l.backoff.x1" y1="3.5" y2="3.5" />
            <line :x1="l.backoff.x0" :x2="l.backoff.x1" :y1="H - 3.5" :y2="H - 3.5" />
            <line :x1="l.backoff.x1" :x2="l.backoff.x1" y1="3" :y2="H - 3" />
          </g>
          <rect v-for="(p, k) in l.pulses" :key="k" :class="`is-${p.result}`" :x="p.x" :y="H / 2 - 5" :width="p.w" height="10"><title>{{ p.title }}</title></rect>
          <rect v-if="l.ghost !== null" class="ui-lanes__ghost" :x="l.ghost" :y="H / 2 - 5" width="3" height="10"><title>下次 {{ fmtTime(l.job.nextAt) }}</title></rect>
          <line class="ui-lanes__now" :x1="nowX" :x2="nowX" y1="0" :y2="H" />
        </svg>
      </div>
      <div class="ui-lanes__meta">
        <span v-if="l.job.calls24h != null" class="num dim">{{ fmtInt(l.job.calls24h) }} 次/24h</span>
        <StatusMark v-if="l.job.state" :state="l.job.state" :label="l.job.stateLabel" />
      </div>
    </div>
    <div class="ui-lanes__axis" aria-hidden="true">
      <span />
      <span ref="host" class="ui-lanes__ticks"><span v-for="a in axis" :key="a.text" :style="{ left: `${a.x}px` }">{{ a.text }}</span></span>
      <span />
    </div>
  </div>
  <p v-else class="ui-lanes__empty">{{ emptyText }}</p>
</template>

<style>
.ui-lanes { display: grid; }
.ui-lanes__row, .ui-lanes__axis { display: grid; grid-template-columns: minmax(120px, 200px) minmax(0, 1fr) minmax(120px, auto); align-items: center; gap: 0 14px; }
.ui-lanes__row { min-height: var(--row-lane); border-bottom: 1px solid var(--rule); }
.ui-lanes__k { display: flex; align-items: baseline; gap: 8px; min-width: 0; }
.ui-lanes__name { all: unset; font-size: var(--fs-sm); color: var(--ink); min-width: 0; }
button.ui-lanes__name { cursor: pointer; }
button.ui-lanes__name:hover { text-decoration: underline; text-underline-offset: 3px; }
.ui-lanes__every { font-family: var(--font-mono); font-size: var(--fs-micro); letter-spacing: .06em; color: var(--ink-3); white-space: nowrap; }
.ui-lanes__lane { min-width: 0; }
.ui-lanes__lane svg { display: block; }
.ui-lanes__base { stroke: var(--rule-2); stroke-width: 1; }
.ui-lanes__fut { fill: var(--paper-2); }
.ui-lanes__lane rect.is-ok { fill: var(--ink-2); }
.ui-lanes__lane rect.is-partial { fill: var(--ink); stroke: var(--signal); stroke-width: 1; }
.ui-lanes__lane rect.is-error { fill: var(--signal); }
.ui-lanes__lane rect.is-skipped { fill: var(--ink-4); }
.ui-lanes__lane rect.is-running { fill: var(--ink); animation: ui-blink 1.2s steps(1) infinite; }
.ui-lanes__ghost { fill: none; stroke: var(--ink-3); stroke-width: 1; stroke-dasharray: 2 1.5; }
.ui-lanes__bo line { stroke: var(--signal); stroke-width: 1; }
.ui-lanes__now { stroke: var(--signal); stroke-width: 1; }
.ui-lanes__meta { display: flex; align-items: center; justify-content: flex-end; gap: 10px; font-size: var(--fs-xs); white-space: nowrap; }
.ui-lanes__axis { height: 18px; }
.ui-lanes__ticks { position: relative; height: 100%; }
.ui-lanes__ticks span { position: absolute; top: 3px; transform: translateX(-50%); font-family: var(--font-mono); font-size: 10px; color: var(--ink-3); white-space: nowrap; }
.ui-lanes__ticks span:first-child { transform: none; }
.ui-lanes__ticks span:last-child { transform: translateX(-100%); }
.ui-lanes__empty { margin: 0; padding: 8px 0; font-size: var(--fs-sm); color: var(--ink-3); }
:root[data-hidden] .ui-lanes__lane rect.is-running { animation-play-state: paused; }
@media (max-width: 599px) {
  .ui-lanes__row, .ui-lanes__axis { grid-template-columns: minmax(0, 1fr) auto; }
  .ui-lanes__lane, .ui-lanes__ticks { grid-column: 1 / -1; grid-row: 2; }
  .ui-lanes__axis > span:not(.ui-lanes__ticks) { display: none; }
}
</style>

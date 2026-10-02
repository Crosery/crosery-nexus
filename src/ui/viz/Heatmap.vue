<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, shallowRef, useTemplateRef, watch } from 'vue'
import type { RouteLocationRaw } from 'vue-router'
import { useBreakpoint } from '../composables/useBreakpoint'
import { useElementWidth } from '../composables/useElementWidth'
import { dayKey, fmtCompact, fmtInt, fmtUsd, NONE } from '../fmt'
import DayReadout from './DayReadout.vue'
import HeatCard from './HeatCard.vue'
import { aggregateSpan, buildHeatGraph, dayTitle, heatValueText, spanTitle, type HeatCell, type HeatMetric, type HeatSeries } from './heatModel'

/**
 * Usage contribution graph (GitHub style): weeks are columns (Monday first), one square per day, four ink steps
 * plus a faint "nothing" square; days before the retention window are fainter still and inert ("无记录").
 *
 * - Hover: the cell gets a 1px inset ink ring and a small tooltip `9月28日 周日 · 2.38B token`.
 * - Click / Enter: the day card (old relay card) anchored to the cell; a bottom sheet on phones. Clicking the same
 *   cell, Esc, or any empty area closes it; focus returns to the cell.
 * - Press and drag across cells (or click, then shift-click) selects a span: cells outside it dim, and the card
 *   shows the span's totals with `spanAction` (emits `apply`) and / or `spanLink`.
 * - Keyboard: one tab stop (roving tabindex); ↑↓ = day, ←→ = week, Home / End = first / last day.
 * - Cells are ≥10px (11px on phones); when a year does not fit, the graph scrolls inside its own box, opened at
 *   the newest week — on touch, dragging pans the timeline.
 */
const props = withDefaults(
  defineProps<{
    series: HeatSeries | null
    metric?: HeatMetric
    /** spend is partly estimated (≈) */
    approx?: boolean
    /** 查看当天请求 → target for a day with calls */
    dayLink?: ((day: string) => RouteLocationRaw | null) | null
    /** link offered on a span card */
    spanLink?: ((from: string, to: string) => RouteLocationRaw | null) | null
    spanLinkText?: string
    /** button offered on a span card; emits `apply(from, to)` */
    spanAction?: string | null
  }>(),
  { metric: 'tokens', approx: false, dayLink: null, spanLink: null, spanLinkText: '查看这段请求 →', spanAction: null },
)
const emit = defineEmits<{ apply: [from: string, to: string] }>()

const { isCompact } = useBreakpoint()
const root = useTemplateRef<HTMLElement>('root')
const scroller = useTemplateRef<HTMLElement>('scroller')
const gridEl = useTemplateRef<HTMLElement>('grid')
const tipEl = useTemplateRef<HTMLElement>('tipBox')
const width = useElementWidth(root, 800)

const today = ref(dayKey(Date.now()))
watch(() => props.series, () => (today.value = dayKey(Date.now())))
const graph = computed(() => buildHeatGraph(props.series, props.metric, today.value))
const retention = computed(() => props.series?.history.retentionDays ?? 0)
const hasVoid = computed(() => graph.value.cells.some((c) => c.kind === 'void'))

/* ── geometry ──────────────────────────────────────────────────────────────────────────────────── */
const LABEL_W = 22
const GAP = 3
const MIN_CELL = 10
const MAX_CELL = 16
const PHONE_CELL = 11
const cell = computed(() => {
  if (isCompact.value) return PHONE_CELL
  const fit = Math.floor((width.value - LABEL_W) / Math.max(1, graph.value.cols)) - GAP
  return Math.max(MIN_CELL, Math.min(MAX_CELL, fit))
})
const plotWidth = computed(() => LABEL_W + graph.value.cols * (cell.value + GAP) - GAP)
const rows = computed(() => {
  const out: HeatCell[][] = [[], [], [], [], [], [], []]
  for (const c of graph.value.cells) out[c.row].push(c)
  return out
})
// open at the newest week whenever the plot is wider than its box
watch([plotWidth, width], () => {
  const s = scroller.value
  if (s && s.scrollWidth > s.clientWidth) s.scrollLeft = s.scrollWidth
}, { flush: 'post' })

/* ── words ─────────────────────────────────────────────────────────────────────────────────────── */
const FMT = { compact: fmtCompact, int: fmtInt, usd: (v: number) => fmtUsd(v, { approx: props.approx }) }
const valueText = (value: number) => heatValueText(value, props.metric, FMT)
const shortValue = (value: number) => (props.metric === 'requests' ? `${fmtInt(value)} 次` : props.metric === 'cost' ? fmtUsd(value, { approx: props.approx }) : fmtCompact(value))
function cellText(c: HeatCell): string {
  if (c.kind === 'void') return `${dayTitle(c.date)} · 无记录（只保留近 ${retention.value} 天）`
  return `${dayTitle(c.date)} · ${valueText(c.value)}${c.today ? ' · 今天' : ''}`
}
const peakText = computed(() => {
  const p = graph.value.peak
  return p ? `峰值 ${dayTitle(p.date).split(' ')[0]} · ${shortValue(p.value)}` : ''
})
const costText = (cost: number | null, requests: number) => (requests === 0 ? NONE : cost === null ? '未定价' : fmtUsd(cost, { approx: props.approx }))

/* ── card / span state ─────────────────────────────────────────────────────────────────────────── */
type Card = { kind: 'day'; date: string } | { kind: 'span'; from: string; to: string; at: string }
const card = shallowRef<Card | null>(null)
const drag = shallowRef<{ anchor: string; current: string } | null>(null)
const ordered = (a: string, b: string) => (a <= b ? { from: a, to: b } : { from: b, to: a })
const span = computed(() => {
  const d = drag.value
  if (d && d.current !== d.anchor) return ordered(d.anchor, d.current)
  return card.value?.kind === 'span' ? { from: card.value.from, to: card.value.to } : null
})
const cardDate = computed(() => (card.value ? (card.value.kind === 'day' ? card.value.date : card.value.at) : null))
const anchorEl = shallowRef<HTMLElement | null>(null)
const cellEl = (date: string) => gridEl.value?.querySelector<HTMLElement>(`[data-date="${date}"]:not([data-void])`) ?? null

let focusCard = false
watch(cardDate, async (date) => {
  await nextTick()
  anchorEl.value = date ? cellEl(date) : null
  if (date && focusCard) {
    focusCard = false
    // the popover mounts its panel on the next frames; keyboard users land in the card so its link is reachable
    let tries = 0
    // the panel exists before it is shown (positioning first), and focus() on a hidden panel is a no-op: retry
    const land = () => {
      const target = document.querySelector<HTMLElement>('[data-heat-card]')
      target?.focus({ preventScroll: true })
      if (cardDate.value === date && document.activeElement !== target && ++tries < 40) requestAnimationFrame(land)
    }
    requestAnimationFrame(land)
  }
})
// a refresh / year switch that drops the open day closes the card
watch(graph, async (g) => {
  if (cardDate.value && !g.byDate.has(cardDate.value)) return close(false)
  // a refresh may re-render the cells: re-anchor the open card to the live element
  await nextTick()
  if (cardDate.value) anchorEl.value = cellEl(cardDate.value)
})

function openDay(date: string) {
  card.value = cardDate.value === date && card.value?.kind === 'day' ? null : { kind: 'day', date }
}
function openSpan(a: string, b: string, at: string) {
  card.value = { kind: 'span', ...ordered(a, b), at }
}
function close(returnFocus: boolean) {
  const date = cardDate.value
  card.value = null
  drag.value = null
  if (returnFocus && date) cellEl(date)?.focus({ preventScroll: true })
}
const cardStart = () => (card.value ? (card.value.kind === 'day' ? card.value.date : card.value.from) : null)

/* ── pointer: hover tooltip, click, drag-select (mouse); tap (touch) ───────────────────────────── */
const dateOf = (target: EventTarget | null): string | null => {
  const el = (target as Element | null)?.closest?.('[data-date]')
  return el && !el.hasAttribute('data-void') && gridEl.value?.contains(el) ? el.getAttribute('data-date') : null
}
const tip = shallowRef<{ text: string; el: HTMLElement } | null>(null)
watch(tip, (t) => {
  const box = tipEl.value
  const host = root.value
  if (!t || !box || !host) return
  const r = t.el.getBoundingClientRect()
  const o = host.getBoundingClientRect()
  const w = box.offsetWidth
  const left = Math.max(0, Math.min(o.width - w, r.left + r.width / 2 - o.left - w / 2))
  box.style.left = `${left}px`
  box.style.top = `${r.top - o.top - box.offsetHeight - 6}px`
}, { flush: 'post' })

let pointerType = ''
function onPointerDown(event: PointerEvent) {
  pointerType = event.pointerType
  tip.value = null
  if (event.pointerType !== 'mouse' || event.button !== 0) return
  const date = dateOf(event.target)
  if (!date) return
  event.preventDefault()
  cellEl(date)?.focus({ preventScroll: true })
  const start = cardStart()
  if (event.shiftKey && start) {
    openSpan(start, date, date)
    return
  }
  drag.value = { anchor: date, current: date }
  try {
    gridEl.value?.setPointerCapture(event.pointerId)
  } catch {
    // a pointer the browser no longer tracks: the drag still ends on this grid's pointerup / pointercancel
  }
}
function onPointerMove(event: PointerEvent) {
  const d = drag.value
  if (d) {
    const under = document.elementFromPoint(event.clientX, event.clientY)
    const date = dateOf(under)
    if (date && date !== d.current) drag.value = { anchor: d.anchor, current: date }
    const el = cellEl(drag.value!.current)
    if (el && drag.value!.current !== d.anchor) {
      const s = ordered(d.anchor, drag.value!.current)
      tip.value = { text: `${spanTitle(s.from, s.to)} · ${valueText(aggregateValue(s.from, s.to))}`, el }
    }
    return
  }
  if (event.pointerType !== 'mouse' && event.pointerType !== 'pen') return
  const target = (event.target as Element | null)?.closest?.<HTMLElement>('[data-date]')
  const found = target ? graph.value.cells.find((c) => c.date === target.getAttribute('data-date')) : undefined
  if (!target || !found) {
    tip.value = null
    return
  }
  if (tip.value?.el !== target) tip.value = { text: cellText(found), el: target }
}
function onPointerUp(event: PointerEvent) {
  const d = drag.value
  if (!d) return
  drag.value = null
  if (gridEl.value?.hasPointerCapture?.(event.pointerId)) gridEl.value.releasePointerCapture(event.pointerId)
  tip.value = null
  if (d.current !== d.anchor) openSpan(d.anchor, d.current, d.current)
  else openDay(d.anchor)
}
function onPointerCancel() {
  drag.value = null
  tip.value = null
}
/** Mouse clicks are decided on pointerup (click vs drag); this handles keyboard (detail 0) and touch / pen taps. */
function onClick(event: MouseEvent) {
  if (pointerType === 'mouse' && event.detail > 0) return
  const date = dateOf(event.target)
  if (!date) return
  const start = cardStart()
  if (event.shiftKey && start) {
    openSpan(start, date, date)
    return
  }
  // keyboard activation (Enter / Space): no pointer behind the click → land in the card so its link is reachable
  if (event.detail === 0 || !(event as PointerEvent).pointerType) focusCard = true
  openDay(date)
}
function aggregateValue(from: string, to: string): number {
  const a = aggregateSpan(props.series, from, to)
  return props.metric === 'requests' ? a.requests : props.metric === 'cost' ? a.costUsd ?? 0 : a.tokens
}

/* ── keyboard: roving tabindex ─────────────────────────────────────────────────────────────────── */
const focusDate = ref<string | null>(null)
const tabDate = computed(() => {
  const dates = graph.value.dates
  const want = focusDate.value ?? cardDate.value ?? (graph.value.byDate.has(today.value) ? today.value : dates[dates.length - 1])
  return want && graph.value.byDate.has(want) ? want : dates[dates.length - 1] ?? null
})
const STEP: Record<string, number> = { ArrowUp: -1, ArrowDown: 1, ArrowLeft: -7, ArrowRight: 7 }
function onKeydown(event: KeyboardEvent) {
  const date = dateOf(event.target)
  if (!date) return
  const dates = graph.value.dates
  const at = dates.indexOf(date)
  let next: string | undefined
  if (event.key in STEP) next = dates[Math.max(0, Math.min(dates.length - 1, at + STEP[event.key]))]
  else if (event.key === 'Home') next = dates[0]
  else if (event.key === 'End') next = dates[dates.length - 1]
  if (!next) return
  event.preventDefault()
  focusDate.value = next
  void nextTick(() => cellEl(next!)?.focus())
}
function onFocusIn(event: FocusEvent) {
  const date = dateOf(event.target)
  if (date) focusDate.value = date
}

/* ── outside click / Esc while a card is open ──────────────────────────────────────────────────── */
function onDocPointerDown(event: PointerEvent) {
  const target = event.target
  if (!(target instanceof Element) || target.closest('[data-heat-card], .tx-drawer')) return
  if (dateOf(target)) return
  close(false)
}
function onDocKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape' && card.value) {
    event.preventDefault()
    close(true)
  }
}
const listening = ref(false)
watch(card, (value) => {
  const want = Boolean(value)
  if (want === listening.value) return
  listening.value = want
  if (want) {
    document.addEventListener('pointerdown', onDocPointerDown, true)
    document.addEventListener('keydown', onDocKeydown)
  } else {
    document.removeEventListener('pointerdown', onDocPointerDown, true)
    document.removeEventListener('keydown', onDocKeydown)
  }
})
onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', onDocPointerDown, true)
  document.removeEventListener('keydown', onDocKeydown)
})

/* ── card body ─────────────────────────────────────────────────────────────────────────────────── */
const view = computed(() => {
  const c = card.value
  if (!c || !props.series) return null
  if (c.kind === 'day') {
    const d = graph.value.byDate.get(c.date)?.data ?? null
    const requests = d?.requests ?? 0
    return {
      title: dayTitle(c.date),
      tokens: d?.tokens ?? 0,
      requests,
      errors: d?.errors ?? 0,
      cost: costText(d?.costUsd ?? null, requests),
      mix: d && d.tokens > 0 ? { freshInput: d.freshInput, output: d.output, cacheRead: d.cacheRead, cacheWrite: d.cacheWrite } : null,
      top: d?.topModels ?? [],
      empty: requests === 0,
      emptyText: '当天无调用',
      to: requests > 0 ? props.dayLink?.(c.date) ?? null : null,
      linkText: '查看当天请求 →',
      action: null,
    }
  }
  const a = aggregateSpan(props.series, c.from, c.to)
  return {
    title: `${spanTitle(c.from, c.to)} · ${a.days} 天`,
    tokens: a.tokens,
    requests: a.requests,
    errors: a.errors,
    cost: costText(a.costUsd, a.requests),
    mix: a.tokens > 0 ? { freshInput: a.freshInput, output: a.output, cacheRead: a.cacheRead, cacheWrite: a.cacheWrite } : null,
    top: [],
    empty: a.requests === 0,
    emptyText: '这段时间无调用',
    to: a.requests > 0 ? props.spanLink?.(c.from, c.to) ?? null : null,
    linkText: props.spanLinkText,
    action: props.spanAction,
  }
})
function apply() {
  const c = card.value
  if (c?.kind !== 'span') return
  card.value = null
  emit('apply', c.from, c.to)
}

const inSpan = (date: string) => Boolean(span.value && date >= span.value.from && date <= span.value.to)
</script>

<template>
  <div ref="root" class="ui-hm" :class="{ 'is-span': Boolean(span), 'is-drag': Boolean(drag), 'is-scroll': plotWidth > width }">
    <div ref="scroller" class="ui-hm__scroll">
      <div class="ui-hm__plot" :style="{ '--c': `${cell}px`, '--g': `${GAP}px`, '--lw': `${LABEL_W}px`, width: `${plotWidth}px` }">
        <div class="ui-hm__months" aria-hidden="true" :style="{ gridTemplateColumns: `repeat(${graph.cols}, var(--c))` }">
          <span v-for="m in graph.months" :key="m.col" :style="{ gridColumn: m.col + 1 }">{{ m.label }}</span>
        </div>
        <div class="ui-hm__body">
          <div class="ui-hm__wd" aria-hidden="true"><span style="grid-row: 1">一</span><span style="grid-row: 3">三</span><span style="grid-row: 5">五</span></div>
          <div
            ref="grid"
            class="ui-hm__grid"
            role="grid"
            :aria-label="`每日用量 · ${graph.dates[0] ?? ''} 至 ${graph.dates[graph.dates.length - 1] ?? ''}`"
            :style="{ gridTemplateColumns: `repeat(${graph.cols}, var(--c))` }"
            @pointerdown="onPointerDown"
            @pointermove="onPointerMove"
            @pointerup="onPointerUp"
            @pointercancel="onPointerCancel"
            @pointerleave="tip = drag ? tip : null"
            @click="onClick"
            @keydown="onKeydown"
            @focusin="onFocusIn"
          >
            <div v-for="(row, r) in rows" :key="r" role="row" class="ui-hm__row">
              <template v-for="c in row" :key="c.date">
                <button
                  v-if="c.kind === 'day'"
                  type="button"
                  role="gridcell"
                  class="ui-hm__c"
                  :class="[`l${c.level}`, { 'is-today': c.today, 'is-in': inSpan(c.date), 'is-on': cardDate === c.date }]"
                  :style="{ gridColumn: c.col + 1, gridRow: c.row + 1 }"
                  :data-date="c.date"
                  :tabindex="c.date === tabDate ? 0 : -1"
                  :aria-label="cellText(c)"
                  :aria-selected="cardDate === c.date || inSpan(c.date)"
                />
                <span v-else role="presentation" class="ui-hm__c is-void" :style="{ gridColumn: c.col + 1, gridRow: c.row + 1 }" :data-date="c.date" data-void />
              </template>
            </div>
          </div>
        </div>
      </div>
    </div>
    <div class="ui-hm__foot">
      <span class="ui-hm__peak">
        <span v-if="peakText" class="num">{{ peakText }}</span>
        <span v-if="hasVoid" class="ui-hm__keep">只保留近 {{ retention }} 天</span>
      </span>
      <span class="ui-hm__legend" aria-hidden="true">少<i class="ui-hm__c l0" /><i class="ui-hm__c l1" /><i class="ui-hm__c l2" /><i class="ui-hm__c l3" /><i class="ui-hm__c l4" />多</span>
    </div>
    <div ref="tipBox" class="ui-hm__tip num" :class="{ 'is-on': tip }" aria-hidden="true">{{ tip?.text }}</div>

    <HeatCard :open="Boolean(view)" :anchor="anchorEl" :title="view?.title ?? ''" :sheet="isCompact" @close="close(true)">
      <template #default="{ bare }">
        <DayReadout
          v-if="view"
          :title="view.title"
          :bare="bare"
          :tokens="view.tokens"
          :requests="view.requests"
          :errors="view.errors"
          :cost="view.cost"
          :mix="view.mix"
          :top="view.top"
          :empty="view.empty"
          :empty-text="view.emptyText"
          :to="view.to"
          :link-text="view.linkText"
          :action-text="view.action"
          @action="apply"
          @go="close(false)"
        />
      </template>
    </HeatCard>
  </div>
</template>

<style>
.ui-hm { --l0: var(--paper-3); position: relative; min-width: 0; padding-top: 10px; user-select: none; -webkit-user-select: none; }
.ui-hm__scroll { max-width: 100%; overflow-x: auto; overflow-y: hidden; overscroll-behavior-x: contain; scrollbar-width: thin; }
.ui-hm__months { display: grid; column-gap: var(--g); height: 14px; margin-left: calc(var(--lw) + var(--g)); font-size: var(--fs-xs); line-height: 14px; color: var(--ink-3); }
.ui-hm__months span { grid-row: 1; white-space: nowrap; }
.ui-hm__body { display: flex; gap: var(--g); margin-top: 4px; }
.ui-hm__wd {
  position: sticky; left: 0; z-index: 1; flex: none; display: grid; grid-template-rows: repeat(7, var(--c)); row-gap: var(--g);
  width: var(--lw); font-size: var(--fs-micro); line-height: var(--c); color: var(--ink-3);
}
/* only when the year scrolls inside its box: the labels stay put over a page-coloured strip */
.ui-hm.is-scroll .ui-hm__wd { background: var(--paper); }
.ui-hm__grid { display: grid; grid-template-rows: repeat(7, var(--c)); gap: var(--g); flex: none; touch-action: pan-x pan-y; }
.ui-hm__row { display: contents; }
.ui-hm__c {
  all: unset; box-sizing: border-box; position: relative; display: block; width: var(--c); height: var(--c); border-radius: 2px;
  background: var(--l0); transition: opacity var(--dur-2) linear;
}
button.ui-hm__c { cursor: pointer; }
.ui-hm__c.l1 { background: color-mix(in oklab, var(--ink) 26%, var(--paper-3)); }
.ui-hm__c.l2 { background: color-mix(in oklab, var(--ink) 48%, var(--paper-3)); }
.ui-hm__c.l3 { background: color-mix(in oklab, var(--ink) 72%, var(--paper-3)); }
.ui-hm__c.l4 { background: var(--ink); }
.ui-hm__c.is-void { background: color-mix(in oklab, var(--paper-3) 45%, transparent); }
/* today: a short ink-3 tick under the square, not a box around it */
.ui-hm__c.is-today::after { content: ""; position: absolute; left: 20%; right: 20%; bottom: -3px; height: 2px; border-radius: 1px; background: var(--ink-3); }
@media (hover: hover) {
  button.ui-hm__c:hover { box-shadow: inset 0 0 0 1px var(--ink); }
  button.ui-hm__c.l4:hover, button.ui-hm__c.l3:hover { box-shadow: inset 0 0 0 1px var(--ink), inset 0 0 0 2px var(--paper); }
}
button.ui-hm__c.is-on { box-shadow: inset 0 0 0 1px var(--ink); }
button.ui-hm__c.is-on.l4, button.ui-hm__c.is-on.l3 { box-shadow: inset 0 0 0 1px var(--ink), inset 0 0 0 2px var(--paper); }
button.ui-hm__c:focus-visible { outline: 2px solid var(--signal); outline-offset: 1px; z-index: 2; }
.ui-hm.is-span .ui-hm__grid .ui-hm__c:not(.is-in) { opacity: .3; }
.ui-hm.is-drag, .ui-hm.is-drag button.ui-hm__c { cursor: col-resize; }

.ui-hm__foot { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 6px 16px; margin-top: 10px; font-size: var(--fs-xs); color: var(--ink-3); }
.ui-hm__peak { display: inline-flex; flex-wrap: wrap; gap: 0 12px; min-width: 0; }
.ui-hm__peak .num { font-family: var(--font-mono); font-variant-numeric: tabular-nums; color: var(--ink-2); }
.ui-hm__legend { display: inline-flex; align-items: center; gap: 3px; margin-left: auto; }
.ui-hm__legend .ui-hm__c { --c: 10px; display: inline-block; }
.ui-hm__legend .ui-hm__c:first-of-type { margin-left: 4px; }
.ui-hm__legend .ui-hm__c:last-of-type { margin-right: 4px; }

.ui-hm__tip {
  position: absolute; top: 0; left: 0; z-index: 5; pointer-events: none; padding: 3px 7px; border-radius: 2px; white-space: nowrap;
  background: var(--ink); color: var(--paper); font-size: var(--fs-xs); line-height: 1.4; visibility: hidden;
}
/* hidden, not display:none — the box keeps its size so it can be measured and clamped before it shows */
.ui-hm__tip.is-on { visibility: visible; }
.ui-hm__tip.num { font-family: var(--font-sans); font-variant-numeric: tabular-nums; }
:root[data-motion="reduce"] .ui-hm__c { transition: none; }
</style>

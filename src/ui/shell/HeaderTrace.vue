<script setup lang="ts">
import { onBeforeUnmount, onMounted, useTemplateRef, watch } from 'vue'

/**
 * Header live edge (DESIGN.md §4.1): the header's 1px bottom edge as a ruler (8px minor / 40px major ticks in
 * rule-2) with a 1px ink-3 trace of the last `windowSec` seconds of gateway req/s drawn on it in an 18px canvas
 * that overhangs 9px; error seconds are 3px signal notches below the line. Redrawn once per sample change
 * (no rAF loop). Stale → the trace flattens to a dashed ink-4 line. `samples` empty = ruler only (key shell).
 */
const props = withDefaults(
  defineProps<{
    samples?: Array<{ t: number; rps: number | null; err?: number | null }>
    windowSec?: number
    stale?: boolean
  }>(),
  { samples: () => [], windowSec: 90, stale: false },
)

const canvas = useTemplateRef<HTMLCanvasElement>('canvas')
const H = 18
let ro: ResizeObserver | null = null
let mo: MutationObserver | null = null
let raf = 0

function css(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || '#888'
}

function draw() {
  const el = canvas.value
  if (!el) return
  const dpr = Math.min(2, window.devicePixelRatio || 1)
  const w = el.clientWidth
  if (!w) return
  if (el.width !== Math.round(w * dpr)) el.width = Math.round(w * dpr)
  if (el.height !== Math.round(H * dpr)) el.height = Math.round(H * dpr)
  const ctx = el.getContext('2d')
  if (!ctx) return
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.clearRect(0, 0, w, H)
  const mid = H / 2 + 0.5
  // ruler: the header edge itself
  ctx.fillStyle = css('--rule-2')
  ctx.fillRect(0, mid - 0.5, w, 1)
  for (let x = 0; x <= w; x += 8) ctx.fillRect(Math.round(x), mid - (x % 40 === 0 ? 4 : 2), 1, x % 40 === 0 ? 4 : 2)
  const list = props.samples
  if (!list.length) return
  const end = list[list.length - 1].t
  const start = end - props.windowSec * 1000
  const xAt = (t: number) => ((t - start) / (end - start || 1)) * w
  const max = Math.max(1e-9, ...list.map((s) => s.rps ?? 0))
  const yAt = (v: number) => mid - 1 - (v / max) * (mid - 2)
  ctx.lineWidth = 1
  if (props.stale) {
    ctx.strokeStyle = css('--ink-4')
    ctx.setLineDash([3, 3])
    ctx.beginPath()
    ctx.moveTo(0, mid - 3)
    ctx.lineTo(w, mid - 3)
    ctx.stroke()
    ctx.setLineDash([])
    return
  }
  ctx.strokeStyle = css('--ink-3')
  ctx.beginPath()
  let pen = false
  for (const s of list) {
    if (s.t < start) continue
    if (s.rps === null || !Number.isFinite(s.rps)) {
      pen = false
      continue
    }
    const x = xAt(s.t)
    const y = yAt(s.rps)
    if (pen) ctx.lineTo(x, y)
    else ctx.moveTo(x, y)
    pen = true
  }
  ctx.stroke()
  ctx.fillStyle = css('--signal')
  for (const s of list) if (s.t >= start && (s.err ?? 0) > 0) ctx.fillRect(Math.round(xAt(s.t)) - 1, mid + 2, 3, 3)
}

function schedule() {
  cancelAnimationFrame(raf)
  raf = requestAnimationFrame(draw)
}

watch(() => [props.samples, props.stale], schedule, { deep: false })
onMounted(() => {
  schedule()
  if (typeof ResizeObserver !== 'undefined' && canvas.value) {
    ro = new ResizeObserver(schedule)
    ro.observe(canvas.value)
  }
  // colours come from the theme tokens: repaint when the theme flips
  mo = new MutationObserver(schedule)
  mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
})
onBeforeUnmount(() => {
  cancelAnimationFrame(raf)
  ro?.disconnect()
  mo?.disconnect()
})
</script>

<template>
  <canvas ref="canvas" class="ui-htrace" aria-hidden="true" />
</template>

<style>
.ui-htrace { position: absolute; left: 0; right: 0; bottom: -9px; width: 100%; height: 18px; pointer-events: none; display: block; }
</style>

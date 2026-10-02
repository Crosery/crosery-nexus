<script setup lang="ts">
import { computed } from 'vue'
import { fmtInt, fmtPct } from '../../ui/fmt'
import { explainFailure, type MeFailure } from './meModel'

/**
 * Failures of this key grouped by cause, in plain words (DESIGN §6.10 /me/usage 失败; §6.0 copy tone):
 * `上游限流 · 不是你的问题 · 稍后重试   43 次 · 0.3%   429`. A cause that is the caller's to fix gets the signal
 * diamond; upstream ones a hollow ink ring (the gateway owns them — orange means "you act"). No edge bars: the
 * mark and one hairline per row are enough. Rows are buttons when the parent listens to `select` (filters the
 * request list to failures).
 */
const props = withDefaults(defineProps<{ failures: MeFailure[]; total: number; limit?: number; selectable?: boolean }>(), { limit: 6, selectable: false })
const emit = defineEmits<{ select: [] }>()

/** one row per plain-word cause; its status codes (`500 · 502 · 503`, else the category) become the mono suffix */
const rows = computed(() => {
  type Row = { title: string; whose: string; next: string; count: number; statuses: Map<string, number>; categories: Set<string> }
  const merged = new Map<string, Row>()
  for (const f of props.failures) {
    const words = explainFailure(f.status, f.category)
    const hit = merged.get(words.title) ?? { title: words.title, whose: words.whose, next: words.next, count: 0, statuses: new Map(), categories: new Set() }
    hit.count += f.count
    const status = f.status === null ? '' : String(f.status)
    if (status) hit.statuses.set(status, (hit.statuses.get(status) ?? 0) + f.count)
    if (f.category && f.category !== 'other') hit.categories.add(f.category)
    merged.set(words.title, hit)
  }
  return [...merged.values()]
    .sort((a, b) => b.count - a.count)
    .slice(0, props.limit)
    .map((r) => ({
      ...r,
      code: [...r.statuses].sort((a, b) => b[1] - a[1]).map(([k]) => k).join(' · ') || [...r.categories].join(' ') || '未知',
    }))
})
const kinds = computed(() => new Set(props.failures.map((f) => explainFailure(f.status, f.category).title)).size)
const sum = computed(() => props.failures.reduce((s, f) => s + f.count, 0))
const more = computed(() => Math.max(0, kinds.value - rows.value.length))
const tag = computed(() => (props.selectable ? 'button' : 'div'))
</script>

<template>
  <ul class="me-fc">
    <li v-for="r in rows" :key="r.title" class="me-fc__row" :class="`is-${r.whose}`" data-row>
      <component :is="tag" class="me-fc__body" :type="selectable ? 'button' : undefined" @click="selectable && emit('select')">
        <span class="me-fc__what">
          <span class="me-fc__mark" aria-hidden="true">{{ r.whose === 'client' || r.whose === 'key' ? '◆' : '○' }}</span>
          <b>{{ r.title }}</b>
        </span>
        <span class="me-fc__n num">{{ fmtInt(r.count) }} 次<span class="me-fc__share"> · {{ fmtPct(total ? r.count / total : null, 1) }}</span></span>
        <span class="me-fc__next">{{ r.next }}</span>
        <span class="me-fc__code num">{{ r.code }}</span>
      </component>
    </li>
    <li v-if="more" class="me-fc__more">另有 {{ fmtInt(more) }} 类 · 共 {{ fmtInt(sum) }} 次</li>
  </ul>
</template>

<style>
.me-fc { list-style: none; margin: 0; padding: 0; }
.me-fc__row { border-bottom: 1px solid var(--rule); }
.me-fc__row:last-child { border-bottom: 0; }
.me-fc__body {
  all: unset; box-sizing: border-box; width: 100%; display: grid; grid-template-columns: minmax(0, 1fr) auto; grid-template-areas: "what n" "next code";
  gap: 1px 12px; min-height: 46px; padding: 7px 4px 7px 0;
}
button.me-fc__body { cursor: pointer; }
button.me-fc__body:hover { background: var(--paper-2); }
button.me-fc__body:focus-visible { outline: 2px solid var(--signal); outline-offset: -2px; }
.me-fc__what { grid-area: what; display: flex; align-items: baseline; gap: 8px; min-width: 0; font-size: var(--fs-row); }
.me-fc__what b { font-weight: 600; color: var(--ink); }
.me-fc__mark { flex: none; width: 10px; color: var(--ink-3); font-size: 10px; text-align: center; }
.me-fc__row.is-client .me-fc__mark, .me-fc__row.is-key .me-fc__mark { color: var(--signal); }
.me-fc__next { grid-area: next; min-width: 0; padding-left: 18px; font-size: var(--fs-xs); color: var(--ink-2); }
.me-fc__n { grid-area: n; align-self: center; font-size: var(--fs-sm); color: var(--ink); white-space: nowrap; }
.me-fc__share { color: var(--ink-3); }
.me-fc__code { grid-area: code; justify-self: end; font-size: var(--fs-xs); color: var(--ink-3); text-align: right; }
.me-fc__more { padding: 8px 0 0 18px; font-size: var(--fs-xs); color: var(--ink-3); }
</style>

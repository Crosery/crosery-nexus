<script setup lang="ts">
import { computed } from 'vue'
import { RouterLink, type RouteLocationRaw } from 'vue-router'
import { TxButton } from '@talex-touch/tuffex/button'
import { fmtCompact, fmtInt } from '../fmt'

/**
 * The heatmap's day / span card body, in the old relay's shape (simple first): the date, one big token figure,
 * 请求 · 花费 · 失败, one token-mix line, the day's top models, and one way onward. A day with no calls is a
 * single line. Used inside HeatCard (floating card on desktop, bottom sheet on phones — `bare` drops the title
 * there because the sheet head already shows it).
 */
const props = withDefaults(
  defineProps<{
    title: string
    bare?: boolean
    tokens: number
    requests: number
    errors: number
    /** formatted spend, e.g. `$12.30` · `≈ $3.10` · `未定价` */
    cost: string
    mix?: { freshInput: number; output: number; cacheRead: number; cacheWrite: number } | null
    top?: Array<{ model: string; tokens: number }>
    empty?: boolean
    emptyText?: string
    to?: RouteLocationRaw | null
    linkText?: string
    /** a button instead of / next to the link (e.g. 按这段时间查看) */
    actionText?: string | null
  }>(),
  { bare: false, mix: null, top: () => [], empty: false, emptyText: '当天无调用', to: null, linkText: '查看当天请求 →', actionText: null },
)
const emit = defineEmits<{ action: []; go: [] }>()

const mixLine = computed(() => {
  const m = props.mix
  if (!m) return []
  return [
    { k: '新输入', v: m.freshInput },
    { k: '输出', v: m.output },
    { k: '缓存读', v: m.cacheRead },
    { k: '缓存写', v: m.cacheWrite },
  ].filter((part) => part.v > 0)
})
</script>

<template>
  <div class="ui-day">
    <p v-if="!bare" class="ui-day__t">{{ title }}</p>
    <p v-if="empty" class="ui-day__none">{{ emptyText }}</p>
    <template v-else>
      <p class="ui-day__big"><span class="num">{{ fmtCompact(tokens) }}</span> <small>token</small></p>
      <dl class="ui-day__stats">
        <div><dt>请求</dt><dd class="num">{{ fmtInt(requests) }}</dd></div>
        <div><dt>花费</dt><dd class="num">{{ cost }}</dd></div>
        <div><dt>失败</dt><dd class="num">{{ fmtInt(errors) }}</dd></div>
      </dl>
      <p v-if="mixLine.length" class="ui-day__mix">
        <span v-for="part in mixLine" :key="part.k">{{ part.k }} <b class="num">{{ fmtCompact(part.v) }}</b></span>
      </p>
      <ol v-if="top.length" class="ui-day__top" aria-label="用量最多的模型">
        <li v-for="m in top" :key="m.model"><span class="ui-day__m num" :title="m.model">{{ m.model }}</span><span class="num">{{ fmtCompact(m.tokens) }}</span></li>
      </ol>
    </template>
    <div v-if="actionText || to" class="ui-day__go">
      <TxButton v-if="actionText" size="sm" variant="secondary" @click="emit('action')">{{ actionText }}</TxButton>
      <RouterLink v-if="to" :to="to" class="ui-link" @click="emit('go')">{{ linkText }}</RouterLink>
    </div>
  </div>
</template>

<style>
.ui-day { display: grid; gap: 10px; min-width: 0; font-size: var(--fs-sm); color: var(--ink-2); }
.ui-day p { margin: 0; }
.ui-day__t { font-size: var(--fs-base); font-weight: 600; color: var(--ink); }
.ui-day__none { color: var(--ink-3); }
.ui-day__big { margin-top: -4px !important; color: var(--ink); line-height: 1.1; }
.ui-day__big .num { font-family: var(--font-mono); font-size: var(--fs-lg); font-weight: 500; font-variant-numeric: tabular-nums; }
.ui-day__big small { font-size: var(--fs-xs); color: var(--ink-3); }
.ui-day__stats { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; margin: 0; }
.ui-day__stats dt { font-size: var(--fs-xs); color: var(--ink-3); }
.ui-day__stats dd { margin: 2px 0 0; font-family: var(--font-mono); font-variant-numeric: tabular-nums; color: var(--ink); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.ui-day__mix { display: flex; flex-wrap: wrap; gap: 2px 12px; font-size: var(--fs-xs); color: var(--ink-3); }
.ui-day__mix b { font-family: var(--font-mono); font-weight: 400; font-variant-numeric: tabular-nums; color: var(--ink-2); }
.ui-day__top { display: grid; gap: 4px; margin: 0; padding: 0; list-style: none; font-size: var(--fs-xs); }
.ui-day__top li { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; }
.ui-day__top .num { font-family: var(--font-mono); font-variant-numeric: tabular-nums; color: var(--ink); flex: none; }
.ui-day__top .ui-day__m { flex: 0 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--ink-2); }
.ui-day__go { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 14px; }
.ui-day__go .ui-link { font-size: var(--fs-sm); }
</style>

<script setup lang="ts">
import { computed, ref } from 'vue'
import { TxIconButton } from '@talex-touch/tuffex/button'
import { TxTag } from '@talex-touch/tuffex/tag'
import PageHead from '../../ui/shell/PageHead.vue'
import Plate from '../../ui/data/Plate.vue'
import RowTable from '../../ui/data/RowTable.vue'
import GroupedRowTable from '../../ui/data/GroupedRowTable.vue'
import ProviderMark from '../../ui/data/ProviderMark.vue'
import SearchField from '../../ui/form/SearchField.vue'
import Segmented from '../../ui/form/Segmented.vue'
import Icon from '../../ui/Icon.vue'
import { useLive } from '../../ui/composables/useLive'
import { copyText } from '../../ui/feedback/toast'
import { fmtInt, NONE } from '../../ui/fmt'
import { useQueryState } from '../../lib/listState'
import { api } from '../../api'
import { usePaletteCommands } from '../../shell/palette'
import { isModelKind, kindChips, kindTag } from '../../lib/modelKind'
import { byUse, callableCount, fmtCtx, fmtPerM, modelFilterCounts, usedText, vendorOf, type Vendor } from './meModel'
import type { MeModel, MeModels } from '../../types'
import type { RowColumn } from '../../ui/types'

/**
 * /me/models (DESIGN §6.10): what this key may call. Search + one filter row, `我常用的` (top 5 by this
 * week's tokens), then every callable model grouped by maker. Prices are $ per million tokens; unknown is `—`,
 * a real zero is `免费`, never `$0`. Clicking an id copies it (toast `已复制 ‹id›`); phones get a 40px button.
 * Desktop rows carry no separate copy icon: the id itself is the copy button (one action per row, not two).
 */
const live = useLive<MeModels>((signal) => api.me.models(signal), {
  intervalMs: 5 * 60_000,
  isEmpty: (data) => data.models.length === 0,
})
const scope = useQueryState({ q: '', f: 'all', type: '' })

const models = computed(() => live.data.value?.models ?? [])
/** null badges while the callable list is unknown (gateway unreadable): never four `0`s */
const counts = computed(() => modelFilterCounts(live.data.value))
const FILTERS = computed(() => [
  { value: 'all', label: '全部', count: counts.value.all },
  { value: 'used', label: '我用过', count: counts.value.used },
  { value: 'priced', label: '有价格', count: counts.value.priced },
  { value: 'reasoning', label: '思考', count: counts.value.reasoning },
])
const headStatus = computed(() => {
  const data = live.data.value
  if (!data) return undefined
  // gateway unreadable: the count is unknown, not 0
  if (callableCount(data) === null) return '暂时读不到可调用的模型'
  return `可调用 ${fmtInt(counts.value.all)} · 有价格 ${fmtInt(counts.value.priced)} · 近 7 个自然日用过 ${fmtInt(counts.value.used)}`
})

/* 类型: only when this key can call more than one kind; counted over the whole list like the filters above */
const kind = computed(() => (isModelKind(scope.state.type) ? scope.state.type : ''))
const typeChips = computed(() => kindChips(models.value.map((m) => m.kind), live.data.value ? models.value.map((m) => m.kind) : null, kind.value))

const query = computed(() => scope.state.q.trim().toLowerCase())
const narrowed = computed(() => query.value !== '' || scope.state.f !== 'all' || kind.value !== '')
const filtered = computed(() => {
  const q = query.value
  const f = scope.state.f
  return models.value.filter((m) => {
    if (q && !m.id.toLowerCase().includes(q)) return false
    if (kind.value && m.kind !== kind.value) return false
    if (f === 'used') return (m.used7d?.requests ?? 0) > 0
    if (f === 'priced') return m.pricing !== null
    if (f === 'reasoning') return m.reasoning === true
    return true
  })
})
const favourites = computed(() => models.value.filter((m) => (m.used7d?.requests ?? 0) > 0).sort(byUse).slice(0, 5))

/* vendor groups: most-used vendor first; each group shows 6 rows until expanded (search / filter shows all) */
const COLLAPSED = 6
const expanded = ref(new Set<string>())
type Group = { key: string; head: string; vendor: Vendor; rows: MeModel[]; total: number }
const groups = computed<Group[]>(() => {
  const by = new Map<string, { vendor: Vendor; rows: MeModel[]; used: number }>()
  for (const m of filtered.value) {
    const vendor = vendorOf(m.id)
    const entry = by.get(vendor.id) ?? { vendor, rows: [], used: 0 }
    entry.rows.push(m)
    entry.used += m.used7d?.tokens ?? 0
    by.set(vendor.id, entry)
  }
  return [...by.values()]
    .sort((a, b) => (a.vendor.id === 'other' ? 1 : b.vendor.id === 'other' ? -1 : 0) || b.used - a.used || b.rows.length - a.rows.length || a.vendor.label.localeCompare(b.vendor.label))
    .map(({ vendor, rows }) => {
      const sorted = [...rows].sort(byUse)
      const open = narrowed.value || expanded.value.has(vendor.id)
      return { key: vendor.id, head: vendor.label, vendor, rows: open ? sorted : sorted.slice(0, COLLAPSED), total: sorted.length }
    })
})
function toggle(id: string) {
  const next = new Set(expanded.value)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  expanded.value = next
}

const emptyText = computed(() => {
  const reason = live.data.value?.reason
  if (reason === 'key_blocked') return '本 Key 额度已用完 · 恢复后可调用'
  if (reason === 'gateway_unavailable') return '暂时读不到模型列表 · 稍后重试'
  return '没有可调用的模型'
})
const noMatch = computed(() => (query.value ? `没有匹配「${scope.state.q.trim()}」的模型` : '这一类没有模型'))

const priceTitle = (m: MeModel) => {
  const p = m.pricing
  if (!p) return '未定价'
  const parts = [`输入 ${fmtPerM(p.inputPerM)}`, `输出 ${fmtPerM(p.outputPerM)}`]
  if (p.cacheReadPerM !== null) parts.push(`缓存读 ${fmtPerM(p.cacheReadPerM)}`)
  if (p.cacheWritePerM !== null) parts.push(`缓存写 ${fmtPerM(p.cacheWritePerM)}`)
  return `${parts.join(' · ')} · $/百万 token${p.source ? ` · ${p.source}` : ''}`
}
const columns: RowColumn<MeModel>[] = [
  { key: 'id', title: '模型', minWidth: 240, card: 'primary' },
  { key: 'input', title: '输入 $/M', width: 92, align: 'right', nowrap: true, format: (_v, row) => fmtPerM(row.pricing?.inputPerM) },
  { key: 'output', title: '输出 $/M', width: 92, align: 'right', nowrap: true, format: (_v, row) => fmtPerM(row.pricing?.outputPerM) },
  { key: 'cacheRead', title: '缓存读 $/M', width: 100, align: 'right', nowrap: true, format: (_v, row) => fmtPerM(row.pricing?.cacheReadPerM) },
  { key: 'contextWindow', title: '上下文', width: 80, align: 'right', nowrap: true, format: (v) => fmtCtx(v as number | null) },
  { key: 'maxOutput', title: '最大输出', width: 88, align: 'right', nowrap: true, format: (v) => fmtCtx(v as number | null) },
  { key: 'used7d', title: '近 7 个自然日', width: 160, align: 'right', nowrap: true, format: (_v, row) => usedText(row.used7d) },
]

usePaletteCommands(() =>
  [...models.value].sort(byUse).slice(0, 200).map((m) => ({
    id: `find:model:${m.id}`,
    title: m.id,
    section: 'FIND' as const,
    hint: '复制模型 id',
    keywords: ['model', '模型'],
    run: () => void copyText(m.id, m.id),
  })),
)
</script>

<template>
  <div class="ui-page me-models">
    <PageHead title="模型" plain :status="headStatus">
      <template #actions>
        <SearchField v-model="scope.state.q" placeholder="搜索模型 id" label="搜索模型" />
      </template>
    </PageHead>

    <div class="me-models__filter">
      <span class="me-models__chips">
        <Segmented v-model="scope.state.f" :items="FILTERS" label="模型筛选" />
        <Segmented v-if="typeChips" v-model="scope.state.type" :items="typeChips" label="模型类型" />
      </span>
      <span class="me-models__unit">价格 = 每百万 token · 未定价 —</span>
    </div>

    <div class="me-models__stack">
      <Plate v-if="favourites.length && !narrowed" title="我常用的" flush :state="live.state.value" :error="live.error.value" :rows="5" @retry="live.refresh">
        <RowTable :columns="columns" :data="favourites" row-key="id" density="dense" caption="我常用的模型">
          <template #cell-id="{ row }">
            <span class="me-models__id">
              <button type="button" class="me-models__name num" :title="`复制 ${row.id}`" :aria-label="`复制 ${row.id}`" @click.stop="copyText(row.id, row.id)">{{ row.id }}</button>
              <TxTag v-if="kindTag(row.kind, kind)" :label="kindTag(row.kind) ?? ''" size="sm" variant="outline" />
              <TxTag v-if="row.reasoning" label="思考" size="sm" variant="plain" />
            </span>
          </template>
          <template #cell-input="{ row }"><span class="num" :title="priceTitle(row)">{{ fmtPerM(row.pricing?.inputPerM) }}</span></template>
          <template #card="{ row }">
            <div class="ui-rcard__l1">
              <span class="ui-rcard__primary"><span class="num me-models__cardid">{{ row.id }}</span><TxTag v-if="kindTag(row.kind, kind)" :label="kindTag(row.kind) ?? ''" size="sm" variant="outline" /><TxTag v-if="row.reasoning" label="思考" size="sm" variant="plain" /></span>
              <TxIconButton class="me-models__cardcopy" :label="`复制 ${row.id}`" size="md" @click.stop="copyText(row.id, row.id)"><Icon name="copy" /></TxIconButton>
            </div>
            <div class="ui-rcard__ln num">
              <span class="ui-rcard__seg">{{ row.pricing ? `${fmtPerM(row.pricing.inputPerM)} / ${fmtPerM(row.pricing.outputPerM)}` : '未定价' }}</span>
              <span class="ui-rcard__seg">{{ fmtCtx(row.contextWindow) }} 上下文</span>
              <span class="ui-rcard__seg">{{ usedText(row.used7d) }}</span>
            </div>
          </template>
        </RowTable>
      </Plate>

      <Plate
        :title="narrowed ? `匹配 ${fmtInt(filtered.length)} 个` : '全部'"
        :state="live.state.value"
        :error="live.error.value"
        :rows="10"
        :empty-text="emptyText"
        :stale-at="live.lastAt.value"
        @retry="live.refresh"
      >
        <p v-if="!filtered.length" class="me-models__none">— {{ noMatch }} · <button type="button" class="ui-link" @click="scope.reset()">清除筛选</button></p>
        <GroupedRowTable v-else :groups="groups" :columns="columns" row-key="id" density="dense">
          <template #group-head="{ group }">
            <ProviderMark v-if="group.vendor.logo" :provider="group.vendor.logo" :size="22" />
            <span v-else class="me-models__nomark" aria-hidden="true" />
            <h3 class="me-models__vendor">{{ group.head }}</h3>
            <span class="me-models__count num">{{ fmtInt(group.total) }}</span>
            <button v-if="!narrowed && group.total > COLLAPSED" type="button" class="ui-link me-models__more" :aria-expanded="expanded.has(group.key)" @click="toggle(group.key)">
              {{ expanded.has(group.key) ? '收起' : `展开另 ${fmtInt(group.total - COLLAPSED)} 个` }}
            </button>
          </template>
          <template #cell-id="{ row }">
            <span class="me-models__id">
              <button type="button" class="me-models__name num" :title="`复制 ${row.id}`" :aria-label="`复制 ${row.id}`" @click.stop="copyText(row.id, row.id)">{{ row.id }}</button>
              <TxTag v-if="kindTag(row.kind, kind)" :label="kindTag(row.kind) ?? ''" size="sm" variant="outline" />
              <TxTag v-if="row.reasoning" label="思考" size="sm" variant="plain" />
            </span>
          </template>
          <template #cell-input="{ row }"><span class="num" :title="priceTitle(row)">{{ fmtPerM(row.pricing?.inputPerM) }}</span></template>
          <template #card="{ row }">
            <div class="ui-rcard__l1">
              <span class="ui-rcard__primary"><span class="num me-models__cardid">{{ row.id }}</span><TxTag v-if="kindTag(row.kind, kind)" :label="kindTag(row.kind) ?? ''" size="sm" variant="outline" /><TxTag v-if="row.reasoning" label="思考" size="sm" variant="plain" /></span>
              <TxIconButton class="me-models__cardcopy" :label="`复制 ${row.id}`" size="md" @click.stop="copyText(row.id, row.id)"><Icon name="copy" /></TxIconButton>
            </div>
            <div class="ui-rcard__ln num">
              <span class="ui-rcard__seg">{{ row.pricing ? `${fmtPerM(row.pricing.inputPerM)} / ${fmtPerM(row.pricing.outputPerM)}` : '未定价' }}</span>
              <span class="ui-rcard__seg">{{ fmtCtx(row.contextWindow) }} 上下文</span>
              <span v-if="row.used7d?.requests" class="ui-rcard__seg">{{ usedText(row.used7d) }}</span>
            </div>
          </template>
        </GroupedRowTable>
      </Plate>
    </div>
  </div>
</template>

<style>
.me-models__filter { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 8px 16px; margin: -12px 0 -4px; }
.me-models__chips { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; min-width: 0; }
.me-models__unit { font-size: var(--fs-xs); color: var(--ink-3); }
.me-models__stack { display: grid; gap: 26px; min-width: 0; }
.me-models__id { display: flex; align-items: center; gap: 8px; min-width: 0; }
.me-models__name { all: unset; cursor: copy; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-family: var(--font-mono); color: var(--ink); }
.me-models__name:hover { text-decoration: underline; text-underline-offset: 3px; }
.me-models__name:focus-visible { outline: 2px solid var(--signal); outline-offset: 2px; }
.me-models__vendor { margin: 0; font-size: var(--fs-md); font-weight: 600; }
.me-models__count { font-size: var(--fs-sm); color: var(--ink-3); }
.me-models__more { margin-left: auto; }
.me-models__nomark { width: 22px; height: 22px; background: var(--paper-3); border-radius: var(--r-1); flex: none; }
.me-models__none { margin: 12px 0 4px; font-size: var(--fs-sm); color: var(--ink-3); }
/* a long id wraps instead of widening the grouped grid's single column past the phone (it is what gets copied) */
.me-models__cardid { min-width: 0; white-space: normal; overflow-wrap: anywhere; }
.me-models__cardcopy { flex: none; width: 40px; height: 40px; margin: -8px -6px -8px 0; }
.me-models .ui-rcard__l1 { align-items: center; }
</style>

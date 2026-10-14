<script setup lang="ts">
import { computed, ref } from 'vue'
import { TxButton } from '@talex-touch/tuffex/button'
import { TxCheckbox } from '@talex-touch/tuffex/checkbox'
import { TxTag } from '@talex-touch/tuffex/tag'
import SearchField from '../../ui/form/SearchField.vue'
import Segmented from '../../ui/form/Segmented.vue'
import { fmtInt } from '../../ui/fmt'
import type { SegmentItem } from '../../ui/types'
import type { ChannelModelPreviewRow } from '../../types'

/**
 * 「拉取模型」的勾选列表：上游这次返回的模型 ∪ 渠道里已有、上游没列的映射。
 * 勾上 = 接入并开着；新模型不勾 = 记为人工停用（自动同步不会再加回）；「上游没有」的不勾 = 从渠道摘掉。
 * 只管勾选状态，写入由抽屉统一提交。
 */
const props = defineProps<{ rows: ChannelModelPreviewRow[] }>()
const selected = defineModel<Set<string>>({ required: true })

type Filter = 'all' | 'new' | 'have' | 'gone'
const counts = computed(() => ({
  all: props.rows.length,
  new: props.rows.filter((row) => row.state === 'new').length,
  have: props.rows.filter((row) => row.state === 'on' || row.state === 'off').length,
  gone: props.rows.filter((row) => row.state === 'gone').length,
}))
const filter = ref<Filter>(counts.value.new ? 'new' : 'all')
const q = ref('')
const filterItems = computed<SegmentItem[]>(() => [
  { value: 'all', label: '全部', count: counts.value.all },
  { value: 'new', label: '新增', count: counts.value.new },
  { value: 'have', label: '已接入', count: counts.value.have },
  { value: 'gone', label: '上游没有', count: counts.value.gone },
])

const visible = computed(() => {
  const term = q.value.trim().toLowerCase()
  return props.rows.filter((row) => {
    if (filter.value === 'new' && row.state !== 'new') return false
    if (filter.value === 'have' && row.state !== 'on' && row.state !== 'off') return false
    if (filter.value === 'gone' && row.state !== 'gone') return false
    return !term || row.model.toLowerCase().includes(term) || row.id.toLowerCase().includes(term)
  })
})

const TAG: Record<ChannelModelPreviewRow['state'], string> = { on: '', off: '人工停用', new: '新', gone: '上游没有' }
const TAG_TITLE: Record<ChannelModelPreviewRow['state'], string> = {
  on: '',
  off: '之前人工停用 · 勾上恢复',
  new: '渠道里还没有 · 不勾记为人工停用，自动同步不会再加回',
  gone: '渠道里有、这次上游列表里没有 · 可能已下架，也可能是上游不列的隐藏模型 · 不勾就从渠道摘掉',
}

function toggle(id: string, on: boolean) {
  const next = new Set(selected.value)
  if (on) next.add(id)
  else next.delete(id)
  selected.value = next
}
function selectVisible(on: boolean) {
  const next = new Set(selected.value)
  for (const row of visible.value) {
    if (on) next.add(row.id)
    else next.delete(row.id)
  }
  selected.value = next
}
</script>

<template>
  <div class="cx-pick">
    <div class="cx-pick__tools">
      <SearchField v-model="q" placeholder="模型 id" label="筛选上游模型" :slash="false" class="cx-pick__search" />
      <Segmented v-model="filter" :items="filterItems" label="按和渠道现状的关系筛选" />
    </div>
    <div class="cx-pick__bulk">
      <span class="cx-pick__count num">当前列表 {{ fmtInt(visible.length) }} 个</span>
      <TxButton variant="ghost" size="sm" :disabled="!visible.length" @click="selectVisible(true)">全选</TxButton>
      <TxButton variant="ghost" size="sm" :disabled="!visible.length" @click="selectVisible(false)">全不选</TxButton>
    </div>
    <ul v-if="visible.length" class="cx-pick__list" aria-label="上游模型勾选">
      <li v-for="row in visible" :key="row.id">
        <TxCheckbox class="cx-pick__row" :model-value="selected.has(row.id)" @update:model-value="(on: boolean) => toggle(row.id, on)">
          <span class="cx-pick__id mono ellip" :title="row.model">{{ row.model }}</span>
          <span v-if="row.id !== row.model" class="cx-pick__up mono ellip" :title="`上游 id ${row.id}`">{{ row.id }}</span>
          <TxTag v-if="TAG[row.state]" size="sm" :variant="row.state === 'new' ? 'outline' : 'plain'" :label="TAG[row.state]" :title="TAG_TITLE[row.state]" class="cx-pick__tag" />
        </TxCheckbox>
      </li>
    </ul>
    <p v-else class="cx-pick__none">— {{ q.trim() ? `没有匹配「${q.trim()}」的模型` : filter === 'new' ? '上游没有新模型' : filter === 'gone' ? '渠道里的模型上游都列着' : '没有模型' }}</p>
  </div>
</template>

<style>
.cx-pick { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
.cx-pick__tools { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin: 8px 0 0; }
.cx-pick__search { width: 200px; }
.cx-pick__bulk { display: flex; align-items: center; gap: 4px; min-width: 0; }
.cx-pick__count { margin-right: auto; font-size: var(--fs-xs); color: var(--ink-3); }
/* the scroll area keeps one hairline top and bottom (its bounds); rows are separated by spacing alone */
.cx-pick__list { list-style: none; margin: 0; padding: 2px 0; max-height: min(420px, 48vh); overflow: auto; border-top: 1px solid var(--rule); border-bottom: 1px solid var(--rule); }
html:root .cx-pick__row { display: flex; align-items: center; gap: 10px; width: 100%; min-height: 34px; padding: 0 4px; min-width: 0; border-radius: var(--r-1); }
html:root .cx-pick__row:hover { background: var(--paper-2); }
html:root .cx-pick__row .tx-checkbox__box { flex: none; }
html:root .cx-pick__row .tx-checkbox__label { display: flex; align-items: center; gap: 10px; flex: 1 1 auto; min-width: 0; font-size: var(--fs-sm); color: var(--ink); text-align: left; }
.cx-pick__id { flex: 0 1 auto; min-width: 0; }
.cx-pick__up { flex: 1 1 0; min-width: 0; color: var(--ink-3); font-size: var(--fs-xs); }
.cx-pick__tag { flex: none; margin-left: auto; }
.cx-pick__none { margin: 10px 0; font-size: var(--fs-sm); color: var(--ink-3); }
@media (max-width: 599px) {
  .cx-pick__search { width: 100%; }
}
@media (pointer: coarse) {
  html:root .cx-pick__row { min-height: 44px; }
}
</style>

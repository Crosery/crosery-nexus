<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, useTemplateRef, watch } from 'vue'
import { TxModal } from '@talex-touch/tuffex/modal'
import { TxButton } from '@talex-touch/tuffex/button'
import { TxCheckbox } from '@talex-touch/tuffex/checkbox'
import { TxTag } from '@talex-touch/tuffex/tag'
import Sheet from '../../ui/feedback/Sheet.vue'
import SearchField from '../../ui/form/SearchField.vue'
import Segmented from '../../ui/form/Segmented.vue'
import { useBreakpoint } from '../../ui/composables/useBreakpoint'
import { focusInModal } from '../../lib/focus'
import { fmtInt } from '../../ui/fmt'
import type { SegmentItem } from '../../ui/types'

export type PulledModelRow = {
  /** selection key */
  id: string
  /** what the row shows (the exposed model id) */
  model: string
  /** secondary text, e.g. the upstream id when it differs */
  sub?: string
  /** new → checkable; anything already there is listed read-only */
  fresh: boolean
  /** tag on read-only rows: 已接入 / 已停用 / 上游没列 */
  tag?: string
  tagTitle?: string
}

/**
 * 「拉取模型」之后的勾选弹窗（≥960 TxModal，<960 底部 Sheet），渠道和账号池共用。
 * 只有新模型能勾；已经在的模型列出来但不可勾，搜索、筛选都覆盖。只管勾选状态，写入由调用方在 apply 时做。
 * 叠在详情抽屉上面：Esc / Tab 在捕获阶段由这里处理，否则抽屉挂在 document 上的处理会一起关掉或把焦点抢回去。
 */
const props = defineProps<{
  title: string
  summary: string
  rows: PulledModelRow[]
  /** footer line: what 确定 will write */
  hint: string
  confirmText: string
  canApply: boolean
  busy?: boolean
}>()
const open = defineModel<boolean>({ default: false })
const selected = defineModel<Set<string>>('selected', { required: true })
const emit = defineEmits<{ apply: [] }>()
const { isMobile } = useBreakpoint()
const body = useTemplateRef<HTMLElement>('body')
const search = useTemplateRef<InstanceType<typeof SearchField>>('search')

type Filter = 'new' | 'have' | 'all'
const counts = computed(() => {
  const fresh = props.rows.filter((row) => row.fresh).length
  return { new: fresh, have: props.rows.length - fresh, all: props.rows.length }
})
const filter = ref<Filter>('all')
const q = ref('')
const filterItems = computed<SegmentItem[]>(() => [
  { value: 'new', label: '新增', count: counts.value.new },
  { value: 'have', label: '已有', count: counts.value.have },
  { value: 'all', label: '全部', count: counts.value.all },
])

const ordered = computed(() => [...props.rows].sort((a, b) => Number(b.fresh) - Number(a.fresh) || a.model.localeCompare(b.model, undefined, { numeric: true })))
const visible = computed(() => {
  const term = q.value.trim().toLowerCase()
  return ordered.value.filter((row) => {
    if (filter.value === 'new' && !row.fresh) return false
    if (filter.value === 'have' && row.fresh) return false
    return !term || row.model.toLowerCase().includes(term) || Boolean(row.sub?.toLowerCase().includes(term))
  })
})
const visibleFresh = computed(() => visible.value.filter((row) => row.fresh))
const picked = computed(() => props.rows.filter((row) => row.fresh && selected.value.has(row.id)).length)

function toggle(id: string, on: boolean) {
  const next = new Set(selected.value)
  if (on) next.add(id)
  else next.delete(id)
  selected.value = next
}
function selectVisible(on: boolean) {
  const next = new Set(selected.value)
  for (const row of visibleFresh.value) {
    if (on) next.add(row.id)
    else next.delete(row.id)
  }
  selected.value = next
}

const emptyWords = computed(() => {
  if (q.value.trim()) return `没有匹配「${q.value.trim()}」的模型`
  if (filter.value === 'new') return '上游没有新模型 · 列表里的都已经有了'
  return '没有模型'
})

function focusables(): HTMLElement[] {
  const root = body.value?.closest<HTMLElement>('.tx-modal__overlay, .tx-drawer__panel')
  if (!root) return []
  return [...root.querySelectorAll<HTMLElement>('a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])')]
    .filter((el) => el.getClientRects().length > 0)
}
function onKeydown(event: KeyboardEvent) {
  if (!open.value) return
  if (event.key === 'Escape') {
    event.preventDefault()
    event.stopPropagation()
    if (!props.busy) open.value = false
    return
  }
  if (event.key !== 'Tab') return
  const list = focusables()
  if (!list.length) return
  event.preventDefault()
  event.stopPropagation()
  const at = list.indexOf(document.activeElement as HTMLElement)
  const next = at < 0 ? (event.shiftKey ? list.length - 1 : 0) : (at + (event.shiftKey ? -1 : 1) + list.length) % list.length
  list[next].focus()
}
function listen(on: boolean) {
  if (on) window.addEventListener('keydown', onKeydown, true)
  else window.removeEventListener('keydown', onKeydown, true)
}
onBeforeUnmount(() => listen(false))

watch(open, async (isOpen) => {
  listen(isOpen)
  if (!isOpen) return
  q.value = ''
  filter.value = counts.value.new ? 'new' : 'all'
  await nextTick()
  // TxModal hard-codes aria-label="Close" on its × button
  document.querySelector('.tx-modal__close')?.setAttribute('aria-label', '关闭')
  void focusInModal(search.value, '.pmd__search input')
}, { immediate: true, flush: 'post' })

const shell = computed(() => (isMobile.value ? { side: 'bottom', height: 'auto' } : { width: 'min(92vw, 640px)' }))
</script>

<template>
  <component :is="isMobile ? Sheet : TxModal" v-model="open" :title="title" v-bind="shell">
    <div ref="body" class="pmd">
      <p class="pmd__sum num">{{ summary }}</p>
      <div class="pmd__tools">
        <SearchField ref="search" v-model="q" placeholder="搜索模型 id" label="搜索模型" :slash="false" class="pmd__search" />
        <Segmented v-model="filter" :items="filterItems" label="按是否已有筛选" />
      </div>
      <div v-if="filter !== 'have' && counts.new" class="pmd__bulk">
        <span class="pmd__count num">已选 {{ fmtInt(picked) }} / {{ fmtInt(counts.new) }} 个新模型</span>
        <TxButton variant="ghost" size="sm" :disabled="!visibleFresh.length || busy" @click="selectVisible(true)">全选</TxButton>
        <TxButton variant="ghost" size="sm" :disabled="!visibleFresh.length || busy" @click="selectVisible(false)">全不选</TxButton>
      </div>
      <ul v-if="visible.length" class="pmd__list" aria-label="拉取到的模型">
        <li v-for="row in visible" :key="row.id" :class="{ 'is-have': !row.fresh }">
          <TxCheckbox
            class="pmd__row"
            :model-value="row.fresh && selected.has(row.id)"
            :disabled="!row.fresh || busy"
            @update:model-value="(on: boolean) => toggle(row.id, on)"
          >
            <span class="pmd__id mono ellip" :title="row.model">{{ row.model }}</span>
            <span v-if="row.sub" class="pmd__sub mono ellip" :title="row.sub">{{ row.sub }}</span>
            <TxTag v-if="row.tag" size="sm" variant="plain" :label="row.tag" :title="row.tagTitle" class="pmd__tag" />
          </TxCheckbox>
        </li>
      </ul>
      <p v-else class="pmd__none">— {{ emptyWords }}</p>
    </div>
    <template #footer>
      <div class="pmd__foot">
        <span class="pmd__hint num">{{ hint }}</span>
        <span class="pmd__actions">
          <template v-if="counts.new">
            <TxButton variant="secondary" :disabled="busy" @click="open = false">取消</TxButton>
            <TxButton variant="primary" :loading="busy" :disabled="!canApply" @click="emit('apply')">{{ confirmText }}</TxButton>
          </template>
          <TxButton v-else variant="secondary" @click="open = false">关闭</TxButton>
        </span>
      </div>
    </template>
  </component>
</template>

<style>
.pmd { display: flex; flex-direction: column; gap: 8px; min-width: 0; }
.pmd__sum { margin: 0; font-size: var(--fs-xs); color: var(--ink-3); }
.pmd__tools { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.pmd__search { width: 220px; }
.pmd__bulk { display: flex; align-items: center; gap: 4px; min-width: 0; }
.pmd__count { margin-right: auto; font-size: var(--fs-xs); color: var(--ink-2); }
/* the scroll area keeps one hairline top and bottom (its bounds); rows are separated by spacing alone */
.pmd__list { list-style: none; margin: 0; padding: 2px 0; max-height: min(420px, 50vh); overflow: auto; border-top: 1px solid var(--rule); border-bottom: 1px solid var(--rule); }
html:root .pmd__row { display: flex; align-items: center; gap: 10px; width: 100%; min-height: 34px; padding: 0 4px; min-width: 0; border-radius: var(--r-1); }
html:root .pmd__row:not(.is-disabled):hover { background: var(--paper-2); }
html:root .pmd__row .tx-checkbox__box { flex: none; }
html:root .pmd__row .tx-checkbox__label { display: flex; align-items: center; gap: 10px; flex: 1 1 auto; min-width: 0; font-size: var(--fs-sm); color: var(--ink); text-align: left; }
/* read-only rows: the model stays legible, only the box and the text tone say "already there" */
html:root .pmd__list .is-have .pmd__row { opacity: 1; cursor: default; }
html:root .pmd__list .is-have .pmd__row .tx-checkbox__box { opacity: .35; }
.pmd__list .is-have .pmd__id { color: var(--ink-3); }
.pmd__id { flex: 0 1 auto; min-width: 0; }
.pmd__sub { flex: 1 1 0; min-width: 0; color: var(--ink-3); font-size: var(--fs-xs); }
.pmd__tag { flex: none; margin-left: auto; }
.pmd__none { margin: 10px 0; font-size: var(--fs-sm); color: var(--ink-3); }
.pmd__foot { display: flex; align-items: center; justify-content: space-between; gap: 10px; width: 100%; min-width: 0; }
.pmd__hint { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: var(--fs-xs); color: var(--ink-2); }
.pmd__actions { display: inline-flex; gap: 8px; flex: none; }
@media (max-width: 959px) {
  .pmd__search { width: 100%; }
  .pmd__foot { flex-wrap: wrap; }
  .pmd__hint { flex: 1 0 100%; white-space: normal; }
  .pmd__actions { flex: 1 0 100%; }
  html:root .pmd__actions .tx-button { flex: 1; min-height: var(--tap); }
}
@media (pointer: coarse) {
  html:root .pmd__row { min-height: 44px; }
}
</style>

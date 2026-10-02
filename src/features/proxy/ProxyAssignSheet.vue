<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { TxButton } from '@talex-touch/tuffex/button'
import { TxCheckbox } from '@talex-touch/tuffex/checkbox'
import { TxTag } from '@talex-touch/tuffex/tag'
import Sheet from '../../ui/feedback/Sheet.vue'
import StateBlock from '../../ui/data/StateBlock.vue'
import Pii from '../../ui/data/Pii.vue'
import SearchField from '../../ui/form/SearchField.vue'
import Segmented from '../../ui/form/Segmented.vue'
import { useBreakpoint } from '../../ui/composables/useBreakpoint'
import { confirmSheet } from '../../ui/feedback/confirmSheet'
import { notify } from '../../ui/feedback/toast'
import { errorMessage } from '../../lib/errors'
import { api } from '../../api'
import type { DataState } from '../../ui/types'
import type { ProxyAccountRow, ProxyAccountsData, ProxyEntryView } from '../../types'
import { accountExit, accountGroups, assignFacts } from './proxyModel'

/**
 * 分配给账号 (PROXY-SPEC §7): accounts by provider with what each one uses now; tick, then confirm (N accounts,
 * from → to). The write goes through the existing account writer and records the previous exit, so every account
 * that uses this exit can be put back with 还原. Opened from 在用 N the list starts filtered to those accounts.
 */
const props = defineProps<{ entry: ProxyEntryView | null; onlyUsing?: boolean }>()
const open = defineModel<boolean>({ default: false })
const emit = defineEmits<{ changed: [] }>()
const { isMobile } = useBreakpoint()

const data = ref<ProxyAccountsData | null>(null)
const loadError = ref<unknown>(null)
const scope = ref<string>('all')
const query = ref('')
const selected = ref(new Set<string>())
const busy = ref(false)

async function load() {
  loadError.value = null
  try {
    data.value = await api.proxies.accounts()
  } catch (error) {
    loadError.value = error
  }
}
watch(open, (now) => {
  if (!now) return
  data.value = null
  selected.value = new Set()
  query.value = ''
  scope.value = props.onlyUsing ? 'using' : 'all'
  void load()
})

const state = computed<DataState>(() => (data.value ? 'ready' : loadError.value ? 'error' : 'loading'))
const usingCount = computed(() => (data.value?.accounts ?? []).filter(row => row.entryId && row.entryId === props.entry?.id).length)
const scopes = computed(() => [
  { value: 'all', label: '全部账号' },
  { value: 'using', label: '在用这个出口', count: usingCount.value },
])
const groups = computed(() => accountGroups(data.value?.accounts ?? [], { entryId: scope.value === 'using' ? props.entry?.id ?? null : null, query: query.value }))
const isCurrent = (row: ProxyAccountRow) => Boolean(props.entry && row.entryId === props.entry.id)
const selectable = (row: ProxyAccountRow) => row.assignable && !isCurrent(row)
const pickedRows = computed(() => (data.value?.accounts ?? []).filter(row => selected.value.has(row.ref)))

function toggle(row: ProxyAccountRow, on: boolean) {
  const next = new Set(selected.value)
  if (on) next.add(row.ref)
  else next.delete(row.ref)
  selected.value = next
}

async function assign() {
  const entry = props.entry
  if (!entry || busy.value || !pickedRows.value.length) return
  const rows = pickedRows.value
  const ok = await confirmSheet({
    title: `分配给 ${rows.length} 个账号？`,
    body: entry.kind === 'mihomo' ? '账号会改走这台机器上的本机端口（mihomo 内核转发到节点）。' : undefined,
    facts: assignFacts(rows, entry.name),
    consequence: '可随时撤销 · 原出口已记下，可一键还原',
    confirmText: '分配',
  })
  if (!ok) return
  busy.value = true
  try {
    const result = await api.proxies.assign(entry.id, rows.map(row => row.ref))
    const warn = result.warnings?.length ? result.warnings.join(' · ') : undefined
    if (result.failed) notify(`◇ 已分配 ${result.updated} 个 · ${result.failed} 个失败`, { tone: 'warn', description: result.results.filter(item => item.status === 'failed').map(item => item.error).filter(Boolean).slice(0, 2).join(' · ') || warn, id: 'cx-proxy' })
    else notify(`✓ 已分配 ${result.updated} 个账号`, { tone: 'ok', description: warn, id: 'cx-proxy' })
    emit('changed')
    open.value = false
  } catch (error) {
    notify(`◆ 没有分配 · ${errorMessage(error) || '请求失败'}`, { tone: 'bad', id: 'cx-proxy' })
  } finally {
    busy.value = false
  }
}

async function restore(row: ProxyAccountRow) {
  if (busy.value) return
  const ok = await confirmSheet({
    title: '还原原来的出口？',
    facts: [{ k: '账号', v: row.label || row.name }, { k: '当前', v: accountExit(row) }],
    consequence: '恢复分配之前记下的出口',
    confirmText: '还原',
  })
  if (!ok) return
  busy.value = true
  try {
    await api.proxies.unassign([row.ref], true)
    notify('✓ 已还原', { tone: 'ok', id: 'cx-proxy' })
    emit('changed')
    await load()
  } catch (error) {
    notify(`◆ 没有还原 · ${errorMessage(error) || '请求失败'}`, { tone: 'bad', id: 'cx-proxy' })
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <Sheet v-model="open" :title="entry ? `分配 · ${entry.name}` : '分配给账号'" size="600px" :height="isMobile ? '92vh' : 'auto'">
    <div class="px-as">
      <p v-if="data" class="px-as__note">{{ data.signinNote }}</p>
      <div class="px-as__tools">
        <Segmented v-model="scope" :items="scopes" label="账号范围" />
        <SearchField v-model="query" class="px-as__q" placeholder="筛选账号" label="筛选账号" :slash="false" />
      </div>
      <StateBlock v-if="state !== 'ready'" :state="state" :error="loadError" :rows="5" @retry="load" />
      <p v-else-if="!groups.length" class="px-as__none">— {{ scope === 'using' ? '没有账号在用这个出口' : '没有匹配的账号' }}</p>
      <section v-for="g in groups" v-else :key="g.provider" class="px-as__group" :aria-label="g.label">
        <h3 class="px-as__h">{{ g.label }} <span class="num dim">{{ g.rows.length }}</span></h3>
        <ul>
          <li v-for="row in g.rows" :key="row.ref" :class="{ 'is-off': row.disabled }">
            <TxCheckbox
              :model-value="selected.has(row.ref) || isCurrent(row)"
              :disabled="!selectable(row) || busy"
              :aria-label="`选择账号 ${row.label || row.name}`"
              @update:model-value="(on: boolean) => toggle(row, on)"
            >
              <span class="px-as__name ellip"><Pii :value="row.label || row.name" /></span>
            </TxCheckbox>
            <span class="px-as__exit ellip" :class="{ mono: row.mode === 'url' && !row.entryName }" :title="accountExit(row)">{{ accountExit(row) }}</span>
            <span class="px-as__end">
              <TxTag v-if="isCurrent(row)" size="sm" variant="plain" label="当前" />
              <TxTag v-else-if="!row.assignable" size="sm" variant="outline" label="只读" />
              <TxButton v-if="isCurrent(row) && row.restorable" size="sm" variant="ghost" :disabled="busy" @click="restore(row)">还原</TxButton>
            </span>
          </li>
        </ul>
      </section>
    </div>
    <template #footer>
      <div class="px-add__foot">
        <span class="px-add__fh">{{ entry && !entry.assignable ? entry.unassignableReason : selected.size ? `已选 ${selected.size} 个` : '勾选要改走这个出口的账号' }}</span>
        <TxButton variant="primary" :loading="busy" :disabled="busy || !selected.size || !entry?.assignable" @click="assign">{{ selected.size ? `分配 ${selected.size} 个账号` : '分配' }}</TxButton>
      </div>
    </template>
  </Sheet>
</template>

<style>
.px-as { display: grid; gap: 12px; min-width: 0; }
.px-as__note { margin: 0; font-size: var(--fs-xs); line-height: 1.5; color: var(--ink-3); }
.px-as__tools { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 12px; }
.px-as__q { flex: 1 1 180px; min-width: 0; }
.px-as__none { margin: 0; font-size: var(--fs-sm); color: var(--ink-3); }
.px-as__group ul { margin: 0; padding: 0; list-style: none; }
.px-as__h { margin: 0; padding: 6px 0; font-size: var(--fs-sm); font-weight: 600; color: var(--ink); border-bottom: 1px solid var(--rule-2); display: flex; gap: 8px; align-items: baseline; }
.px-as__group li { display: grid; grid-template-columns: minmax(0, 1.2fr) minmax(0, 1fr) auto; align-items: center; gap: 10px; min-height: 40px; border-bottom: 1px solid var(--rule); font-size: var(--fs-sm); }
.px-as__group li.is-off { color: var(--ink-3); }
html:root .px-as__group .tx-checkbox { min-width: 0; max-width: 100%; }
html:root .px-as__group .tx-checkbox__label { min-width: 0; }
.px-as__name { display: block; min-width: 0; }
.px-as__exit { font-size: var(--fs-xs); color: var(--ink-2); min-width: 0; }
.px-as__end { display: inline-flex; align-items: center; gap: 6px; justify-self: end; }
@media (max-width: 599px) {
  .px-as__group li { grid-template-columns: minmax(0, 1fr) auto; row-gap: 0; padding: 6px 0; }
  .px-as__exit { grid-column: 1; grid-row: 2; padding-left: 26px; }
  .px-as__end { grid-row: 1 / span 2; grid-column: 2; }
}
</style>

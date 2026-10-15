<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { TxButton } from '@talex-touch/tuffex/button'
import { TxTag } from '@talex-touch/tuffex/tag'
import Plate from '../../ui/data/Plate.vue'
import RowTable from '../../ui/data/RowTable.vue'
import StatusMark from '../../ui/data/StatusMark.vue'
import SearchField from '../../ui/form/SearchField.vue'
import Segmented from '../../ui/form/Segmented.vue'
import Pager from '../../ui/data/Pager.vue'
import { paginate } from '../../lib/listState'
import { useLive } from '../../ui/composables/useLive'
import { confirmSheet } from '../../ui/feedback/confirmSheet'
import { notify } from '../../ui/feedback/toast'
import { errorMessage } from '../../lib/errors'
import { api } from '../../api'
import { useServiceRestart } from './useServiceRestart'
import type { InstalledPlugin, StorePlugin } from '../../api/plugins'
import type { RowColumn, SegmentItem, StatusKind } from '../../ui/types'

/**
 * 插件市场：商店里的 CPA 插件一键安装，已装插件一键卸载。
 * 安装 / 卸载只改磁盘上的插件文件，CPA 进程重启后才会注册或完全卸载——页面顶部一直写明这一点。
 */
type Row = {
  id: string
  name: string
  description: string
  author: string
  version: string
  tags: string[]
  source: string
  installed: boolean
  updatable: boolean
  registered: boolean
  enabled: boolean
  /** 本地有文件、商店里没有（手动放进去的 .so） */
  local: boolean
  homepage: string
}

// 商店读的是远端 registry：不轮询，手动刷新
const storeLive = useLive(() => api.plugins.store(), { intervalMs: 0, isEmpty: () => false })
const installedLive = useLive(() => api.plugins.installed(), { intervalMs: 0, isEmpty: () => false })

const view = ref<string>('store')
const query = ref('')
const tag = ref('')
const page = ref(1)
const PAGE_SIZE = 10
const busy = ref<Set<string>>(new Set())
/** 本次会话里装 / 卸过：即使列表还没反映，也提示要重启 */
const changed = ref(false)

const installedById = computed(() => new Map((installedLive.data.value?.plugins ?? []).map((item) => [item.id, item])))

function rowOf(store: StorePlugin | null, local: InstalledPlugin | null): Row {
  const id = store?.id ?? local!.id
  const version = local?.version || store?.installed_version || ''
  return {
    id,
    name: store?.name || id,
    description: store?.description ?? '',
    author: store?.author ?? '',
    version: version || store?.version || '',
    tags: store?.tags ?? [],
    source: store?.source_id ?? '',
    installed: Boolean(local) || Boolean(store?.installed),
    updatable: Boolean(store?.update_available),
    registered: Boolean(local?.registered),
    enabled: Boolean(local?.effective_enabled),
    local: !store,
    homepage: store?.homepage || store?.repository || '',
  }
}

const rows = computed<Row[]>(() => {
  const storeList = storeLive.data.value?.plugins ?? []
  const seen = new Set<string>()
  const out: Row[] = []
  for (const item of storeList) {
    seen.add(item.id)
    out.push(rowOf(item, installedById.value.get(item.id) ?? null))
  }
  for (const [id, item] of installedById.value) if (!seen.has(id)) out.push(rowOf(null, item))
  return out
})

const installedRows = computed(() => rows.value.filter((row) => row.installed))

const baseRows = computed(() => (view.value === 'installed' ? installedRows.value : rows.value))

/** 商店里出现最多的标签，做成一排快捷筛选；其余靠搜索 */
const tagItems = computed<SegmentItem[]>(() => {
  const counts = new Map<string, number>()
  for (const row of baseRows.value) for (const t of row.tags) counts.set(t, (counts.get(t) ?? 0) + 1)
  const top = [...counts].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([value, count]) => ({ value, label: value, count }))
  return [{ value: '', label: '全部' }, ...top]
})

const filtered = computed(() => {
  const needle = query.value.trim().toLowerCase()
  let list = baseRows.value
  if (tag.value) list = list.filter((row) => row.tags.includes(tag.value))
  if (needle) list = list.filter((row) => [row.id, row.name, row.description, row.author, ...row.tags].some((text) => text.toLowerCase().includes(needle)))
  // 商店视图：可更新 > 已安装 > 其余，同级保持商店顺序
  return view.value === 'store' ? [...list].sort((a, b) => Number(b.updatable) - Number(a.updatable) || Number(b.installed) - Number(a.installed)) : list
})
const paged = computed(() => paginate(filtered.value, page.value, PAGE_SIZE))
watch([query, tag, view], () => { page.value = 1 })

const viewItems = computed<SegmentItem[]>(() => [
  { value: 'store', label: '商店', count: rows.value.length },
  { value: 'installed', label: '已安装', count: installedRows.value.length },
])

const columns: RowColumn<Row>[] = [
  { key: 'name', title: '插件' },
  { key: 'version', title: '版本', width: 96 },
  { key: 'status', title: '状态', width: 150 },
  { key: 'ops', title: '', width: 210, align: 'right' },
]

function statusOf(row: Row): { state: StatusKind; label: string } | null {
  if (!row.installed) return null
  if (row.registered && row.enabled) return { state: 'run', label: '运行中' }
  if (!row.registered) return { state: 'warn', label: '待重启 CPA' }
  return { state: 'off', label: '已停用' }
}

async function mutate(row: Row, work: () => Promise<unknown>, done: string) {
  if (busy.value.has(row.id)) return
  busy.value = new Set(busy.value).add(row.id)
  try {
    await work()
    changed.value = true
    notify(`✓ ${done} · ${row.name}，需重启 CPA 后生效`)
  } catch (error) {
    notify(`◆ ${done}失败 · ${row.name} · ${errorMessage(error) || '请求失败'}`, { tone: 'bad' })
  } finally {
    const next = new Set(busy.value)
    next.delete(row.id)
    busy.value = next
    await Promise.all([installedLive.refresh(), storeLive.refresh()])
  }
}

const install = (row: Row) => mutate(row, () => api.plugins.install(row.id, row.source || undefined), row.installed ? '更新' : '安装')

async function uninstall(row: Row) {
  const ok = await confirmSheet({
    title: `卸载 ${row.name}？`,
    body: '会删除磁盘上的插件文件；已加载的实例要重启 CPA 才会完全卸载。',
    confirmText: '卸载',
    danger: true,
    facts: [{ k: 'ID', v: row.id }, ...(row.version ? [{ k: '版本', v: row.version }] : [])],
  })
  if (ok) await mutate(row, () => api.plugins.remove(row.id), '卸载')
}

/* ── 重启 CPA：插件是 .so，进程重启后才会加载 ── */
const { restarting, restart: restartCpa } = useServiceRestart('cpa', () => { changed.value = false; refresh() })

/** 文件已装、但 CPA 还没加载它 */
const needsRestart = (row: Row) => row.installed && !row.registered && !restarting.value

function refresh() {
  void Promise.all([installedLive.refresh(), storeLive.refresh()])
}

const loadState = computed(() => (storeLive.state.value === 'loading' || installedLive.state.value === 'loading' ? 'loading' : storeLive.state.value === 'error' ? 'error' : 'ready'))
</script>

<template>
  <Plate title="插件市场" flush>
    <template #actions>
      <TxButton variant="subtle" size="small" @click="refresh">刷新</TxButton>
    </template>


    <div class="ui-toolbar pg-toolbar">
      <SearchField v-model="query" placeholder="搜索插件、作者或标签" label="搜索插件" />
      <Segmented v-model="view" :items="viewItems" label="插件视图" />
    </div>
    <div v-if="tagItems.length > 1" class="pg-tags">
      <Segmented v-model="tag" :items="tagItems" label="按标签筛选" />
    </div>

    <RowTable
      :columns="columns"
      :data="paged.rows"
      row-key="id"
      density="two-line"
      :state="loadState"
      :error="storeLive.error.value"
      :empty-text="view === 'installed' ? '还没有安装插件' : '没有匹配的插件'"
      caption="CPA 插件"
    >
      <template #cell-name="{ row }">
        <span class="cx-2l">
          <span class="cx-strong ellip">{{ row.name }}<span class="dim pg-meta">{{ [row.author, row.tags.slice(0, 2).join(' / ')].filter(Boolean).join(' · ') }}</span><a v-if="row.homepage" class="pg-link" :href="row.homepage" target="_blank" rel="noopener noreferrer" @click.stop>详情 ↗</a></span>
          <span class="cx-l2 ellip" :title="row.description">{{ row.description || (row.local ? '本地手动放入的插件，不在商店里' : '暂无介绍') }}</span>
        </span>
      </template>
      <template #cell-version="{ row }"><span class="mono">{{ row.version || '—' }}</span></template>
      <template #cell-status="{ row }">
        <span class="pg-status">
          <StatusMark v-if="statusOf(row)" :state="statusOf(row)!.state" :label="statusOf(row)!.label" />
          <span v-else class="dim">未安装</span>
          <TxTag v-if="row.updatable" size="small">可更新</TxTag>
        </span>
      </template>
      <template #cell-ops="{ row }">
        <span class="pg-ops">
          <TxButton v-if="row.updatable" variant="subtle" size="small" :disabled="busy.has(row.id)" @click="install(row)">{{ busy.has(row.id) ? '更新中…' : '更新' }}</TxButton>
          <TxButton v-if="needsRestart(row)" variant="primary" size="small" :disabled="restarting" @click="restartCpa">{{ restarting ? '重启中…' : '重启 CPA' }}</TxButton>
          <TxButton v-if="!row.installed" variant="subtle" size="small" :disabled="busy.has(row.id)" @click="install(row)">{{ busy.has(row.id) ? '安装中…' : '安装' }}</TxButton>
          <TxButton v-else variant="ghost" size="small" :disabled="busy.has(row.id)" @click="uninstall(row)">{{ busy.has(row.id) ? '处理中…' : '卸载' }}</TxButton>
        </span>
      </template>
      <template #card="{ row }">
        <div class="cx-card">
          <div class="cx-card__l1">
            <StatusMark v-if="statusOf(row)" :state="statusOf(row)!.state" :label="statusOf(row)!.label" bare />
            <span class="cx-card__name ellip">{{ row.name }}</span>
            <TxButton v-if="needsRestart(row)" variant="primary" size="small" :disabled="restarting" @click.stop="restartCpa">{{ restarting ? '重启中…' : '重启 CPA' }}</TxButton>
            <TxButton v-if="!row.installed" variant="subtle" size="small" :disabled="busy.has(row.id)" @click.stop="install(row)">安装</TxButton>
            <TxButton v-else variant="ghost" size="small" :disabled="busy.has(row.id)" @click.stop="uninstall(row)">卸载</TxButton>
          </div>
          <div class="cx-card__ln ellip">{{ row.author }}{{ row.author ? ' · ' : '' }}{{ row.id }}{{ row.version ? ` · ${row.version}` : '' }}{{ row.updatable ? ' · 可更新' : '' }}</div>
        </div>
      </template>
    </RowTable>
    <div class="pg-foot"><Pager v-model:page="page" :total="paged.total" :page-size="PAGE_SIZE" /></div>
  </Plate>
</template>

<style scoped>
.pg-toolbar { display: flex; flex-wrap: wrap; gap: 12px; align-items: center; justify-content: space-between; padding: 12px 16px; }
.pg-status { display: inline-flex; align-items: center; gap: 8px; }
.pg-ops { display: inline-flex; gap: 6px; justify-content: flex-end; }
.dim { color: var(--ink-4); }
.pg-tags { padding: 0 16px 12px; overflow-x: auto; }
.pg-foot { padding: 0 16px 12px; }
.pg-meta { margin-left: 8px; font-weight: 400; font-size: var(--fs-xs); }
.pg-link { margin-left: 8px; font-size: var(--fs-xs); color: var(--ink-3); text-decoration: none; }
.pg-link:hover { color: var(--ink-1); text-decoration: underline; }
</style>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { TxButton } from '@talex-touch/tuffex/button'
import Sheet from '../../ui/feedback/Sheet.vue'
import ProviderMark from '../../ui/data/ProviderMark.vue'
import SearchField from '../../ui/form/SearchField.vue'
import Segmented from '../../ui/form/Segmented.vue'
import Switch from '../../ui/form/Switch.vue'
import Icon from '../../ui/Icon.vue'
import Pager from '../../ui/data/Pager.vue'
import PulledModelsDialog, { type PulledModelRow } from '../models/PulledModelsDialog.vue'
import { useBreakpoint } from '../../ui/composables/useBreakpoint'
import { paginate } from '../../lib/listState'
import { fmtInt } from '../../ui/fmt'
import type { SegmentItem } from '../../ui/types'
import type { ProviderGroup, ProviderInfo } from './model'

export type ProviderModelItem = {
  id: string
  enabled: boolean
}

const props = defineProps<{
  provider: ProviderInfo | null
  group: ProviderGroup | null
  models: ProviderModelItem[]
  loading?: boolean
  /** 重读网关目录；返回拉取前已有的模型 id 和拉取后的列表，null = 失败（页面已经提示过） */
  pullModels?: () => Promise<{ before: Set<string>; after: ProviderModelItem[] } | null>
  /** 弹窗里没勾的新模型一次停用；成功返回 true */
  disableModels?: (models: string[]) => Promise<boolean>
}>()

const open = defineModel<boolean>({ default: false })
const emit = defineEmits<{
  toggle: [model: string, enabled: boolean]
}>()

const { isMobile } = useBreakpoint()
const PAGE = 50

const q = ref('')
const filter = ref<'all' | 'on' | 'off'>('all')
const page = ref(1)
const pulling = ref(false)
const pendingModels = ref(new Set<string>())

watch(open, (isOpen) => {
  if (isOpen) {
    q.value = ''
    filter.value = 'all'
    page.value = 1
  }
})

const counts = computed(() => {
  const on = props.models.filter((m) => m.enabled).length
  return {
    on,
    total: props.models.length,
    off: props.models.length - on,
  }
})

const filterItems = computed<SegmentItem[]>(() => [
  { value: 'all', label: '全部', count: counts.value.total },
  { value: 'on', label: '开着', count: counts.value.on },
  { value: 'off', label: '人工停用', count: counts.value.off },
])

const filteredModels = computed(() => {
  const term = q.value.trim().toLowerCase()
  return props.models.filter((m) => {
    if (filter.value === 'on' && !m.enabled) return false
    if (filter.value === 'off' && m.enabled) return false
    return !term || m.id.toLowerCase().includes(term)
  })
})

const paged = computed(() => paginate(filteredModels.value, page.value, PAGE))
const pageRows = computed(() => paged.value.rows)
const currentPage = computed({
  get: () => paged.value.page,
  set: (next: number) => { page.value = next },
})

/* 账号池的新模型网关一拉到就在下发，所以弹窗里新模型默认勾着（= 保持现状）；取消勾选的才写进停用 */
const pick = ref<{ rows: PulledModelRow[]; selected: Set<string> } | null>(null)
const pickOpen = ref(false)
const applying = ref(false)

async function onPull() {
  if (!props.provider || pulling.value || !props.pullModels) return
  pulling.value = true
  const provider = props.provider.id
  try {
    const pulled = await props.pullModels()
    if (!pulled || props.provider?.id !== provider || !open.value) return
    const rows = pulled.after.map((m): PulledModelRow => {
      const fresh = m.enabled && !pulled.before.has(m.id)
      return fresh
        ? { id: m.id, model: m.id, fresh }
        : { id: m.id, model: m.id, fresh, tag: m.enabled ? '已开着' : '已停用', tagTitle: m.enabled ? '拉取前就在列表里、开着' : '人工停用 · 要用就在模型列表里开回' }
    })
    pick.value = { rows, selected: new Set(rows.filter((row) => row.fresh).map((row) => row.id)) }
    pickOpen.value = true
  } finally {
    pulling.value = false
  }
}

const freshCount = computed(() => pick.value?.rows.filter((row) => row.fresh).length ?? 0)
const dropped = computed(() => (pick.value ? pick.value.rows.filter((row) => row.fresh && !pick.value!.selected.has(row.id)).map((row) => row.id) : []))
const pickSummary = computed(() => `网关目录 ${fmtInt(pick.value?.rows.length ?? 0)} 个 · 新增 ${fmtInt(freshCount.value)} 个`)
const pickHint = computed(() => {
  if (!freshCount.value) return '没有新模型 · 列表里的都已经有了'
  if (!dropped.value.length) return `${fmtInt(freshCount.value)} 个新模型网关已在下发 · 全部保留`
  return `没勾的 ${fmtInt(dropped.value.length)} 个会停用 · 之后可在模型列表开回`
})

async function onApplyPick() {
  if (applying.value) return
  if (!dropped.value.length) {
    pickOpen.value = false
    return
  }
  if (!props.disableModels) return
  applying.value = true
  try {
    if (await props.disableModels(dropped.value)) pickOpen.value = false
  } finally {
    applying.value = false
  }
}
watch(open, (isOpen) => { if (!isOpen) pickOpen.value = false })

async function onToggle(modelId: string, next: boolean) {
  if (pendingModels.value.has(modelId)) return
  pendingModels.value.add(modelId)
  try {
    emit('toggle', modelId, next)
  } finally {
    pendingModels.value.delete(modelId)
  }
}
</script>

<template>
  <Sheet v-model="open" :title="provider ? `${provider.name} 账号池配置` : '账号池配置'" size="600px" :height="isMobile ? '92vh' : 'auto'">
    <template #head-extra>
      <ProviderMark v-if="provider" :provider="provider.mark ?? provider.name" :size="20" />
    </template>

    <div v-if="provider" class="pms-sheet">
      <section class="pms-sec" aria-labelledby="pms-sec-info">
        <h3 id="pms-sec-info" class="pms-h">账号池概况</h3>
        <dl class="ui-facts">
          <dt>提供商</dt>
          <dd>{{ provider.vendor }}</dd>
          <dt>账号规模</dt>
          <dd>{{ group?.accounts.length ?? 0 }} 个账号<template v-if="group?.routable"> · {{ group.routable }} 参与路由</template></dd>
          <dt>模型规模</dt>
          <dd>{{ fmtInt(counts.on) }} / {{ fmtInt(counts.total) }} 个模型开着</dd>
        </dl>
      </section>

      <section class="pms-sec" aria-labelledby="pms-sec-models">
        <div class="pms-models-head">
          <h3 id="pms-sec-models" class="pms-h">
            模型列表
            <span class="dim num">{{ fmtInt(counts.on) }} / {{ fmtInt(counts.total) }} 开着</span>
          </h3>
          <TxButton
            variant="subtle"
            size="small"
            class="pms-pull-btn"
            :loading="pulling || props.loading"
            :disabled="!pullModels"
            title="从网关重读该账号池的最新模型目录（按凭据动态下发）· 弹窗里挑新模型"
            @click="onPull"
          >
            <Icon name="refresh" :size="14" />拉取最新模型
          </TxButton>
        </div>

        <div class="pms-tools">
          <SearchField v-model="q" placeholder="搜索模型 ID" label="搜索模型" :slash="false" class="pms-search" />
          <Segmented v-model="filter" :items="filterItems" label="按状态筛选" />
        </div>

        <ul v-if="pageRows.length" class="pms-models" aria-label="模型列表">
          <li v-for="m in pageRows" :key="m.id" class="pms-model" :class="{ 'is-off': !m.enabled }">
            <span class="pms-model__id mono ellip" :title="m.id">{{ m.id }}</span>
            <span class="pms-model__sw">
              <Switch
                :model-value="m.enabled"
                :disabled="pendingModels.has(m.id)"
                :loading="pendingModels.has(m.id)"
                :aria-label="`${m.enabled ? '停用' : '启用'}模型 ${m.id}`"
                @update:model-value="(v: boolean) => onToggle(m.id, v)"
              />
            </span>
          </li>
        </ul>
        <p v-else class="pms-empty">— {{ q.trim() ? `没有匹配「${q.trim()}」的模型` : filter === 'off' ? '没有人工停用的模型' : '当前没有可用模型' }}</p>
        <Pager v-model:page="currentPage" :total="filteredModels.length" :page-size="PAGE" />
      </section>
    </div>

    <PulledModelsDialog
      v-if="pick"
      v-model="pickOpen"
      v-model:selected="pick.selected"
      :title="`拉取模型 · ${provider?.name ?? ''}`"
      :summary="pickSummary"
      :rows="pick.rows"
      :hint="pickHint"
      :confirm-text="dropped.length ? `保留 ${fmtInt(freshCount - dropped.length)} · 停用 ${fmtInt(dropped.length)}` : '全部保留'"
      :can-apply="true"
      :busy="applying"
      @apply="onApplyPick"
    />

    <template #footer="{ close }">
      <div class="pms-foot">
        <TxButton variant="secondary" @click="close">关闭</TxButton>
      </div>
    </template>
  </Sheet>
</template>

<style scoped>
.pms-sheet { display: flex; flex-direction: column; gap: 18px; min-width: 0; }
.pms-sec { min-width: 0; }
.pms-h { display: flex; align-items: baseline; gap: 8px; margin: 0 0 6px; font-size: var(--fs-sm); font-weight: 600; color: var(--ink); }
.pms-h .dim { font-weight: 400; font-size: var(--fs-xs); }
.pms-models-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px; }
.pms-pull-btn { display: inline-flex; align-items: center; gap: 5px; }
.pms-tools { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin: 8px 0 10px; }
.pms-search { width: 220px; }
.pms-models { list-style: none; margin: 0; padding: 0; }
.pms-model { display: flex; align-items: center; gap: 8px; min-height: 40px; border-bottom: 1px solid var(--rule); min-width: 0; }
.pms-model:last-child { border-bottom: 0; }
.pms-model__id { flex: 1 1 auto; min-width: 0; font-size: var(--fs-sm); color: var(--ink); }
.pms-model.is-off .pms-model__id { color: var(--ink-2); }
.pms-model__sw { flex: none; display: inline-grid; place-items: center; min-width: 40px; min-height: 36px; }
.pms-empty { margin: 12px 0; font-size: var(--fs-sm); color: var(--ink-3); }
.pms-foot { display: flex; justify-content: flex-end; width: 100%; }
@media (max-width: 599px) {
  .pms-search { width: 100%; }
}
</style>

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
}>()

const open = defineModel<boolean>({ default: false })
const emit = defineEmits<{
  pull: [provider: string]
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

async function onPull() {
  if (!props.provider || pulling.value) return
  pulling.value = true
  try {
    emit('pull', props.provider.id)
  } finally {
    pulling.value = false
  }
}

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
            title="从网关重读该账号池的最新模型目录（按凭据动态下发）"
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

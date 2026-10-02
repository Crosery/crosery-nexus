<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { TxButton } from '@talex-touch/tuffex/button'
import { TxTag } from '@talex-touch/tuffex/tag'
import Sheet from '../../ui/feedback/Sheet.vue'
import StatusMark from '../../ui/data/StatusMark.vue'
import Pager from '../../ui/data/Pager.vue'
import Segmented from '../../ui/form/Segmented.vue'
import SearchField from '../../ui/form/SearchField.vue'
import Switch from '../../ui/form/Switch.vue'
import TickStrip from '../../ui/viz/TickStrip.vue'
import { useNow } from '../../ui/composables/useNow'
import { useBreakpoint } from '../../ui/composables/useBreakpoint'
import { paginate } from '../../lib/listState'
import { NONE, fmtAgo, fmtClock, fmtDuration, fmtInt, fmtPct } from '../../ui/fmt'
import type { ChannelItem } from '../../types'
import type { SegmentItem } from '../../ui/types'
import {
  discoveryErrorWords, errorWords, modelCounts, poolSlots, type ChannelHealthClass, type ChannelHealthItem,
} from './channelModel'

/**
 * Channel detail sheet (right 560px ≥960, bottom sheet below): health facts for the selected window, the newest
 * failure in plain words, the discovery probe, and the model mapping list with a per-model switch.
 * Models a person turns off stay off — the discovery job only ever adds models.
 * Mutations belong to the page (it owns the lists); `toggleModel` resolves true on success.
 */
const props = defineProps<{
  channel: ChannelItem | null
  health: ChannelHealthItem | null
  cls: ChannelHealthClass | null
  windowLabel: string
  healthAvailable: boolean
  pending: ReadonlySet<string>
  toggleModel: (channel: ChannelItem, modelId: string, next: boolean) => Promise<boolean>
}>()
const open = defineModel<boolean>({ default: false })
const emit = defineEmits<{ (e: 'toggle-channel', channel: ChannelItem, next: boolean): void; (e: 'delete', channel: ChannelItem): void }>()

const now = useNow()
const { isMobile } = useBreakpoint()
const PAGE = 50

/* keep the last channel while the sheet animates out (the page clears ?focus first) */
const shown = ref<ChannelItem | null>(props.channel)
watch(() => props.channel, (c) => { if (c) shown.value = c })

const q = ref('')
const filter = ref<'all' | 'on' | 'off'>('all')
const page = ref(1)
watch(() => shown.value?.name, () => {
  q.value = ''
  filter.value = 'all'
  page.value = 1
})
watch([q, filter], () => { page.value = 1 })

const counts = computed(() => (shown.value ? modelCounts(shown.value) : { on: 0, total: 0, off: 0 }))
const filterItems = computed<SegmentItem[]>(() => [
  { value: 'all', label: '全部', count: counts.value.total },
  { value: 'on', label: '开着', count: counts.value.on },
  { value: 'off', label: '人工停用', count: counts.value.off },
])
const models = computed(() => {
  const term = q.value.trim().toLowerCase()
  return (shown.value?.models ?? []).filter((m) => {
    if (filter.value === 'on' && !m.enabled) return false
    if (filter.value === 'off' && m.enabled) return false
    return !term || m.id.toLowerCase().includes(term)
  })
})
/* paginate() clamps: switching off the only row of the last page lands on the new last page, not on an empty one */
const paged = computed(() => paginate(models.value, page.value, PAGE))
const pageRows = computed(() => paged.value.rows)
const currentPage = computed({
  get: () => paged.value.page,
  set: (next: number) => { page.value = next },
})

const h = computed(() => (props.healthAvailable ? props.health : null))
const upstreamFailed = computed(() => (h.value ? Math.max(0, h.value.errors - h.value.clientCancelled) : 0))
const strip = computed(() => poolSlots(h.value?.slots ?? [], isMobile.value ? 18 : 36))
const lastError = computed(() => h.value?.lastError ?? null)
/** the job checks every 5 min which channels are due; an overdue probe waits for that tick (or a host backoff) */
const nextProbe = computed(() => {
  const d = props.health?.discovery
  if (!d) return NONE
  if (d.hostBackoffUntil && Date.parse(d.hostBackoffUntil) > now.value) return `退避至 ${fmtClock(d.hostBackoffUntil, now.value)} · 主机失败后自动顺延`
  if (!d.nextProbeAt) return NONE
  const at = Date.parse(d.nextProbeAt)
  return at <= now.value ? '已到期 · 等下一次调度（每 5m 检查）' : `${fmtClock(d.nextProbeAt, now.value)} · ${fmtAgo(d.nextProbeAt, now.value)}`
})

function pendingModel(id: string) {
  return shown.value ? props.pending.has(`${shown.value.name}\u0000${id}`) : false
}
async function onModel(id: string, next: boolean) {
  if (!shown.value) return
  await props.toggleModel(shown.value, id, next)
}
</script>

<template>
  <Sheet v-model="open" :title="shown?.name ?? '渠道'" size="600px" :height="isMobile ? '92vh' : 'auto'">
    <template #head-extra>
      <StatusMark v-if="cls" :state="cls.state" :label="cls.label" class="cx-sheet__mark" />
    </template>

    <div v-if="shown" class="cx-sheet">
      <p v-if="cls?.reason" class="cx-sheet__reason" :class="{ sig: cls.state === 'bad' }">{{ cls.reason }}</p>

      <section class="cx-sheet__sec" aria-labelledby="cx-sec-health">
        <h3 id="cx-sec-health" class="cx-sheet__h">健康 <span class="dim num">近 {{ windowLabel }}</span></h3>
        <dl class="ui-facts">
          <dt>地址</dt>
          <dd>{{ shown.baseUrl || NONE }}</dd>
          <dt>Key</dt>
          <dd>{{ fmtInt(shown.keyCount) }} 个</dd>
          <template v-if="!healthAvailable">
            <dt>健康</dt>
            <dd class="cx-sheet__sans">服务更新后可见</dd>
          </template>
          <template v-else-if="h">
            <dt>请求</dt>
            <dd>
              {{ fmtInt(h.requests) }} 次<template v-if="h.errors"> · 失败 {{ fmtInt(h.errors) }}</template><template v-if="h.clientCancelled"> · 其中客户端取消 {{ fmtInt(h.clientCancelled) }}</template>
            </dd>
            <dt>成功率</dt>
            <dd>
              <span :class="{ sig: cls?.state === 'bad' && h.requests > 0 }">{{ h.requests ? fmtPct(h.successRate, 2) : NONE }}</span>
              <template v-if="h.p95Ms !== null"> · p95 {{ fmtDuration(h.p95Ms) }}</template>
            </dd>
            <dt>分布</dt>
            <dd class="cx-sheet__strip">
              <TickStrip :ticks="strip.ticks" :bad="strip.bad" :h="12" :label="`近 ${windowLabel} 分布 · 上游失败 ${fmtInt(upstreamFailed)}`" />
            </dd>
            <dt>近 1h</dt>
            <dd>{{ fmtInt(h.recent.requests) }} 次<template v-if="h.recent.errors"> · 失败 {{ fmtInt(h.recent.errors) }}</template></dd>
            <dt>最近调用</dt>
            <dd>{{ h.lastRequestAt ? `${fmtClock(h.lastRequestAt, now)} · ${fmtAgo(h.lastRequestAt, now)}` : '从未调用' }}</dd>
          </template>
          <template v-else>
            <dt>健康</dt>
            <dd>{{ NONE }}</dd>
          </template>
        </dl>
        <div v-if="lastError" class="cx-sheet__err">
          <p class="cx-sheet__err-h num">
            <span :class="{ sig: lastError.category !== 'client_cancelled' }">◆</span>
            最近错误 {{ fmtClock(lastError.at, now) }}{{ lastError.status ? ` · ${lastError.status}` : '' }}<span class="cx-sheet__err-w"> · {{ errorWords(lastError.category, lastError.status) }}</span>
          </p>
          <pre v-if="lastError.detail" class="cx-sheet__detail">{{ lastError.detail }}</pre>
        </div>
      </section>

      <section class="cx-sheet__sec" aria-labelledby="cx-sec-disc">
        <h3 id="cx-sec-disc" class="cx-sheet__h">模型发现</h3>
        <dl class="ui-facts">
          <template v-if="!shown.enabled">
            <dt>状态</dt>
            <dd class="cx-sheet__sans">停用渠道不探测 · 启用后下一轮会探</dd>
          </template>
          <template v-else-if="health?.discovery">
            <dt>上次</dt>
            <dd>
              {{ health.discovery.lastProbeAt ? fmtClock(health.discovery.lastProbeAt, now) : '未探测' }}
              <template v-if="health.discovery.lastStatus"> · HTTP {{ health.discovery.lastStatus }}</template>
              <template v-if="health.discovery.discovered !== null && !health.discovery.lastError"> · 上游返回 {{ fmtInt(health.discovery.discovered) }} 个</template>
            </dd>
            <template v-if="health.discovery.lastError">
              <dt>结果</dt>
              <dd class="sig">{{ discoveryErrorWords(health.discovery.lastError) }}</dd>
            </template>
            <dt>下次</dt>
            <dd>{{ nextProbe }}</dd>
          </template>
          <template v-else>
            <dt>状态</dt>
            <dd class="cx-sheet__sans">{{ healthAvailable ? '等待首次探测' : '服务更新后可见' }}</dd>
          </template>
        </dl>
        <p class="cx-sheet__note">发现只加新模型 · 人工停用的模型不会被恢复</p>
      </section>

      <section class="cx-sheet__sec" aria-labelledby="cx-sec-models">
        <h3 id="cx-sec-models" class="cx-sheet__h">模型 <span class="dim num">{{ fmtInt(counts.on) }} / {{ fmtInt(counts.total) }} 开着</span></h3>
        <p v-if="!shown.enabled" class="cx-sheet__note">渠道停用中 · 启用后才能单独开关模型</p>
        <div class="cx-sheet__tools">
          <SearchField v-model="q" placeholder="模型 id" label="搜索模型" :slash="false" class="cx-sheet__search" />
          <Segmented v-model="filter" :items="filterItems" label="按开关筛选" />
        </div>
        <ul v-if="pageRows.length" class="cx-models" aria-label="模型列表">
          <li v-for="m in pageRows" :key="m.id" class="cx-model" :class="{ 'is-off': !m.enabled }">
            <span class="cx-model__id mono ellip" :title="m.id">{{ m.id }}</span>
            <TxTag v-if="m.upstreams > 1" size="sm" variant="outline" :label="`×${m.upstreams}`" :title="`${m.upstreams} 条上游轮询`" />
            <span class="cx-model__sw">
              <Switch
                :model-value="m.enabled"
                :aria-label="`${m.enabled ? '停用' : '开启'}模型 ${m.id}`"
                :disabled="!shown.enabled"
                :loading="pendingModel(m.id)"
                @update:model-value="(v: boolean) => onModel(m.id, v)"
              />
            </span>
          </li>
        </ul>
        <p v-else class="cx-sheet__empty">— {{ q.trim() ? `没有匹配「${q.trim()}」的模型` : filter === 'off' ? '没有人工停用的模型' : '这个渠道没有模型' }}</p>
        <Pager v-model:page="currentPage" :total="models.length" :page-size="PAGE" />
      </section>
    </div>

    <template #footer="{ close }">
      <div v-if="shown" class="cx-sheet__foot">
        <!-- the destructive confirm (signal) lives in the confirm sheet; this only opens it -->
        <TxButton variant="ghost" class="cx-sheet__del" :disabled="pending.has(shown.name)" @click="emit('delete', shown)">删除渠道</TxButton>
        <span class="cx-sheet__foot-r">
          <TxButton variant="secondary" @click="close">关闭</TxButton>
          <TxButton
            variant="secondary"
            :disabled="pending.has(shown.name) || shown.stale"
            @click="emit('toggle-channel', shown, !shown.enabled)"
          >{{ shown.enabled ? '停用渠道' : '启用渠道' }}</TxButton>
        </span>
      </div>
    </template>
  </Sheet>
</template>

<style>
.cx-sheet { display: flex; flex-direction: column; gap: 18px; min-width: 0; }
.cx-sheet__mark { margin-left: 4px; }
.cx-sheet__reason { margin: 0; font-size: var(--fs-sm); color: var(--ink-2); }
.cx-sheet__sec { min-width: 0; }
.cx-sheet__h {
  display: flex; align-items: baseline; gap: 8px; margin: 0 0 6px;
  font-size: var(--fs-sm); font-weight: 600; color: var(--ink);
}
/* facts read as aligned pairs: spacing separates them, no hairline under every row */
.cx-sheet .ui-facts > dt, .cx-sheet .ui-facts > dd { padding: 4px 0; border-bottom: 0; }
.cx-sheet__h .dim { font-weight: 400; font-size: var(--fs-xs); }
.cx-sheet .ui-facts > dd.cx-sheet__sans { font-family: var(--font-sans); color: var(--ink-2); }
.cx-sheet__strip { display: flex; align-items: center; }
.cx-sheet__err { margin-top: 10px; }
.cx-sheet__err-h { margin: 0 0 4px; font-size: var(--fs-xs); color: var(--ink-2); font-family: var(--font-mono); }
.cx-sheet__err-w { font-family: var(--font-sans); }
.cx-sheet__detail {
  margin: 0; padding: 8px 10px; background: var(--paper-2); color: var(--ink-2);
  font-family: var(--font-mono); font-size: var(--fs-xs); line-height: 1.5; white-space: pre-wrap; overflow-wrap: anywhere; max-height: 120px; overflow: auto;
}
.cx-sheet__note { margin: 6px 0 0; font-size: var(--fs-xs); color: var(--ink-3); }
.cx-sheet__tools { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin: 8px 0 4px; }
.cx-sheet__search { width: 200px; }
.cx-models { list-style: none; margin: 0; padding: 0; }
.cx-model { display: flex; align-items: center; gap: 8px; min-height: 40px; border-bottom: 1px solid var(--rule); min-width: 0; }
.cx-model:last-child { border-bottom: 0; }
.cx-model__id { flex: 1 1 auto; min-width: 0; font-size: var(--fs-sm); color: var(--ink); }
.cx-model.is-off .cx-model__id { color: var(--ink-2); }
.cx-model__sw { flex: none; display: inline-grid; place-items: center; min-width: 40px; min-height: 36px; }
.cx-sheet__empty { margin: 10px 0; font-size: var(--fs-sm); color: var(--ink-3); }
.cx-sheet__foot { display: flex; align-items: center; justify-content: space-between; gap: 8px; width: 100%; }
.cx-sheet__foot-r { display: inline-flex; gap: 8px; }
html:root .cx-sheet__foot .tx-button.cx-sheet__del { padding: 0 4px; color: var(--ink-2); }
html:root .cx-sheet__foot .tx-button.cx-sheet__del:hover:not(.disabled) { color: var(--signal-ink); background: transparent; }
.cx-sheet .sig, .cx-sheet__reason.sig { color: var(--signal-ink); }
@media (max-width: 599px) {
  .cx-sheet__search { width: 100%; }
}
</style>

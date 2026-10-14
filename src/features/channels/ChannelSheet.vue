<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { TxButton, TxIconButton } from '@talex-touch/tuffex/button'
import { TxTag } from '@talex-touch/tuffex/tag'
import Sheet from '../../ui/feedback/Sheet.vue'
import StatusMark from '../../ui/data/StatusMark.vue'
import Pager from '../../ui/data/Pager.vue'
import Segmented from '../../ui/form/Segmented.vue'
import SearchField from '../../ui/form/SearchField.vue'
import Switch from '../../ui/form/Switch.vue'
import SecretField from '../../ui/form/SecretField.vue'
import TickStrip from '../../ui/viz/TickStrip.vue'
import Icon from '../../ui/Icon.vue'
import PulledModelsDialog, { type PulledModelRow } from '../models/PulledModelsDialog.vue'
import { useNow } from '../../ui/composables/useNow'
import { useBreakpoint } from '../../ui/composables/useBreakpoint'
import { paginate } from '../../lib/listState'
import { NONE, fmtAgo, fmtClock, fmtDuration, fmtInt, fmtPct } from '../../ui/fmt'
import { copyText, notify } from '../../ui/feedback/toast'
import { errorReason } from '../../lib/errors'
import { api } from '../../api'
import type { SegmentItem } from '../../ui/types'
import type { ChannelItem, ChannelModelChanges, ChannelModelPreview, ChannelModelPreviewRow } from '../../types'
import {
  discoveryErrorWords, errorWords, modelCounts, poolSlots, type ChannelHealthClass, type ChannelHealthItem,
} from './channelModel'

/**
 * Channel detail sheet (right 560px ≥960, bottom sheet below): health facts for the selected window, the newest
 * failure in plain words, the discovery probe, and the model mapping list with a per-model switch.
 * Models a person turns off stay off. 拉取模型 = probe (no write) → tick new models in a dialog → one apply.
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
  /** 拉取模型 step 1: probe the upstream without writing; null = failed (the page already said why) */
  previewModels?: (channel: ChannelItem) => Promise<ChannelModelPreview | null>
  /** step 2: write the picked result in one go; resolves true on success */
  applyModels?: (channel: ChannelItem, changes: ChannelModelChanges) => Promise<boolean>
  setAutoSync?: (channel: ChannelItem, next: boolean) => Promise<boolean>
  addKey: (channel: ChannelItem, apiKey: string) => Promise<boolean>
  removeKey: (channel: ChannelItem, ref: string) => Promise<boolean>
}>()
const open = defineModel<boolean>({ default: false })
const emit = defineEmits<{ (e: 'toggle-channel', channel: ChannelItem, next: boolean): void; (e: 'delete', channel: ChannelItem): void }>()

const now = useNow()
const { isMobile } = useBreakpoint()
const PAGE = 50
const pulling = ref(false)
/** the pull result being picked in the dialog; only new models can be ticked, nothing is ticked up front */
const picker = ref<{ channel: string; preview: ChannelModelPreview; selected: Set<string> } | null>(null)
const pickOpen = ref(false)
const applying = ref(false)

async function onPull() {
  if (!shown.value || pulling.value || !props.previewModels) return
  pulling.value = true
  const channel = shown.value
  try {
    const preview = await props.previewModels(channel)
    if (preview && shown.value?.name === channel.name) {
      picker.value = { channel: channel.name, preview, selected: new Set() }
      pickOpen.value = true
    }
  } finally {
    pulling.value = false
  }
}

const HAVE_TAG: Record<Exclude<ChannelModelPreviewRow['state'], 'new'>, { tag: string; title: string }> = {
  on: { tag: '已接入', title: '渠道里已经有、开着' },
  off: { tag: '已停用', title: '之前人工停用 · 要用就在模型列表里开回' },
  gone: { tag: '上游没列', title: '渠道里有、这次上游列表里没有 · 可能已下架，也可能是上游不列的隐藏模型' },
}
const pickRows = computed<PulledModelRow[]>(() => (picker.value?.preview.rows ?? []).map((row) => ({
  id: row.id,
  model: row.model,
  sub: row.id !== row.model ? `上游 ${row.id}` : undefined,
  fresh: row.state === 'new',
  ...(row.state === 'new' ? {} : HAVE_TAG[row.state]),
})))
/* unticked new models only need a tombstone when auto-sync would otherwise add them back next round */
const changes = computed<ChannelModelChanges | null>(() => {
  const p = picker.value
  if (!p) return null
  const out: ChannelModelChanges = { add: [], enable: [], disable: [], remove: [] }
  for (const row of p.preview.rows) {
    if (row.state !== 'new') continue
    const on = p.selected.has(row.id)
    if (on || shown.value?.autoSync) out.add.push({ id: row.id, alias: row.model, enabled: on })
  }
  return out
})
const taken = computed(() => changes.value?.add.filter((item) => item.enabled).length ?? 0)
const declined = computed(() => (changes.value?.add.length ?? 0) - taken.value)
const pickSummary = computed(() => {
  const p = picker.value
  if (!p) return ''
  const listed = p.preview.rows.filter((row) => row.state !== 'gone').length
  const fresh = p.preview.rows.filter((row) => row.state === 'new').length
  return `上游返回 ${fmtInt(listed)} 个 · 新增 ${fmtInt(fresh)} 个 · ${fmtClock(p.preview.probedAt, now.value)} 探测`
})
const pickHint = computed(() => {
  const fresh = picker.value?.preview.rows.filter((row) => row.state === 'new').length ?? 0
  if (!fresh) return '渠道已经有上游列出的全部模型'
  const rest = fresh - taken.value
  if (!rest) return `${fmtInt(taken.value)} 个新模型全部接入`
  if (!taken.value && !shown.value?.autoSync) return '勾上要接入的新模型'
  return shown.value?.autoSync
    ? `没勾的 ${fmtInt(rest)} 个记为停用 · 自动同步不会再加回`
    : `没勾的 ${fmtInt(rest)} 个不接入 · 下次拉取还会列出`
})

async function onApply() {
  if (!shown.value || !changes.value?.add.length || applying.value || !props.applyModels) return
  applying.value = true
  try {
    if (await props.applyModels(shown.value, changes.value)) {
      pickOpen.value = false
      picker.value = null
    }
  } finally {
    applying.value = false
  }
}

const autoSyncBusy = ref(false)
async function onAutoSync(next: boolean) {
  if (!shown.value || autoSyncBusy.value || !props.setAutoSync) return
  autoSyncBusy.value = true
  try {
    await props.setAutoSync(shown.value, next)
  } finally {
    autoSyncBusy.value = false
  }
}

/* keep the last channel while the sheet animates out (the page clears the focus first);
   a same-named update replaces it, so writes (模型开关 / 拉取模型) read back what the server now holds */
const shown = ref<ChannelItem | null>(props.channel)
watch(() => props.channel, (c) => { if (c) shown.value = c })

const channelKeys = computed(() => shown.value?.keys ?? [])
const newKey = ref('')
const keySecret = ref<InstanceType<typeof SecretField> | null>(null)
const keyBusy = ref(false)
const addingKey = ref(false)
const deletingRef = ref<string | null>(null)

watch(open, (isOpen) => {
  if (!isOpen) {
    newKey.value = ''
    keySecret.value?.mask()
    pickOpen.value = false
    picker.value = null
  }
})

const q = ref('')
const filter = ref<'all' | 'on' | 'off'>('all')
const page = ref(1)
watch(() => shown.value?.name, () => {
  q.value = ''
  filter.value = 'all'
  page.value = 1
  newKey.value = ''
  keySecret.value?.mask()
  pickOpen.value = false
  picker.value = null
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
  if (shown.value?.autoSync === false) return '不参与定时同步 · 只在手动拉取时探测'
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

function pendingKey(ref: string) {
  if (!shown.value) return false
  return deletingRef.value === ref || props.pending.has(`${shown.value.name}\u0000${ref}`) || props.pending.has(`${shown.value.name}\u0000key:${ref}`)
}

async function copyKey(masked: string) {
  await copyText(masked, 'Key')
}

async function copyRef(ref: string) {
  await copyText(ref, 'Key ref')
}

async function onAddKey() {
  const raw = newKey.value.trim()
  if (!raw || !shown.value || keyBusy.value) return
  keyBusy.value = true
  addingKey.value = true
  newKey.value = ''
  keySecret.value?.mask()
  try {
    await props.addKey(shown.value, raw)
  } finally {
    keyBusy.value = false
    addingKey.value = false
  }
}

async function onRemoveKey(ref: string) {
  if (!shown.value || keyBusy.value) return
  keyBusy.value = true
  deletingRef.value = ref
  try {
    await props.removeKey(shown.value, ref)
  } finally {
    keyBusy.value = false
    deletingRef.value = null
  }
}

const proxyBusy = ref(false)
async function onToggleProxy() {
  if (!shown.value || proxyBusy.value) return
  const current = shown.value.proxyUrl
  const next = current === 'direct' ? '' : 'direct'
  proxyBusy.value = true
  try {
    await api.setChannelProxy(shown.value.name, next)
    notify(`✓ 已将 ${shown.value.name} 出口代理设为 ${next === 'direct' ? '直连 (direct)' : '继承全局'}`)
    shown.value.proxyUrl = next || undefined
  } catch (error) {
    notify(`◆ 设置代理失败 · ${errorReason(error)}`, { tone: 'bad' })
  } finally {
    proxyBusy.value = false
  }
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
          <dt>出口代理</dt>
          <dd>
            <span class="cx-sheet__proxy-box">
              <span class="mono">{{ shown.proxyUrl === 'direct' ? '直连 (direct)' : (shown.proxyUrl || '继承全局') }}</span>
              <button
                type="button"
                class="ui-link cx-sheet__proxy-btn"
                :disabled="proxyBusy"
                @click="onToggleProxy"
              >
                {{ shown.proxyUrl === 'direct' ? '设为继承全局' : '设为强制直连' }}
              </button>
            </span>
          </dd>
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

      <section class="cx-sheet__sec" aria-labelledby="cx-sec-keys">
        <h3 id="cx-sec-keys" class="cx-sheet__h">
          上游 Key <span class="dim num">{{ fmtInt(channelKeys.length) }} 把</span>
        </h3>
        <ul v-if="channelKeys.length" class="cx-keys" aria-label="上游 Key 列表">
          <li v-for="k in channelKeys" :key="k.ref" class="cx-key">
            <span class="cx-key__info ellip">
              <span class="cx-key__masked mono ellip" :title="k.masked">{{ k.masked }}</span>
              <button
                type="button"
                class="ui-link cx-key__ref mono dim"
                :title="`复制 ref ${k.ref}`"
                @click="copyRef(k.ref)"
              >#{{ k.ref }}</button>
            </span>
            <span class="cx-key__actions">
              <TxIconButton
                :label="`复制 Key ${k.ref}`"
                title="复制打码 Key"
                size="sm"
                @click="copyKey(k.masked)"
              >
                <Icon name="copy" />
              </TxIconButton>
              <TxButton
                variant="ghost"
                size="sm"
                class="cx-key__del"
                :loading="pendingKey(k.ref)"
                :disabled="keyBusy"
                @click="onRemoveKey(k.ref)"
              >
                删除
              </TxButton>
            </span>
          </li>
        </ul>
        <p v-else class="cx-sheet__empty">— 没有上游 Key · 渠道无法转发请求</p>
        <form class="cx-keys__add" @submit.prevent="onAddKey">
          <SecretField
            ref="keySecret"
            v-model="newKey"
            name="channel-api-key"
            autocomplete="off"
            noun="Key"
            placeholder="添加上游 Key (sk-…)"
            mono
            :disabled="keyBusy"
            class="cx-keys__input"
          />
          <TxButton
            type="submit"
            variant="secondary"
            size="sm"
            :loading="addingKey"
            :disabled="!newKey.trim() || keyBusy"
          >
            添加 Key
          </TxButton>
        </form>
      </section>

      <section class="cx-sheet__sec" aria-labelledby="cx-sec-disc">
        <h3 id="cx-sec-disc" class="cx-sheet__h">模型发现</h3>
        <div v-if="shown.autoSync !== undefined && setAutoSync" class="cx-sheet__auto">
          <span class="cx-sheet__auto-l">
            <span class="cx-sheet__auto-t">自动同步</span>
            <span class="cx-sheet__auto-d">{{ shown.autoSync ? '每 30m 对一次上游列表 · 新增的自动接入，上次列过、这次没列的自动摘掉' : '关闭 · 只在点「拉取模型」时变化' }}</span>
          </span>
          <Switch
            :model-value="shown.autoSync"
            :aria-label="`${shown.autoSync ? '关闭' : '开启'} ${shown.name} 的自动同步`"
            :disabled="!shown.enabled || shown.stale"
            :loading="autoSyncBusy"
            @update:model-value="onAutoSync"
          />
        </div>
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
        <p class="cx-sheet__note">人工停用的模型不会被自动同步恢复 · 聚合渠道（上游列表里大多是付费模型）别开自动同步，用「拉取模型」挑</p>
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

    <PulledModelsDialog
      v-if="picker"
      v-model="pickOpen"
      v-model:selected="picker.selected"
      :title="`拉取模型 · ${picker.channel}`"
      :summary="pickSummary"
      :rows="pickRows"
      :hint="pickHint"
      :confirm-text="taken ? `接入 ${fmtInt(taken)} 个` : declined ? '都不接入' : '接入'"
      :can-apply="Boolean(changes?.add.length)"
      :busy="applying"
      @apply="onApply"
    />

    <template #footer="{ close }">
      <div v-if="shown" class="cx-sheet__foot">
        <!-- the destructive confirm (signal) lives in the confirm sheet; this only opens it -->
        <TxButton variant="ghost" class="cx-sheet__del" :disabled="pending.has(shown.name)" @click="emit('delete', shown)">删除渠道</TxButton>
        <span class="cx-sheet__foot-r">
          <TxButton
            variant="ghost"
            class="cx-sheet__pull"
            :loading="pulling"
            :disabled="!shown.enabled || shown.stale || !previewModels"
            :title="shown.enabled ? '向这个渠道的上游发一次 /models 探测 · 弹窗里勾选新模型，确定后才写入' : '停用渠道不探测上游'"
            @click="onPull"
          ><Icon name="refresh" :size="14" />拉取模型</TxButton>
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
.cx-keys { list-style: none; margin: 0; padding: 0; }
.cx-key {
  display: flex; align-items: center; justify-content: space-between; gap: 8px;
  min-height: 38px; border-bottom: 1px solid var(--rule); min-width: 0;
}
.cx-key:last-child { border-bottom: 0; }
.cx-key__info { display: flex; align-items: baseline; gap: 8px; min-width: 0; flex: 1 1 auto; }
.cx-key__masked { font-size: var(--fs-xs); color: var(--ink); user-select: text; }
.cx-key__ref { font-size: var(--fs-xs); color: var(--ink-3); user-select: text; }
.cx-key__actions { display: inline-flex; align-items: center; gap: 4px; flex: none; }
html:root .cx-key .tx-button.cx-key__del { padding: 0 6px; font-size: var(--fs-xs); color: var(--ink-2); }
html:root .cx-key .tx-button.cx-key__del:hover:not(.disabled) { color: var(--signal-ink); background: transparent; }
.cx-keys__add { display: flex; align-items: center; gap: 8px; margin-top: 8px; min-width: 0; }
.cx-keys__add .ui-secret { flex: 1 1 auto; min-width: 0; }
.cx-sheet__foot { display: flex; align-items: center; justify-content: space-between; gap: 8px; width: 100%; }
.cx-sheet__foot-r { display: inline-flex; gap: 8px; flex: none; }
.cx-sheet__auto { display: flex; align-items: center; justify-content: space-between; gap: 12px; min-height: 44px; margin-bottom: 4px; }
.cx-sheet__auto-l { display: grid; gap: 2px; min-width: 0; }
.cx-sheet__auto-t { font-size: var(--fs-sm); color: var(--ink); }
.cx-sheet__auto-d { font-size: var(--fs-xs); color: var(--ink-3); }
html:root .cx-sheet__foot .tx-button.cx-sheet__del { padding: 0 4px; color: var(--ink-2); }
html:root .cx-sheet__foot .tx-button.cx-sheet__del:hover:not(.disabled) { color: var(--signal-ink); background: transparent; }
html:root .cx-sheet__foot .tx-button.cx-sheet__pull { padding: 0 8px; color: var(--ink-2); }
html:root .cx-sheet__foot .tx-button.cx-sheet__pull .tx-button__inner { gap: 5px; }
.cx-sheet .sig, .cx-sheet__reason.sig { color: var(--signal-ink); }
@media (max-width: 599px) {
  .cx-sheet__search { width: 100%; }
}
.cx-sheet__proxy-box { display: inline-flex; align-items: center; gap: 8px; }
.cx-sheet__proxy-btn { font-size: var(--fs-xs); color: var(--accent-ink, #2563eb); }
</style>

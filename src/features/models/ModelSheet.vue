<script setup lang="ts">
/**
 * One model, in a sheet (right ≥960, bottom below): identity and aliases, dual-source price, spec, every channel
 * mapping with its own switch, and the 7-day evidence. Disabling a mapping asks first (it breaks calls routed
 * that way); enabling does not. Writes go through the existing PATCH; the switch stays locked until the page has re-read.
 */
import { computed, ref } from 'vue'
import { RouterLink } from 'vue-router'
import Sheet from '../../ui/feedback/Sheet.vue'
import StatusMark from '../../ui/data/StatusMark.vue'
import ProviderMark from '../../ui/data/ProviderMark.vue'
import Switch from '../../ui/form/Switch.vue'
import WeightField from '../../ui/form/WeightField.vue'
import Icon from '../../ui/Icon.vue'
import { TxIconButton } from '@talex-touch/tuffex/button'
import { TxTag } from '@talex-touch/tuffex/tag'
import { confirmSheet } from '../../ui/feedback/confirmSheet'
import { copyText, notify } from '../../ui/feedback/toast'
import { fmtCompact, fmtInt, fmtPct, fmtTime, fmtUsd } from '../../ui/fmt'
import { errorReason } from '../../lib/errors'
import { api } from '../../api'
import ModelPricingSources from './ModelPricingSources.vue'
import ModelUpstreamModels from './ModelUpstreamModels.vue'
import { errorWord, fmtWindow, hourLabel, type InsightProbe, type ModelMapping, type ModelRow } from './modelRows'
import type { ModelIndexData } from '../../types'

const props = defineProps<{
  row: ModelRow | null
  probes: Map<string, InsightProbe>
  sourceStatus?: ModelIndexData['sourceStatus']
  /** false while /api/models/insights is not served (spec / success read 暂不可用) */
  insightsReady: boolean
  /** true when the 7-day usage overview could not be read */
  usageMissing: boolean
  /** re-reads the list after a write; the switch stays locked until it resolves (else `changed` is emitted) */
  reload?: () => Promise<void>
}>()
const open = defineModel<boolean>({ default: false })
const emit = defineEmits<{ changed: [] }>()

const KIND: Record<ModelMapping['kind'], string> = { compat: '兼容', oauth: '账号池' }
const SPEC_SOURCE: Record<string, string> = { gateway: '网关目录', catalog: '共享目录', openrouter: 'OpenRouter', 'models.dev': 'models.dev' }

const busy = ref('')
const mappingKey = (m: ModelMapping) => `${m.model}@${m.channel}:${m.kind}`

const channelUse = computed(() => new Map((props.row?.evidence?.channels ?? []).map((c) => [c.channel, c])))

function probeText(channel: string): { text: string; bad: boolean } | null {
  const probe = props.probes.get(channel)
  if (!probe?.lastProbeAt) return null
  if (probe.backoffUntil && Date.parse(probe.backoffUntil) > Date.now()) return { text: `探测退避 → ${fmtTime(probe.backoffUntil)}`, bad: true }
  const failing = Boolean(probe.error) || (probe.status !== null && probe.status >= 400)
  return { text: `探测 ${fmtTime(probe.lastProbeAt)} ${failing ? `◆ ${probe.status ?? ''}`.trim() : '✓'}`, bad: failing }
}

function useText(channel: string): string {
  const use = channelUse.value.get(channel)
  if (!use) return props.insightsReady ? '7 天 0 次' : ''
  return `7 天 ${fmtInt(use.requests)} 次${use.errors ? ` · 失败 ${fmtInt(use.errors)}` : ''}`
}

const enabledCount = computed(() => props.row?.mappings.filter((m) => m.enabled).length ?? 0)

async function toggle(mapping: ModelMapping, next: boolean) {
  const row = props.row
  if (!row || busy.value) return
  if (!next) {
    const last = enabledCount.value <= 1
    const use = channelUse.value.get(mapping.channel)
    const ok = await confirmSheet({
      title: '停用这条映射？',
      facts: [
        { k: '模型', v: mapping.model },
        { k: '渠道', v: `${mapping.channel} · ${KIND[mapping.kind]}` },
        { k: '近 7 天', v: use ? `${fmtInt(use.requests)} 次调用` : '无调用记录' },
      ],
      consequence: last ? '这是最后一条启用的映射 · 停用后该模型无法调用' : '经此渠道调用该模型会失败 · 其他渠道照常',
      confirmText: '停用',
      danger: true,
    })
    if (!ok) return
  }
  busy.value = mappingKey(mapping)
  try {
    await api.setModelSourceEnabled(mapping.model, mapping.channel, mapping.kind, next)
    notify(`✓ ${next ? '已启用' : '已停用'} ${mapping.channel}`, { tone: 'ok', description: mapping.model })
    // until the list shows the acknowledged state, a second click would repeat the same write
    if (props.reload) await props.reload().catch(() => undefined)
    else emit('changed')
  } catch (error) {
    notify(`◆ ${mapping.channel} 切换失败`, { tone: 'bad', description: `${errorReason(error)} · ${mapping.model}` })
  } finally {
    busy.value = ''
  }
}

/* 模型级路由：这个模型自己的来源顺序（越靠前越优先）。权重小的先用；同权重按列表先后，开了「同档轮询」才轮流。
   顺序、权重都存在控制台，中转层按它把请求定向到来源，网关只转发。别名 id（另一个模型名）的映射不参与排序。 */
const sortable = computed(() => props.row?.mappings.filter((m) => m.model === props.row?.id) ?? [])
/** 另一个模型名（别名 id）上的映射不属于这个模型的排序；只有启用着的才有必要列出来，停用的不显示 */
const fixed = computed(() => props.row?.mappings.filter((m) => m.model !== props.row?.id && m.enabled) ?? [])
const canOrder = computed(() => sortable.value.length > 1)
const dragFrom = ref(-1)
const dragOver = ref(-1)

async function saveRoute(list: ModelMapping[], weights: number[], roundRobin?: boolean) {
  const row = props.row
  if (!row || busy.value) return
  busy.value = 'route'
  try {
    await api.setModelRoute(row.id, list.map((m, i) => ({ channel: m.channel, kind: m.kind, weight: weights[i] })), roundRobin)
    notify('✓ 已保存调度顺序', { tone: 'ok', description: row.id })
    if (props.reload) await props.reload().catch(() => undefined)
    else emit('changed')
  } catch (error) {
    notify('◆ 调度顺序保存失败', { tone: 'bad', description: `${errorReason(error)} · ${row.id}` })
  } finally {
    busy.value = ''
  }
}

/** 拖动或点箭头：新顺序里权重按位置重排（0,1,2…），同档需要的话再手动把权重改成一样 */
function move(from: number, to: number) {
  const list = [...sortable.value]
  if (from === to || from < 0 || to < 0 || from >= list.length || to >= list.length) return
  const [item] = list.splice(from, 1)
  list.splice(to, 0, item)
  void saveRoute(list, list.map((_, i) => i))
}
function onDrop(to: number) {
  const from = dragFrom.value
  dragFrom.value = -1
  dragOver.value = -1
  if (from >= 0) move(from, to)
}
function setWeight(index: number, weight: number) {
  const list = [...sortable.value]
  const weights = list.map((m) => m.weight ?? 0)
  weights[index] = weight
  // 列表按权重（再按原先后）重新排好，页面和中转层看到的是同一个顺序
  const order = list.map((m, i) => ({ m, w: weights[i], i })).sort((a, b) => a.w - b.w || a.i - b.i)
  void saveRoute(order.map((x) => x.m), order.map((x) => x.w))
}
function setRoundRobin(next: boolean) {
  const list = [...sortable.value]
  void saveRoute(list, list.map((m) => m.weight ?? 0), next)
}

const spec = computed(() => props.row?.spec ?? null)
/** the catalog's display name only when it says something the id does not */
const displayName = computed(() => {
  const vendor = props.row?.vendorLabel ?? ''
  const raw = spec.value?.name?.trim()
  // OpenRouter names read `Google: Gemma 4 …` — the vendor is already on this line
  const name = raw && vendor && raw.toLowerCase().startsWith(`${vendor.toLowerCase()}:`) ? raw.slice(vendor.length + 1).trim() : raw
  if (!name || !props.row) return null
  const flat = (text: string) => text.toLowerCase().replace(/[^a-z0-9]/g, '')
  return flat(name) === flat(props.row.id.split('/').pop() ?? '') ? null : name
})
const specFacts = computed(() => {
  const s = spec.value
  const na = '暂不可用'
  const reasoning = props.insightsReady ? reasoningText.value : na
  return [
    { k: '上下文', v: props.insightsReady ? fmtWindow(s?.contextWindow) : na },
    { k: '输出上限', v: props.insightsReady ? fmtWindow(s?.maxOutput) : na },
    { k: '思考', v: reasoning },
    { k: '来源', v: s?.specSource ? SPEC_SOURCE[s.specSource] : '—' },
  ]
})
const reasoningText = computed(() => {
  const s = spec.value
  if (!s || s.reasoning === null) return '未知'
  if (!s.reasoning) return '不支持'
  return s.efforts.length ? `支持 · ${s.efforts.join(' / ')}` : '支持'
})

const usageFacts = computed(() => {
  const row = props.row
  if (!row) return []
  const ev = row.evidence
  const facts: Array<{ k: string; v: string; hot?: boolean }> = []
  facts.push({ k: '调用', v: row.requests === null ? '—' : `${fmtInt(row.requests)} 次` })
  facts.push({ k: 'Token', v: row.tokens === null ? '—' : fmtCompact(row.tokens) })
  if (props.insightsReady) {
    facts.push({ k: '成功率', v: row.successRate === null ? '—' : fmtPct(row.successRate, 1), hot: row.bad })
    facts.push({ k: '最近成功', v: ev?.lastOkHour ? hourLabel(ev.lastOkHour) : '—' })
    if (ev?.topError) facts.push({ k: '主要错误', v: `${errorWord(ev.topError)} × ${fmtInt(ev.topError.requests)}`, hot: row.bad })
  }
  if (row.requests) {
    facts.push({ k: '花费', v: row.cost !== null ? fmtUsd(row.cost) : row.unbilled ? '未定价 · 不计' : '部分未计价' })
  }
  return facts
})
</script>

<template>
  <Sheet v-model="open" :title="row?.id ?? '模型'">
    <template v-if="row" #head-extra>
      <TxIconButton label="复制模型 id" title="复制模型 id" size="sm" @click="copyText(row.id, '模型 id')"><Icon name="copy" /></TxIconButton>
    </template>
    <div v-if="row" class="msh">
      <div class="msh__top">
        <p class="msh__id">
          <ProviderMark :provider="row.vendor === 'other' ? row.key : row.vendor" :size="20" />
          <span class="msh__vendor">{{ row.vendorLabel }}<template v-if="displayName"> · {{ displayName }}</template></span>
          <StatusMark :state="row.status" :label="row.statusLabel" />
        </p>
        <p v-if="row.bad && row.note" class="msh__note">{{ row.note }}</p>
        <p v-if="row.aliases.length" class="msh__alias"><span class="msh__k">别名</span><span class="num">{{ row.aliases.join(' · ') }}</span></p>
      </div>

      <section class="msh__sec">
        <h3 class="msh__h">价格</h3>
        <ModelPricingSources :row="row" :source-status="sourceStatus" />
      </section>

      <section class="msh__sec">
        <h3 class="msh__h">规格</h3>
        <dl class="msh__kv">
          <div v-for="f in specFacts" :key="f.k" :class="{ 'is-wide': f.v.length > 12 }"><dt>{{ f.k }}</dt><dd>{{ f.v }}</dd></div>
        </dl>
      </section>

      <section class="msh__sec">
        <h3 class="msh__h">渠道映射 <span class="num msh__h-n">{{ row.enabledChannels }}/{{ row.channels }}</span>
          <label v-if="canOrder" class="msh__rr" title="权重相同的来源轮流用；关闭时同权重按列表先后">
            <span>同档轮询</span>
            <Switch :model-value="row.roundRobin" :disabled="busy !== ''" aria-label="同档轮询" @update:model-value="setRoundRobin" />
          </label>
        </h3>
        <p v-if="canOrder && row.routed" class="msh__hint">拖动调整先后，越靠前越优先；权重小的先用，权重相同按列表先后。</p>
        <p v-else-if="canOrder" class="msh__hint">还没设置顺序 · 现在由网关自己在这几个来源之间轮流；拖动或改权重保存后，就按这里的顺序走。</p>
        <p v-if="!row.mappings.length" class="msh__empty">— 没有渠道提供 · 只在价格源里出现</p>
        <ul v-else class="msh__maps">
          <li
            v-for="(m, i) in [...sortable, ...fixed]"
            :key="mappingKey(m)"
            class="msh__map"
            :class="{ 'is-off': !m.enabled, 'is-over': canOrder && dragOver === i && dragFrom !== i, 'is-drag': dragFrom === i }"
            :draggable="canOrder && i < sortable.length && busy === ''"
            @dragstart="dragFrom = i"
            @dragover.prevent="dragOver = i"
            @drop.prevent="onDrop(i)"
            @dragend="dragFrom = -1; dragOver = -1"
          >
            <span v-if="canOrder && i < sortable.length" class="msh__grip" aria-hidden="true">⋮⋮</span>
            <div class="msh__map-l">
              <div class="msh__map-1">
                <span class="msh__ch num">{{ m.channel }}</span>
                <TxTag size="sm" variant="plain" :label="KIND[m.kind]" />
                <span v-if="m.upstreams > 1" class="msh__dim num">×{{ m.upstreams }}</span>
                <span v-if="m.model !== row.id" class="msh__dim num msh__exact" :title="m.model">{{ m.model }}</span>
              </div>
              <div class="msh__map-2 num">
                <span v-if="!m.channelEnabled">渠道停用</span>
                <span v-else-if="probeText(m.channel)" :class="{ 'is-bad': probeText(m.channel)?.bad }">{{ probeText(m.channel)?.text }}</span>
                <span v-if="useText(m.channel)">{{ useText(m.channel) }}</span>
              </div>
            </div>
            <div class="msh__ctl">
              <template v-if="canOrder && i < sortable.length">
                <button type="button" class="msh__mv" :disabled="busy !== '' || i === 0" :aria-label="`${m.channel} 上移`" @click="move(i, i - 1)"><Icon name="chev" class="msh__up" /></button>
                <button type="button" class="msh__mv" :disabled="busy !== '' || i === sortable.length - 1" :aria-label="`${m.channel} 下移`" @click="move(i, i + 1)"><Icon name="chev" /></button>
                <WeightField
                  :model-value="m.weight ?? 0"
                  :label="`${m.channel} 的权重`"
                  :disabled="busy !== ''"
                  hint="权重小的先用；改成和相邻一样 = 同档（开了同档轮询才轮流）"
                  @commit="(v: number) => setWeight(i, v)"
                />
              </template>
              <Switch
                :model-value="m.enabled"
                :disabled="(!m.channelEnabled && !m.enabled) || (busy !== '' && busy !== mappingKey(m))"
                :loading="busy === mappingKey(m)"
                :aria-label="`${m.enabled ? '停用' : '启用'} ${m.model} 在 ${m.channel}`"
                @update:model-value="(v: boolean) => toggle(m, v)"
              />
            </div>
          </li>
        </ul>
      </section>

      <ModelUpstreamModels :model-key="row.key" :model-id="row.id" :active="open" />

      <section class="msh__sec">
        <h3 class="msh__h">近 7 天<span v-if="usageMissing" class="msh__h-note">◇ 用量读取失败</span></h3>
        <dl class="msh__kv">
          <div v-for="f in usageFacts" :key="f.k" :class="{ 'is-wide': f.v.length > 12 }"><dt>{{ f.k }}</dt><dd :class="{ 'is-hot': f.hot }">{{ f.v }}</dd></div>
        </dl>
        <RouterLink class="ui-link msh__link" :to="{ path: '/usage/requests', query: { model: row.key } }">看这个模型的请求 →</RouterLink>
      </section>
    </div>
  </Sheet>
</template>

<style scoped>
.msh { display: grid; gap: 22px; min-width: 0; }
.msh__top { display: grid; gap: 6px; min-width: 0; }
.msh__id { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 10px; margin: 0; font-size: var(--fs-sm); }
.msh__vendor { color: var(--ink-2); }
.msh__note { margin: 0; color: var(--signal-ink); font-family: var(--font-mono); font-size: var(--fs-xs); overflow-wrap: anywhere; }
.msh__alias { display: flex; gap: 10px; margin: 0; font-size: var(--fs-xs); color: var(--ink-2); min-width: 0; }
.msh__alias .num { overflow-wrap: anywhere; min-width: 0; }
.msh__k { flex: none; color: var(--ink-3); }
.msh__sec { display: grid; gap: 8px; min-width: 0; }
.msh__h { display: flex; align-items: baseline; gap: 8px; margin: 0; font-size: var(--fs-sm); font-weight: 600; color: var(--ink); }
.msh__h-n { font-weight: 400; color: var(--ink-3); }
.msh__h-note { margin-left: auto; font-weight: 400; color: var(--ink-2); font-size: var(--fs-xs); }
/* compact facts: k / v pairs flow into as many columns as fit, no rule under every pair; a long value takes a row */
.msh__kv { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 6px 16px; margin: 0; font-size: var(--fs-sm); }
.msh__kv { grid-auto-flow: row dense; }
.msh__kv > div { display: flex; align-items: baseline; gap: 8px; min-width: 0; }
.msh__kv > div.is-wide { grid-column: 1 / -1; }
.msh__kv dt { flex: none; color: var(--ink-3); }
.msh__kv dd { margin: 0; min-width: 0; font-family: var(--font-mono); font-variant-numeric: tabular-nums; color: var(--ink); overflow-wrap: anywhere; }
.msh__kv dd.is-hot { color: var(--signal-ink); }
.msh__empty { margin: 0; font-size: var(--fs-sm); color: var(--ink-3); }
.msh__maps { margin: 0; padding: 0; list-style: none; }
.msh__map { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 12px; min-height: 48px; padding: 6px 0; border-bottom: 1px solid var(--rule); }
.msh__map[draggable="true"] { cursor: grab; }
.msh__map.is-drag { opacity: .45; }
.msh__map.is-over { box-shadow: 0 -2px 0 var(--ink-3); }
.msh__grip { flex: none; color: var(--ink-4); font-size: var(--fs-xs); letter-spacing: -2px; user-select: none; }
.msh__ctl { display: flex; align-items: center; gap: 8px; flex: none; margin-left: auto; }
.msh__mv { display: inline-grid; place-items: center; width: 26px; height: 26px; padding: 0; border: 0; border-radius: var(--r-1); background: transparent; color: var(--ink-3); cursor: pointer; }
.msh__mv:hover:not(:disabled) { background: var(--paper-2); color: var(--ink); }
.msh__mv:disabled { opacity: .3; cursor: default; }
.msh__up { transform: rotate(180deg); }
.msh__rr { display: inline-flex; align-items: center; gap: 8px; margin-left: auto; font-weight: 400; font-size: var(--fs-xs); color: var(--ink-2); }
.msh__hint { margin: 0; font-size: var(--fs-xs); color: var(--ink-3); }
.msh__map-l { display: grid; gap: 2px; flex: 1 1 140px; min-width: 0; }
.msh__map-1 { display: flex; align-items: center; gap: 8px; min-width: 0; }
.msh__map-2 { display: flex; flex-wrap: wrap; gap: 0; font-size: var(--fs-xs); color: var(--ink-3); }
.msh__map-2 > span + span::before { content: "·"; margin: 0 6px; color: var(--ink-4); }
.msh__map-2 .is-bad { color: var(--signal-ink); }
.msh__ch { flex: none; color: var(--ink); font-size: var(--fs-sm); }
.msh__map.is-off .msh__ch { color: var(--ink-3); }
.msh__dim { color: var(--ink-3); font-size: var(--fs-xs); white-space: nowrap; }
.msh__exact { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
.msh__link { justify-self: start; }
</style>

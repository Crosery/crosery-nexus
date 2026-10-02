<script setup lang="ts">
import { computed } from 'vue'
import { TxButton, TxIconButton } from '@talex-touch/tuffex/button'
import StatusMark from '../../ui/data/StatusMark.vue'
import EmailIdentity from '../../ui/data/EmailIdentity.vue'
import CountdownPie from '../../ui/viz/CountdownPie.vue'
import TickStrip from '../../ui/viz/TickStrip.vue'
import Switch from '../../ui/form/Switch.vue'
import Icon from '../../ui/Icon.vue'
import { fmtInt } from '../../ui/fmt'
import { maskEmail, useMask } from '../../lib/privacy'
import type { EgressData, ProxyPreset } from '../../types'
import QuotaCell from './QuotaCell.vue'
import AccountDetail from './AccountDetail.vue'
import EgressTag from './EgressTag.vue'
import { fmtStamp, HOT_RATIO, type AccountView, type ShareWindow } from './model'
import { cpaRef, egressBadge, serviceOf } from './egressModel'
import { proxyRead } from './proxyStore'

const fmtDay = (v: string) => fmtStamp(v).split(' ')[0]

/**
 * One account, one ~44px two-line row (DESIGN §6.5 table): 状态 · 账号 (email / plan · 首选 · 参与路由) ·
 * 路由 switch · 窗口 A · 窗口 B · 重置 · 最近 · 操作. Cooldown / lapsed rows carry a reason line; the expanded
 * band (paper-2) holds AccountDetail. Clicking the row body toggles it; ⋯ is the keyboard path.
 */
const props = withDefaults(
  defineProps<{
    row: AccountView
    index: number
    mode: 'used' | 'left'
    /** meter width: 56 full row, 48 in the md layout */
    meter?: number
    now: number
    expanded: boolean
    busy?: string
    washed?: boolean
    share?: ShareWindow | null
    presets?: ProxyPreset[]
    egress?: EgressData | null
  }>(),
  { meter: 56, busy: undefined, washed: false, share: null, presets: () => [], egress: null },
)
const emit = defineEmits<{ expand: []; routing: [on: boolean]; reset: []; reauth: []; proxy: [url: string]; remove: []; cooled: [] }>()
const { on: masked } = useMask()

const tone = computed(() => {
  if (props.row.attention) return 'is-attn'
  if (props.row.state === 'cool') return 'is-cool'
  if (props.row.state === 'pause') return 'is-off'
  return ''
})
const recentLive = computed(() => {
  const t = props.row.recent?.ticks ?? []
  return props.row.state === 'run' && t.slice(-2).some((n) => n > 0)
})
const routeWord = computed(() => (props.row.disabled ? '不参与路由' : props.row.routable ? '参与路由' : '暂不可路由'))
const recentOk = computed(() => (props.row.recent ? `近 200m ✓ ${fmtInt(props.row.recent.ok)}` : ''))
const recentFail = computed(() => (props.row.recent?.failed ? `✗ ${fmtInt(props.row.recent.failed)}` : ''))
const extraHot = computed(() => props.row.extra.some((w) => w.used >= HOT_RATIO))
const credits = computed(() => props.row.credits)
const canReset = computed(() => Boolean(props.row.provider?.resettable && credits.value && credits.value.count > 0 && props.row.authIndex))
const who = computed(() => (masked.value ? maskEmail(props.row.email) : props.row.email))
const detailId = computed(() => `acc-x-${props.row.key.replace(/[^a-z0-9]/gi, '')}`)
/** the exit as last read for this account (detail open), else as the pool last saw it */
const exitBadge = computed(() => {
  const read = proxyRead(props.row.name)
  return egressBadge(props.egress, cpaRef(props.row.name), serviceOf(props.row.type), read.state === 'ready' ? read.value : null)
})
const winMessage = computed(() => {
  switch (props.row.quotaState) {
    case 'error': return { text: '额度读取失败 · 稍后自动重试', title: props.row.quotaError ?? '' }
    case 'missing': return { text: '额度这次没读到', title: '' }
    case 'none': return { text: '上游不报告额度窗口', title: '' }
    default: return { text: '上游没有返回额度窗口', title: '' }
  }
})

function onRowClick(event: MouseEvent) {
  const target = event.target as HTMLElement
  if (target.closest('button, a, input, select, label, .tx-switch, .acc-row__x')) return
  if (window.getSelection()?.toString()) return
  emit('expand')
}
</script>

<template>
  <li class="acc-row" :class="[tone, { 'is-open': expanded, 'ui-washed': washed }]" data-row :style="{ '--r': Math.min(index, 14) }" @click="onRowClick">
    <span class="acc-c acc-c--st">
      <CountdownPie v-if="row.state === 'cool' && row.coolUntil" :until="row.coolUntil" :total="row.coolTotal" @done="emit('cooled')" />
      <StatusMark v-else :state="row.state" :label="row.stateLabel" :live="recentLive" />
    </span>
    <span class="acc-c acc-c--id">
      <EmailIdentity :email="row.email" :struck="row.lapsed">
        <template #line2>
          <span v-if="row.plan" class="mono">{{ row.plan }}</span><template v-if="row.plan"> · </template>
          <template v-if="row.first"><b class="acc-first">首选</b> · </template>
          <span>{{ routeWord }}</span>
          <span v-if="recentOk" class="acc-l2-recent num"> · {{ recentOk }}<span v-if="recentFail" class="sig acc-l2-fail"> {{ recentFail }}</span></span>
          <template v-if="exitBadge"> · <EgressTag class="acc-l2-eg" :badge="exitBadge" /></template>
        </template>
      </EmailIdentity>
    </span>
    <span class="acc-c acc-c--sw">
      <Switch :model-value="!row.disabled" :aria-label="`参与路由：${who}`" :loading="busy === 'routing'" :disabled="Boolean(busy)" @update:model-value="emit('routing', $event)" />
    </span>
    <span v-if="row.lapsed && !row.a && !row.b" class="acc-c acc-c--wmsg">— 授权失效 · 额度不可读</span>
    <template v-else-if="row.a || row.b">
      <span class="acc-c acc-c--w"><QuotaCell v-if="row.a" :win="row.a" :mode="mode" :width="meter" :now="now" /><span v-else class="dim">—</span></span>
      <span class="acc-c acc-c--w">
        <QuotaCell v-if="row.b" :win="row.b" :mode="mode" :width="meter" :now="now" /><span v-else class="dim">—</span>
        <span v-if="row.extra.length" class="acc-more num" :class="{ sig: extraHot }" :title="row.extra.map((w) => `${w.label} ${Math.round(w.used * 100)}%`).join(' · ')">+{{ row.extra.length }}</span>
      </span>
    </template>
    <span v-else class="acc-c acc-c--wmsg" :title="winMessage.title || undefined">{{ winMessage.text }}</span>
    <span class="acc-c acc-c--rs num">
      <template v-if="credits && credits.count > 0">
        <span class="acc-rs-full" :title="credits.entries[0] ? `最早 ${fmtStamp(credits.entries[0].expiresAt)} 过期` : undefined">↺ {{ credits.count }} 次<template v-if="credits.entries[0]"><span class="dim"> · 最早 {{ fmtDay(credits.entries[0].expiresAt) }} 过期</span></template></span>
        <span class="acc-rs-short" :title="credits.entries[0] ? `最早 ${fmtStamp(credits.entries[0].expiresAt)} 过期` : undefined">↺ {{ credits.count }}</span>
      </template>
      <span v-else-if="row.provider?.resettable && (row.quotaState === 'ok' || row.quotaState === 'empty')" class="dim"><span class="acc-rs-full">无重置次数</span><span class="acc-rs-short" title="无重置次数">↺ 0</span></span>
      <span v-else class="dim">—</span>
    </span>
    <span class="acc-c acc-c--rc">
      <TickStrip v-if="row.recent" :ticks="row.recent.ticks" :bad="row.recent.bad" :label="`近 200 分钟 · 成功 ${row.recent.ok} · 失败 ${row.recent.failed}`" />
      <span v-else class="dim">—</span>
    </span>
    <span class="acc-c acc-c--act">
      <TxButton v-if="row.lapsed" variant="danger" size="sm" :disabled="Boolean(busy)" @click="emit('reauth')">重新授权</TxButton>
      <TxButton v-else-if="canReset" variant="secondary" size="sm" :disabled="Boolean(busy)" title="用最早到期的 1 次重置" @click="emit('reset')">{{ busy === 'reset' ? '重置中···' : '重置' }}</TxButton>
      <TxIconButton
        class="acc-more-btn"
        size="sm"
        :label="`${expanded ? '收起' : '展开'}详情：${who}`"
        :aria-expanded="expanded"
        :aria-controls="detailId"
        :title="expanded ? '收起' : '详情 · 代理 · 移除'"
        @click="emit('expand')"
      ><Icon :name="expanded ? 'chev' : 'dots'" /></TxIconButton>
    </span>
    <div v-if="row.leader" class="acc-row__leader" :class="{ sig: row.attention }">{{ row.leader }}</div>
    <div v-if="expanded" :id="detailId" class="acc-row__x">
      <AccountDetail :row="row" :share="share" :mode="mode" :now="now" :busy="busy" :presets="presets" :egress="egress" @reset="emit('reset')" @proxy="emit('proxy', $event)" @remove="emit('remove')" />
    </div>
  </li>
</template>

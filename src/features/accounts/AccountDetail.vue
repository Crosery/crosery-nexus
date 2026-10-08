<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { TxButton } from '@talex-touch/tuffex/button'
import { TxInput } from '@talex-touch/tuffex/input'
import { TxTag } from '@talex-touch/tuffex/tag'
import FilterField from '../../ui/form/FilterField.vue'
import TickStrip from '../../ui/viz/TickStrip.vue'
import ShareBar from '../../ui/viz/ShareBar.vue'
import { fmtCompact, fmtInt } from '../../ui/fmt'
import { maskName, useMask } from '../../lib/privacy'
import type { EgressData, ProxyPreset } from '../../types'
import type { SegmentItem, ShareSegment } from '../../ui/types'
import QuotaCell from './QuotaCell.vue'
import EgressTag from './EgressTag.vue'
import { fmtStamp, PROXY_CUSTOM, PROXY_UNKNOWN, proxyChoice, proxyKeepsDraft, proxyNeedsWrite, proxySentAfterWrite, type AccountView, type ShareWindow } from './model'
import { cpaRef, egressBadge, egressOptions, serviceOf } from './egressModel'
import { proxyRead, readProxy } from './proxyStore'

/**
 * Expanded account (DESIGN §6.5 "Expanded row"): 全部窗口 · 重置次数 ledger · 本服务各 Key 消耗, then the
 * management line (代理, 移除). Desktop renders it in the paper-2 band under the row; below 960 it is the body
 * of the detail sheet (`compact`), where the footer carries the 40px actions.
 */
const props = withDefaults(
  defineProps<{
    row: AccountView
    share?: ShareWindow | null
    mode: 'used' | 'left'
    now: number
    busy?: string
    presets?: ProxyPreset[]
    /** the pool view (exits, their country and checks); null when the pool routes are not there */
    egress?: EgressData | null
    compact?: boolean
  }>(),
  { share: null, busy: undefined, presets: () => [], egress: null, compact: false },
)
const emit = defineEmits<{ reset: []; proxy: [url: string]; remove: [] }>()
const { on: masked } = useMask()

const meterW = computed(() => (props.compact ? 96 : 120))
const resettable = computed(() => Boolean(props.row.provider?.resettable))

/* ── Key share: provider-wide (the server attributes token volume per provider window, not per account) ── */
const segments = computed<ShareSegment[]>(() =>
  (props.share?.keys ?? []).map((k) => ({
    key: k.keyId || k.keyName,
    label: masked.value ? maskName(k.keyName || '未关联 Key') : k.keyName || '未关联 Key',
    value: k.promptTokens + k.outputTokens,
  })),
)
const shareSince = computed(() => (props.share?.windowStart ? fmtStamp(props.share.windowStart) : null))

/* ── exit picker ──
   The current value comes from GET /api/proxies/egress/account, read when this detail opens: the list endpoints
   report '' for every account in CPA mode, so `row.proxyUrl` is not authoritative. The answer names the pool entry
   the account points at and a masked address — never the URL. Until it answers the picker says so, and any pick
   is sent (a write is skipped only when the known value already equals it). Picks are pool entries (by id), the
   presets that are not in the pool, 继承, 直连 or a typed address. */
const CUSTOM = PROXY_CUSTOM
const ref_ = computed(() => cpaRef(props.row.name))
const service = computed(() => serviceOf(props.row.type))
const read = computed(() => proxyRead(props.row.name))
const current = computed(() => (read.value.state === 'ready' ? read.value.value : null))
const choice = ref(PROXY_UNKNOWN)
const draft = ref('')
/** the custom address last sent: the server's answer replaces it in the field */
let sent: string | null = null
watch(() => props.row.name, (name) => {
  draft.value = ''
  sent = null
  void readProxy(name, props.row.type)
}, { immediate: true })
// the draft starts empty: a stored proxy URL may carry user:password, and it is never echoed into a field
watch(read, (value) => {
  if (proxyKeepsDraft(choice.value, draft.value, sent)) return
  sent = null
  choice.value = proxyChoice(value, props.egress)
  draft.value = ''
}, { immediate: true })
// the pool view can land after the account's read: the pick follows it (not mid-write, not over a typed address)
watch(() => props.egress, (egress) => {
  if (props.busy || read.value.state !== 'ready' || proxyKeepsDraft(choice.value, draft.value, sent)) return
  choice.value = proxyChoice(read.value, egress)
})
// a failed save: the write ended without its answer landing, so the address is a draft again (kept for a retry)
watch(() => props.busy, (now, before) => { sent = proxySentAfterWrite(before, now, sent) })
const draftOk = computed(() => /^(https?|socks5h?):\/\/[^\s]+$/i.test(draft.value.trim()))
const proxyOptions = computed<SegmentItem[]>(() => {
  const items = egressOptions(props.egress, ref_.value, service.value, { presets: props.presets, custom: true })
  const custom = items.find((item) => item.value === CUSTOM)
  if (custom && choice.value === CUSTOM && current.value?.masked) custom.label = `自定义 · ${current.value.masked}`
  if (choice.value === PROXY_UNKNOWN) items.push({ value: PROXY_UNKNOWN, label: read.value.state === 'error' ? '当前值没读到' : '读取中···', disabled: true })
  return items
})
/** where the current exit lands and whether it reaches this account's vendor (Claude account → Claude check) */
const badge = computed(() => (current.value ? egressBadge(props.egress, ref_.value, service.value, current.value) : null))
// a pool entry's option already reads `region · name · check`; the tag beside it only says where 继承 / 直连 lands
const pickedEntry = computed(() => Boolean(props.egress?.entries.some((entry) => entry.id === choice.value)))
function onChoice(value: string) {
  choice.value = value
  if (proxyNeedsWrite(read.value, value, props.egress)) emit('proxy', value)
}
function saveCustom() {
  const next = draft.value.trim()
  if (!draftOk.value || !proxyNeedsWrite(read.value, next, props.egress)) return
  sent = next
  emit('proxy', next)
}
</script>

<template>
  <div class="acc-x" :class="{ 'is-compact': compact }">
    <section class="acc-x__col" aria-label="全部窗口">
      <h4 class="acc-x__h">全部窗口</h4>
      <ul v-if="row.windows.length" class="acc-x__wins">
        <li v-for="w in row.windows" :key="w.id"><QuotaCell :win="w" :mode="mode" :width="meterW" :now="now" full /></li>
      </ul>
      <p v-else class="acc-x__none">
        <template v-if="row.quotaState === 'error'">额度读取失败 · <span class="mono">{{ row.quotaError }}</span></template>
        <template v-else-if="row.quotaState === 'missing'">额度这次没读到 · 下次刷新再试</template>
        <template v-else-if="row.quotaState === 'none'">上游不报告这类账号的额度窗口</template>
        <template v-else>上游没有返回额度窗口</template>
      </p>
      <p v-if="row.quotaState === 'ok' && row.quotaError" class="acc-x__note">◇ 显示的是上次读到的额度 · <span class="mono">{{ row.quotaError }}</span></p>
      <div v-if="row.recent" class="acc-x__recent">
        <TickStrip :ticks="row.recent.ticks" :bad="row.recent.bad" :label="`近 200 分钟请求 · 每格 10 分钟`" />
        <span class="num">近 200 分钟 · 成功 {{ fmtInt(row.recent.ok) }} · <span :class="{ sig: row.recent.failed > 0 }">失败 {{ fmtInt(row.recent.failed) }}</span></span>
      </div>
    </section>

    <section class="acc-x__col" aria-label="重置次数">
      <h4 class="acc-x__h">重置次数</h4>
      <template v-if="row.credits && row.credits.count > 0">
        <ol class="acc-x__ledger">
          <li v-for="(c, i) in row.credits.entries" :key="c.id || i">
            <span class="dim">第 {{ i + 1 }} 次</span>
            <span class="num">{{ fmtStamp(c.expiresAt) }} 过期</span>
            <TxTag v-if="i === 0" size="sm" variant="plain" label="下次使用" />
          </li>
          <li v-if="!row.credits.entries.length"><span class="num">↺ {{ row.credits.count }} 次</span><span class="dim">过期时间未上报</span></li>
        </ol>
        <p v-if="compact" class="acc-x__note">用最早到期的 1 次 · 不可撤销</p>
        <div v-else class="acc-x__act">
          <TxButton variant="secondary" size="sm" :disabled="Boolean(busy)" @click="emit('reset')">
            {{ busy === 'reset' ? '重置中···' : '用 1 次重置' }}
          </TxButton>
          <span class="dim">用最早到期的 1 次 · 不可撤销</span>
        </div>
      </template>
      <p v-else class="acc-x__none">
        {{ !resettable ? '该服务没有主动重置' : row.quotaState === 'ok' || row.quotaState === 'empty' ? '没有可用的重置次数' : '重置次数未读到' }}
      </p>
    </section>

    <section class="acc-x__col acc-x__col--share" aria-label="本服务各 Key 消耗">
      <h4 class="acc-x__h">本服务各 Key 消耗</h4>
      <template v-if="segments.length">
        <ShareBar :segments="segments" :format="fmtCompact" :direct="false" :label="`${row.provider?.name ?? row.type} 各 Key Token 占比`" />
        <p class="acc-x__note">按 Token · 自 {{ shareSince ?? '—' }} 起 · 全部 {{ row.provider?.name ?? row.type }} 账号合计</p>
      </template>
      <p v-else class="acc-x__none">{{ share ? '这个窗口还没有 Key 消耗' : '该服务不按 Key 统计' }}</p>
    </section>

    <footer class="acc-x__foot">
      <!-- inert while a write is in flight: FilterField has no `disabled` yet, and a pick then would not be sent -->
      <FilterField
        class="acc-x__proxy"
        label="出口"
        :all-label="null"
        :options="proxyOptions"
        :model-value="choice"
        :inert="Boolean(busy) || undefined"
        @update:model-value="onChoice"
      />
      <EgressTag v-if="badge && choice !== CUSTOM && !pickedEntry" class="acc-x__eg" :badge="badge" bare />
      <TxButton v-if="read.state === 'error'" variant="secondary" size="sm" :disabled="Boolean(busy)" @click="readProxy(row.name, row.type)">重读</TxButton>
      <span v-if="choice === CUSTOM" class="acc-x__custom">
        <TxInput v-model="draft" type="url" inputmode="url" autocomplete="off" spellcheck="false" :placeholder="current && choice === CUSTOM ? '新地址 · socks5://host:port' : 'socks5://host:port'" aria-label="自定义代理地址" @keydown.enter.prevent="saveCustom" />
        <TxButton variant="secondary" size="sm" :disabled="!draftOk || Boolean(busy)" @click="saveCustom">保存</TxButton>
      </span>
      <span class="acc-x__file mono" :title="masked ? undefined : row.name"><span class="pii-t">{{ row.name }}</span><span class="pii-m">{{ maskName(row.name) }}</span></span>
      <TxButton v-if="!compact" class="acc-x__rm" variant="danger" size="sm" :disabled="Boolean(busy)" @click="emit('remove')">移除</TxButton>
    </footer>
  </div>
</template>

<style>
.acc-x { display: grid; grid-template-columns: minmax(0, 1.15fr) minmax(0, .85fr) minmax(0, 1.1fr); gap: 14px 28px; min-width: 0; }
.acc-x__col { min-width: 0; display: flex; flex-direction: column; gap: 6px; }
.acc-x__h { margin: 0 0 2px; font-size: var(--fs-xs); font-weight: 600; color: var(--ink-2); }
.acc-x__wins { list-style: none; margin: 0; padding: 0; display: grid; gap: 5px; }
.acc-x__wins .acc-q { width: 100%; }
.acc-x__none { margin: 0; font-size: var(--fs-xs); color: var(--ink-3); }
.acc-x__none::before { content: "— "; }
.acc-x__note { margin: 0; font-size: var(--fs-xs); color: var(--ink-3); }
.acc-x__recent { display: flex; align-items: center; gap: 8px; margin-top: 4px; font-size: var(--fs-xs); color: var(--ink-3); min-width: 0; flex-wrap: wrap; }
.acc-x__ledger { list-style: none; margin: 0; padding: 0; display: grid; gap: 4px; font-size: var(--fs-xs); }
.acc-x__ledger li { display: flex; align-items: center; gap: 10px; min-height: 20px; }
.acc-x__ledger .num { color: var(--ink); }
.acc-x__act { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 10px; margin-top: 4px; font-size: var(--fs-xs); }
.acc-x__col--share .ui-legend { margin-top: 6px; }
.acc-x__foot { grid-column: 1 / -1; display: flex; flex-wrap: wrap; align-items: center; gap: 8px 14px; padding-top: 10px; border-top: 1px solid var(--rule); font-size: var(--fs-xs); min-width: 0; }
.acc-x__proxy .ui-ff__k { font-size: var(--fs-xs); }
.acc-x__proxy[inert] { opacity: .6; }
html:root .acc-x__proxy .tuff-select { width: 300px; max-width: 100%; }
.acc-x__eg { flex: 0 1 auto; }
.acc-x__eg .eg__n { display: none; }
.acc-x__custom { display: inline-flex; align-items: center; gap: 6px; min-width: 0; }
html:root .acc-x__custom .tx-input { width: 220px; max-width: 100%; }
html:root .acc-x__custom .tx-input__inner { font-family: var(--font-mono); font-size: var(--fs-xs); }
.acc-x__file { color: var(--ink-3); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; flex: 1 1 120px; text-align: right; }
.acc-x.is-compact { grid-template-columns: minmax(0, 1fr); gap: 18px; }
.acc-x.is-compact .acc-x__file { text-align: left; flex-basis: 100%; }
.acc-x.is-compact .acc-x__proxy { flex: 1 1 100%; }
html:root .acc-x.is-compact .acc-x__proxy .tuff-select { width: auto; max-width: none; }
html:root .acc-x.is-compact .acc-x__custom .tx-input__inner { font-size: var(--fs-input); }
@container accounts (max-width: 1299px) {
  .acc-x { grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); }
  .acc-x__col--share { grid-column: 1 / -1; }
}
</style>

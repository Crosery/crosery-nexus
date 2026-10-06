<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, shallowRef, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { TxButton } from '@talex-touch/tuffex/button'
import { TxTag } from '@talex-touch/tuffex/tag'
import PageHead from '../../ui/shell/PageHead.vue'
import LiveMark from '../../ui/shell/LiveMark.vue'
import Plate from '../../ui/data/Plate.vue'
import StateBlock from '../../ui/data/StateBlock.vue'
import ProviderMark from '../../ui/data/ProviderMark.vue'
import StatusMark from '../../ui/data/StatusMark.vue'
import EmailIdentity from '../../ui/data/EmailIdentity.vue'
import CountdownPie from '../../ui/viz/CountdownPie.vue'
import SearchField from '../../ui/form/SearchField.vue'
import Segmented from '../../ui/form/Segmented.vue'
import Switch from '../../ui/form/Switch.vue'
import Sheet from '../../ui/feedback/Sheet.vue'
import Icon from '../../ui/Icon.vue'
import { useBreakpoint } from '../../ui/composables/useBreakpoint'
import { useElementWidth } from '../../ui/composables/useElementWidth'
import { useLive } from '../../ui/composables/useLive'
import { useNow } from '../../ui/composables/useNow'
import { fmtTime } from '../../ui/fmt'
import { maskEmail, useMask } from '../../lib/privacy'
import { setNavCount } from '../../shell/badges'
import { usePaletteCommands } from '../../shell/palette'
import type { CommandItem, SegmentItem } from '../../ui/types'
import { loadAccounts, type AccountsPayload } from './accountsApi'
import { proxyApi } from '../../api/proxy'
import type { EgressData } from '../../types'
import AccountRow from './AccountRow.vue'
import AccountCard from './AccountCard.vue'
import AccountDetail from './AccountDetail.vue'
import ProviderHead from './ProviderHead.vue'
import AddAccountSheet from './AddAccountSheet.vue'
import { useAccountActions } from './useAccountActions'
import {
  buildAccounts, countBy, filterGroups, groupAccounts, mergeAccountsPayload, PROVIDERS, providerById, verifyOutcome,
  type AccountView, type CredentialLike, type MonitorAccount, type ProviderGroup, type ProviderInfo, type QuotaShare, type VerifyResult,
} from './model'

/**
 * 账号 (DESIGN §6.5; Magpie Providers → accounts): every credential grouped by provider, one row each with
 * inline quota windows, reset credits, routing switch and the management actions; adding an account runs
 * the existing OAuth / device-code / paste-callback flows in a sheet. `?add=1` (⌘K 添加账号…), `?add=<服务>`
 * and `#oauth` open that sheet.
 * `embedded`: the pool renders as the Providers page 订阅账号池 section — its own Plate carries the
 * section title (`plateTitle`), the PageHead and the `.ui-page` rhythm are the host's job. The data loop,
 * filters, row actions, deep links and the add flow are unchanged; `count` hands the host the account total
 * so the section tab can count without a second channels/monitor read.
 */
const props = withDefaults(
  defineProps<{ embedded?: boolean; plateTitle?: string }>(),
  { embedded: false, plateTitle: '账号池' },
)
const emit = defineEmits<{ (e: 'count', total: number): void }>()
const route = useRoute()
const router = useRouter()
const { isMobile } = useBreakpoint()
const now = useNow()
const { on: masked } = useMask()

/* ── data: one loop, both endpoints (either may fail alone; the failed one keeps its last good data) ── */
const INTERVAL = 60_000
const live = useLive<AccountsPayload>(async (signal) => {
  const next = await loadAccounts(signal)
  return mergeAccountsPayload(live.data.value, next)
}, { intervalMs: INTERVAL, isEmpty: () => false })
async function refresh() {
  await live.refresh()
}

const payload = computed(() => live.data.value)
const rows = computed<AccountView[]>(() => {
  const p = payload.value
  if (!p) return []
  return buildAccounts(
    (p.channels?.credentials ?? null) as CredentialLike[] | null,
    (p.monitor?.accounts ?? null) as MonitorAccount[] | null,
    p.at,
  )
})
const counts = computed(() => countBy(rows.value))
const quotaShare = computed(() => (payload.value?.monitor?.quotaShare ?? {}) as QuotaShare)
watch(() => counts.value.all, (n) => emit('count', n), { immediate: true })
const presets = computed(() => payload.value?.channels?.proxyPresets ?? [])

/* ── account exits: the proxy pool's view (local reads on the server, no CPA / vendor traffic); a server without
   the pool routes leaves it null and the page keeps working without exits ── */
const egressLive = useLive<EgressData>((signal) => proxyApi.egress(signal), { intervalMs: INTERVAL, isEmpty: () => false })
const egress = computed(() => egressLive.data.value ?? null)

/* ── filters (URL) and the used/left figure (this device) ── */
const q = ref('')
const show = ref<string | number | null>('all')
const MODE_KEY = 'cx-acc-quota'
const mode = ref<'used' | 'left'>(readMode())
function readMode(): 'used' | 'left' {
  try {
    return localStorage.getItem(MODE_KEY) === 'left' ? 'left' : 'used'
  } catch {
    return 'used'
  }
}
watch(mode, (v) => {
  try {
    localStorage.setItem(MODE_KEY, v)
  } catch { /* private mode: keep it for this page only */ }
})
const MODE_ITEMS: SegmentItem[] = [{ value: 'used', label: '已用' }, { value: 'left', label: '剩余' }]
const showItems = computed<SegmentItem[]>(() => {
  const c = counts.value
  const current = String(show.value ?? 'all')
  const items: SegmentItem[] = [
    { value: 'all', label: '全部', count: c.all },
    { value: 'run', label: '运行', count: c.run },
    { value: 'cool', label: '冷却', count: c.cool },
    { value: 'pause', label: '暂停', count: c.pause },
    { value: 'bad', label: '失效', count: c.bad },
    { value: 'warn', label: '异常', count: c.warn },
    { value: 'hot', label: '窗口 ≥90%', count: c.hot },
    { value: 'reset', label: '可用重置', count: c.reset },
  ]
  // a chip that can only show an empty list is noise: keep 全部 and the one in use, drop the other zeros
  return items.filter((it) => it.value === 'all' || it.value === current || (it.count ?? 0) > 0)
})
const filtering = computed(() => String(show.value ?? 'all') !== 'all' || q.value.trim() !== '')
function clearFilters() {
  show.value = 'all'
  q.value = ''
  void router.replace({ query: { ...route.query, show: undefined, q: undefined } })
}

/* ── groups: providers with accounts, plus the three core services even when empty ── */
const CORE = ['codex', 'claude', 'antigravity']
const allGroups = computed(() => groupAccounts(rows.value))
const groups = computed<ProviderGroup[]>(() => {
  const list = filterGroups(allGroups.value, String(show.value ?? 'all'), q.value)
  if (filtering.value) return list
  const have = new Set(list.map((g) => g.key))
  const empties: ProviderGroup[] = CORE.filter((id) => !have.has(id)).map((id) => {
    const p = providerById(id)!
    return { key: id, provider: p, type: id, name: p.name, vendor: p.vendor, accounts: [], routable: 0, tiered: false }
  })
  const order = (g: ProviderGroup) => {
    const i = PROVIDERS.findIndex((p) => p.id === g.key)
    return i === -1 ? PROVIDERS.length : i
  }
  return [...list, ...empties].sort((a, b) => order(a) - order(b))
})
const groupOf = (row: AccountView) => allGroups.value.find((g) => g.accounts.includes(row)) ?? null
const others = computed<ProviderInfo[]>(() => {
  const have = new Set(allGroups.value.map((g) => g.key))
  return PROVIDERS.filter((p) => !CORE.includes(p.id) && !have.has(p.id))
})
const visibleCount = computed(() => groups.value.reduce((n, g) => n + g.accounts.length, 0))

/* ── head status, nav badge, palette ── */
const plateState = computed(() => live.state.value)
const headStatus = computed(() => {
  const c = counts.value
  if (!payload.value) return []
  if (!c.all) return [{ t: `0 账号 · ${PROVIDERS.length} 种服务可添加`, sig: false }]
  const parts = [{ t: `${c.all} 账号 · ${c.providers} 服务`, sig: false }, { t: `运行 ${c.run}`, sig: false }]
  if (c.cool) parts.push({ t: `冷却 ${c.cool}`, sig: false })
  if (c.pause) parts.push({ t: `暂停 ${c.pause}`, sig: false })
  if (c.warn) parts.push({ t: `异常 ${c.warn}`, sig: true })
  if (c.bad) parts.push({ t: `失效 ${c.bad}`, sig: true })
  return parts
})
watch(() => counts.value.attention, (n) => setNavCount('accounts', n), { immediate: true })
onBeforeUnmount(() => setNavCount('accounts', null))

const quotaFailures = computed(() => rows.value.filter((r) => r.quotaState === 'error').length)
const monitored = computed(() => rows.value.filter((r) => r.provider?.monitored).length)

usePaletteCommands((): CommandItem[] => [
  ...PROVIDERS.map((p) => ({ id: `act:add-account:${p.id}`, title: `添加 ${p.name} 账号…`, section: 'ACT' as const, keywords: ['oauth', '授权', p.id], run: () => openAdd(p.id) })),
  ...rows.value.map((r) => ({
    id: `find:account:${r.key}`,
    title: masked.value ? maskEmail(r.email) : r.email,
    section: 'FIND' as const,
    hint: `${r.provider?.name ?? r.type} · ${r.stateLabel}`,
    keywords: [r.plan, r.provider?.name ?? r.type],
    run: () => focusAccount(r.key),
  })),
])

/* ── expand / detail sheet ── */
const expanded = ref<string | null>(null)
const detailKey = ref<string | null>(null)
const detailOpen = computed({ get: () => detailKey.value !== null, set: (v) => { if (!v) detailKey.value = null } })
const detailRow = computed(() => rows.value.find((r) => r.key === detailKey.value) ?? null)
function toggle(row: AccountView) {
  expanded.value = expanded.value === row.key ? null : row.key
}
function focusAccount(key: string) {
  if (filtering.value) clearFilters()
  if (isMobile.value) {
    detailKey.value = key
    return
  }
  expanded.value = key
  void nextTick(() => document.querySelector(`[data-acc="${CSS.escape(key)}"]`)?.scrollIntoView({ block: 'center', behavior: 'smooth' }))
}

/* ── actions ── */
const actions = useAccountActions(refresh, () => ({ data: egress.value, presets: presets.value, reload: () => void egressLive.refresh() }))
async function onRemove(row: AccountView) {
  if (await actions.remove(row, groupOf(row))) {
    if (expanded.value === row.key) expanded.value = null
    if (detailKey.value === row.key) detailKey.value = null
  }
}

/* ── add sheet ── */
const addOpen = ref(false)
const addProvider = ref<string | null>(null)
const reauthEmail = ref<string | null>(null)
/** credential keys listed before the flow; null = the list was not read yet (deep link before the first answer) */
const addBaseline = shallowRef<Set<string> | null>(null)
const washed = ref<string | null>(null)
const listedKeys = () => (payload.value?.channels ? new Set(rows.value.map((r) => r.key)) : null)
function openAdd(providerId: string | null = null, reauth: AccountView | null = null) {
  addProvider.value = providerId
  reauthEmail.value = reauth?.email ?? null
  addBaseline.value = listedKeys()
  detailKey.value = null
  addOpen.value = true
}
// opened before the first credential list arrived: take the baseline from that first list (the OAuth round trip
// takes far longer than the immediate first poll); until then nothing is claimed as the new account
watch(rows, () => {
  if (addOpen.value && addBaseline.value === null) addBaseline.value = listedKeys()
})
async function verifyAdded(providerId: string): Promise<VerifyResult> {
  const baseline = addBaseline.value
  await refresh()
  const p = providerById(providerId)
  const mine = rows.value.filter((r) => (p ? r.provider?.id === p.id : r.type === providerId))
  // a renewal needs a fresh credential list and a sheet opened to re-authorize that account
  const readOk = live.error.value === null && !payload.value?.channelsError
  return verifyOutcome(mine, baseline, reauthEmail.value, readOk)
}
function onAdded(name: string | null) {
  if (!name) return
  washed.value = name
  window.setTimeout(() => { if (washed.value === name) washed.value = null }, 1600)
  void nextTick(() => document.querySelector(`[data-acc="${CSS.escape(name)}"]`)?.scrollIntoView({ block: 'center' }))
}

/* deep links: ?add=1 · ?add=<provider> · #oauth. The old /oauth redirect lands on the plain list (no hash), not here. */
function consumeDeepLink() {
  const add = route.query.add
  const wantsAdd = add !== undefined || route.hash === '#oauth'
  if (!wantsAdd) return
  const id = typeof add === 'string' && providerById(add) ? add : null
  openAdd(id)
  const query = { ...route.query }
  delete query.add
  void router.replace({ query, hash: '' })
}
watch(() => [route.query.add, route.hash], consumeDeepLink, { immediate: true })

const cols = ['96px', '1fr', '40px', '232px', '232px', '168px', '84px', '100px']
/* md (DESIGN §6.5): narrower meters once the list is under the full row width; mirrors the @container rule */
const listEl = ref<HTMLElement | null>(null)
const listW = useElementWidth(listEl, 1400)
const meter = computed(() => (listW.value < 1300 ? 48 : 56))
</script>

<template>
  <div class="ui-page acc" :class="{ 'is-embedded': props.embedded }">
    <PageHead v-if="!props.embedded" title="账号">
      <template #status>
        <span class="acc-status num"><template v-for="(p, i) in headStatus" :key="i"><template v-if="i"> · </template><span :class="{ sig: p.sig }">{{ p.t }}</span></template></span>
      </template>
      <template #live><LiveMark :state="plateState" :last-at="live.lastAt.value" :interval-ms="INTERVAL" @retry="refresh" /></template>
      <template #actions>
        <TxButton variant="primary" @click="openAdd()"><Icon name="plus" :size="14" />添加账号</TxButton>
      </template>
    </PageHead>

    <div v-if="counts.all || filtering" class="ui-toolbar acc-tools">
      <SearchField v-model="q" query="q" placeholder="邮箱 / 套餐 / 服务" label="搜索账号" />
      <Segmented v-model="show" query="show" default-value="all" :items="showItems" label="按状态筛选" />
      <Segmented v-model="mode" class="push" :items="MODE_ITEMS" label="额度显示已用或剩余" />
    </div>

    <Plate :title="props.plateTitle" flush class="acc-plate" :state="plateState" :error="live.error.value" :stale-at="live.lastAt.value" :rows="8" :cols="cols" @retry="refresh">
      <template #meta>
        <span v-if="payload?.monitorError" class="acc-meta-warn">{{ payload.monitor ? `◇ 额度刷新失败 · 显示 ${fmtTime(payload.monitorAt ?? payload.at)} 读到的` : '◇ 额度没读到 · 账号列表照常' }}</span>
        <span v-else-if="payload?.channelsError" class="acc-meta-warn">{{ payload.channels ? `◇ 凭据列表刷新失败 · 显示 ${fmtTime(payload.channelsAt ?? payload.at)} 读到的` : '◇ 凭据列表没读到 · 只显示有额度的账号' }}</span>
        <span v-else-if="quotaFailures" class="acc-meta-warn">◇ 额度读取失败 {{ quotaFailures }}/{{ monitored }}</span>
        <span class="acc-meta-src">额度按账号缓存 3–15m · 不频繁打上游</span>
      </template>
      <template v-if="props.embedded" #actions>
        <LiveMark :state="plateState" :last-at="live.lastAt.value" :interval-ms="INTERVAL" @retry="refresh" />
        <TxButton variant="subtle" size="small" @click="openAdd()"><Icon name="plus" :size="14" />添加账号</TxButton>
      </template>

      <div ref="listEl" class="acc-list" :class="{ 'is-mobile': isMobile }">
        <div v-if="!isMobile && visibleCount" class="acc-cols micro" aria-hidden="true">
          <span>状态</span><span>账号</span><span>路由</span><span>窗口 A</span><span>窗口 B</span><span class="acc-cols__rs">重置</span><span class="acc-cols__rc">最近</span><span />
        </div>

        <StateBlock v-if="filtering && !visibleCount" state="empty" empty-text="没有匹配的账号" action-label="清除筛选" @action="clearFilters" />
        <StateBlock v-else-if="!counts.all" class="acc-empty" state="empty" empty-text="还没有账号 · 选一个服务添加，额度、重置次数和冷却会出现在这里" />

        <section v-for="g in groups" :key="g.key" class="acc-group" :aria-labelledby="`acc-g-${g.key}`">
          <ProviderHead :group="g" :provider="g.provider" :name="g.name" :vendor="g.vendor" :compact="isMobile" :heading-id="`acc-g-${g.key}`" @add="openAdd(g.provider?.id ?? null)" />
          <StateBlock v-if="!g.accounts.length" class="acc-group__none" state="empty" :empty-text="`没有 ${g.name} 账号`" />
          <ul v-else-if="!isMobile" class="acc-rows">
            <AccountRow
              v-for="(row, i) in g.accounts"
              :key="row.key"
              :data-acc="row.key"
              :row="row"
              :index="i"
              :mode="mode"
              :meter="meter"
              :now="now"
              :expanded="expanded === row.key"
              :busy="actions.busy[row.key]"
              :washed="washed === row.key"
              :share="quotaShare[g.provider?.id ?? g.type] ?? null"
              :presets="presets"
              :egress="egress"
              @expand="toggle(row)"
              @routing="actions.setRouting(row, $event, groupOf(row))"
              @reset="actions.reset(row)"
              @reauth="openAdd(row.provider?.id ?? null, row)"
              @proxy="actions.setProxy(row, $event)"
              @remove="onRemove(row)"
              @cooled="refresh"
            />
          </ul>
          <ul v-else class="ui-rcards acc-cards">
            <AccountCard
              v-for="row in g.accounts"
              :key="row.key"
              :data-acc="row.key"
              :row="row"
              :mode="mode"
              :now="now"
              :washed="washed === row.key"
              :egress="egress"
              @open="detailKey = row.key"
              @cooled="refresh"
            />
          </ul>
        </section>

        <div v-if="others.length && !filtering" class="acc-others">
          <span class="acc-others__k">其它服务</span>
          <TxButton
            v-for="p in others"
            :key="p.id"
            class="acc-others__b"
            variant="ghost"
            size="sm"
            :aria-label="`添加 ${p.name} 账号`"
            :title="p.flow === 'device' ? '设备码授权' : '浏览器登录'"
            @click="openAdd(p.id)"
          ><ProviderMark :provider="p.mark" :size="18" />{{ p.name }}<Icon name="plus" :size="12" /></TxButton>
        </div>
      </div>
    </Plate>

    <!-- 390: the expanded content lives in a sheet with 40px actions -->
    <Sheet v-model="detailOpen" :title="detailRow ? (detailRow.provider?.name ?? detailRow.type) + ' 账号' : '账号'" height="92vh">
      <template v-if="detailRow">
        <div class="acc-sheet__id">
          <div class="acc-sheet__l1">
            <CountdownPie v-if="detailRow.state === 'cool' && detailRow.coolUntil" :until="detailRow.coolUntil" :total="detailRow.coolTotal" />
            <StatusMark v-else :state="detailRow.state" :label="detailRow.stateLabel" />
            <TxTag v-if="detailRow.plan" size="sm" variant="outline" :label="detailRow.plan" />
            <b v-if="detailRow.first" class="acc-first">首选</b>
          </div>
          <EmailIdentity :email="detailRow.email" :struck="detailRow.lapsed" />
          <p v-if="detailRow.leader" class="acc-sheet__leader" :class="{ sig: detailRow.attention }">{{ detailRow.leader }}</p>
          <div class="acc-sheet__route">
            <Switch :model-value="!detailRow.disabled" :label="detailRow.disabled ? '不参与路由' : '参与路由'" :loading="actions.busy[detailRow.key] === 'routing'" :disabled="Boolean(actions.busy[detailRow.key])" @update:model-value="actions.setRouting(detailRow, $event, groupOf(detailRow))" />
          </div>
        </div>
        <AccountDetail
          :row="detailRow"
          :share="quotaShare[detailRow.provider?.id ?? detailRow.type] ?? null"
          :mode="mode"
          :now="now"
          :busy="actions.busy[detailRow.key]"
          :presets="presets"
          :egress="egress"
          compact
          @reset="actions.reset(detailRow)"
          @proxy="actions.setProxy(detailRow, $event)"
          @remove="onRemove(detailRow)"
        />
      </template>
      <template v-if="detailRow" #footer>
        <TxButton variant="danger" :disabled="Boolean(actions.busy[detailRow.key])" @click="onRemove(detailRow)">移除</TxButton>
        <TxButton v-if="detailRow.lapsed" variant="primary" @click="openAdd(detailRow.provider?.id ?? null, detailRow)">重新授权</TxButton>
        <TxButton v-else-if="detailRow.provider?.resettable && (detailRow.credits?.count ?? 0) > 0" variant="primary" :disabled="Boolean(actions.busy[detailRow.key])" @click="actions.reset(detailRow)">用 1 次重置</TxButton>
      </template>
    </Sheet>

    <AddAccountSheet v-model="addOpen" :provider="addProvider" :reauth-email="reauthEmail" :verify="verifyAdded" :egress="egress" @done="onAdded" @egress="egressLive.refresh()" @imported="refresh()" />
  </div>
</template>

<style>
.acc-status .sig { color: var(--signal-ink); }
.acc-tools { margin: -4px 0 14px; }
.acc-tools .ui-search { width: 240px; }
.acc-meta-warn { color: var(--ink-2); }
.acc-meta-src { color: var(--ink-3); }

/* embedded: the host section owns the page head, so the rhythm tightens and the tools stop pulling up */
.ui-page.acc.is-embedded { gap: 12px; }
.ui-page.acc.is-embedded .acc-tools { margin: 0; }

/* the list measures itself: the md layout follows the plate's width, not the viewport */
.acc-list { container: accounts / inline-size; min-width: 0; }
.acc-cols, .acc-row {
  --acc-cols: 96px minmax(220px, 1fr) 40px 232px 232px 168px 84px 100px;
  display: grid; grid-template-columns: var(--acc-cols); column-gap: 12px; align-items: center; min-width: 0;
}
.acc-cols { height: var(--row-head); padding-left: 10px; border-bottom: 1px solid var(--rule); color: var(--ink-3); }
.acc-cols > span { white-space: nowrap; overflow: hidden; }
.acc-empty { padding: 8px 0 14px; }
.acc-group { margin-top: 14px; min-width: 0; }
.acc-group:first-of-type { margin-top: 4px; }
.acc-group__none.ui-sb { min-height: var(--row); border-bottom: 1px solid var(--rule); }
.acc-rows { list-style: none; margin: 0; padding: 0; }

.acc-row { min-height: var(--row-2l); padding: 3px 0 3px 10px; border-bottom: 1px solid var(--rule); cursor: default; transition: background-color var(--dur-2) var(--ease-swift); }
.acc-row:hover { background: color-mix(in srgb, var(--paper-2) 60%, transparent); }
.acc-row.is-open { background: var(--paper-2); }
.acc-row.is-attn { box-shadow: inset 2px 0 0 var(--signal); }
.acc-row.is-cool { background: var(--paper-2); }
.acc-row.is-cool, .acc-row.is-cool :is(.dim, .ui-em__domain, .ui-em__l2, .acc-q__rst, .ui-tm__k, .micro) { color: var(--ink-2); }
.acc-row.is-off :is(.ui-em__local, .acc-q__pct) { color: var(--ink-3); }
.acc-c { min-width: 0; display: flex; align-items: center; gap: 6px; white-space: nowrap; }
.acc-c--id { overflow: hidden; }
.acc-c--id .ui-em { width: 100%; }
.acc-first { font-weight: 600; color: var(--ink); }
.acc-l2-recent { display: none; }
.acc-l2-fail { margin-left: .6ch; }
.acc-c--w { overflow: hidden; }
.acc-c--wmsg { grid-column: span 2; font-size: var(--fs-xs); color: var(--ink-3); overflow: hidden; text-overflow: ellipsis; display: block; }
.acc-more { font-size: var(--fs-micro); color: var(--ink-3); flex: none; }
.acc-more.sig { color: var(--signal-ink); }
.acc-c--rs { font-size: var(--fs-xs); overflow: hidden; }
.acc-c--rs > span { overflow: hidden; text-overflow: ellipsis; }
.acc-rs-short { display: none; }
.acc-c--rc .dim, .acc-c--rs .dim { color: var(--ink-3); }
.acc-c--act { justify-content: flex-end; gap: 4px; }
.acc-row__leader { grid-column: 2 / -1; margin: -2px 0 4px; font-size: var(--fs-xs); color: var(--ink-2); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.acc-row__leader.sig { color: var(--signal-ink); }
.acc-row__x { grid-column: 1 / -1; margin: 4px 0 2px; padding: 12px 16px 10px 0; cursor: auto; }

/* md: the plate is narrower than the full row (≈1100 viewports) */
@container accounts (max-width: 1299px) {
  .acc-cols, .acc-row { --acc-cols: 88px minmax(200px, 1fr) 40px 196px 196px 48px 100px; column-gap: 10px; }
  .acc-more:not(.sig) { display: none; }
  .acc-c--rc, .acc-cols__rc { display: none; }
  .acc-row .acc-l2-recent { display: inline; }
  .acc-rs-full { display: none; }
  .acc-rs-short { display: inline; }
}

/* mobile cards */
.acc-list.is-mobile .acc-group { margin-top: 6px; }
.acc-cards .ui-rcard { padding: 10px 0; }
.acc-cards .ui-rcard.is-attn { padding-left: 10px; }

.acc-others { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 6px; margin-top: 14px; padding: 4px 0 12px; font-size: var(--fs-xs); }
.acc-others__k { color: var(--ink-3); margin-right: 6px; }
html:root .acc-others__b.tx-button { padding: 0 8px 0 4px; color: var(--ink); }
html:root .acc-others__b .tx-button__inner { gap: 6px; }
html:root .acc-others__b .ui-ico { color: var(--ink-3); }

.acc-sheet__id { display: grid; gap: 8px; margin-bottom: 18px; padding-bottom: 14px; border-bottom: 1px solid var(--rule); }
.acc-sheet__l1 { display: flex; align-items: center; gap: 8px; }
.acc-sheet__leader { margin: 0; font-size: var(--fs-xs); color: var(--ink-2); }
.acc-sheet__leader.sig { color: var(--signal-ink); }
.acc-sheet__route { display: flex; align-items: center; justify-content: space-between; gap: 10px; min-height: var(--tap); }

@media (max-width: 959px) {
  .acc-tools { margin-bottom: 10px; }
  .acc-tools .ui-search { width: auto; flex: 1 1 160px; order: 0; }
  .acc-tools > .push { margin-left: 0; order: 1; }
  .acc-tools > .ui-seg:not(.push) { order: 2; flex: 1 1 100%; }
  .acc-meta-src { display: none; }
}
</style>

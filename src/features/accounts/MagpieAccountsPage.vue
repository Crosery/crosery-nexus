<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, reactive, ref, shallowRef, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { TxButton } from '@talex-touch/tuffex/button'
import PageHead from '../../ui/shell/PageHead.vue'
import LiveMark from '../../ui/shell/LiveMark.vue'
import Plate from '../../ui/data/Plate.vue'
import ProviderMark from '../../ui/data/ProviderMark.vue'
import Icon from '../../ui/Icon.vue'
import { useLive, type DataState } from '../../ui/composables/useLive'
import { useNow } from '../../ui/composables/useNow'
import { fmtAgo } from '../../ui/fmt'
import { notify, showResetOutcome } from '../../ui/feedback/toast'
import { confirmSheet } from '../../ui/feedback/confirmSheet'
import { confirmReset } from '../../ui/feedback/resetConfirm'
import type { ResetOutcome } from '../../ui/feedback/resetOutcome'
import { errorReason } from '../../lib/errors'
import { maskPii, useMask } from '../../lib/privacy'
import { setNavCount } from '../../shell/badges'
import { usePaletteCommands } from '../../shell/palette'
import { accountsApi } from '../../api/accounts'
import { proxyApi } from '../../api/proxy'
import type { AccountsBackend, AccountsCatalog, AccountsData, EgressData, MagpieAccount, MagpieCodexReset, SignInView } from '../../types'
import type { CommandItem } from '../../ui/types'
import MagpieAccountRow from './MagpieAccountRow.vue'
import CatalogSheet from './CatalogSheet.vue'
import EgressSheet from './EgressSheet.vue'
import { catalogItems, findCatalogItem, findSignedIn, groupFacts, groupsOf, headSummary, quotaLine, type RowAction } from './magpieModel'

/**
 * 账号 in the magpie backend (ACCOUNTS-ALIGN §3): the console kernel's Magpie accounts grouped by service,
 * one hairline row each, Magpie's actions in ⋯, at most two allowance windows inline. 添加账号 opens Magpie's
 * subscription catalog and runs the real sign-in in the same sheet. Signed-in accounts do not serve the gateway
 * yet (one quiet line says so). `?add=1`, `?add=<agent>` and `#oauth` open the sheet.
 */
const props = withDefaults(defineProps<{ seed?: AccountsData | null }>(), { seed: null })
const emit = defineEmits<{ backend: [backend: AccountsBackend] }>()
const route = useRoute()
const router = useRouter()
const now = useNow()
const { on: masked } = useMask()

/* ── the list: the dispatcher's first answer is reused for the first tick ── */
const INTERVAL = 30_000
let seed: AccountsData | null = props.seed
const live = useLive<AccountsData>(async (signal) => {
  if (seed) {
    const first = seed
    seed = null
    return first
  }
  return accountsApi.list(signal)
}, { intervalMs: INTERVAL, isEmpty: () => false })
const data = computed(() => live.data.value ?? null)
watch(() => data.value?.backend, (backend) => { if (backend === 'cpa') emit('backend', 'cpa') })

/* ── account exits: the proxy pool's view (local reads on the server; no kernel, vendor or exit traffic) ── */
const egressLive = useLive<EgressData>((signal) => proxyApi.egress(signal), { intervalMs: INTERVAL, isEmpty: () => false })
const egress = computed(() => egressLive.data.value ?? null)
const egressOf = shallowRef<MagpieAccount | null>(null)
const egressOpen = ref(false)

const available = computed(() => data.value?.backend === 'magpie')
const groups = computed(() => groupsOf(data.value))
const head = computed(() => headSummary(data.value))
const total = computed(() => data.value?.counts?.accounts ?? 0)
const routingNote = computed(() => data.value?.routingNote || '已登录的账号暂不参与网关路由（下一轮接入）')
const plateState = computed<DataState>(() => live.state.value)
const asOfText = computed(() => {
  const at = data.value?.quotaAsOf
  return at ? `用量 ${fmtAgo(at, now.value)}读取` : ''
})
watch(() => data.value?.counts?.attention ?? 0, (n) => setNavCount('accounts', n || null), { immediate: true })
onBeforeUnmount(() => setNavCount('accounts', null))

/* ── catalog (read when the backend is magpie; again each time the sheet opens) ── */
const catalog = shallowRef<AccountsCatalog | null>(null)
const catalogError = shallowRef<unknown>(null)
const catalogLoading = ref(false)
async function loadCatalog() {
  if (catalogLoading.value) return
  catalogLoading.value = true
  try {
    catalog.value = await accountsApi.catalog()
    catalogError.value = null
  } catch (error) {
    catalogError.value = error
  } finally {
    catalogLoading.value = false
  }
}
const catalogState = computed<DataState>(() => {
  if (catalog.value) return catalogError.value ? 'stale' : 'ready'
  if (catalogError.value) return 'error'
  return 'loading'
})
watch(available, (on) => { if (on && !catalog.value) void loadCatalog() }, { immediate: true })

/* ── add sheet ── */
const addOpen = ref(false)
const target = shallowRef<{ agent: string; relogin: boolean; start: boolean } | null>(null)
function openAdd(agent: string | null = null, options: { relogin?: boolean; start?: boolean } = {}) {
  target.value = agent ? { agent, relogin: Boolean(options.relogin), start: options.start ?? true } : null
  addOpen.value = true
  void loadCatalog()
}

const washed = ref<string | null>(null)
let washTimer: ReturnType<typeof setTimeout> | null = null
async function onSignedIn(view: SignInView) {
  await live.refresh()
  void loadCatalog()
  const account = findSignedIn(data.value, view.agent, view.user)
  if (!account) {
    notify('◇ 已登录，但列表里还没看到这个账号', { tone: 'warn', description: '稍后会自动刷新' })
    return
  }
  // the sheet shows the outcome for 1.2 s, then the new row flashes
  if (washTimer) clearTimeout(washTimer)
  washTimer = setTimeout(() => {
    washed.value = account.id
    void nextTick(() => document.querySelector(`[data-acc="${CSS.escape(account.id)}"]`)?.scrollIntoView({ block: 'center', behavior: 'smooth' }))
    washTimer = setTimeout(() => { if (washed.value === account.id) washed.value = null }, 2000)
  }, 1300)
}
onBeforeUnmount(() => { if (washTimer) clearTimeout(washTimer) })

/* deep links: ?add=1 · ?add=<agent> · #oauth */
function consumeDeepLink() {
  const add = route.query.add
  if (add === undefined && route.hash !== '#oauth') return
  // a link only points at the service; starting a sign-in is the person's click
  openAdd(typeof add === 'string' && add !== '1' && add !== '' ? add : null, { start: false })
  const query = { ...route.query }
  delete query.add
  void router.replace({ query, hash: '' })
}
watch(() => [route.query.add, route.hash], consumeDeepLink, { immediate: true })

/* ── row actions ── */
const busy = reactive<Record<string, string>>({})
const DONE: Record<'first' | 'on' | 'off' | 'forget', string> = {
  first: '✓ 已设为首选',
  on: '✓ 已同时启用',
  off: '✓ 已停用',
  forget: '✓ 已移除 · 账号本身不受影响',
}
const whoOf = (account: MagpieAccount) => (masked.value ? maskPii(account.user) : account.user)

async function onAction(account: MagpieAccount, action: RowAction) {
  if (busy[account.id]) return
  if (action === 'relogin') return openAdd(account.agent, { relogin: true })
  if (action === 'egress') {
    egressOf.value = account
    egressOpen.value = true
    return
  }
  if (action === 'reset') return reset(account)
  if (action === 'forget') {
    const ok = await confirmSheet({
      title: '移除这个账号？',
      body: 'magpie 会忘记这个账号的登录，账号本身不受影响。',
      facts: [{ k: '账号', v: whoOf(account) }],
      confirmText: '移除',
      danger: true,
    })
    if (!ok) return
  }
  busy[account.id] = action
  try {
    await accountsApi.login(action, account.agent, account.id)
    notify(DONE[action])
    await live.refresh()
  } catch (error) {
    notify(`◆ ${errorReason(error)}`, { tone: 'bad' })
  } finally {
    delete busy[account.id]
  }
}

const RESET_OUTCOME: Record<MagpieCodexReset['outcome'], ResetOutcome> = {
  reset: 'ok', nothing_to_reset: 'no_window', no_credit: 'no_credit', already_redeemed: 'redeemed',
}
async function reset(account: MagpieAccount) {
  const count = account.quota?.resets?.count ?? 0
  const line = quotaLine(account, now.value)
  const ok = await confirmReset({
    account: whoOf(account),
    service: `ChatGPT${account.plan ? ` · ${account.plan}` : ''}`,
    creditIndex: 1,
    creditExpiresAt: account.quota?.resets?.until ?? null,
    creditsBefore: count,
    windows: line.kind === 'bars' ? [...line.bars, ...line.more].map((b) => b.short) : undefined,
    clearsCooldown: false,
  })
  if (!ok) return
  busy[account.id] = 'reset'
  try {
    const result = await accountsApi.codexReset(account.id)
    showResetOutcome(RESET_OUTCOME[result.outcome], { remaining: result.outcome === 'reset' ? Math.max(0, count - 1) : null })
    await live.refresh()
  } catch (error) {
    notify(`◆ ${errorReason(error)}`, { tone: 'bad' })
  } finally {
    delete busy[account.id]
  }
}

/* ── ⌘K ── */
usePaletteCommands((): CommandItem[] => {
  if (!available.value) return []
  return [
    { id: 'act:add-account', title: '添加账号…', section: 'ACT' as const, keywords: ['magpie', '登录', 'oauth'], run: () => openAdd() },
    ...catalogItems(catalog.value).filter((item) => !item.gated).map((item) => ({
      id: `act:add-account:${item.agent}`, title: `添加 ${item.shortName} 账号…`, section: 'ACT' as const, keywords: ['magpie', '登录', item.agent], run: () => openAdd(item.agent),
    })),
    ...groups.value.flatMap((group) => group.accounts.map((account) => ({
      id: `find:account:${account.id}`,
      title: whoOf(account),
      section: 'FIND' as const,
      hint: `${group.name} · ${account.status === 'relogin' ? '需重新登录' : account.plan ?? ''}`,
      keywords: [group.name, account.plan ?? ''],
      run: () => document.querySelector(`[data-acc="${CSS.escape(account.id)}"]`)?.scrollIntoView({ block: 'center', behavior: 'smooth' }),
    }))),
  ]
})

const addLabel = (agent: string, name: string, single: boolean) => {
  const item = findCatalogItem(catalog.value, agent)
  if (item?.gated) return null
  return single ? `换一个 ${name} 账号登录` : `添加另一个 ${name} 账号`
}
</script>

<template>
  <div class="ui-page mx">
    <PageHead title="账号">
      <template #status>
        <span class="mx-status num" :title="data?.revision ? `内核 ${data.revision}` : undefined">{{ head.text }}<template v-if="head.attention"> · <span class="sig">{{ head.attention }}</span></template></span>
      </template>
      <template #live><LiveMark :state="plateState" :last-at="live.lastAt.value" :interval-ms="INTERVAL" @retry="live.refresh" /></template>
      <template v-if="available" #actions>
        <TxButton variant="primary" @click="openAdd()"><Icon name="plus" :size="14" />添加账号</TxButton>
      </template>
    </PageHead>

    <Plate title="订阅登录" flush class="mx-plate" :state="plateState" :error="live.error.value" :stale-at="live.lastAt.value" :rows="6" :cols="['96px', '1fr', '320px', '32px']" @retry="live.refresh">
      <template v-if="asOfText" #meta><span class="mx-meta">{{ asOfText }} · 每个服务至多 5 分钟一次</span></template>

      <div class="mx-list">
        <p v-if="data && !available" class="mx-line">◇ {{ data.message || '当前内核不支持账号登录，需要重新构建内核' }}</p>
        <p v-else-if="data && !groups.length" class="mx-line">还没有账号<button type="button" class="ui-link mx-line__add" @click="openAdd()"><Icon name="plus" :size="12" />添加账号</button></p>

        <section v-for="group in groups" :key="group.agent" class="mx-group" :aria-labelledby="`mx-g-${group.agent}`">
          <header class="mx-gh">
            <ProviderMark :provider="group.agent" :size="18" />
            <h3 :id="`mx-g-${group.agent}`" class="mx-gh__n">{{ group.name }}</h3>
            <span class="mx-gh__f">{{ groupFacts(group) }}</span>
            <button
              v-if="addLabel(group.agent, group.name, group.single)"
              type="button"
              class="ui-link mx-gh__add"
              :aria-label="addLabel(group.agent, group.name, group.single) ?? undefined"
              @click="openAdd(group.agent)"
            ><Icon name="plus" :size="12" />{{ group.single ? '换一个' : '添加' }}</button>
          </header>
          <ul class="mx-rows">
            <MagpieAccountRow
              v-for="account in group.accounts"
              :key="account.id"
              :account="account"
              :now="now"
              :busy="busy[account.id]"
              :washed="washed === account.id"
              :egress="egress"
              @action="onAction(account, $event)"
            />
          </ul>
        </section>

        <p v-if="available" class="mx-note">{{ routingNote }}</p>
      </div>
    </Plate>

    <CatalogSheet
      v-model="addOpen"
      :catalog="catalog"
      :catalog-state="catalogState"
      :catalog-error="catalogError"
      :signing-in="data?.signingIn ?? []"
      :target="target"
      :egress="egress"
      @done="onSignedIn"
      @reload="loadCatalog"
      @egress="egressLive.refresh()"
    />
    <EgressSheet v-model="egressOpen" :account="egressOf" :egress="egress" :service-name="groups.find((g) => g.agent === egressOf?.agent)?.name" @changed="egressLive.refresh()" />
  </div>
</template>

<style>
.mx-status .sig { color: var(--signal-ink); }
.mx-meta { color: var(--ink-3); }
.mx-list { container: mxlist / inline-size; min-width: 0; padding-bottom: 4px; }
.mx-line { margin: 0; min-height: var(--row); display: flex; align-items: center; gap: 12px; font-size: var(--fs-sm); color: var(--ink-2); border-bottom: 1px solid var(--rule); }
.mx-line__add { display: inline-flex; align-items: center; gap: 3px; font-size: var(--fs-sm); color: var(--ink); border-bottom-color: var(--rule-2); }
.mx-group + .mx-group { margin-top: 18px; }
.mx-gh { display: flex; align-items: center; gap: 8px; min-height: 32px; border-bottom: 1px solid var(--rule-2); min-width: 0; }
.mx-gh__n { margin: 0; font-size: var(--fs-sm); font-weight: 650; white-space: nowrap; }
.mx-gh__f { font-size: var(--fs-xs); color: var(--ink-3); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; }
.mx-gh__add { margin-left: auto; display: inline-flex; align-items: center; gap: 3px; font-size: var(--fs-xs); flex: none; }
.mx-rows { list-style: none; margin: 0; padding: 0; }
.mx-note { margin: 14px 0 6px; font-size: var(--fs-xs); color: var(--ink-3); }
@media (pointer: coarse) { .mx-gh__add, .mx-line__add { min-height: var(--tap); padding: 0 4px; } }
</style>

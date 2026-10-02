<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, useTemplateRef, watch } from 'vue'
import { TxButton, TxIconButton } from '@talex-touch/tuffex/button'
import { TxTag } from '@talex-touch/tuffex/tag'
import Sheet from '../../ui/feedback/Sheet.vue'
import StateBlock from '../../ui/data/StateBlock.vue'
import ProviderMark from '../../ui/data/ProviderMark.vue'
import Icon from '../../ui/Icon.vue'
import { confirmSheet } from '../../ui/feedback/confirmSheet'
import { useNow } from '../../ui/composables/useNow'
import type { DataState } from '../../ui/composables/useLive'
import type { AccountsCatalog, EgressData, MagpieCatalogItem, SignInView } from '../../types'
import { catalogTiles, findCatalogItem, type CatalogTile } from './magpieModel'
import { proxyApi } from '../../api/proxy'
import { notify } from '../../ui/feedback/toast'
import { errorReason } from '../../lib/errors'
import { choiceName, magpieRef, serviceOf } from './egressModel'
import SigninEgress from './SigninEgress.vue'
import { isLive, type FlowState } from './signIn'
import { useSignIn } from './useSignIn'
import SignInFlow from './SignInFlow.vue'

/**
 * 添加账号 (magpie backend): Magpie's subscription catalog — 订阅 · 登录即可，无需密钥 — then the sign-in flow
 * in the same sheet. Tiles that run a vendor CLI / installer on the server stay visible, disabled, with the
 * reason. Closing the sheet (×, Esc, scrim, drag) while a sign-in is live asks first, then cancels it on the
 * server. `target` opens straight into one agent's flow (a group's 添加, a row's 重新登录, ⌘K) or, for a link
 * (?add=<agent>), only focuses its tile: a URL never starts a sign-in by itself.
 */
const props = withDefaults(defineProps<{
  catalog: AccountsCatalog | null
  catalogState: DataState
  catalogError?: unknown
  signingIn?: Array<{ id: string; agent: string; state: string }>
  /** `start`: run that agent's sign-in right away (a group's 添加, 重新登录, ⌘K); otherwise only point at its tile */
  target?: { agent: string; relogin: boolean; start: boolean } | null
  /** the proxy pool's view: 登录出口 / 账号出口 (null: no pool routes, nothing shown) */
  egress?: EgressData | null
}>(), { catalogError: null, signingIn: () => [], target: null, egress: null })
const open = defineModel<boolean>({ default: false })
const emit = defineEmits<{ done: [view: SignInView]; reload: []; egress: [] }>()

const now = useNow()
const flow = useSignIn({ onDone: (view) => onDone(view) })
const state = computed<FlowState | null>(() => flow.state.value)
const item = computed<MagpieCatalogItem | null>(() => findCatalogItem(props.catalog, state.value?.agent))
const tiles = computed(() => catalogTiles(props.catalog, props.signingIn))
const copy = computed<Record<string, string>>(() => props.catalog?.copy ?? {})
const unavailable = computed(() => props.catalog && (!props.catalog.available || props.catalog.backend !== 'magpie'))
const title = computed(() => (state.value && props.target?.relogin && props.target.agent === state.value.agent ? '重新登录' : '添加账号'))

/* ── 账号出口: picked while signing in, written to the new account when the sign-in is done (not for a re-login) ── */
const exitChoice = ref('')
const showExit = computed(() => {
  const s = state.value
  return Boolean(s && ['risk', 'site', 'starting', 'installing', 'waiting'].includes(s.step) && !(props.target?.relogin && props.target.agent === s.agent))
})
watch(() => state.value?.agent, () => { exitChoice.value = '' })
async function applyExit(view: SignInView) {
  const choice = exitChoice.value
  exitChoice.value = ''
  if (!choice || !view.user || !props.egress?.accountProxy.supported) return
  const ref = magpieRef(view.agent, view.user)
  try {
    const result = await proxyApi.assign(choice, [ref])
    const failed = result.results.find((item) => item.status === 'failed')
    if (failed) throw new Error(failed.error || '出口没设上')
    notify(`✓ 新账号的出口：${choiceName(props.egress, ref, choice)}`, { id: 'cx-acc-proxy' })
    emit('egress')
  } catch (error) {
    notify(`◇ 已登录，但出口没设上 · ${errorReason(error)}`, { tone: 'warn', description: '在这个账号的 ⋯ → 出口… 里再选', id: 'cx-acc-proxy' })
  }
}

/* ── open / close ── */
let closeTimer: ReturnType<typeof setTimeout> | null = null
let confirming = false

function startFor(entry: MagpieCatalogItem) {
  if (entry.gated) return
  const running = props.signingIn.find((s) => s.agent === entry.agent && (s.state === 'waiting' || s.state === 'installing'))
  if (running) void flow.attach(entry, running.id)
  else flow.open(entry)
}

function begin() {
  if (closeTimer) clearTimeout(closeTimer)
  closeTimer = null
  flow.abandon()
  const entry = findCatalogItem(props.catalog, props.target?.agent)
  if (entry && props.target?.start) startFor(entry)
  else void nextTick(() => focusTile(entry?.agent ?? null))
}

watch(open, (value) => {
  if (value) begin()
  else {
    if (closeTimer) clearTimeout(closeTimer)
    closeTimer = null
    flow.abandon()
  }
}, { immediate: true })
// the first catalog arrives after the sheet opened: start the target's flow, or focus a tile, then
watch(() => props.catalog, (_now, before) => {
  if (open.value && !state.value && !before) begin()
})
onBeforeUnmount(() => { if (closeTimer) clearTimeout(closeTimer) })

async function confirmCancel(): Promise<boolean> {
  if (!isLive(state.value)) return true
  if (confirming) return false
  confirming = true
  try {
    return await confirmSheet({
      title: '取消这次登录？',
      body: '登录页里还没完成的步骤会作废，之后可以重新开始。',
      confirmText: '取消登录',
      cancelText: '继续登录',
      danger: true,
    })
  } finally {
    confirming = false
  }
}

/** Every way of closing the sheet lands here; a live sign-in is confirmed, then canceled on the server. */
async function requestClose() {
  if (confirming) return
  if (!(await confirmCancel())) return
  flow.cancel()
  open.value = false
}
const sheetOpen = computed({
  get: () => open.value,
  set: (value: boolean) => { if (value) open.value = true; else void requestClose() },
})

async function back() {
  if (!(await confirmCancel())) return
  flow.abandon()
  void nextTick(focusFirstTile)
}

/** The flow's own 取消 is the decision itself (no second question); ×, Esc, the scrim and ‹ ask first. */
function cancelFlow() {
  flow.cancel()
  open.value = false
}

function onDone(view: SignInView) {
  void applyExit(view)
  emit('done', view)
  if (closeTimer) clearTimeout(closeTimer)
  // Magpie shows the outcome briefly, then the new row flashes in the list
  closeTimer = setTimeout(() => {
    closeTimer = null
    if (state.value?.step === 'done') open.value = false
  }, 1200)
}

/* ── catalog ── */
const grid = useTemplateRef<HTMLElement>('grid')
function focusFirstTile() {
  focusTile(null)
}
function focusTile(agent: string | null) {
  const wanted = agent ? grid.value?.querySelector<HTMLButtonElement>(`[data-agent="${CSS.escape(agent)}"]:not([disabled])`) : null
  ;(wanted ?? grid.value?.querySelector<HTMLButtonElement>('button:not([disabled])'))?.focus({ preventScroll: !wanted })
}
function pick(tile: CatalogTile) {
  if (tile.disabled) return
  startFor(tile.item)
}
function tileLabel(tile: CatalogTile): string {
  const parts = [`添加 ${tile.item.name} 账号`, tile.item.plans]
  if (tile.signedIn) parts.push(`已登录 ${tile.signedIn} 个`)
  if (tile.risk) parts.push('有封号风险')
  if (tile.hostOnly) parts.push('需在服务器本机的浏览器完成')
  if (tile.signingIn) parts.push('正在登录')
  if (tile.disabled) parts.push(tile.disabled)
  return parts.filter(Boolean).join('，')
}
/* arrow keys move through the tiles; Enter / Space are the buttons' own */
function onGridKey(event: KeyboardEvent) {
  if (!['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
  const items = [...(grid.value?.querySelectorAll<HTMLButtonElement>('button:not([disabled])') ?? [])]
  const i = items.indexOf(document.activeElement as HTMLButtonElement)
  if (i === -1) return
  const cols = getComputedStyle(grid.value!).gridTemplateColumns.split(' ').length || 1
  const step = event.key === 'ArrowDown' ? cols : event.key === 'ArrowUp' ? -cols : event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0
  const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : Math.max(0, Math.min(items.length - 1, i + step))
  items[next]?.focus()
  event.preventDefault()
}
</script>

<template>
  <Sheet v-model="sheetOpen" :title="title" height="auto">
    <template v-if="state">
      <div class="cs-flowhead">
        <TxIconButton v-if="state.step !== 'done'" class="cs-back" size="sm" label="返回服务列表" title="返回服务列表" @click="back"><Icon name="chev-left" /></TxIconButton>
        <ProviderMark :provider="state.agent" :size="20" />
        <span class="cs-flowhead__n">{{ item?.name ?? state.name }}</span>
        <span v-if="item?.plans" class="cs-flowhead__p">{{ item.plans }}</span>
      </div>
      <SignInFlow
        :state="state"
        :item="item"
        :copy="copy"
        :now="now"
        @confirm-risk="flow.confirmRisk()"
        @pick-site="flow.pickSite($event)"
        @back="back"
        @cancel="cancelFlow"
        @retry="flow.retry()"
        @callback="flow.submitCallback($event)"
      />
      <SigninEgress v-if="showExit" v-model="exitChoice" class="cs-exit" :egress="egress" :service="serviceOf(state.agent)" :agent="state.agent" />
    </template>

    <template v-else>
      <StateBlock v-if="catalogState === 'loading' || catalogState === 'error'" :state="catalogState" :error="catalogError" :rows="6" :cols="['1fr', '1fr']" @retry="emit('reload')" />
      <p v-else-if="unavailable" class="cs-line">◇ {{ catalog?.message || '当前内核不支持账号登录，需要重新构建内核' }}</p>
      <section v-else class="cs-sec" aria-labelledby="cs-subs">
        <h3 id="cs-subs" class="cs-sec__t">{{ copy.section || '订阅' }}<span class="cs-sec__hint">{{ copy.sectionHint || '登录即可，无需密钥' }}</span></h3>
        <p v-if="!tiles.length" class="cs-line">— 这个内核没有可登录的服务</p>
        <ul v-else ref="grid" class="cs-grid" @keydown="onGridKey">
          <li v-for="tile in tiles" :key="tile.item.agent">
            <TxButton
              class="cs-tile"
              :class="{ 'has-tags': tile.risk || tile.hostOnly }"
              :data-agent="tile.item.agent"
              variant="ghost"
              block
              :disabled="Boolean(tile.disabled)"
              :aria-label="tileLabel(tile)"
              :title="tile.disabled ? `${tile.item.name}：该服务要在服务器上运行厂商 CLI 或安装器，已关闭` : `${tile.item.name} 订阅 · ${tile.item.plans}`"
              @click="pick(tile)"
            >
              <ProviderMark :provider="tile.item.agent" :size="22" />
              <span class="cs-tile__n">{{ tile.item.shortName }}<span v-if="tile.signedIn" class="cs-tile__count num" aria-hidden="true">● {{ tile.signedIn }}</span><span v-if="tile.signingIn" class="cs-tile__live" aria-hidden="true">登录中</span></span>
              <span class="cs-tile__p" aria-hidden="true">{{ tile.note }}</span>
              <span v-if="tile.risk || tile.hostOnly" class="cs-tile__tags" aria-hidden="true">
                <TxTag v-if="tile.risk" size="sm" variant="outline" label="有封号风险" />
                <TxTag v-if="tile.hostOnly" class="cs-tile__host" size="sm" variant="plain" label="仅限本机" />
              </span>
            </TxButton>
          </li>
        </ul>
        <p v-if="catalog?.stale" class="cs-foot">服务目录来自 Magpie {{ catalog.catalogRevision }}，内核是 {{ catalog.revision }}</p>
      </section>
    </template>
  </Sheet>
</template>

<style>
.cs-flowhead { display: flex; align-items: center; gap: 8px; min-height: 32px; margin: -4px 0 14px; min-width: 0; }
.cs-back { margin-left: -6px; flex: none; }
.cs-exit { margin-top: 16px; }
.cs-flowhead__n { font-size: var(--fs-sm); font-weight: 600; color: var(--ink); white-space: nowrap; }
.cs-flowhead__p { font-family: var(--font-mono); font-size: var(--fs-xs); color: var(--ink-3); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; }
.cs-line { margin: 0; padding: 6px 0; font-size: var(--fs-sm); color: var(--ink-2); }
.cs-sec { display: grid; gap: 10px; }
.cs-sec__t { margin: 0; display: flex; align-items: baseline; gap: 10px; font-size: var(--fs-sm); font-weight: 600; color: var(--ink); }
.cs-sec__hint { font-size: var(--fs-xs); font-weight: 400; color: var(--ink-3); }
.cs-grid { list-style: none; margin: 0; padding: 0; display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); column-gap: 16px; border-top: 1px solid var(--rule); }
.cs-grid > li { min-width: 0; border-bottom: 1px solid var(--rule); }
/* a tile: a ghost TxButton laid out as mark | name + plans | tags, left-aligned, no box of its own */
html:root .cs-tile.tx-button {
  height: auto; min-height: 52px; padding: 7px 6px; justify-content: flex-start; text-align: left; font-weight: 400; color: var(--ink);
  border: 0; border-radius: var(--r-1);
}
html:root .cs-tile .tx-button__inner {
  flex: 1 1 auto; min-width: 0; display: grid; grid-template-columns: 22px minmax(0, 1fr) auto;
  grid-template-areas: "mark name tags" "mark note tags"; column-gap: 10px; row-gap: 1px; align-items: center; justify-items: start;
}
html:root .cs-tile .ui-pm { grid-area: mark; }
html:root .cs-tile.tx-button:focus-visible { outline: 2px solid var(--signal); outline-offset: -2px; }
html:root .cs-tile.tx-button.disabled { border-style: none; background: transparent; }
html:root .cs-tile.tx-button.disabled .ui-pm { opacity: .5; }
.cs-tile__n { grid-area: name; display: flex; align-items: baseline; gap: 8px; max-width: 100%; min-width: 0; font-size: var(--fs-row); font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.cs-tile__count { font-size: var(--fs-xs); font-weight: 400; color: var(--ink-2); }
.cs-tile__live { font-size: var(--fs-xs); font-weight: 400; color: var(--signal-ink); }
.cs-tile__p { grid-area: note; max-width: 100%; font-family: var(--font-mono); font-size: var(--fs-xs); color: var(--ink-3); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.cs-tile__tags { grid-area: tags; display: inline-flex; flex-direction: column; align-items: flex-end; gap: 3px; }
html:root .cs-tile.disabled :is(.cs-tile__n, .cs-tile__p) { color: var(--ink-3); }
/* wide tiles say 仅限本机 in the plans line; the narrow ones swap that line for the tags */
@media (min-width: 600px) { html:root .cs-tile .cs-tile__host { display: none; } }
.cs-foot { margin: 6px 0 0; font-size: var(--fs-xs); color: var(--ink-3); }
@media (max-width: 599px) {
  .cs-grid { column-gap: 12px; }
  html:root .cs-tile .tx-button__inner { grid-template-columns: 20px minmax(0, 1fr); grid-template-areas: "mark name" "mark note"; column-gap: 8px; }
  html:root .cs-tile.has-tags .tx-button__inner { grid-template-areas: "mark name" "mark tags"; }
  html:root .cs-tile.has-tags .cs-tile__p { display: none; }
  .cs-tile__tags { flex-direction: row; align-items: center; }
  html:root .cs-tile .ui-pm { --pm: 20px !important; }
}
</style>

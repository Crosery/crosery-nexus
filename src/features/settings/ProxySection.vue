<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import { TxButton, TxIconButton } from '@talex-touch/tuffex/button'
import { TxDropdownItem, TxDropdownMenu } from '@talex-touch/tuffex/dropdown-menu'
import { TxTag } from '@talex-touch/tuffex/tag'
import Icon from '../../ui/Icon.vue'
import Plate from '../../ui/data/Plate.vue'
import GroupedRowTable from '../../ui/data/GroupedRowTable.vue'
import StatusMark from '../../ui/data/StatusMark.vue'
import StateBlock from '../../ui/data/StateBlock.vue'
import Pager from '../../ui/data/Pager.vue'
import SearchField from '../../ui/form/SearchField.vue'
import FilterField from '../../ui/form/FilterField.vue'
import { CALM_MENU } from '../../ui/form/anchor'
import { useLive } from '../../ui/composables/useLive'
import { useNow } from '../../ui/composables/useNow'
import { confirmSheet } from '../../ui/feedback/confirmSheet'
import { notify } from '../../ui/feedback/toast'
import { fmtAgo, fmtDuration } from '../../ui/fmt'
import { errorMessage } from '../../lib/errors'
import { api } from '../../api'
import type { RowColumn } from '../../ui/types'
import type { ProxyEntryView, ProxyPoolData, ProxySubscriptionView } from '../../types'
import ProxyRowMenu from '../proxy/ProxyRowMenu.vue'
import ProxyAddSheet from '../proxy/ProxyAddSheet.vue'
import ProxyMigrateSheet from '../proxy/ProxyMigrateSheet.vue'
import ProxyAssignSheet from '../proxy/ProxyAssignSheet.vue'
import ProxyEditSheet from '../proxy/ProxyEditSheet.vue'
import {
  CHECK_WORD, defaultLine, firstRunNote, groupRows, indexValue, kernelLine, maskIp, matchesQuery, migrationBanner, portRange,
  PROXY_SERVICES, protocolLabel, quotaLine, summaryLine, tagOptions, toRows, type ProxyRow, type ProxyRowAction,
} from '../proxy/proxyModel'

/**
 * 代理 (#proxy, PROXY-SPEC §12): the proxy pool — every exit the accounts can use, where it comes out, and whether
 * Claude / OpenAI / Google answer through it. One flat plate: a status line (kernel · ports · default exit), the
 * migration banner when accounts use exits the pool does not know yet, the exits table, the subscriptions.
 * The page only reads local state (30 s); checks run in 「代理巡检」 or on an explicit 立即检测 / 检测在用.
 */
const emit = defineEmits<{ index: [value: { value: string; hot: boolean; status: string } | null] }>()

const live = useLive<ProxyPoolData>((signal) => api.proxies.pool(signal), { intervalMs: 30_000 })
const data = computed(() => live.data.value)
const now = useNow()

watch(data, (d) => {
  if (!d) return emit('index', null)
  const index = indexValue(d)
  const pending = d.migration.pending?.exits ?? 0
  emit('index', { ...index, status: d.summary.entries ? `代理 ${d.summary.entries} 出口` : pending ? `代理 待导入 ${pending}` : '' })
}, { immediate: true })

const kernel = computed(() => (data.value ? kernelLine(data.value.kernel, data.value) : null))
const banner = computed(() => (data.value ? migrationBanner(data.value.migration) : null))
const firstRun = computed(() => (data.value ? firstRunNote(data.value.migration, now.value) : null))
const defaultName = computed(() => (data.value ? defaultLine(data.value) : null))
const canDefault = computed(() => Boolean(data.value) && data.value?.default.mode !== 'unsupported')

/* ── table ── */
const query = ref('')
const tag = ref('')
const page = ref(1)
const PAGE = 50
const allRows = computed(() => toRows(data.value?.entries ?? [], data.value?.subscriptions ?? []))
const tags = computed(() => tagOptions(data.value?.entries ?? []))
const filtered = computed(() => allRows.value.filter(row => matchesQuery(row, query.value) && (!tag.value || row.tags.includes(tag.value))))
watch([query, tag], () => { page.value = 1 })
const groups = computed(() => groupRows(filtered.value.slice((page.value - 1) * PAGE, page.value * PAGE), data.value?.subscriptions ?? []))

const columns: RowColumn<ProxyRow>[] = [
  { key: 'name', title: '名称', card: 'primary' },
  { key: 'protocol', title: '类型', width: 132, card: 'line2' },
  { key: 'exit', title: '出口', width: 156, card: 'line2' },
  ...PROXY_SERVICES.map(service => ({ key: service.key, title: service.label, width: 92, card: 'line3' as const, cardLabel: service.label })),
  { key: 'used', title: '在用', width: 52, align: 'right', card: 'meta' },
  { key: 'checked', title: '检查于', width: 76, align: 'right', card: 'hidden' },
  { key: 'act', title: '', width: 40, align: 'right', card: 'actions' },
]
const rowTone = (row: ProxyRow) => (!row.enabled ? 'off' : row.validity === 'invalid' ? 'attn' : null)

/* ── sheets ── */
const addOpen = ref(false)
const migrateOpen = ref(false)
const assignOpen = ref(false)
const assignOnlyUsing = ref(false)
const editOpen = ref(false)
const target = ref<ProxyEntryView | null>(null)

function refresh() {
  void live.refresh()
}

function openAssign(row: ProxyEntryView, onlyUsing: boolean) {
  target.value = row
  assignOnlyUsing.value = onlyUsing
  assignOpen.value = true
}

/* ── actions ── */
const busy = ref<string | null>(null)

function failed(what: string, error: unknown) {
  const retry = (error as { retryAfterSec?: number | null }).retryAfterSec
  const reason = errorMessage(error) || '请求失败'
  notify(`◆ ${what} · ${reason}${retry ? ` · ${fmtDuration(retry * 1000)} 后再试` : ''}`, { tone: retry ? 'warn' : 'bad', id: 'cx-proxy' })
}

function testSummary(health: ProxyEntryView['health']): string {
  if (!health) return ''
  const exit = health.exit
  const parts = [exit?.country ? `出口 ${exit.country}` : exit?.state && exit.state !== 'ok' ? `出口 ✗ ${CHECK_WORD[exit.state] ?? exit.state}` : '出口 —']
  for (const service of PROXY_SERVICES) {
    const cell = health.services?.[service.key]
    if (!cell) continue
    parts.push(`${service.label} ${cell.state === 'ok' || cell.state === 'auth-expected' ? '✓' : `✗ ${CHECK_WORD[cell.state] ?? cell.state}`}`)
  }
  return parts.join(' · ')
}

async function testOne(row: ProxyEntryView) {
  if (busy.value) return
  busy.value = `test:${row.id}`
  notify(`— 正在检测 ${row.name}`, { tone: 'note', id: 'cx-proxy' })
  try {
    const result = await api.proxies.test(row.id) as { health: ProxyEntryView['health']; cached: boolean; skipped: string | null }
    if (result.skipped) notify(`— 未检测 · ${result.skipped}`, { tone: 'note', id: 'cx-proxy' })
    else notify(`${result.cached ? '◇ 1 分钟内刚检测过' : '✓ 检测完成'} · ${row.name}`, { tone: 'ok', description: testSummary(result.health), id: 'cx-proxy' })
    refresh()
  } catch (error) {
    failed('检测失败', error)
  } finally {
    busy.value = null
  }
}

async function testInUse() {
  if (busy.value) return
  const n = data.value?.summary.inUse ?? 0
  busy.value = 'test-in-use'
  try {
    await api.proxies.testInUse()
    notify(`✓ 已开始检测在用的 ${n} 个出口`, { tone: 'ok', description: '每个出口 8 个请求 · 结果写进表格', id: 'cx-proxy' })
    setTimeout(refresh, 4000)
  } catch (error) {
    failed('没有开始', error)
  } finally {
    busy.value = null
  }
}

async function askDefault(row: ProxyEntryView) {
  // how many accounts follow the global proxy (read on this explicit action only)
  const accounts = await api.proxies.accounts().catch(() => null)
  const inheriting = accounts ? accounts.accounts.filter(item => item.kind === 'credential' && item.mode === 'inherit').length : null
  const ok = await confirmSheet({
    title: '设为默认出口？',
    body: '改的是 CPA 全局代理：所有「继承全局」的账号都会改走这个出口；单独设置过出口的账号不受影响。',
    facts: [
      { k: '新默认', v: row.name },
      { k: '当前', v: defaultName.value ?? '未设置' },
      { k: '受影响', v: inheriting === null ? '继承全局的账号' : `${inheriting} 个继承全局的账号` },
    ],
    consequence: '可随时改回 · 原值已记下',
    confirmText: '设为默认',
  })
  if (!ok) return
  busy.value = `default:${row.id}`
  try {
    const result = await api.proxies.setDefault(row.id)
    notify(`✓ 默认出口已改为 ${row.name}`, { tone: 'ok', description: `${result.inheriting} 个继承全局的账号改走这个出口`, id: 'cx-proxy' })
    refresh()
  } catch (error) {
    failed('没有设置', error)
  } finally {
    busy.value = null
  }
}
async function toggle(row: ProxyEntryView) {
  const next = !row.enabled
  if (!next) {
    const ok = await confirmSheet({
      title: `停用 ${row.name}？`,
      facts: [{ k: '在用', v: '0 个账号' }],
      consequence: row.kind === 'mihomo' ? '本机端口随之关闭 · 可随时启用' : '不能再分配给账号 · 可随时启用',
      confirmText: '停用',
    })
    if (!ok) return
  }
  try {
    await api.proxies.update(row.id, { enabled: next })
    notify(next ? `✓ 已启用 ${row.name}` : `✓ 已停用 ${row.name}`, { tone: 'ok', id: 'cx-proxy' })
    refresh()
  } catch (error) {
    failed(next ? '没有启用' : '没有停用', error)
  }
}

async function remove(row: ProxyEntryView) {
  const ok = await confirmSheet({
    title: `删除 ${row.name}？`,
    facts: [
      { k: '类型', v: protocolLabel(row.protocol) },
      { k: '地址', v: row.display },
    ],
    consequence: row.source === 'migrated' || row.source === 'subscription' ? '删除后扫描和订阅刷新不会再把它加回来' : '从代理池删除，账号设置不受影响',
    confirmText: '删除',
    danger: true,
  })
  if (!ok) return
  try {
    await api.proxies.remove(row.id)
    notify(`✓ 已删除 ${row.name}`, { tone: 'ok', id: 'cx-proxy' })
    refresh()
  } catch (error) {
    failed('没有删除', error)
  }
}

function onRow(row: ProxyRow, action: ProxyRowAction) {
  if (action === 'test') return void testOne(row)
  if (action === 'assign') return openAssign(row, false)
  if (action === 'default') return void askDefault(row)
  if (action === 'toggle') return void toggle(row)
  if (action === 'remove') return void remove(row)
  target.value = row
  editOpen.value = true
}

/* ── pool menu ── */
const menuOpen = ref(false)
const menuTrigger = ref<{ $el: HTMLElement } | null>(null)
type PoolAction = 'migrate' | 'export' | 'start' | 'restart' | 'stop'

async function runMenu(action: PoolAction) {
  menuOpen.value = false
  await nextTick()
  menuTrigger.value?.$el?.focus()
  if (action === 'migrate') migrateOpen.value = true
  else if (action === 'export') void exportMasked()
  else void kernelAction(action)
}

async function exportMasked() {
  try {
    const file = await api.proxies.exportMasked()
    const blob = new Blob([`${JSON.stringify(file, null, 2)}\n`], { type: 'application/json' })
    const link = document.createElement('a')
    link.href = URL.createObjectURL(blob)
    link.download = `crosery-proxy-pool-${new Date().toISOString().slice(0, 10)}.json`
    link.click()
    setTimeout(() => URL.revokeObjectURL(link.href), 1000)
    notify('✓ 已导出（脱敏）', { tone: 'ok', description: '密码已替换成 *** · 含密码的迁移文件用 cradmin proxy export --with-secrets', id: 'cx-proxy' })
  } catch (error) {
    failed('导出失败', error)
  }
}

const KERNEL_VERB = { start: '启动', restart: '重启', stop: '停止' } as const
async function kernelAction(action: 'start' | 'restart' | 'stop') {
  const d = data.value
  if (!d) return
  const linked = d.entries.filter(entry => entry.kind === 'mihomo' && entry.usedBy.total > 0).reduce((sum, entry) => sum + entry.usedBy.total, 0)
  const ok = await confirmSheet({
    title: `${KERNEL_VERB[action]} mihomo 内核？`,
    facts: [
      { k: '加密节点', v: `${d.summary.mihomo} 个` },
      { k: '在用账号', v: `${linked} 个` },
    ],
    consequence: action === 'start' ? '按代理池启动本机端口' : action === 'stop' ? `本机端口全部关闭 · ${linked} 个账号会连不上，直到再次启动` : '端口短暂中断后恢复',
    confirmText: KERNEL_VERB[action],
    danger: action === 'stop' && linked > 0,
  })
  if (!ok) return
  busy.value = 'kernel'
  try {
    await api.proxies.kernel(action)
    notify(`✓ 内核已${KERNEL_VERB[action]}`, { tone: 'ok', id: 'cx-proxy' })
  } catch (error) {
    failed(`没有${KERNEL_VERB[action]}`, error)
  } finally {
    busy.value = null
    refresh()
  }
}

/* ── subscriptions ── */
async function refreshSub(sub: ProxySubscriptionView) {
  if (busy.value) return
  busy.value = `sub:${sub.id}`
  try {
    const result = await api.proxies.refreshSubscription(sub.id)
    notify(`✓ ${sub.name} 已更新`, { tone: 'ok', description: `${result.nodeCount} 个节点 · 新增 ${result.added} · 更新 ${result.updated}${result.removed ? ` · 移除 ${result.removed}` : ''}${result.stale ? ` · ${result.stale} 个在用的保留` : ''}`, id: 'cx-proxy' })
    refresh()
  } catch (error) {
    failed('没有更新', error)
  } finally {
    busy.value = null
  }
}

async function removeSub(sub: ProxySubscriptionView) {
  const used = (data.value?.entries ?? []).filter(entry => entry.subscriptionId === sub.id && entry.usedBy.total > 0).length
  const ok = await confirmSheet({
    title: `删除订阅 ${sub.name}？`,
    facts: [
      { k: '节点', v: `${sub.nodeCount} 个` },
      { k: '在用', v: `${used} 个` },
    ],
    consequence: used ? `没在用的节点一并删除 · 在用的 ${used} 个保留为手动出口` : '订阅和它的节点一并删除',
    confirmText: '删除',
    danger: true,
  })
  if (!ok) return
  try {
    const result = await api.proxies.removeSubscription(sub.id)
    notify(`✓ 已删除订阅 · 删除 ${result.removed} 个节点${result.kept ? ` · 保留 ${result.kept} 个` : ''}`, { tone: 'ok', id: 'cx-proxy' })
    refresh()
  } catch (error) {
    failed('没有删除', error)
  }
}

function subLine(sub: ProxySubscriptionView): string {
  const parts = [`${sub.nodeCount} 个节点`, `每 ${sub.intervalH} 小时`]
  if (sub.lastFetchAt) parts.push(`${fmtAgo(sub.lastFetchAt, now.value)}更新`)
  const quota = quotaLine(sub.info)
  if (quota) parts.push(quota)
  return parts.join(' · ')
}
</script>

<template>
  <Plate
    id="proxy"
    title="代理"
    class="set-sec px-sec"
    :state="live.state.value"
    :error="live.error.value"
    :stale-at="live.lastAt.value"
    :rows="5"
    flush
    @retry="live.refresh"
  >
    <template #meta>
      <span v-if="data" class="num">{{ summaryLine(data) }}</span>
    </template>
    <template #actions>
      <TxButton v-if="data && data.summary.inUse" size="sm" variant="ghost" :loading="busy === 'test-in-use'" :disabled="Boolean(busy)" @click="testInUse">检测在用</TxButton>
      <TxButton size="sm" variant="primary" :disabled="!data || Boolean(data.readOnly)" @click="addOpen = true">添加代理</TxButton>
      <TxDropdownMenu v-model="menuOpen" placement="bottom-end" :min-width="176" :offset="4" v-bind="CALM_MENU">
        <template #trigger>
          <TxIconButton ref="menuTrigger" class="px-menu__trigger" size="sm" label="代理池 · 更多操作" aria-haspopup="menu" :aria-expanded="menuOpen" :disabled="!data">
            <Icon name="more" />
          </TxIconButton>
        </template>
        <TxDropdownItem :disabled="Boolean(data?.readOnly)" @select="runMenu('migrate')">从现有账号导入…</TxDropdownItem>
        <TxDropdownItem @select="runMenu('export')">导出（脱敏）</TxDropdownItem>
        <template v-if="data && data.kernel.state !== 'unavailable'">
          <div class="px-menu__rule" role="separator" />
          <TxDropdownItem v-if="data.kernel.state === 'stopped' || data.kernel.state === 'idle'" :disabled="!data.summary.mihomo" @select="runMenu('start')">启动内核</TxDropdownItem>
          <template v-else>
            <TxDropdownItem @select="runMenu('restart')">重启内核</TxDropdownItem>
            <TxDropdownItem danger @select="runMenu('stop')">停止内核</TxDropdownItem>
          </template>
        </template>
      </TxDropdownMenu>
    </template>

    <template v-if="data && kernel">
      <div class="px-status">
        <span class="px-status__seg">
          <span class="px-status__k">内核</span>
          <StatusMark :state="kernel.state" :label="kernel.label" />
          <span v-if="kernel.detail" class="px-status__d">{{ kernel.detail }}</span>
          <button v-if="kernel.action" type="button" class="ui-link" :disabled="busy === 'kernel'" @click="kernelAction(kernel.action)">{{ kernel.action === 'start' ? '启动内核' : '重启内核' }}</button>
        </span>
        <span v-if="data.summary.mihomo" class="px-status__seg"><span class="px-status__k">本机端口</span><span class="num">{{ portRange(data.ports) }}</span></span>
        <span v-if="defaultName" class="px-status__seg"><span class="px-status__k">默认出口</span><span class="px-status__v ellip">{{ defaultName }}</span></span>
      </div>
      <p v-if="!data.cpaSameHost" class="px-note">CPA 不在本机：本机端口类出口不能分配给 CPA 账号</p>
      <p v-if="data.readOnly" class="px-note is-warn">◆ {{ data.readOnly }} · 代理池只读</p>

      <div v-if="banner" class="px-banner" role="status">
        <span class="px-banner__t"><span class="px-banner__mk" aria-hidden="true">◇</span>{{ banner }}</span>
        <TxButton size="sm" variant="ghost" @click="migrateOpen = true">预览</TxButton>
      </div>
      <p v-else-if="firstRun" class="px-note">{{ firstRun }}</p>

      <template v-if="allRows.length">
        <div v-if="allRows.length > 6 || tags.length" class="px-tools">
          <SearchField v-model="query" class="px-tools__q" placeholder="名称、地址、国家" label="筛选出口" :slash="false" />
          <FilterField v-if="tags.length" v-model="tag" label="标签" :options="tags" />
          <span v-if="query || tag" class="px-tools__n num">{{ filtered.length }} / {{ allRows.length }}</span>
        </div>
        <GroupedRowTable
          :groups="groups"
          :columns="columns"
          row-key="id"
          density="list"
          :row-tone="rowTone"
          empty-text="没有匹配的出口"
          class="px-table"
        >
          <template #group-head="{ group }">
            <h3 class="px-gh">{{ group.head }} <span class="num">{{ group.rows.length }}</span></h3>
          </template>
          <template #cell-name="{ row }">
            <span class="px-name">
              <span class="px-name__t ellip" :title="row.display">{{ row.name }}</span>
              <span v-if="row.twin" class="px-name__twin mono">{{ row.twin }}</span>
              <TxTag v-for="flag in row.flags" :key="flag.label" size="sm" :variant="flag.tone" :label="flag.label" />
              <span v-if="row.shownTags.length" class="px-name__tags ellip">{{ row.shownTags.join(' · ') }}</span>
            </span>
          </template>
          <template #cell-protocol="{ row }">
            <span class="px-proto">{{ protocolLabel(row.protocol) }}<span v-if="row.portLabel" class="px-proto__port num" :title="`本机端口 ${row.port}`">{{ row.portLabel }}</span></span>
          </template>
          <template #cell-exit="{ row }">
            <span v-if="row.exit.ip" class="px-exit num">
              <span class="pii"><span class="pii-t">{{ row.exit.ip }}</span><span class="pii-m">{{ maskIp(row.exit.ip) }}</span></span>
              <b v-if="row.exit.country" class="px-exit__cc">{{ row.exit.country }}</b>
            </span>
            <span v-else-if="row.exit.failure" class="px-cell is-bad"><span aria-hidden="true">✗</span> {{ row.exit.failure }}</span>
            <span v-else class="px-cell is-none" title="还没有检测">—</span>
          </template>
          <template v-for="service in PROXY_SERVICES" :key="service.key" #[`cell-${service.key}`]="{ row }">
            <span class="px-cell" :class="row.cells[service.key].ok === true ? 'is-ok' : row.cells[service.key].ok === false ? 'is-bad' : 'is-none'" :title="row.cells[service.key].title">
              <template v-if="row.cells[service.key].ok === null">—</template>
              <template v-else><span aria-hidden="true">{{ row.cells[service.key].ok ? '✓' : '✗' }}</span><span class="sr-only">{{ row.cells[service.key].ok ? '可访问' : '不可访问' }}</span> {{ row.cells[service.key].text }}</template>
            </span>
          </template>
          <template #cell-used="{ row }">
            <span class="px-used__k" aria-hidden="true">在用</span>
            <button v-if="row.usedBy.total" type="button" class="ui-link num px-used" :title="row.usedTitle" :aria-label="`${row.usedBy.total} 个账号在用 ${row.name}`" @click="openAssign(row, true)">{{ row.usedBy.total }}</button>
            <span v-else class="num px-dim">0</span>
          </template>
          <template #cell-checked="{ row }">
            <span class="num px-dim">{{ row.checkedAt ? fmtAgo(row.checkedAt, now) : '—' }}</span>
          </template>
          <template #cell-act="{ row }">
            <ProxyRowMenu
              :name="row.name"
              :enabled="row.enabled"
              :in-use="row.usedBy.total"
              :assignable="row.assignable"
              :assign-reason="row.unassignableReason"
              :can-default="canDefault"
              :is-default="data.default.entryId === row.id"
              @action="(action) => onRow(row, action)"
            />
          </template>
        </GroupedRowTable>
        <Pager v-model:page="page" :total="filtered.length" :page-size="PAGE" />
      </template>
      <StateBlock
        v-else
        state="empty"
        :empty-text="banner ? '代理池还是空的 · 先预览上面的账号出口' : '代理池还是空的 · 粘贴 Clash 配置、订阅链接或代理地址即可添加'"
        action-label="添加代理"
        @action="addOpen = true"
      />

      <section v-if="data.subscriptions.length" class="px-subs" aria-label="订阅">
        <h3 class="px-gh">订阅 <span class="num">{{ data.subscriptions.length }}</span></h3>
        <div v-for="sub in data.subscriptions" :key="sub.id" class="px-sub">
          <span class="px-sub__n ellip">{{ sub.name }}</span>
          <span class="px-sub__u mono ellip" :title="sub.maskedUrl">{{ sub.maskedUrl }}</span>
          <span class="px-sub__l num">{{ subLine(sub) }}</span>
          <span v-if="sub.error" class="px-sub__e">◆ {{ sub.error }}{{ sub.failures > 1 ? ` · 连续 ${sub.failures} 次` : '' }}</span>
          <span class="px-sub__a">
            <TxButton size="sm" variant="ghost" :loading="busy === `sub:${sub.id}`" :disabled="Boolean(busy)" @click="refreshSub(sub)">刷新</TxButton>
            <TxIconButton size="sm" :label="`删除订阅 ${sub.name}`" @click="removeSub(sub)"><Icon name="x" /></TxIconButton>
          </span>
        </div>
      </section>
    </template>
  </Plate>

  <ProxyAddSheet v-model="addOpen" @imported="refresh" />
  <ProxyMigrateSheet v-model="migrateOpen" @applied="refresh" />
  <ProxyAssignSheet v-model="assignOpen" :entry="target" :only-using="assignOnlyUsing" @changed="refresh" />
  <ProxyEditSheet v-model="editOpen" :entry="target" @saved="refresh" />
</template>

<style>
.px-status { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 22px; min-height: 36px; padding: 2px 0 6px; font-size: var(--fs-sm); color: var(--ink); }
.px-status__seg { display: inline-flex; flex-wrap: wrap; align-items: center; gap: 2px 8px; min-width: 0; max-width: 100%; }
.px-status__k { flex: none; white-space: nowrap; font-size: var(--fs-xs); color: var(--ink-3); }
html:root .px-status .ui-st { flex: none; }
.px-status__d { font-size: var(--fs-xs); color: var(--ink-2); min-width: 0; overflow-wrap: anywhere; }
.px-status__v { max-width: 260px; }
.px-status .ui-link { font-size: var(--fs-xs); }
.px-note { margin: 0 0 8px; font-size: var(--fs-xs); line-height: 1.5; color: var(--ink-3); }
.px-note.is-warn { color: var(--signal-ink); }

/* the migration banner: one inline row between two hairlines, a signal edge, no box */
.px-banner {
  display: flex; align-items: center; gap: 12px; min-height: 42px; margin: 0 0 8px; padding: 0 0 0 12px;
  border-top: 1px solid var(--rule); border-bottom: 1px solid var(--rule); box-shadow: inset 2px 0 0 var(--signal);
  font-size: var(--fs-sm); color: var(--ink);
}
.px-banner__t { flex: 1; min-width: 0; }
.px-banner__mk { margin-right: 8px; color: var(--signal-ink); }

.px-tools { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 16px; padding: 2px 0 8px; }
.px-tools__q { flex: 0 1 260px; min-width: 0; }
.px-tools__n { font-size: var(--fs-xs); color: var(--ink-3); }

html:root .px-table .ui-grt__head { min-height: 34px; border-bottom-color: var(--rule); }
.px-table.ui-grt { gap: 10px; }
.px-gh { margin: 0; display: flex; align-items: baseline; gap: 8px; font-size: var(--fs-sm); font-weight: 600; color: var(--ink); }
.px-gh .num { font-weight: 400; font-size: var(--fs-xs); color: var(--ink-3); }

.px-name { display: inline-flex; align-items: center; gap: 8px; min-width: 0; max-width: 100%; vertical-align: middle; }
.px-name__t { min-width: 0; color: var(--ink); }
.px-name__twin { flex: none; font-size: var(--fs-xs); color: var(--ink-3); }
.px-name__tags { min-width: 0; font-size: var(--fs-xs); color: var(--ink-3); }
.px-proto { display: inline-flex; align-items: baseline; gap: 6px; font-size: var(--fs-sm); color: var(--ink); }
.px-proto__port { font-size: var(--fs-xs); color: var(--ink-3); }
.px-exit { display: inline-flex; align-items: baseline; gap: 6px; font-size: var(--fs-sm); color: var(--ink); }
.px-exit__cc { font-weight: 600; font-size: var(--fs-xs); letter-spacing: .04em; }
.px-cell { font-size: var(--fs-sm); white-space: nowrap; font-variant-numeric: tabular-nums; }
.px-cell.is-ok { color: var(--ink); }
.px-cell.is-bad { color: var(--signal-ink); }
.px-cell.is-none { color: var(--ink-4, var(--ink-3)); }
.px-dim { color: var(--ink-3); font-size: var(--fs-xs); }
.px-used { font-size: var(--fs-sm); }
/* the table has a 在用 header; a phone card says it inline */
.px-used__k { display: none; }
.ui-rcard .px-used__k { display: inline; margin-right: 4px; font-size: var(--fs-xs); color: var(--ink-3); }

.px-subs { display: grid; margin-top: 18px; padding-bottom: 6px; }
.px-subs > .px-gh { min-height: 34px; border-bottom: 1px solid var(--rule); }
.px-sub {
  display: grid; grid-template-columns: minmax(0, 160px) minmax(0, 1fr) auto auto; grid-template-areas: 'n u l a' 'e e e e';
  align-items: center; gap: 0 16px; min-height: 40px; border-bottom: 1px solid var(--rule); font-size: var(--fs-sm);
}
.px-sub__n { grid-area: n; color: var(--ink); }
.px-sub__u { grid-area: u; font-size: var(--fs-xs); color: var(--ink-3); min-width: 0; }
.px-sub__l { grid-area: l; font-size: var(--fs-xs); color: var(--ink-2); white-space: nowrap; }
.px-sub__e { grid-area: e; padding-bottom: 6px; font-size: var(--fs-xs); color: var(--signal-ink); }
.px-sub__a { grid-area: a; display: inline-flex; align-items: center; gap: 2px; }

@media (max-width: 959px) {
  .px-sub { grid-template-columns: minmax(0, 1fr) auto; grid-template-areas: 'n a' 'u u' 'l l' 'e e'; padding: 6px 0; }
  .px-sub__l { white-space: normal; }
  .px-banner { align-items: flex-start; flex-wrap: wrap; padding: 8px 0 8px 12px; gap: 6px 12px; }
  .px-tools__q { flex: 1 1 200px; }
  .px-status { gap: 2px 16px; }
}
</style>

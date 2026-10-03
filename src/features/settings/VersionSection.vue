<script setup lang="ts">
import { computed, ref } from 'vue'
import { TxButton } from '@talex-touch/tuffex/button'
import Plate from '../../ui/data/Plate.vue'
import StatusMark from '../../ui/data/StatusMark.vue'
import Sheet from '../../ui/feedback/Sheet.vue'
import Switch from '../../ui/form/Switch.vue'
import { api } from '../../api'
import { errorMessage } from '../../lib/errors'
import { useLive } from '../../ui/composables/useLive'
import { notify } from '../../ui/feedback/toast'
import { fmtInt, fmtTime } from '../../ui/fmt'
import type { DataState } from '../../ui/types'
import type { MagpieAutoView, MagpieUpdateStatus, VersionsData } from '../../types'
import MagpieUpdatePanel from './MagpieUpdatePanel.vue'
import { fmtSpan, gapMark, shortRev } from './settingsModel'

/**
 * 网关 Magpie (#magpie; #version still lands here): which build runs, what upstream has, how far behind, how
 * it follows upstream, what waits for review, 自动更新 (switch + one line, from /api/autoupdate), and the check →
 * rehearse → apply flow. Facts come from
 * `/api/version` → `cpa.gateway` (the shell's 5-minute read, re-read with 刷新); the update flow reads
 * `/api/magpie/update-status` once and after every action. Neither reaches upstream.
 */
const props = defineProps<{
  data: VersionsData | undefined; state: DataState; error: unknown; lastAt: number | null; checking: boolean
  /** 「自动更新」 (/api/autoupdate → magpie); null = not read yet or an older server */
  auto?: MagpieAutoView | null
  autoBusy?: boolean
}>()
const emit = defineEmits<{ retry: []; recheck: []; auto: [on: boolean] }>()

/** ◇ held / waiting on something, ◆ failed — the same marks the sync rows use (the space is part of the mark: template whitespace is condensed) */
const autoMark = computed(() => (props.auto?.tone === 'bad' ? '◆ ' : props.auto?.tone === 'warn' ? '◇ ' : ''))
const reasonsOpen = ref(false)

const update = useLive<MagpieUpdateStatus>(() => api.getMagpieUpdateStatus(), { intervalMs: 0 })
const updateBusy = ref<'check' | 'rehearse' | 'apply' | null>(null)

const cpa = computed(() => props.data?.cpa ?? null)
const g = computed(() => cpa.value?.gateway ?? null)
const gap = computed(() => (g.value ? gapMark(g.value.gap) : null))
const upstream = computed(() => cpa.value?.upstream ?? null)

/** engine without the gateway model (cpa, or a server that predates it): the one line it can still say */
const legacyKernel = computed(() => {
  const c = cpa.value
  if (!c || g.value) return null
  const engine = c.engine === 'magpie' ? 'Magpie' : 'CPA'
  if (c.version === 'offline') return `${engine} · 离线`
  return `${engine} ${c.commit && c.commit !== 'unknown' ? c.commit.slice(0, 7) : c.version}`
})

const installed = computed(() => {
  const cur = g.value?.current
  if (!cur) return ''
  return [cur.buildTime ? `安装于 ${fmtTime(cur.buildTime)}` : '', cur.release ? `发布 ${cur.release}` : cur.releaseNote ? '源码提交构建 · 没有对应的发布版本号' : '']
    .filter(Boolean).join(' · ')
})

const checks = computed(() => {
  const u = g.value?.upstream
  if (!u) return null
  return {
    last: u.checkedAt ? fmtTime(u.checkedAt) : '—',
    next: u.nextCheckAt ? fmtTime(u.nextCheckAt) : '—',
    every: g.value?.policy.intervalMs ? `每 ${fmtSpan(g.value.policy.intervalMs)}` : '未定时',
  }
})

const otherVersions = computed(() => {
  const parts: string[] = []
  const c = props.data?.console
  if (c) parts.push(['Console', c.version, c.releaseId].filter(Boolean).join(' '))
  const rtk = cpa.value?.rtk
  const latest = upstream.value?.rtkRelease
  // RTK hooks live on the Magpie host (this Mac); on the relay there is no agent to hook
  if (rtk && cpa.value?.engine === 'magpie') parts.push(`RTK ${rtk.connected ? `本机 ${rtk.version ?? '已连接'}` : '本机未安装'}${latest ? `（最新 ${latest}）` : ''}`)
  return parts.join(' · ')
})

const diffOpen = ref(false)
const diffGroups = computed(() => {
  const changes = upstream.value?.changes
  if (!changes) return []
  return [
    { key: 'add', mark: '+', title: '新增路由', items: changes.addedRoutes },
    { key: 'chg', mark: '~', title: '变更路由', items: changes.changedRoutes },
    { key: 'del', mark: '−', title: '移除路由', items: changes.removedRoutes },
    { key: 'la', mark: '+', title: '新增登录方式', items: changes.addedLoginAgents },
    { key: 'lr', mark: '−', title: '移除登录方式', items: changes.removedLoginAgents },
  ].filter((group) => group.items.length)
})

const ACTION_WORD = { check: '检查', rehearse: '演练', apply: '替换' } as const
async function runUpdate(action: 'check' | 'rehearse' | 'apply') {
  updateBusy.value = action
  try {
    const result = await api.runMagpieUpdate(action, action === 'apply')
    const text = typeof result.error === 'string' ? result.error : ''
    if (text) notify(`◆ ${ACTION_WORD[action]}未完成 · ${text}`, { tone: 'bad', id: 'cx-kernel' })
    else {
      notify(action === 'apply' ? '✓ 内核已替换' : action === 'rehearse' ? '✓ 演练完成 · 运行中的内核未改动' : '✓ 已用发布源检查', { tone: 'ok', id: 'cx-kernel' })
      // the facts above read /api/version (no poll on this page): re-read it so 当前版本 shows the commit now running
      if (action === 'apply') emit('recheck')
    }
  } catch (error) {
    notify(`◆ ${ACTION_WORD[action]}失败 · ${errorMessage(error) || '请求失败'}`, { tone: 'bad', id: 'cx-kernel' })
  } finally {
    updateBusy.value = null
    void update.refresh()
  }
}
</script>

<template>
  <Plate id="magpie" :title="cpa?.engine === 'magpie' ? '网关 Magpie' : '网关'" class="set-sec set-mag" :state="state" :error="error" :stale-at="lastAt" :rows="6" @retry="emit('retry')">
    <template #actions>
      <TxButton variant="ghost" size="sm" :loading="checking" :disabled="checking" @click="emit('recheck')">刷新</TxButton>
    </template>
    <!-- old deep links (#version, the 概览 to-dos before this section existed) land on the same plate -->
    <span id="version" class="set-mag__anchor" aria-hidden="true" />

    <dl v-if="g" class="set-mag__facts">
      <dt>当前版本</dt>
      <dd>
        <b class="num set-mag__ver">{{ g.current.label }}</b>
        <StatusMark :state="g.current.running ? 'run' : 'bad'" :label="g.current.running ? '运行中' : '离线'" />
        <span v-if="installed" class="dim">{{ installed }}</span>
      </dd>

      <dt>上游最新</dt>
      <dd>
        <template v-if="g.upstream.latestRelease || g.upstream.latestCommit">
          <span v-if="g.upstream.latestRelease"><span class="num">{{ g.upstream.latestRelease }}</span> <span class="dim">发布</span></span>
          <span v-if="g.upstream.latestCommit"><span class="num">{{ g.upstream.latestCommit.slice(0, 7) }}</span> <span class="dim">main</span></span>
        </template>
        <span v-else class="dim">— 还没有上游结果</span>
      </dd>

      <dt>差距</dt>
      <dd>
        <StatusMark v-if="gap" :state="gap.state" :label="gap.label" />
        <span v-if="g.gap.note" class="dim">{{ g.gap.note }}</span>
      </dd>

      <dt>待评审</dt>
      <dd>
        <template v-if="g.review.pending">
          <button type="button" class="ui-link" @click="diffOpen = true">契约变化 {{ fmtInt(g.review.changes) }} 项 →</button>
          <span class="dim">schema {{ fmtInt(g.review.schemaCount) }} · 实现文件 {{ fmtInt(g.review.implementationFileCount) }}</span>
        </template>
        <span v-else class="dim">— 没有待评审的变化</span>
      </dd>

      <dt>检查</dt>
      <dd v-if="checks">
        <span>上次 <span class="num">{{ checks.last }}</span></span>
        <span>下次 <span class="num">{{ checks.next }}</span></span>
        <span class="dim">{{ checks.every }}</span>
        <span v-if="g.upstream.failed" class="set-mag__warn">◇ 上次检查失败 · 保留上一次结果</span>
        <span v-else-if="g.upstream.overdue" class="set-mag__warn">◇ 已逾期 · 定时任务可能没在跑</span>
      </dd>

      <dt>跟随策略</dt>
      <dd><span class="set-mag__policy">{{ g.policy.text }}</span></dd>

      <template v-if="auto">
        <dt>自动更新</dt>
        <dd class="set-mag__auto">
          <Switch
            :model-value="auto.enabled"
            :disabled="!auto.available || autoBusy"
            :loading="autoBusy"
            :aria-label="`Magpie 自动更新 · ${auto.enabled ? '开' : '关'}`"
            @update:model-value="emit('auto', $event)"
          />
          <span class="set-mag__autol" :class="`is-${auto.tone}`"><span v-if="autoMark" aria-hidden="true">{{ autoMark }}</span>{{ auto.line }}</span>
          <button v-if="auto.reasons.length > 1" type="button" class="ui-link set-mag__why" @click="reasonsOpen = true">全部原因 →</button>
        </dd>
      </template>

      <dt>更新</dt>
      <dd class="set-mag__upd">
        <MagpieUpdatePanel
          :status="update.data.value ?? null"
          :available="update.data.value ? update.data.value.capability !== false : update.error.value ? false : undefined"
          :reason="update.data.value?.reason ?? (update.error.value ? errorMessage(update.error.value) || '读取更新状态失败' : null)"
          :busy="updateBusy"
          @check="runUpdate('check')"
          @rehearse="runUpdate('rehearse')"
          @apply="runUpdate('apply')"
        />
      </dd>
    </dl>

    <dl v-else class="set-mag__facts">
      <dt>网关内核</dt>
      <dd><span class="num">{{ legacyKernel ?? '—' }}</span></dd>
    </dl>

    <p v-if="otherVersions" class="set-mag__other num">{{ otherVersions }}</p>
  </Plate>

  <Sheet v-if="auto" v-model="reasonsOpen" :title="`为什么没自动替换 · ${shortRev(auto.candidate) ?? ''}`">
    <ul class="set-why">
      <li v-for="r in auto.reasons" :key="r.code + r.text">{{ r.text }}</li>
    </ul>
    <p class="set-diff__note">自动更新只接受不影响控制台的变化 · 这些都要人工评审后再升级基线</p>
  </Sheet>

  <Sheet v-model="diffOpen" :title="`契约变化 · ${shortRev(upstream?.candidateRevision) ?? ''}`">
    <p class="set-diff__meta num">
      当前 {{ shortRev(upstream?.contractRevision) ?? '—' }} → 候选 {{ shortRev(upstream?.candidateRevision) ?? '—' }}
      · schema {{ fmtInt(upstream?.changes.schemaCount) }} · 实现文件 {{ fmtInt(upstream?.changes.implementationFileCount) }}
    </p>
    <section v-for="grp in diffGroups" :key="grp.key" class="set-diff__g">
      <h3>{{ grp.title }} <span class="num dim">{{ grp.items.length }}</span></h3>
      <ul>
        <li v-for="item in grp.items" :key="item" class="num"><span class="set-diff__m" :class="`is-${grp.key}`" aria-hidden="true">{{ grp.mark }}</span>{{ item }}</li>
      </ul>
    </section>
    <p class="set-diff__note">候选只是检测结果 · 评审通过后再走 检查 → 演练 → 替换</p>
  </Sheet>
</template>

<style>
/* a text button: no resting fill (tuffex's fake-background layer), the fill only on hover */
.set-mag .tx-button.variant-ghost { --fake-opacity: 0; }
.set-mag__anchor { display: block; height: 0; scroll-margin-top: calc(var(--head) + 16px); }
.set-mag__facts { display: grid; grid-template-columns: 72px minmax(0, 1fr); gap: 2px 20px; margin: 0; padding: 4px 0 2px; font-size: var(--fs-sm); }
.set-mag__facts dt, .set-mag__facts dd { margin: 0; min-height: 30px; display: flex; align-items: center; min-width: 0; }
.set-mag__facts dt { color: var(--ink-3); white-space: nowrap; }
.set-mag__facts dd { flex-wrap: wrap; gap: 2px 14px; color: var(--ink); }
.set-mag__facts dd .dim { font-size: var(--fs-xs); }
.set-mag__ver { font-size: var(--fs-base); font-weight: 600; }
.set-mag__policy { color: var(--ink-2); line-height: 1.5; }
.set-mag__warn { font-size: var(--fs-xs); color: var(--ink-2); }
.set-mag__facts dd.set-mag__upd { padding: 4px 0; }
.set-mag__facts dd.set-mag__auto { flex-wrap: nowrap; align-items: flex-start; gap: 10px; padding: 6px 0; }
.set-mag__auto .ui-switch { flex: none; margin-top: 1px; }
.set-mag__autol { min-width: 0; line-height: 1.5; color: var(--ink-2); overflow-wrap: anywhere; }
.set-mag__autol.is-bad { color: var(--signal-ink); }
.set-mag__why { flex: none; font-size: var(--fs-xs); line-height: 1.5; }
.set-why { margin: 0 0 12px; padding: 0; list-style: none; display: grid; gap: 8px; }
.set-why li { font-size: var(--fs-sm); line-height: 1.5; color: var(--ink); overflow-wrap: anywhere; padding-bottom: 8px; border-bottom: 1px solid var(--rule); }
.set-why li:last-child { border-bottom: 0; }
.set-mag__other { margin: 10px 0 0; padding-top: 10px; border-top: 1px solid var(--rule); font-size: var(--fs-xs); color: var(--ink-3); overflow-wrap: anywhere; }

.set-diff__meta { margin: 0 0 12px; font-size: var(--fs-xs); color: var(--ink-3); }
.set-diff__g { margin-bottom: 14px; }
.set-diff__g h3 { margin: 0 0 4px; font-size: var(--fs-sm); font-weight: 600; display: flex; gap: 8px; align-items: baseline; }
.set-diff__g ul { margin: 0; padding: 0; list-style: none; }
.set-diff__g li { display: flex; gap: 10px; padding: 4px 0; font-size: var(--fs-xs); color: var(--ink); overflow-wrap: anywhere; }
.set-diff__m { width: 10px; flex: none; color: var(--ink-3); }
.set-diff__m.is-del, .set-diff__m.is-lr { color: var(--ink); font-weight: 700; }
.set-diff__note { margin: 6px 0 0; font-size: var(--fs-xs); color: var(--ink-3); }

@media (max-width: 959px) {
  .set-mag__anchor { scroll-margin-top: calc(var(--head) + var(--ticker) + 12px); }
}
@media (max-width: 599px) {
  .set-mag__facts { grid-template-columns: minmax(0, 1fr); gap: 0; }
  .set-mag__facts dt { min-height: 0; padding-top: 10px; font-size: var(--fs-xs); }
  .set-mag__facts dd { min-height: 26px; }
}
</style>

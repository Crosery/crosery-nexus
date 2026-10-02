<script setup lang="ts">
import { computed, onBeforeUnmount, reactive } from 'vue'
import Plate from '../../ui/data/Plate.vue'
import RowTable from '../../ui/data/RowTable.vue'
import StatusMark from '../../ui/data/StatusMark.vue'
import Pii from '../../ui/data/Pii.vue'
import { api } from '../../api'
import { errorMessage, errorStatus } from '../../lib/errors'
import { confirmSheet } from '../../ui/feedback/confirmSheet'
import { notify } from '../../ui/feedback/toast'
import { fmtCountdownClock, useNow } from '../../ui/composables/useNow'
import { useBreakpoint } from '../../ui/composables/useBreakpoint'
import { maskEmail, useMask } from '../../ui/composables/prefs'
import { fmtAgo, fmtTime } from '../../ui/fmt'
import type { DataState, RowColumn, RowTone } from '../../ui/types'
import type { SyncJob, SyncStatus } from '../../types'
import SyncLane from './SyncLane.vue'
import SyncJobAction from './SyncJobAction.vue'
import { jobAction, jobRow, policyFigures, splitEmails, syncHeadline, syncTally, type JobAction, type JobRow } from './settingsModel'

/**
 * 同步中心 (#sync, DESIGN §6.8): the policy figures, then one table row per background job (RowTable →
 * TxDataTable; a card per job on phones) — status, last run (its error in place of the summary), next run with
 * the interval, a 24h timing lane with the job's upstream calls, and the one button. 立即同步 is server-cooled
 * (429 cooldown) and asks first when the upstream is in backoff. The page owns the poll (useLive).
 */
const props = defineProps<{ data: SyncStatus | undefined; state: DataState; error: unknown; lastAt: number | null }>()
const emit = defineEmits<{ retry: []; refresh: [] }>()

const tick = useNow()
const { isCompact, width } = useBreakpoint()
// lanes move in 10s steps: the pulses do not need second accuracy and this keeps SVG work tiny
const now = computed(() => Math.floor(tick.value / 10_000) * 10_000)
const fromHours = computed(() => (isCompact.value ? 6 : 24))
const toHours = computed(() => (isCompact.value ? 1 : 2))
const from = computed(() => now.value - fromHours.value * 3_600_000)
const to = computed(() => now.value + toHours.value * 3_600_000)

const jobs = computed<SyncJob[]>(() => props.data?.jobs ?? [])
const tally = computed(() => syncTally(jobs.value))
const figures = computed(() => (props.data ? policyFigures(props.data.policy, tally.value) : []))
const headline = computed(() => syncHeadline(tally.value))
/** jobId → when its 立即同步 got the 202: the button stays `已提交` until the status shows that run (jobAction) */
const accepted = reactive(new Map<string, number>())

type JobLine = { id: string; job: SyncJob; row: JobRow; action: JobAction }
const rows = computed<JobLine[]>(() =>
  jobs.value.map((job) => ({ id: job.id, job, row: jobRow(job, props.data?.policy ?? null, tick.value), action: jobAction(job, tick.value, accepted.get(job.id) ?? null) })),
)
const plateState = computed<DataState>(() => {
  if (props.state === 'error' && errorStatus(props.error) === 404) return 'empty'
  if (props.state === 'ready' && !jobs.value.length) return 'empty'
  return props.state
})
const emptyText = computed(() => (errorStatus(props.error) === 404 ? '同步中心接口未上线 · 服务重启后可用' : '没有登记的同步任务'))

const columns = computed<RowColumn<JobLine>[]>(() => [
  { key: 'name', title: '任务' },
  { key: 'state', title: '状态', width: 92 },
  { key: 'last', title: '上次' },
  { key: 'next', title: '下次', width: 148 },
  { key: 'lane', title: `近 ${fromHours.value} 小时`, width: width.value >= 1440 ? 280 : 236 },
  { key: 'act', title: '', width: 112, align: 'right' },
])
/** a job that needs a look gets the attention edge; a disabled one reads in ink-3 */
function rowTone(line: JobLine): RowTone {
  const state = line.row.mark.state
  if (state === 'bad' || state === 'warn') return 'attn'
  return state === 'off' ? 'off' : null
}

/** 下次: the time (or 按需 / —), then how far off it is and the interval, in one quiet line */
function nextCell(line: JobLine) {
  const { next, every, jitter } = line.row
  const scheduled = line.job.intervalMs !== null
  const main = next.at !== null ? fmtTime(next.at, tick.value) : scheduled ? '—' : '按需'
  const when = next.at === null ? '' : next.overdue ? `逾期 ${fmtAgo(next.at, tick.value).replace(' 前', '')}` : fmtAgo(next.at, tick.value)
  const sub = [when, scheduled ? `${every}${jitter ? ` ${jitter}` : ''}` : ''].filter(Boolean).join(' · ')
  return { prefix: next.prefix, main, sub, overdue: next.overdue }
}

const mask = useMask()
/** confirm facts are plain text, so emails are masked here when the privacy mask is on */
const shown = (text: string) => splitEmails(text).map((part) => (part.email && mask.on.value ? maskEmail(part.text) : part.text)).join('')

const pending = reactive(new Set<string>())
const timers: Array<ReturnType<typeof setTimeout>> = []
onBeforeUnmount(() => timers.forEach(clearTimeout))

async function run(job: SyncJob) {
  if (pending.has(job.id)) return
  if (job.state === 'backoff') {
    const ok = await confirmSheet({
      title: `现在同步 ${job.label}？`,
      facts: [
        { k: '状态', v: `上游退避中${job.backoffUntil ? ` · 至 ${fmtTime(job.backoffUntil)}` : ''}` },
        ...(job.lastError ? [{ k: '上次错误', v: shown(job.lastError) }] : []),
      ],
      consequence: '会提前请求正在退避的上游 · 之后进入手动冷却',
      confirmText: '仍然同步',
    })
    if (!ok) return
  }
  pending.add(job.id)
  try {
    await api.sync.run(job.id)
    accepted.set(job.id, Date.now())
    notify(`✓ 已开始 · ${job.label}`, { tone: 'ok', id: `cx-sync-${job.id}` })
    // catch the finish without polling faster forever
    for (const ms of [1_500, 6_000, 20_000]) timers.push(setTimeout(() => emit('refresh'), ms))
  } catch (error) {
    const code = (error as { code?: string | null }).code
    const retry = (error as { retryAfterSec?: number | null }).retryAfterSec
    if (code === 'cooldown') notify(`◇ ${job.label} 冷却中${retry ? ` · ${fmtCountdownClock(retry * 1000)} 后再试` : ''}`, { tone: 'warn', id: `cx-sync-${job.id}` })
    else if (code === 'running') notify(`— ${job.label} 正在同步`, { tone: 'note', id: `cx-sync-${job.id}` })
    else if (code === 'not_runnable' || code === 'disabled') notify(`— ${job.label} 不能从控制台触发`, { tone: 'note', id: `cx-sync-${job.id}` })
    else notify(`◆ ${job.label} · ${errorMessage(error) || '同步请求失败'}`, { tone: 'bad', id: `cx-sync-${job.id}` })
  } finally {
    pending.delete(job.id)
    emit('refresh')
  }
}
</script>

<template>
  <Plate
    id="sync"
    title="同步中心"
    class="set-sec"
    :state="plateState"
    :error="error"
    :stale-at="lastAt"
    :rows="6"
    :cols="['180px', '1fr', '120px']"
    :empty-text="emptyText"
    @retry="emit('retry')"
  >
    <template #meta>
      <span v-if="tally.total" class="set-sync__head">
        <StatusMark v-if="tally.bad" state="bad" :label="`${tally.bad} 失败`" />
        <StatusMark v-if="tally.warn" state="warn" :label="`${tally.warn} 注意`" />
        <StatusMark v-if="tally.busy" state="busy" :label="`${tally.busy} 运行`" />
        <StatusMark v-if="!tally.bad && !tally.warn && !tally.busy" state="run" :label="headline" />
      </span>
    </template>

    <div class="set-policy">
      <dl class="set-policy__figs" aria-label="同步策略">
        <div v-for="f in figures" :key="f.k" class="set-policy__f" :title="f.title">
          <dt>{{ f.k }}</dt>
          <dd class="num">{{ f.v }}<small v-if="f.sub">{{ f.sub }}</small></dd>
        </div>
      </dl>
      <p class="set-policy__note">并发与单源间隔由服务端统一限制 · 手动同步也有冷却 · 不会为赶进度多发请求</p>
    </div>

    <RowTable :columns="columns" :data="rows" row-key="id" density="two-line" :row-tone="rowTone" caption="同步任务" class="set-jobs">
      <template #cell-name="{ row: r }">
        <span class="cell-stack">
          <span class="set-job__name ellip" :title="r.row.label">{{ r.row.label }}</span>
          <span v-if="r.row.source" class="cell-sub mono ellip">{{ r.row.source }}</span>
        </span>
      </template>

      <template #cell-state="{ row: r }">
        <StatusMark :state="r.row.mark.state" :label="r.row.mark.label" />
      </template>

      <template #cell-last="{ row: r }">
        <span class="cell-stack">
          <span class="set-job__l1 ellip"><span class="num">{{ r.row.lastAt ?? '—' }}</span><span v-if="r.row.error && r.row.lastWords" class="cell-sub"> · {{ r.row.lastWords }}</span></span>
          <span
            v-if="r.row.error"
            class="cell-sub set-job__err ellip"
            :class="{ 'is-hot': r.row.error.hot }"
            :title="mask.on.value ? undefined : r.row.error.text"
          ><span aria-hidden="true">{{ r.row.error.hot ? '◆ ' : '· ' }}</span><template v-for="(part, k) in r.row.error.parts" :key="k"><Pii v-if="part.email" :value="part.text" kind="email" /><template v-else>{{ part.text }}</template></template></span>
          <span v-else-if="r.row.lastWords" class="cell-sub mono ellip" :title="r.row.lastWords">{{ r.row.lastWords }}</span>
        </span>
      </template>

      <template #cell-next="{ row: r }">
        <span class="cell-stack num">
          <span class="ellip"><span v-if="nextCell(r).prefix" class="set-job__pre">{{ nextCell(r).prefix }}</span>{{ nextCell(r).main }}</span>
          <span v-if="nextCell(r).sub" class="cell-sub ellip" :class="{ dim2: nextCell(r).overdue }">{{ nextCell(r).sub }}</span>
        </span>
      </template>

      <template #cell-lane="{ row: r }">
        <span class="set-job__lane">
          <SyncLane :job="r.job" :from="from" :to="to" :now="now" />
          <span class="set-job__calls num" :title="r.row.callsTitle">{{ r.job.requests24h === null ? '' : r.row.calls }}</span>
        </span>
      </template>

      <template #cell-act="{ row: r }">
        <SyncJobAction :job="r.job" :label="r.row.label" :action="r.action" :pending="pending.has(r.job.id)" :now="tick" @run="run(r.job)" />
      </template>

      <!-- < 960: one card per job — name · button, status with the facts, the summary, the lane, the error -->
      <template #card="{ row: r }">
        <div class="set-jcard">
          <div class="set-jcard__l1">
            <span class="cell-stack">
              <span class="set-job__name ellip">{{ r.row.label }}</span>
              <span v-if="r.row.source" class="cell-sub mono ellip">{{ r.row.source }}</span>
            </span>
            <span class="set-jcard__act">
              <SyncJobAction :job="r.job" :label="r.row.label" :action="r.action" :pending="pending.has(r.job.id)" :now="tick" @run="run(r.job)" />
            </span>
          </div>
          <div class="set-jcard__ln num">
            <StatusMark :state="r.row.mark.state" :label="r.row.mark.label" />
            <span>上次 {{ r.row.lastAt ?? '—' }}</span>
            <span>{{ nextCell(r).prefix || '下次' }} {{ nextCell(r).main }}<template v-if="nextCell(r).sub"> · {{ nextCell(r).sub }}</template></span>
          </div>
          <div v-if="r.row.lastWords" class="set-jcard__ln mono">{{ r.row.lastWords }}</div>
          <div class="set-jcard__lane">
            <SyncLane :job="r.job" :from="from" :to="to" :now="now" :height="18" />
            <span class="set-job__calls num" :title="r.row.callsTitle">{{ r.job.requests24h === null ? '' : r.row.calls }}</span>
          </div>
          <div v-if="r.row.error" class="set-jcard__err" :class="{ 'is-hot': r.row.error.hot }">
            <span aria-hidden="true">{{ r.row.error.hot ? '◆ ' : '· ' }}</span><template v-for="(part, k) in r.row.error.parts" :key="k"><Pii v-if="part.email" :value="part.text" kind="email" /><template v-else>{{ part.text }}</template></template>
          </div>
        </div>
      </template>
    </RowTable>
  </Plate>
</template>

<style>
.set-sync__head { display: inline-flex; align-items: center; gap: 12px; }

/* policy: five quiet figures, spacing between them, the one sentence after */
.set-policy { display: flex; flex-wrap: wrap; align-items: flex-end; justify-content: space-between; gap: 8px 32px; padding: 2px 0 14px; }
.set-policy__figs { display: flex; flex-wrap: wrap; gap: 8px 32px; margin: 0; }
.set-policy__f { display: grid; gap: 2px; min-width: 0; }
.set-policy__f dt { font-size: var(--fs-xs); color: var(--ink-3); white-space: nowrap; }
.set-policy__f dd { margin: 0; font-size: 16px; font-weight: 500; line-height: 1.2; color: var(--ink); white-space: nowrap; }
.set-policy__f small { margin-left: 6px; font-size: var(--fs-xs); color: var(--ink-3); font-weight: 400; }
.set-policy__note { margin: 0 0 0 auto; font-size: var(--fs-xs); line-height: 1.5; color: var(--ink-3); }

.set-job__name { font-size: var(--fs-base); font-weight: 600; color: var(--ink); }
.set-job__l1 { display: block; max-width: 100%; }
.set-job__pre { margin-right: 6px; color: var(--ink-2); }
.set-job__err { font-family: var(--font-mono); color: var(--ink-2); }
.set-job__err.is-hot { color: var(--signal-ink); }
.set-job__lane { display: flex; align-items: center; gap: 10px; min-width: 0; }
.set-job__lane .set-lane { flex: 1 1 auto; }
.set-job__calls { flex: none; width: 52px; font-size: var(--fs-xs); color: var(--ink-2); text-align: right; white-space: nowrap; }

/* phone / tablet card */
.set-jcard { display: grid; gap: 6px; min-width: 0; }
.set-jcard__l1 { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: center; gap: 12px; min-width: 0; }
.set-jcard__act { display: flex; justify-content: flex-end; }
.set-jcard__ln { display: flex; flex-wrap: wrap; align-items: center; gap: 2px 14px; font-size: var(--fs-xs); color: var(--ink-2); overflow-wrap: anywhere; }
.set-jcard__ln .ui-st { font-family: var(--font-sans); font-size: var(--fs-xs); color: var(--ink); }
.set-jcard__lane { display: flex; align-items: center; gap: 10px; min-width: 0; margin-top: 2px; }
.set-jcard__lane .set-lane { flex: 1 1 auto; }
.set-jcard__err { font-family: var(--font-mono); font-size: var(--fs-xs); line-height: 1.45; color: var(--ink-2); overflow-wrap: anywhere; }
.set-jcard__err.is-hot { color: var(--signal-ink); }

@media (max-width: 959px) {
  .set-policy { padding-bottom: 10px; }
  .set-policy__figs { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px 16px; width: 100%; }
}
</style>

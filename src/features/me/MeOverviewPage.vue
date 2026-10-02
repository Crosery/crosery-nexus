<script setup lang="ts">
import { computed } from 'vue'
import { RouterLink } from 'vue-router'
import PageHead from '../../ui/shell/PageHead.vue'
import LiveMark from '../../ui/shell/LiveMark.vue'
import Plate from '../../ui/data/Plate.vue'
import StatusMark from '../../ui/data/StatusMark.vue'
import RulerMeter from '../../ui/viz/RulerMeter.vue'
import RollNumber from '../../ui/viz/RollNumber.vue'
import SpendForecast from '../../ui/viz/SpendForecast.vue'
import CopyField from '../../ui/form/CopyField.vue'
import { useLive } from '../../ui/composables/useLive'
import { useNow } from '../../ui/composables/useNow'
import { clockParts, fmtAgo, fmtClock, fmtCompact, fmtDuration, fmtInt, fmtPct, fmtUsd, NONE } from '../../ui/fmt'
import { api } from '../../api'
import MeRequestTable from './MeRequestTable.vue'
import WeekStrip from './WeekStrip.vue'
import { callableCount, failureBrief, projectToday, quotaRows, requestFailure, statusText, usageDayBounds, type MeConnectX, type MeOverviewX, type MeUsageX } from './meModel'
import type { MeModels, MeRequestsPage } from '../../types'
import type { StatusKind } from '../../ui/types'

/**
 * /me 概览 (DESIGN §6.10). Phone first screen: who this key is, the three quota rulers (剩…, reset, pace),
 * today's spend as the one hero number. Below: today's facts, the latest failures in plain words, the
 * latest requests and the base URL. Every figure comes from /api/me* (the server filters by the session's
 * key and counts all of its traffic, so today's spend equals the daily quota's 已用).
 */
const now = useNow()
const me = useLive<MeOverviewX>((signal) => api.me.overview(signal) as Promise<MeOverviewX>, { intervalMs: 15_000 })
const week = useLive<MeUsageX>((signal) => api.me.usage(7, signal) as Promise<MeUsageX>, { intervalMs: 60_000 })
const recent = useLive<MeRequestsPage>((signal) => api.me.requests({ limit: 10 }, signal), {
  intervalMs: 30_000,
  isEmpty: (page) => page.items.length === 0,
})
const errors = useLive<MeRequestsPage>((signal) => api.me.requests({ limit: 5, status: 'error' }, signal), {
  intervalMs: 60_000,
  isEmpty: (page) => page.items.length === 0,
})
const models = useLive<MeModels>((signal) => api.me.models(signal), { intervalMs: 5 * 60_000 })
const connect = useLive<MeConnectX>((signal) => api.me.connect(signal) as Promise<MeConnectX>, { intervalMs: 0 })

const data = computed(() => me.data.value)
const today = computed(() => data.value?.today)

/* ── identity ── */
const keyState = computed<{ state: StatusKind; label: string } | null>(() => {
  const d = data.value
  if (!d) return null
  const q = d.quota
  const exceeded = q.daily.exceeded || q.weekly.exceeded || q.total.exceeded
  if (!d.key.enabled) return d.key.blockedReason || exceeded ? { state: 'bad', label: '超额停用' } : { state: 'off', label: '停用' }
  if (exceeded) return { state: 'bad', label: '超额' }
  return { state: 'run', label: '可用' }
})
const idLine = computed(() => {
  const d = data.value
  if (!d) return ''
  const parts = [d.key.masked]
  if (d.key.totalConcurrency) parts.push(`并发 ${d.key.totalConcurrency}`)
  if (d.key.lastUsedAt) parts.push(`上次调用 ${fmtClock(d.key.lastUsedAt, now.value)}`)
  return parts.join(' · ')
})
const blocked = computed(() => {
  const d = data.value
  if (!d || d.key.enabled) return null
  const row = rows.value.find((r) => r.window.exceeded)
  return [d.key.blockedReason || (row ? `${row.label}额度已用完` : '已停用'), row && row.kind !== 'total' ? row.reset.replace(' 重置', ' 恢复') : ''].filter(Boolean).join(' · ')
})

/* ── 01 额度 ── */
const weekDays = computed(() => (week.data.value?.daily ?? []).slice(-7))
const weekAvgPerMs = computed(() => {
  const days = weekDays.value
  if (days.length < 7) return null
  // the first day's start on the server's calendar (not a hard-coded +08:00)
  const start = usageDayBounds(days[0].day, week.data.value)?.start ?? NaN
  const spent = days.reduce((sum, d) => sum + (d.estimatedCostUsd ?? 0), 0)
  return Number.isFinite(start) && now.value > start ? spent / (now.value - start) : null
})
const rows = computed(() => (data.value ? quotaRows(data.value.quota, now.value, weekAvgPerMs.value) : []))
const allUnlimited = computed(() => rows.value.length > 0 && rows.value.every((r) => r.unlimited))

/* ── 02 今日花费 ── */
const hoursNow = computed(() => {
  const p = clockParts(now.value)
  return p ? Number(p.hour) + Number(p.minute) / 60 : 0
})
const hourly = computed(() => {
  const out: Array<number | null> = Array.from({ length: 24 }, () => null)
  for (const point of today.value?.hourly ?? []) {
    const p = clockParts(point.hour)
    if (p) out[Number(p.hour)] = point.costUsd
  }
  return out
})
const quiet = computed(() => (today.value?.requests ?? 0) === 0)
/** no projection once the key is paused or the day's quota is spent: the sentence would describe a future that cannot happen */
const projected = computed(() => {
  const d = data.value
  if (!d || !d.key.enabled || d.quota.daily.exceeded) return null
  return projectToday(today.value?.costUsd ?? null, hoursNow.value)
})
const costLabel = computed(() => {
  const t = today.value
  if (!t) return NONE
  // DESIGN §6.0: never a `$0.00` headline — no calls today reads — with the quiet line under it
  if (t.requests === 0) return NONE
  if (t.costUsd === null) return NONE
  return fmtUsd(t.costUsd, { approx: t.unpricedRequests > 0 })
})
const dailyLimit = computed(() => data.value?.quota.daily.limitUsd ?? null)
const priced = computed(() => weekDays.value.some((d) => d.estimatedCostUsd !== null) || (today.value?.costUsd ?? null) !== null)
/** the strip's today column follows /api/me (15 s) rather than the 60 s usage poll */
const stripDays = computed(() =>
  weekDays.value.map((d, i, list) => {
    const isToday = i === list.length - 1 && today.value
    const value = priced.value ? (isToday ? today.value!.costUsd : d.estimatedCostUsd) : isToday ? today.value!.tokens : d.totalTokens
    return { day: d.day, value: value ?? (priced.value ? null : 0), requests: isToday ? today.value!.requests : d.requests }
  }),
)
const quietLine = computed(() => {
  const at = data.value?.key.lastUsedAt
  return at ? `今天还没有调用 · 上次 ${fmtClock(at, now.value)} · ${fmtAgo(at, now.value)}` : '还没有调用记录 · 接入后这里开始计数'
})
const stripHasData = computed(() => stripDays.value.some((d) => d.requests > 0))

/* ── 今日: what the hero line does not already say (requests / tokens sit under the spend) ── */
const facts = computed(() => {
  const t = today.value
  const m = models.data.value
  const failRate = t && t.requests ? t.errors / t.requests : null
  return [
    { k: '失败', v: fmtInt(t?.errors ?? null), sub: t?.errors ? failureBrief(t.failures) || fmtPct(failRate) : t?.requests ? '0%' : '', hot: Boolean(t?.errors) },
    { k: '平均耗时', v: fmtDuration(t?.avgLatencyMs ?? null), sub: t?.avgLatencyMs != null ? '成功请求' : '' },
    // gateway unreadable → `—` (unknown), never 0
    { k: '可用模型', v: m ? (m.reason === 'key_blocked' ? '暂停' : fmtInt(callableCount(m))) : NONE, sub: m?.reason === 'gateway_unavailable' ? '暂时读不到' : '' },
  ]
})
</script>

<template>
  <div class="ui-page me-ov">
    <PageHead :title="data?.key.name ?? '概览'" plain>
      <template v-if="keyState" #status>
        <span class="me-ov__id">
          <StatusMark :state="keyState.state" :label="keyState.label" :live="keyState.state === 'run'" />
          <span class="num">{{ idLine }}</span>
        </span>
      </template>
      <template #live>
        <LiveMark :state="me.state.value" :last-at="me.lastAt.value" :interval-ms="15_000" @retry="me.refresh" />
      </template>
    </PageHead>

    <p v-if="blocked" class="me-ov__alert" role="status"><span aria-hidden="true">◆</span> 已暂停 · {{ blocked }}</p>

    <div class="me-ov__grid">
      <div class="me-ov__col me-ov__a1">
        <Plate title="额度" class="me-ov__p1" :state="me.state.value" :error="me.error.value" :rows="3" :stale-at="me.lastAt.value" @retry="me.refresh">
          <template v-if="allUnlimited" #meta><span>不限额 · 只记花费</span></template>
          <div class="me-ov__quota">
            <template v-for="r in rows" :key="r.kind">
              <div v-if="r.unlimited" class="me-ov__free">
                <span class="me-ov__free-l">{{ r.label }}</span>
                <span class="me-ov__free-v num">{{ fmtUsd(r.window.spentUsd) }}</span>
                <span class="me-ov__free-t">不限</span>
                <span class="me-ov__free-r">{{ r.reset }}</span>
              </div>
              <RulerMeter
                v-else
                :label="r.label"
                :used="r.window.spentUsd"
                :limit="r.window.limitUsd"
                :reset="r.reset"
                :pace="r.pace"
                compact
              />
            </template>
          </div>
        </Plate>

        <Plate title="今日" class="me-ov__p3" :state="me.state.value" :error="me.error.value" :rows="2" :stale-at="me.lastAt.value" @retry="me.refresh">
          <dl class="me-ov__facts">
            <div v-for="f in facts" :key="f.k" class="me-ov__fact">
              <dt>{{ f.k }}</dt>
              <dd class="num" :class="{ 'is-hot': f.hot }">{{ f.v }}</dd>
              <dd v-if="f.sub" class="me-ov__fact-sub num">{{ f.sub }}</dd>
            </div>
          </dl>
        </Plate>
      </div>

      <div class="me-ov__col me-ov__a2">
        <Plate title="今日花费" class="me-ov__p2" :state="me.state.value" :error="me.error.value" :rows="4" :stale-at="me.lastAt.value" @retry="me.refresh">
          <div class="me-ov__hero" :class="{ 'is-quiet': quiet }">
            <span class="me-ov__cost num"><RollNumber :value="costLabel" /></span>
            <span v-if="today && today.requests && today.costUsd === null" class="me-ov__unpriced">未定价</span>
            <p class="me-ov__sub num">
              <template v-if="quiet">{{ quietLine }}</template>
              <template v-else>{{ fmtInt(today?.requests ?? null) }} 次请求 · {{ fmtCompact(today?.tokens ?? null) }} token</template>
            </p>
            <p v-if="today && today.unpricedRequests" class="me-ov__note">未定价 {{ fmtInt(today.unpricedRequests) }} 次 · 不计入</p>
          </div>
          <SpendForecast v-if="!quiet && today?.costUsd !== null" class="me-ov__forecast" :hourly="hourly" :limit="dailyLimit" :now="hoursNow" :projected="projected">
            <template #over>将超过日额度 · 超出后本 Key 当日暂停</template>
          </SpendForecast>
          <WeekStrip
            v-if="stripDays.length === 7 && stripHasData"
            class="me-ov__week"
            :days="stripDays"
            :metric="priced ? 'usd' : 'tokens'"
            :projected="priced && !quiet ? projected : null"
            :approx="(week.data.value?.totals.unpricedRequests ?? 0) > 0"
          />
        </Plate>
      </div>

      <div class="me-ov__col me-ov__b1">
        <Plate
          title="最近请求"
          class="me-ov__p5"
          flush
          :state="recent.state.value"
          :error="recent.error.value"
          :rows="8"
          empty-text="还没有调用记录"
          empty-action="看接入方式 →"
          :stale-at="recent.lastAt.value"
          @retry="recent.refresh"
          @empty-action="$router.push('/me/connect')"
        >
          <template #actions>
            <RouterLink to="/me/usage#requests" class="ui-link">全部 →</RouterLink>
          </template>
          <MeRequestTable :items="recent.data.value?.items ?? []" caption="最近请求" />
        </Plate>
      </div>

      <div class="me-ov__col me-ov__b2">
        <Plate
          title="最近失败"
          class="me-ov__p4"
          :state="errors.state.value"
          :error="errors.error.value"
          :rows="3"
          empty-text="最近没有失败"
          :stale-at="errors.lastAt.value"
          @retry="errors.refresh"
        >
          <template #actions>
            <RouterLink to="/me/usage?status=error#requests" class="ui-link">全部 →</RouterLink>
          </template>
          <ul class="me-ov__errs">
            <li v-for="item in errors.data.value?.items ?? []" :key="item.id" class="me-ov__err" data-row>
              <div class="me-ov__err-l1 num">
                <span class="me-ov__err-code">{{ statusText(item) }}</span>
                <span class="me-ov__err-t">{{ fmtClock(item.timestamp, now) }}</span>
                <span class="me-ov__err-m" :title="item.model">{{ item.model }}</span>
              </div>
              <div class="me-ov__err-l2">
                {{ requestFailure(item).title }}<template v-if="requestFailure(item).next"> · {{ requestFailure(item).next }}</template>
              </div>
            </li>
          </ul>
        </Plate>

        <Plate title="接入" class="me-ov__p6" :state="connect.state.value" :error="connect.error.value" :rows="2" @retry="connect.refresh">
          <CopyField label="Base URL" :value="connect.data.value?.baseUrl ?? ''" />
          <p v-if="connect.data.value?.configured === false" class="me-ov__note me-ov__warn" role="note"><span aria-hidden="true">◆</span> 公网地址未配置 · 这是服务器本机地址 · 向管理员要地址</p>
          <div class="me-ov__more">
            <RouterLink to="/me/connect" class="ui-link">完整接入方式 →</RouterLink>
            <RouterLink v-if="models.data.value?.models.length" to="/me/models" class="ui-link">{{ fmtInt(models.data.value.models.length) }} 个模型 →</RouterLink>
          </div>
        </Plate>
      </div>
    </div>
  </div>
</template>

<style>
.me-ov__id { display: inline-flex; flex-wrap: wrap; align-items: baseline; gap: 4px 12px; color: var(--ink-3); font-size: var(--fs-xs); }
.me-ov__id .num { overflow-wrap: anywhere; }
.me-ov__alert { margin: -6px 0 14px; font-size: var(--fs-sm); color: var(--signal-ink); }

.me-ov__grid { display: grid; grid-template-columns: repeat(12, minmax(0, 1fr)); gap: 24px var(--gutter); align-items: start; }
.me-ov__col { display: flex; flex-direction: column; gap: 24px; min-width: 0; }
.me-ov__a1 { grid-column: span 7; }
.me-ov__a2 { grid-column: span 5; }
.me-ov__b1 { grid-column: span 8; }
.me-ov__b2 { grid-column: span 4; }

/* 额度: three compact rulers, spacing alone between them */
.me-ov__quota { display: grid; gap: 18px; padding-top: 4px; }
.me-ov__free { display: grid; grid-template-columns: 34px auto auto minmax(0, 1fr); align-items: baseline; gap: 4px 12px; min-height: 28px; }
.me-ov__free-l { font-weight: 600; color: var(--ink); }
.me-ov__free-v { font-size: var(--fs-md); color: var(--ink); }
.me-ov__free-t { font-size: var(--fs-xs); color: var(--ink-3); }
.me-ov__free-r { justify-self: end; font-size: var(--fs-xs); color: var(--ink-3); text-align: right; }

/* 今日花费 */
.me-ov__hero { display: grid; gap: 2px; padding: 4px 0 14px; }
.me-ov__cost { font-size: var(--fs-3xl); line-height: 1.05; font-weight: 500; letter-spacing: -.02em; color: var(--ink); }
.me-ov__hero.is-quiet .me-ov__cost { color: var(--ink-3); }
.me-ov__unpriced { font-size: var(--fs-sm); color: var(--ink-2); }
.me-ov__sub { margin: 4px 0 0; font-size: var(--fs-sm); color: var(--ink-2); }
.me-ov__note { margin: 0; font-size: var(--fs-xs); color: var(--ink-3); }
.me-ov__forecast { margin-bottom: 18px; }

/* 今日: three facts, separated by space only */
.me-ov__facts { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 0 16px; margin: 0; }
.me-ov__fact { min-width: 0; padding: 4px 0 2px; }
.me-ov__fact dt { font-size: var(--fs-xs); color: var(--ink-3); }
.me-ov__fact dd { margin: 2px 0 0; font-size: 20px; line-height: 1.2; color: var(--ink); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.me-ov__fact dd.is-hot { color: var(--signal-ink); }
.me-ov__fact .me-ov__fact-sub { margin-top: 2px; font-size: var(--fs-xs); color: var(--ink-3); white-space: normal; }

/* 最近失败: code + time + model, then the plain-word reason; rows split by one hairline */
.me-ov__errs { list-style: none; margin: 0; padding: 0; }
.me-ov__err { display: grid; gap: 2px; padding: 8px 0; border-bottom: 1px solid var(--rule); }
.me-ov__err:first-child { padding-top: 2px; }
.me-ov__err:last-child { border-bottom: 0; }
.me-ov__err-l1 { display: flex; align-items: baseline; gap: 10px; min-width: 0; font-size: var(--fs-sm); }
.me-ov__err-code { color: var(--signal-ink); flex: none; }
.me-ov__err-t { color: var(--ink-3); flex: none; }
.me-ov__err-m { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--ink); }
.me-ov__err-l2 { font-size: var(--fs-xs); color: var(--ink-2); }

/* 接入 */
.me-ov__warn { margin-top: 6px; color: var(--signal-ink); }
.me-ov__more { display: flex; flex-wrap: wrap; gap: 6px 18px; margin-top: 10px; }

@media (max-width: 1179px) {
  .me-ov__a1, .me-ov__a2 { grid-column: span 6; }
  .me-ov__b1 { grid-column: span 7; }
  .me-ov__b2 { grid-column: span 5; }
}
@media (max-width: 959px) {
  .me-ov__grid { grid-template-columns: minmax(0, 1fr); gap: 20px; }
  .me-ov__col { display: contents; }
  .me-ov__p1 { order: 1; } .me-ov__p2 { order: 2; } .me-ov__p3 { order: 3; }
  .me-ov__p4 { order: 4; } .me-ov__p5 { order: 5; } .me-ov__p6 { order: 6; }
  .me-ov__quota { gap: 14px; }
  .me-ov__cost { font-size: 36px; }
}
@media (max-width: 599px) {
  .me-ov__free { grid-template-columns: 34px auto minmax(0, 1fr); }
  .me-ov__free-t { display: none; }
  .me-ov__fact dd { font-size: 18px; }
}
</style>

<script setup lang="ts">
import { computed } from 'vue'
import { TxCard } from '@talex-touch/tuffex/card'
import { TxButton } from '@talex-touch/tuffex/button'
import { TxSelect, TxSelectItem } from '@talex-touch/tuffex/select'
import { TxTag } from '@talex-touch/tuffex/tag'
import PageHeader from '../components/PageHeader.vue'
import ErrorPanel from '../components/ErrorPanel.vue'
import LoadingBlock from '../components/LoadingBlock.vue'
import EmptyState from '../components/EmptyState.vue'
import { api } from '../api'
import { useQueryState } from '../lib/listState'
import { useResource } from '../lib/resource'
import { fmtCompact, fmtLatency, fmtPercent } from '../lib/format'
import type { ApiKeyItem, ChartsData } from '../types'

/**
 * 图表分析：真的请求 /api/charts（红队 D3：原来 18 行占位、永久显示「加载图表数据中...」且从不发请求）。
 * 加载态用受控骨架：有数据就绝不显示（对照 TUF `components/LoadingBlock.vue:10-13` 的用法）。
 * 统计周期与 Key 进 URL，刷新/分享链接保持同一视图。
 */
const scope = useQueryState({ days: '7', keyId: '' })
const days = computed(() => {
  const value = Number(scope.state.days)
  return [1, 7, 30, 90].includes(value) ? value : 7
})

const res = useResource(
  () => api.charts<ChartsData>(days.value, scope.state.keyId),
  [() => scope.state.days, () => scope.state.keyId],
)
const keysRes = useResource(() => api.bootstrap<{ keys: ApiKeyItem[] }>(), [])

const charts = computed(() => res.data.value)
const keys = computed(() => keysRes.data.value?.keys ?? [])
const error = computed(() => res.error.value ?? keysRes.error.value)
const reloadAll = () => Promise.all([res.reload(), keysRes.reload()])

const trend = computed(() => charts.value?.trend ?? [])
const groups = computed(() => charts.value?.groups ?? [])
const models = computed(() => charts.value?.models ?? [])
const latency = computed(() => charts.value?.latency ?? [])
const statusCodes = computed(() => charts.value?.statusCodes ?? [])
const errorCategories = computed(() => charts.value?.errorCategories ?? [])

const totals = computed(() => {
  const requests = trend.value.reduce((acc, point) => acc + point.requests, 0)
  const errors = trend.value.reduce((acc, point) => acc + point.errors, 0)
  // task-77 恢复：旧 Charts 有「Token 消耗（每小时 Token 总量）」块，Vue 版被砍；`trend[].tokens` 后端一直在返回
  const tokens = trend.value.reduce((acc, point) => acc + (point.tokens ?? 0), 0)
  return { requests, errors, tokens, errorRate: requests ? errors / requests : 0 }
})

/** 趋势折线：与概览页同一套 viewBox 口径，窄屏按容器宽度自适应，不做横向溢出。 */
const VIEW = { width: 720, height: 200, padding: 28 }
const line = computed(() => {
  const points = trend.value
  if (!points.length) return ''
  const max = Math.max(...points.map((p) => p.requests), 1)
  const innerW = VIEW.width - VIEW.padding * 2
  const innerH = VIEW.height - VIEW.padding * 2
  return points
    .map((point, index) => {
      const x = VIEW.padding + (index / Math.max(points.length - 1, 1)) * innerW
      const y = VIEW.height - VIEW.padding - (point.requests / max) * innerH
      return `${index === 0 ? 'M' : 'L'} ${x.toFixed(1)} ${y.toFixed(1)}`
    })
    .join(' ')
})

/** Token 消耗折线：与请求趋势同一套 viewBox 口径（旧页是「每小时 Token 总量」，这里按时间桶）。 */
const tokenLine = computed(() => {
  const points = trend.value
  if (!points.length) return ''
  const max = Math.max(...points.map((p) => p.tokens ?? 0), 1)
  const innerW = VIEW.width - VIEW.padding * 2
  const innerH = VIEW.height - VIEW.padding * 2
  return points
    .map((point, index) => {
      const x = VIEW.padding + (index / Math.max(points.length - 1, 1)) * innerW
      const y = VIEW.height - VIEW.padding - ((point.tokens ?? 0) / max) * innerH
      return `${index === 0 ? 'M' : 'L'} ${x.toFixed(1)} ${y.toFixed(1)}`
    })
    .join(' ')
})

const topModels = computed(() =>
  [...models.value].sort((a, b) => b.requests - a.requests).slice(0, 8),
)
const topGroups = computed(() =>
  [...groups.value].sort((a, b) => b.requests - a.requests).slice(0, 8),
)
const slowest = computed(() =>
  [...latency.value].sort((a, b) => (b.p95 || b.avgLatency || 0) - (a.p95 || a.avgLatency || 0)).slice(0, 8),
)
const maxModelRequests = computed(() => Math.max(1, ...topModels.value.map((m) => m.requests)))
const maxGroupRequests = computed(() => Math.max(1, ...topGroups.value.map((g) => g.requests)))
const maxStatusCount = computed(() => Math.max(1, ...statusCodes.value.map((s) => s.count)))

const isEmpty = computed(
  () => !trend.value.length && !groups.value.length && !models.value.length && !statusCodes.value.length,
)

function setDays(value: string | number) {
  scope.state.days = String(value)
}
function setKey(value: string | number) {
  scope.state.keyId = String(value)
}
</script>

<template>
  <div class="page">
    <PageHeader
      title="图表分析"
      description="多维度趋势分析、用量分布与请求延迟分布可视化；统计周期与 Key 写在地址栏里。"
    >
      <template #actions>
        <TxSelect :model-value="scope.state.keyId" placeholder="选择 API Key" class="w-180px" @update:model-value="setKey">
          <TxSelectItem value="" label="全部 API Key" />
          <TxSelectItem v-for="k in keys" :key="k.id" :value="k.id" :label="k.name" />
        </TxSelect>
        <TxSelect :model-value="scope.state.days" placeholder="统计周期" class="w-130px" @update:model-value="setDays">
          <TxSelectItem value="1" label="最近 24 小时" />
          <TxSelectItem value="7" label="最近 7 天" />
          <TxSelectItem value="30" label="最近 30 天" />
          <TxSelectItem value="90" label="最近 90 天" />
        </TxSelect>
        <TxButton variant="secondary" :loading="res.loading.value" @click="reloadAll">刷新</TxButton>
      </template>
    </PageHeader>

    <!-- 失败：可读原因 + 重试；首次加载：骨架；其余：保留旧数据继续渲染，刷新不闪空 -->
    <ErrorPanel v-if="error && !charts" :error="error" :retry="reloadAll" />
    <LoadingBlock v-else-if="!charts && !error" :lines="8" label="正在读取图表数据" />
    <TxCard v-else-if="isEmpty">
      <EmptyState
        title="选定的周期内没有调用数据"
        description="把统计周期调长一些，或先让客户端发起几次调用。"
        action-label="看最近 30 天"
        size="medium"
        @action="setDays(30)"
      />
    </TxCard>

    <template v-else>
    <!-- R2：有旧数据时刷新失败不再顶掉内容，只在顶部给非阻断横幅（有意偏离 TUF 的阻断式错误态） -->
    <ErrorPanel v-if="error" inline :error="error" :retry="reloadAll"
      stale-hint="下方仍是最近一次成功读取的图表数据，可以继续查看。" />

      <div class="charts-stats">
        <TxCard class="stat">
          <span class="stat-label">请求总量</span>
          <strong class="stat-value">{{ fmtCompact(totals.requests) }}</strong>
        </TxCard>
        <TxCard class="stat">
          <span class="stat-label">错误数</span>
          <strong class="stat-value">{{ fmtCompact(totals.errors) }}</strong>
        </TxCard>
        <TxCard class="stat">
          <span class="stat-label">错误率</span>
          <strong class="stat-value" :class="{ bad: totals.errorRate > 0.05 }">{{ fmtPercent(totals.errorRate) }}</strong>
        </TxCard>
        <TxCard class="stat">
          <span class="stat-label">Token 总量</span>
          <strong class="stat-value">{{ fmtCompact(totals.tokens) }}</strong>
        </TxCard>
        <TxCard class="stat">
          <span class="stat-label">时间桶</span>
          <strong class="stat-value">{{ trend.length }}</strong>
        </TxCard>
      </div>

      <TxCard :padding="16">
        <template #header>
          <div class="card-head">
            <strong>请求趋势</strong>
            <span class="count">{{ days }} 天 · 共 {{ trend.length }} 个时间桶</span>
          </div>
        </template>
        <div class="trend-wrap">
          <svg viewBox="0 0 720 200" class="trend-svg" preserveAspectRatio="none" role="img" aria-label="请求量趋势折线">
            <line x1="28" y1="172" x2="692" y2="172" stroke="var(--tx-border-color-lighter)" stroke-width="1" />
            <path :d="line" fill="none" stroke="var(--tx-color-primary)" stroke-width="2.2" stroke-linecap="round" />
          </svg>
        </div>
      </TxCard>

      <!-- task-77 恢复：旧 React 版的「Token 消耗（每小时 Token 总量）」折线，Vue 重写时被砍 -->
      <TxCard :padding="16">
        <template #header>
          <div class="card-head">
            <strong>Token 消耗</strong>
            <span class="count">每个时间桶的 Token 总量</span>
          </div>
        </template>
        <div class="trend-wrap">
          <svg viewBox="0 0 720 200" class="trend-svg" preserveAspectRatio="none" role="img" aria-label="Token 消耗趋势折线">
            <line x1="28" y1="172" x2="692" y2="172" stroke="var(--tx-border-color-lighter)" stroke-width="1" />
            <path :d="tokenLine" fill="none" stroke="var(--tx-color-primary)" stroke-width="2.2" stroke-linecap="round" />
          </svg>
        </div>
      </TxCard>

      <div class="charts-grid">
        <TxCard :padding="16">
          <template #header>
            <div class="card-head"><strong>模型用量 Top 8</strong><span class="count">{{ models.length }} 个模型</span></div>
          </template>
          <ul class="bar-list">
            <li v-for="m in topModels" :key="m.name" class="bar-row">
              <span class="bar-name" :title="m.name">{{ m.name }}</span>
              <span class="bar-track"><span class="bar-fill" :style="{ width: `${(m.requests / maxModelRequests) * 100}%` }" /></span>
              <span class="mono bar-value">{{ fmtCompact(m.requests) }}</span>
            </li>
            <li v-if="!topModels.length" class="muted text-12">该周期无模型调用</li>
          </ul>
        </TxCard>

        <TxCard :padding="16">
          <template #header>
            <div class="card-head"><strong>渠道分组用量 Top 8</strong><span class="count">{{ groups.length }} 个分组</span></div>
          </template>
          <ul class="bar-list">
            <li v-for="g in topGroups" :key="g.name" class="bar-row">
              <span class="bar-name" :title="g.name">{{ g.name }}</span>
              <span class="bar-track"><span class="bar-fill" :style="{ width: `${(g.requests / maxGroupRequests) * 100}%` }" /></span>
              <span class="mono bar-value">{{ fmtCompact(g.requests) }}</span>
            </li>
            <li v-if="!topGroups.length" class="muted text-12">该周期无分组数据</li>
          </ul>
        </TxCard>

        <TxCard :padding="16">
          <template #header>
            <div class="card-head"><strong>最慢的上游（按 P95）</strong><span class="count">{{ latency.length }} 条</span></div>
          </template>
          <ul class="bar-list">
            <li v-for="l in slowest" :key="l.name" class="bar-row">
              <span class="bar-name" :title="l.name">{{ l.name }}</span>
              <span class="bar-meta mono">
                P95 {{ fmtLatency(l.p95) }} · 均值 {{ fmtLatency(l.avgLatency) }}
              </span>
            </li>
            <li v-if="!slowest.length" class="muted text-12">该周期无延迟数据</li>
          </ul>
        </TxCard>

        <TxCard :padding="16">
          <template #header>
            <div class="card-head"><strong>状态码与错误类别</strong><span class="count">{{ statusCodes.length }} 种状态码</span></div>
          </template>
          <ul class="bar-list">
            <li v-for="s in statusCodes" :key="s.code" class="bar-row">
              <span class="bar-name mono">{{ s.code }}</span>
              <span class="bar-track">
                <span
                  class="bar-fill"
                  :class="{ bad: s.code >= 400 }"
                  :style="{ width: `${(s.count / maxStatusCount) * 100}%` }"
                />
              </span>
              <span class="mono bar-value">{{ fmtCompact(s.count) }}</span>
            </li>
          </ul>
          <div v-if="errorCategories.length" class="tags">
            <TxTag
              v-for="c in errorCategories"
              :key="c.category"
              size="sm"
              variant="outline"
              :label="`${c.category} · ${fmtCompact(c.count)}`"
            />
          </div>
        </TxCard>
      </div>
    </template>
  </div>
</template>

<style scoped>
.charts-stats {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
  gap: 12px;
}
.charts-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(320px, 1fr));
  gap: 16px;
  align-items: start;
}
.stat {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.stat-label {
  font-size: 12px;
  color: var(--tx-text-color-secondary);
}
.stat-value {
  font-size: 22px;
  color: var(--tx-text-color-primary);
}
.stat-value.bad {
  color: var(--tx-color-danger);
}
.card-head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  width: 100%;
}
.card-head .count {
  margin-left: auto;
  font-size: 12px;
  color: var(--tx-text-color-secondary);
}
.trend-wrap {
  width: 100%;
  overflow: hidden;
}
.trend-svg {
  display: block;
  width: 100%;
  height: 200px;
}
.bar-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.bar-row {
  display: grid;
  grid-template-columns: minmax(0, 1.2fr) minmax(0, 1.4fr) auto;
  align-items: center;
  gap: 10px;
  font-size: 12px;
}
.bar-name {
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  color: var(--tx-text-color-primary);
}
.bar-meta {
  grid-column: 2 / -1;
  color: var(--tx-text-color-secondary);
}
.bar-track {
  height: 6px;
  border-radius: 999px;
  background: var(--tx-fill-color);
  overflow: hidden;
}
.bar-fill {
  display: block;
  height: 100%;
  border-radius: 999px;
  background: var(--tx-color-primary);
}
.bar-fill.bad {
  background: var(--tx-color-danger);
}
.bar-value {
  text-align: right;
  color: var(--tx-text-color-secondary);
}
.tags {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 12px;
}
.w-180px {
  width: min(180px, 46vw);
}
.w-130px {
  width: min(130px, 40vw);
}
@media (max-width: 640px) {
  .bar-row {
    grid-template-columns: minmax(0, 1fr) auto;
  }
  .bar-track {
    grid-column: 1 / -1;
  }
}
</style>

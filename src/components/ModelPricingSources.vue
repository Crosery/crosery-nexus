<script setup lang="ts">
/**
 * task-78 ①：模型总览里的**双源价格**展示（models.dev / openrouter 并排 + 各自时间戳）。
 *
 * 由 Lead 决定挂载点（我不改 `src/pages/RtkPage.vue` 与 `src/styles/**`）。
 * 建议挂在 `模型总览`（ModelsPage.vue）的模型详情/行展开处；数据直接来自
 * `GET /api/public/model-catalog` 的 `models[]`（每条含 `pricing` / `pricingSources` /
 * `availableOnGateway` / `unpriced`，见 `server/modelCatalog.ts`）。
 *
 * 三条展示纪律：
 * 1. 两个来源**并排**显示，能直接看出是否一致、差多少；
 * 2. 取不到的来源显示「未收录」，**绝不显示 0**（0 会被读成"免费"）；
 * 3. 降级可见：来源整体不可用/陈旧时给出显式横幅，而不是拿旧值冒充新值。
 */
import { computed } from 'vue'
import { TxTag } from '@talex-touch/tuffex/tag'

type SourcePrice = { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; sourceId?: string; fetchedAt?: number }
type SourceStatus = { ok?: boolean; fetchedAt?: number; entries?: number; error?: string }

const props = defineProps<{
  /** 单个模型条目（来自模型目录接口） */
  model: {
    id: string
    availableOnGateway?: boolean
    unpriced?: boolean
    pricingSources?: Partial<Record<'models.dev' | 'openrouter', SourcePrice>>
    pricing?: { input: number; output: number; cacheRead: number; cacheWrite?: number } | null
  }
  /** 来源整体状态（可选）：来源 ok=false / 从未同步时给出显式横幅 */
  sourceStatus?: { sources?: Partial<Record<'models.dev' | 'openrouter', SourceStatus>>; degraded?: string[]; loadedAt?: number | null }
}>()

const SOURCES = [
  { id: 'models.dev' as const, label: 'models.dev' },
  { id: 'openrouter' as const, label: 'OpenRouter' },
]

const price = (source: 'models.dev' | 'openrouter') => props.model.pricingSources?.[source]

/** 缺失就是缺失：返回 null 让模板渲染「未收录」，而不是 0。 */
const value = (source: 'models.dev' | 'openrouter', field: keyof SourcePrice): number | null => {
  const raw = price(source)?.[field]
  return typeof raw === 'number' && Number.isFinite(raw) ? raw : null
}

const fetchTime = (source: 'models.dev' | 'openrouter'): string | null => {
  const at = price(source)?.fetchedAt
  return typeof at === 'number' && at > 0 ? new Date(at).toLocaleString() : null
}

/** 两个来源都有报价时，直接给出差异（人不用自己算）。 */
const diff = computed(() => {
  const a = value('models.dev', 'input')
  const b = value('openrouter', 'input')
  if (a === null || b === null || a === b) return null
  const delta = Math.abs(a - b)
  const base = Math.max(a, b)
  return { input: delta, percent: base > 0 ? (delta / base) * 100 : 0, cheaper: a < b ? 'models.dev' : 'openrouter' }
})

/** 整体降级：来源失败 / 从未同步 / 某来源缺席时都要能看见。 */
const degradedNotice = computed(() => {
  const status = props.sourceStatus
  if (!status) return null
  const failures = SOURCES.filter(source => status.sources?.[source.id]?.ok === false)
  if (failures.length) {
    return `${failures.map(source => source.label).join('、')} 本次取不到：${failures.map(source => status.sources?.[source.id]?.error || '未知原因').join('；')}`
  }
  if (status.degraded?.length) {
    const reasons: Record<string, string> = {
      'shared-pricing-not-loaded': '价格来源尚未同步（共享产物里还没有 pricing 段）',
      'shared-pricing-missing': '共享产物缺少 pricing 段（老版本产物或同步未跑）',
      'shared-pricing-empty': '共享产物里的价格为空',
    }
    return status.degraded.map(reason => reasons[reason] || reason).join('；')
  }
  return null
})

const money = (amount: number | null) => (amount === null ? '未收录' : `$${amount.toFixed(amount < 1 ? 4 : 2)}`)
</script>

<template>
  <div class="model-pricing-sources">
    <div class="mps-head">
      <span class="mps-id">{{ props.model.id }}</span>
      <TxTag v-if="props.model.availableOnGateway === false" size="small" type="warning">仅目录收录</TxTag>
      <TxTag v-if="props.model.unpriced" size="small" type="info">未收录价格</TxTag>
    </div>

    <p v-if="degradedNotice" class="mps-degraded">⚠ 价格来源降级：{{ degradedNotice }}（下方数字可能不完整，缺失项显示「未收录」）</p>
    <p v-if="diff" class="mps-diff">
      两源输入价相差 ${{ diff.input.toFixed(diff.input < 1 ? 4 : 2) }}/M（{{ diff.percent.toFixed(1) }}%），{{ diff.cheaper }} 更低
    </p>

    <table class="mps-table">
      <thead>
        <tr><th>来源</th><th>输入</th><th>输出</th><th>缓存读</th><th>缓存写</th><th>抓取时间</th></tr>
      </thead>
      <tbody>
        <tr v-for="source in SOURCES" :key="source.id">
          <td>{{ source.label }}</td>
          <td>{{ money(value(source.id, 'input')) }}</td>
          <td>{{ money(value(source.id, 'output')) }}</td>
          <td>{{ money(value(source.id, 'cacheRead')) }}</td>
          <td>{{ money(value(source.id, 'cacheWrite')) }}</td>
          <td class="mps-time">{{ fetchTime(source.id) || '未收录' }}</td>
        </tr>
      </tbody>
    </table>
    <p class="mps-unit">单位：美元 / 百万 token（0 与「未收录」是两件事：前者是免费，后者是没有数据）</p>
  </div>
</template>

<style scoped>
.model-pricing-sources { display: flex; flex-direction: column; gap: 6px; font-size: 12px; }
.mps-head { display: flex; align-items: center; gap: 6px; }
.mps-id { font-family: var(--font-mono, monospace); }
.mps-degraded { color: var(--color-warning, #b26a00); margin: 0; }
.mps-diff { margin: 0; opacity: .8; }
.mps-table { border-collapse: collapse; }
.mps-table th, .mps-table td { padding: 2px 10px 2px 0; text-align: left; }
.mps-time { opacity: .7; }
.mps-unit { margin: 0; opacity: .6; }
</style>

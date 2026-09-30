<script setup lang="ts">
import { computed } from 'vue'
import { TxModal } from '@talex-touch/tuffex/modal'
import { TxButton } from '@talex-touch/tuffex/button'
import { TxTag } from '@talex-touch/tuffex/tag'
import { CLIENT_LABELS } from '../clientLabels'
import { channelLabel } from '../channelLabels'
import type { RequestDetailItem } from '../types'

const props = defineProps<{
  modelValue: boolean
  request: RequestDetailItem | null
}>()

const emit = defineEmits<{
  (e: 'update:modelValue', value: boolean): void
  (e: 'close'): void
}>()

const open = computed({
  get: () => props.modelValue,
  set: (val: boolean) => emit('update:modelValue', val),
})

function formatTime(iso?: string) {
  if (!iso) return '—'
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString('zh-CN')
}
</script>

<template>
  <TxModal v-model="open" :title="request ? `请求详情 · ${request.model}` : '请求详情'" width="min(92vw, 680px)" @close="emit('close')">
    <div v-if="request" class="request-detail-body">
      <div class="detail-grid">
        <div class="detail-item">
          <span class="detail-label">请求时间</span>
          <span class="detail-value mono">{{ formatTime(request.timestamp) }}</span>
        </div>
        <div class="detail-item">
          <span class="detail-label">客户端 Key</span>
          <span class="detail-value">{{ request.keyName || '未知' }}</span>
        </div>
        <div class="detail-item">
          <span class="detail-label">调用客户端</span>
          <span class="detail-value">
            {{ CLIENT_LABELS[request.clientType || 'unknown'] || '未知' }}
            <small v-if="request.userAgent" class="muted"> ({{ request.userAgent }})</small>
          </span>
        </div>
        <div class="detail-item">
          <span class="detail-label">来源 IP</span>
          <span class="detail-value mono">{{ request.clientIp || '未记录' }}</span>
        </div>
        <div class="detail-item">
          <span class="detail-label">渠道来源</span>
          <span class="detail-value">
            {{ request.provider ? channelLabel(request.provider) : '未记录' }}
            <small v-if="request.provider && channelLabel(request.provider) !== request.provider" class="muted"> ({{ request.provider }})</small>
          </span>
        </div>
        <div class="detail-item">
          <span class="detail-label">模型分组</span>
          <span class="detail-value">{{ request.modelGroup || '未记录' }}</span>
        </div>
        <div class="detail-item">
          <span class="detail-label">请求入口</span>
          <span class="detail-value mono">{{ request.endpoint || '未记录' }}</span>
        </div>
        <div class="detail-item">
          <span class="detail-label">HTTP 状态</span>
          <span class="detail-value">
            <TxTag :label="String(request.statusCode ?? '—')" :color="request.success ? '#10b981' : '#ef4444'" size="sm" variant="soft" />
          </span>
        </div>
        <div class="detail-item">
          <span class="detail-label">耗时</span>
          <span class="detail-value mono">{{ request.latencyMs }} ms <small v-if="request.ttftMs" class="muted">(首 Token: {{ request.ttftMs }}ms)</small></span>
        </div>
        <div class="detail-item">
          <span class="detail-label">思考等级</span>
          <span class="detail-value">{{ request.reasoningEffort || '无' }}</span>
        </div>
        <div class="detail-item full-width">
          <span class="detail-label">请求 ID</span>
          <code class="detail-code mono">{{ request.requestId }}</code>
        </div>
        <div v-if="request.upstreamRequestId" class="detail-item full-width">
          <span class="detail-label">上游请求 ID</span>
          <code class="detail-code mono">{{ request.upstreamRequestId }}</code>
        </div>
        <div class="detail-item full-width">
          <span class="detail-label">Token 构成</span>
          <div class="token-breakdown">
            <span>输入: <strong>{{ (request.inputTokens ?? 0).toLocaleString('zh-CN') }}</strong></span>
            <span>输出: <strong>{{ (request.outputTokens ?? 0).toLocaleString('zh-CN') }}</strong></span>
            <span>推理: <strong>{{ (request.reasoningTokens ?? 0).toLocaleString('zh-CN') }}</strong></span>
            <span>缓存读: <strong>{{ ((request.cachedTokens ?? request.cacheReadTokens) ?? 0).toLocaleString('zh-CN') }}</strong></span>
            <span>缓存写: <strong>{{ (request.cacheWriteTokens || 0).toLocaleString('zh-CN') }}</strong></span>
          </div>
        </div>
        <div class="detail-item full-width">
          <span class="detail-label">缓存与成本</span>
          <div class="token-breakdown">
            <span>命中率: <strong>{{ request.hitRate !== null && request.hitRate !== undefined ? `${(request.hitRate * 100).toFixed(1)}%` : '未计算' }}</strong></span>
            <span>花费: <strong>{{ request.costUsd !== null && request.costUsd !== undefined ? `$${request.costUsd.toFixed(5)}` : '未定价' }}</strong></span>
          </div>
        </div>
        <div v-if="request.errorDetail" class="detail-item full-width error-item">
          <span class="detail-label">错误正文</span>
          <pre class="error-pre mono">{{ request.errorDetail }}</pre>
        </div>
      </div>
    </div>
    <template #footer>
      <TxButton variant="ghost" @click="open = false">关闭</TxButton>
    </template>
  </TxModal>
</template>

<style scoped>
.request-detail-body {
  padding: 4px 0;
}
.detail-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px 16px;
}
.detail-item {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.detail-item.full-width {
  grid-column: 1 / -1;
}
.detail-label {
  font-size: 11.5px;
  color: var(--tx-text-color-secondary, #6d6760);
  font-weight: 500;
}
.detail-value {
  font-size: 13px;
  color: var(--tx-text-color-primary, #2d2a26);
  word-break: break-all;
}
.detail-code {
  display: block;
  padding: 6px 10px;
  background: var(--tx-fill-color, #f4f2ec);
  border-radius: 6px;
  font-size: 11.5px;
  word-break: break-all;
  border: 1px solid var(--tx-border-color, #e3e1db);
}
.mono {
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
}
.muted {
  color: var(--tx-text-color-secondary, #6d6760);
}
.token-breakdown {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  font-size: 12px;
  padding: 6px 10px;
  background: var(--tx-fill-color, #f4f2ec);
  border-radius: 6px;
  border: 1px solid var(--tx-border-color, #e3e1db);
}
.error-pre {
  margin: 0;
  padding: 8px 12px;
  background: rgba(239, 68, 68, 0.08);
  border: 1px solid rgba(239, 68, 68, 0.3);
  border-radius: 6px;
  color: #b91c1c;
  font-size: 12px;
  white-space: pre-wrap;
  word-break: break-all;
}
</style>

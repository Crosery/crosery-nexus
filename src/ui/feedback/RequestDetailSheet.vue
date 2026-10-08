<script setup lang="ts">
import { computed } from 'vue'
import { TxIconButton } from '@talex-touch/tuffex/button'
import Sheet from './Sheet.vue'
import StateBlock from '../data/StateBlock.vue'
import Icon from '../Icon.vue'
import { copyText } from './toast'
import { fmtClock, fmtDuration, fmtInt, fmtPct, fmtUsd, NONE } from '../fmt'
import { CLIENT_LABELS } from '../../clientLabels'
import { channelLabel } from '../../channelLabels'
import type { RequestDetailItem } from '../../types'
import type { DataState } from '../types'

/**
 * Request detail (DESIGN.md §5.2 feedback/RequestDetailSheet): the RequestDetail facts in a right sheet
 * (bottom on mobile). Status reads `✓ 200` / `◆ 429`; ids are mono with copy; the error body is a wrapped
 * mono block. The page loads the item (by requestId) and passes `state` while it does.
 */
const props = withDefaults(
  defineProps<{
    request: RequestDetailItem | null
    state?: DataState
    error?: unknown
    /** error_category → plain words (the page's table); the raw code stays as a mono suffix */
    categoryLabel?: (category: string) => string
  }>(),
  { state: 'ready', error: null, categoryLabel: (category: string) => category },
)
const open = defineModel<boolean>({ default: false })
const emit = defineEmits<{ retry: [] }>()

const ok = computed(() => Boolean(props.request?.success))
const facts = computed(() => {
  const r = props.request
  if (!r) return []
  return [
    { k: '时间', v: fmtClock(r.timestamp) },
    { k: 'Key', v: r.keyName || '未知' },
    { k: '客户端', v: CLIENT_LABELS[r.clientType || 'unknown'] || '未知', sub: r.userAgent },
    { k: '来源 IP', v: r.clientIp || '未记录', mono: true },
    { k: '渠道', v: r.provider ? channelLabel(r.provider) : '未记录' },
    { k: '模型分组', v: r.modelGroup || '未记录' },
    { k: '入口', v: r.endpoint || '未记录', mono: true },
    { k: '耗时', v: `${fmtDuration(r.latencyMs)}${r.ttftMs ? ` · 首字 ${fmtDuration(r.ttftMs)}` : ''}`, mono: true },
    { k: '思考等级', v: r.reasoningEffort || '无' },
    { k: '花费', v: r.costUsd == null ? '未定价' : fmtUsd(r.costUsd, { digits: 5 }), mono: true },
    { k: '缓存命中', v: r.hitRate == null ? '未计算' : fmtPct(r.hitRate), mono: true },
  ]
})
const tokens = computed(() => {
  const r = props.request
  if (!r) return []
  return [
    { k: '输入', v: r.inputTokens },
    { k: '输出', v: r.outputTokens },
    { k: '推理 (计入输出)', v: r.reasoningTokens },
    { k: '缓存读', v: r.cachedTokens ?? r.cacheReadTokens },
    { k: '缓存写', v: r.cacheWriteTokens },
  ]
})
</script>

<template>
  <Sheet v-model="open" :title="request ? `请求详情 · ${request.model}` : '请求详情'" en="REQUEST">
    <StateBlock v-if="state !== 'ready' && state !== 'stale'" :state="state" :error="error" :rows="8" @retry="emit('retry')" />
    <div v-else-if="request" class="ui-reqd">
      <p class="ui-reqd__status" :class="{ 'is-bad': !ok }">
        <span aria-hidden="true">{{ ok ? '✓' : '◆' }}</span> {{ request.statusCode ?? NONE }}
        <template v-if="request.errorCategory">
          · {{ categoryLabel(request.errorCategory) }}
          <span v-if="categoryLabel(request.errorCategory) !== request.errorCategory" class="dim mono">{{ request.errorCategory }}</span>
        </template>
      </p>
      <dl class="ui-reqd__facts">
        <template v-for="f in facts" :key="f.k">
          <dt>{{ f.k }}</dt>
          <dd :class="{ mono: f.mono }">{{ f.v }}<small v-if="f.sub" class="dim"> {{ f.sub }}</small></dd>
        </template>
      </dl>
      <div class="ui-reqd__ids">
        <div v-for="id in [{ k: '请求 ID', v: request.requestId }, { k: '上游请求 ID', v: request.upstreamRequestId }].filter((x) => x.v)" :key="id.k" class="ui-reqd__id">
          <span class="micro">{{ id.k }}</span>
          <code>{{ id.v }}</code>
          <TxIconButton :label="`复制${id.k}`" :title="`复制${id.k}`" size="sm" @click="copyText(id.v as string, id.k)"><Icon name="copy" /></TxIconButton>
        </div>
      </div>
      <h3 class="ui-reqd__h">Token</h3>
      <dl class="ui-reqd__facts">
        <template v-for="t in tokens" :key="t.k"><dt>{{ t.k }}</dt><dd class="mono">{{ fmtInt(t.v ?? null) }}</dd></template>
      </dl>
      <template v-if="request.errorDetail">
        <h3 class="ui-reqd__h">错误正文</h3>
        <pre class="ui-reqd__err">{{ request.errorDetail }}</pre>
      </template>
    </div>
  </Sheet>
</template>

<style>
.ui-reqd { display: grid; gap: 14px; }
.ui-reqd__status { margin: 0; font-family: var(--font-mono); font-size: var(--fs-md); color: var(--ink); }
.ui-reqd__status.is-bad, .ui-reqd__status.is-bad > span:first-child { color: var(--signal-ink); }
.ui-reqd__facts { display: grid; grid-template-columns: max-content minmax(0, 1fr); margin: 0; font-size: var(--fs-sm); border-top: 1px solid var(--rule); }
.ui-reqd__facts dt, .ui-reqd__facts dd { margin: 0; padding: 6px 0; border-bottom: 1px solid var(--rule); }
.ui-reqd__facts dt { padding-right: 18px; color: var(--ink-3); }
.ui-reqd__facts dd { color: var(--ink); overflow-wrap: anywhere; }
.ui-reqd__facts dd.mono { font-family: var(--font-mono); }
.ui-reqd__ids { display: grid; gap: 6px; }
.ui-reqd__id { display: grid; grid-template-columns: max-content minmax(0, 1fr) auto; align-items: center; gap: 10px; }
.ui-reqd__id code { font-family: var(--font-mono); font-size: var(--fs-sm); overflow-wrap: anywhere; }
.ui-reqd__h { margin: 4px 0 0; font-family: var(--font-mono); font-size: var(--fs-micro); font-weight: 500; letter-spacing: .09em; text-transform: uppercase; color: var(--ink-3); }
.ui-reqd__err { margin: 0; padding: 10px 12px; background: var(--paper-2); box-shadow: inset 2px 0 0 var(--signal); font-family: var(--font-mono); font-size: var(--fs-xs); line-height: 1.55; white-space: pre-wrap; overflow-wrap: anywhere; max-height: 40vh; overflow: auto; }
</style>

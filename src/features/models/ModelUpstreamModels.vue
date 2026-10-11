<script setup lang="ts">
/**
 * 上游实际模型分布面板（挂在 ModelSheet 里）：
 * 消费 `GET /api/models/:model/upstream-models?days=7`，展示某请求模型被上游实际响应成了哪些模型、
 * 各占比/次数，并支持展开查看每个实际模型落在哪些账号（authIndex）上。
 */
import { computed, onBeforeUnmount, ref, shallowRef, watch } from 'vue'
import { TxTag } from '@talex-touch/tuffex/tag'
import StateBlock from '../../ui/data/StateBlock.vue'
import Icon from '../../ui/Icon.vue'
import { fmtInt } from '../../ui/fmt'
import { errorStatus } from '../../lib/errors'
import { api } from '../../api'
import {
  buildUpstreamModelsView,
  toggleUpstreamModelExpanded,
  type UpstreamModelsPayload,
} from './modelRows'
import type { DataState } from '../../ui/types'

const props = withDefaults(
  defineProps<{
    /** canonical 模型标识（如 `gemini-3.8-flash-high`） */
    modelKey: string
    /** 展示用请求模型 id */
    modelId?: string
    /** 抽屉打开时才请求 */
    active?: boolean
    days?: number
  }>(),
  { modelId: '', active: true, days: 7 },
)

const payload = shallowRef<UpstreamModelsPayload | null>(null)
const loadedKey = ref('')
const loading = ref(false)
const fetchError = shallowRef<unknown>(null)
const expanded = ref<Set<string>>(new Set())

let abortController: AbortController | null = null
let seq = 0

function cancelInFlight() {
  if (abortController) {
    abortController.abort()
    abortController = null
  }
}

async function loadUpstream() {
  const key = props.modelKey.trim()
  if (!props.active || !key) return
  if (loadedKey.value !== key) {
    payload.value = null
    expanded.value = new Set()
  }
  cancelInFlight()
  const controller = new AbortController()
  abortController = controller
  const mine = ++seq
  loading.value = true
  fetchError.value = null
  try {
    const result = await api.modelUpstreamModels(key, props.days, controller.signal)
    if (mine !== seq) return
    payload.value = result
    loadedKey.value = key
  } catch (err) {
    if (controller.signal.aborted || mine !== seq) return
    fetchError.value = err
  } finally {
    if (mine === seq) loading.value = false
  }
}

watch(
  () => [props.active, props.modelKey, props.days] as const,
  ([isOpen, key]) => {
    if (isOpen && key) void loadUpstream()
    else if (!isOpen) cancelInFlight()
  },
  { immediate: true },
)

onBeforeUnmount(cancelInFlight)

const state = computed<DataState>(() => {
  if (loading.value && !payload.value) return 'loading'
  if (fetchError.value) return errorStatus(fetchError.value) === 403 ? 'forbidden' : 'error'
  return 'ready'
})

const view = computed(() => buildUpstreamModelsView(payload.value, props.modelId || props.modelKey, props.days))
const requestedLabel = computed(() => props.modelId || view.value.requested || props.modelKey)

function onToggleModel(model: string) {
  expanded.value = toggleUpstreamModelExpanded(expanded.value, model)
}
</script>

<template>
  <section class="mum" aria-label="上游实际模型">
    <h3 class="mum__h">
      上游实际模型
      <span v-if="state === 'ready' && view.total > 0" class="num mum__h-n">近 {{ view.days }} 天 {{ fmtInt(view.total) }} 次</span>
      <span v-if="state === 'ready' && view.status !== 'empty'" class="mum__h-note" :class="{ 'is-rewrite': view.status === 'rewritten' }">
        {{ view.status === 'unchanged' ? '✓ 上游未改写' : `◇ ${view.summary}` }}
      </span>
    </h3>

    <StateBlock
      v-if="state !== 'ready'"
      :state="state"
      :error="fetchError"
      :rows="2"
      :cols="['1fr', '72px', '52px']"
      :row-height="32"
      title="读取上游实际模型失败"
      eager
      @retry="loadUpstream"
    />

    <p v-else-if="view.status === 'empty'" class="mum__empty">— {{ view.summary }}（暂无调用或上游未返回实际模型）</p>

    <div v-else class="mum__body">
      <p class="mum__lead">
        <template v-if="view.status === 'unchanged'">
          上游未改写 · 请求 <code class="num">{{ requestedLabel }}</code> 全部按原模型响应
        </template>
        <template v-else>
          请求 <code class="num">{{ requestedLabel }}</code> → 实际响应分布（点击展开各账号次数）
        </template>
      </p>

      <ul class="mum__list" role="list">
        <li v-for="item in view.rows" :key="item.model" class="mum__item" :class="{ 'is-open': expanded.has(item.model) }">
          <button
            type="button"
            class="mum__row"
            :aria-expanded="expanded.has(item.model)"
            @click="onToggleModel(item.model)"
          >
            <Icon name="chev-right" :size="13" class="mum__chev" :class="{ 'is-open': expanded.has(item.model) }" />
            <span class="mum__model num" :title="item.model">{{ item.model }}</span>
            <TxTag v-if="item.rewritten" size="sm" variant="outline" label="改写" />
            <TxTag v-else-if="view.rows.length > 1" size="sm" variant="plain" label="原模型" />
            <span v-if="item.accounts.length" class="mum__acccnt num">{{ fmtInt(item.accountCount) }} 账号</span>
            <i class="mum__bar" aria-hidden="true"><b :style="{ width: `${Math.max(4, item.share * 100)}%` }" /></i>
            <span class="mum__req num">{{ fmtInt(item.requests) }} 次</span>
            <span class="mum__pct num">{{ item.shareText }}</span>
          </button>

          <ul v-if="expanded.has(item.model) && item.accounts.length" class="mum__accs" :aria-label="`${item.model} 账号分布`">
            <li v-for="acc in item.accounts" :key="acc.key" class="mum__acc">
              <span class="mum__acc-id num" :class="{ 'is-anon': !acc.authIndex }" :title="acc.label">{{ acc.label }}</span>
              <i class="mum__acc-bar" aria-hidden="true"><b :style="{ width: `${Math.max(3, acc.share * 100)}%` }" /></i>
              <span class="mum__acc-req num">{{ fmtInt(acc.requests) }} 次</span>
              <span class="mum__acc-pct num">{{ acc.shareText }}</span>
            </li>
          </ul>
        </li>
      </ul>
    </div>
  </section>
</template>

<style scoped>
.mum { display: grid; gap: 8px; min-width: 0; }
.mum__h { display: flex; align-items: baseline; gap: 8px; margin: 0; font-size: var(--fs-sm); font-weight: 600; color: var(--ink); }
.mum__h-n { font-weight: 400; color: var(--ink-3); }
.mum__h-note { margin-left: auto; font-weight: 400; color: var(--ink-2); font-size: var(--fs-xs); }
.mum__h-note.is-rewrite { color: var(--ink); }
.mum__empty { margin: 0; font-size: var(--fs-sm); color: var(--ink-3); }
.mum__body { display: grid; gap: 6px; min-width: 0; }
.mum__lead { margin: 0; font-size: var(--fs-xs); color: var(--ink-3); overflow-wrap: anywhere; }
.mum__lead code { color: var(--ink-2); font-family: var(--font-mono); }
.mum__list { margin: 0; padding: 0; list-style: none; border-top: 1px solid var(--rule); }
.mum__item { border-bottom: 1px solid var(--rule); }
.mum__row {
  all: unset; box-sizing: border-box; width: 100%; display: grid;
  grid-template-columns: 14px minmax(0, 1fr) auto auto 52px auto 5ch;
  align-items: center; gap: 8px; min-height: 36px; padding: 6px 2px; cursor: pointer; font-size: var(--fs-sm);
}
.mum__row:hover { background: var(--paper-2); }
.mum__row:focus-visible { outline: 2px solid var(--signal); outline-offset: -2px; }
.mum__chev { color: var(--ink-3); transition: transform var(--dur-2) var(--ease-settle); }
.mum__chev.is-open { transform: rotate(90deg); color: var(--ink); }
.mum__model { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--ink); }
.mum__acccnt { font-size: var(--fs-xs); color: var(--ink-3); white-space: nowrap; }
.mum__bar { display: block; width: 52px; height: 3px; background: var(--paper-3); overflow: hidden; }
.mum__bar > b { display: block; height: 100%; background: var(--ink-2); }
.mum__req { text-align: right; color: var(--ink); white-space: nowrap; font-size: var(--fs-xs); }
.mum__pct { text-align: right; color: var(--ink-3); font-size: var(--fs-xs); }

.mum__accs {
  margin: 0; padding: 4px 6px 8px 22px; list-style: none;
  background: var(--paper-2); display: grid; gap: 4px;
}
.mum__acc {
  display: grid; grid-template-columns: minmax(0, 1fr) 48px auto 5ch;
  align-items: center; gap: 8px; min-height: 24px; font-size: var(--fs-xs);
}
.mum__acc-id { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--ink-2); }
.mum__acc-id.is-anon { color: var(--ink-3); }
.mum__acc-bar { display: block; width: 48px; height: 2px; background: var(--paper-3); overflow: hidden; }
.mum__acc-bar > b { display: block; height: 100%; background: var(--ink-3); }
.mum__acc-req { text-align: right; color: var(--ink-2); white-space: nowrap; }
.mum__acc-pct { text-align: right; color: var(--ink-3); }

@media (max-width: 599px) {
  .mum__row { grid-template-columns: 14px minmax(0, 1fr) auto auto auto 5ch; }
  .mum__bar { display: none; }
}
</style>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import Plate from '../../ui/data/Plate.vue'
import StatusMark from '../../ui/data/StatusMark.vue'
import Switch from '../../ui/form/Switch.vue'
import { api } from '../../api'
import { errorMessage } from '../../lib/errors'
import { notify } from '../../ui/feedback/toast'
import { fmtCompact, fmtInt } from '../../ui/fmt'
import { useLive } from '../../ui/composables/useLive'
import type { RtkRelayStatus, RtkRelayTally } from '../../types'
import type { StatusKind } from '../../ui/types'

/**
 * RTK 中转 (#rtk-relay, server/rtkRelay.ts): the listener in front of the context guard, the global compression
 * switch and what it saved. Shown for both engines; the listener itself is RTK_RELAY_PORT on the host.
 */
const emit = defineEmits<{ index: [value: { value: string; hot: boolean } | null] }>()

const busy = ref(false)
const relay = useLive<RtkRelayStatus>((signal) => api.rtkRelay.get(signal), { intervalMs: 60_000, enabled: () => !busy.value })

const LISTENER: Record<RtkRelayStatus['listener']['state'], { state: StatusKind; label: string }> = {
  listening: { state: 'run', label: '监听中' },
  starting: { state: 'busy', label: '启动中' },
  failed: { state: 'bad', label: '启动失败' },
  off: { state: 'off', label: '未启用' },
}
const mark = computed(() => (relay.data.value ? LISTENER[relay.data.value.listener.state] : null))
const listenerLine = computed(() => {
  const l = relay.data.value?.listener
  if (!l) return ''
  if (l.state === 'off') return '未设置 RTK_RELAY_PORT · 请求不经过中转'
  const route = `127.0.0.1:${l.port} → ${l.target.replace(/^http:\/\//, '')}`
  return l.state === 'failed' ? `${route} · ${l.error || '未知原因'} · 自动重试中` : route
})
const tally = (t: RtkRelayTally) => `约 ${fmtCompact(t.savedTokens)} tok · ${fmtInt(t.requests)} 次请求${t.errors ? ` · 跳过 ${fmtInt(t.errors)}` : ''}`

watch(relay.data, (d) => {
  if (!d) return emit('index', null)
  emit('index', { value: LISTENER[d.listener.state].label, hot: d.listener.state === 'failed' })
}, { immediate: true })

async function setEnabled(enabled: boolean) {
  if (busy.value || !relay.data.value) return
  busy.value = true
  try {
    relay.data.value = await api.rtkRelay.set(enabled)
    relay.error.value = null
    relay.lastAt.value = Date.now()
    notify(`✓ RTK 压缩已${enabled ? '开' : '关'}`, { tone: 'ok', id: 'cx-rtk-relay' })
  } catch (error) {
    notify(`◆ RTK 压缩没改成 · ${errorMessage(error) || '请求失败'}`, { tone: 'bad', id: 'cx-rtk-relay' })
  } finally {
    busy.value = false
    void relay.refresh()
  }
}
</script>

<template>
  <Plate
    id="rtk-relay"
    title="RTK 中转"
    class="set-sec"
    :state="relay.state.value"
    :stale-at="relay.lastAt.value"
    :error="relay.error.value"
    :rows="3"
    @retry="relay.refresh"
  >
    <template #meta><StatusMark v-if="mark" :state="mark.state" :label="mark.label" /></template>
    <div v-if="relay.data.value" class="set-relay">
      <div class="set-relay__row">
        <span class="set-relay__k">监听</span>
        <span class="set-relay__v num">{{ listenerLine }}</span>
      </div>
      <div class="set-relay__row is-switch">
        <span class="set-relay__k">压缩工具输出<small>只对在 Key 里开启的 {{ fmtInt(relay.data.value.optedInKeys) }} 个 Key 生效</small></span>
        <span class="set-relay__v">
          <Switch :model-value="relay.data.value.enabled" :loading="busy" aria-label="RTK 压缩工具输出" @update:model-value="setEnabled" />
        </span>
      </div>
      <div class="set-relay__row">
        <span class="set-relay__k">今日</span>
        <span class="set-relay__v num">{{ tally(relay.data.value.today) }}</span>
      </div>
      <div class="set-relay__row">
        <span class="set-relay__k">累计</span>
        <span class="set-relay__v num">{{ tally(relay.data.value.total) }}</span>
      </div>
      <p class="set-relay__note">tok 是按移除字节 ÷ 4 的估算，不是账单节省 · 跳过 = 压缩出错，请求按原样转发</p>
    </div>
  </Plate>
</template>

<style>
.set-relay { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 4px 40px; padding-bottom: 2px; }
.set-relay__row { display: flex; align-items: center; justify-content: space-between; gap: 12px; min-height: 44px; min-width: 0; }
.set-relay__k { display: grid; gap: 1px; font-size: var(--fs-base); color: var(--ink); min-width: 0; }
.set-relay__k small { font-size: var(--fs-xs); color: var(--ink-3); }
.set-relay__v { display: flex; align-items: center; justify-content: flex-end; min-width: 0; font-size: var(--fs-sm); color: var(--ink-2); text-align: right; overflow-wrap: anywhere; }
.set-relay__note { grid-column: 1 / -1; margin: 4px 0 0; font-size: var(--fs-xs); color: var(--ink-3); }
@media (max-width: 959px) {
  .set-relay { grid-template-columns: minmax(0, 1fr); }
}
@media (max-width: 599px) {
  .set-relay__row:not(.is-switch) { flex-wrap: wrap; row-gap: 4px; padding: 4px 0; }
  .set-relay__v.num { flex: 1 0 100%; justify-content: flex-start; text-align: left; }
}
</style>

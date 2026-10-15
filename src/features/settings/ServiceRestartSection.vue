<script setup lang="ts">
import { TxButton } from '@talex-touch/tuffex/button'
import Plate from '../../ui/data/Plate.vue'
import { api } from '../../api'
import { useLive } from '../../ui/composables/useLive'
import { useServiceRestart } from '../plugins/useServiceRestart'
import type { RestartTarget } from '../../api/plugins'

/** 服务重启 (#service-restart)：控制台没有重启权限，请求由服务器上的 root 单元执行（见 server/serviceRestart.ts）。 */
const status = useLive(() => api.restart.status(), { intervalMs: 0, isEmpty: () => false })

const ITEMS: Array<{ target: RestartTarget; name: string; note: string }> = [
  { target: 'cpa', name: 'CPA 网关', note: '装、卸插件后需要；会中断正在进行的请求，几秒恢复' },
  { target: 'console', name: '控制台', note: '页面断开几秒；不影响 API 请求' },
]
const cpa = useServiceRestart('cpa', () => void status.refresh())
const consoleSvc = useServiceRestart('console', () => void status.refresh())
const handle = { cpa, console: consoleSvc }

function last(target: RestartTarget) {
  const item = status.data.value?.[target]
  if (!item) return '还没重启过'
  if (item.pending) return '已排队，等待执行'
  const at = item.finishedAt ? new Date(item.finishedAt).toLocaleString('zh-CN', { hour12: false }) : ''
  return item.result === 'ok' ? `上次重启 ${at}` : `上次失败 ${at} · ${item.message || ''}`
}
</script>

<template>
  <Plate id="service-restart" title="服务重启" class="set-sec" :state="status.state.value" :error="status.error.value" :rows="2" @retry="status.refresh">
    <div class="set-restart">
      <div v-for="item in ITEMS" :key="item.target" class="set-restart__row">
        <span class="set-restart__k">{{ item.name }}<small>{{ item.note }}</small></span>
        <span class="set-restart__v">
          <span class="set-restart__last">{{ last(item.target) }}</span>
          <TxButton variant="ghost" size="small" :disabled="handle[item.target].restarting.value" @click="handle[item.target].restart()">
            {{ handle[item.target].restarting.value ? '重启中…' : '重启' }}
          </TxButton>
        </span>
      </div>
    </div>
  </Plate>
</template>

<style scoped>
.set-restart { display: flex; flex-direction: column; }
.set-restart__row { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 12px 0; border-top: 1px solid var(--hair, var(--paper-3)); }
.set-restart__row:first-child { border-top: 0; }
.set-restart__k { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.set-restart__k small { font-size: var(--fs-xs); color: var(--ink-3); }
.set-restart__v { display: inline-flex; align-items: center; gap: 12px; flex: none; }
.set-restart__last { font-size: var(--fs-xs); color: var(--ink-3); }
</style>

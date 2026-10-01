<script setup lang="ts">
import { computed } from 'vue'
import { TxCard } from '@talex-touch/tuffex/card'
import { TxTag } from '@talex-touch/tuffex/tag'
import { TxButton } from '@talex-touch/tuffex/button'
import { TxSwitch } from '@talex-touch/tuffex/switch'
import type { RTKStatusResponse, RtkAgentStatus, RtkPlaneId, RtkPlaneProbe, RtkPlaneState } from '../types'

const props = withDefaults(defineProps<{
  status?: RTKStatusResponse | null
  loading?: boolean
  busy?: string | null
}>(), {
  status: null,
  loading: false,
  busy: null,
})

const emit = defineEmits<{
  (e: 'toggle', agent: string, on: boolean): void
  (e: 'remote', plane: RtkPlaneId, on: boolean, agent: string): void
  (e: 'install', plane: RtkPlaneId): void
  (e: 'upgrade', plane: RtkPlaneId): void
  (e: 'rollback', backup: string): void
  (e: 'refresh'): void
}>()

const PLANE_LABEL: Record<RtkPlaneId, string> = {
  kernel: '内核（沙箱 HOME）',
  relay: '中转站',
  local: '本机',
}

const STATE_LABEL: Record<RtkPlaneState, string> = {
  available: '已接通',
  not_configured: '未配置',
  unreachable: '不可达',
  unauthorized: '凭据被拒',
  not_supported: '未提供该接口',
}

const STATE_COLOR: Record<RtkPlaneState, string> = {
  available: '#10b981',
  not_configured: '#94a3b8',
  unreachable: '#f59e0b',
  unauthorized: '#ef4444',
  not_supported: '#f59e0b',
}

const planes = computed<RtkPlaneProbe[]>(() => props.status?.planes || [])
const localAgents = computed<RtkAgentStatus[]>(() => props.status?.localAgents || [])
const authorityAgents = computed<RtkAgentStatus[]>(() => props.status?.agents || [])
const backups = computed(() => props.status?.backups || [])

const fmtNumber = (value: number | undefined) => Number(value || 0).toLocaleString()

/** 权威平面读数说明：内核的 path/version 是「那台机器」的，不是本机。 */
const authorityHint = computed(() => {
  const status = props.status
  if (!status) return ''
  if (status.plane === 'kernel') return '权威数据来自本机内核进程，但内核以沙箱 HOME 运行，其中的 agent 配置不是你这台机器的 ~/.codex / ~/.claude。'
  if (status.plane === 'relay') return '权威数据来自中转站那台机器，不是本机。'
  return '权威数据来自本机：内核与中转站都不可用（或都没有 RTK 接口），已如实回退。'
})
</script>

<template>
  <div class="rtk-board">
    <TxCard :padding="0" class="board-card">
      <div class="board-head">
        <div>
          <p class="eyebrow">RTK CONTROL PLANE</p>
          <h2>RTK 平面</h2>
          <p class="hint">{{ authorityHint }}</p>
        </div>
        <div class="head-actions">
          <TxTag v-if="status" :label="`权威平面：${PLANE_LABEL[status.plane]}${status.plane === 'local' ? '（回退）' : ''}`" :color="status.plane === 'local' ? '#f59e0b' : '#3346c8'" size="sm" />
          <TxButton size="sm" variant="ghost" :disabled="loading" @click="emit('refresh')">{{ loading ? '刷新中…' : '刷新' }}</TxButton>
        </div>
      </div>

      <div class="plane-grid">
        <div v-for="plane in planes" :key="plane.id" class="plane-item">
          <div class="plane-top">
            <strong>{{ PLANE_LABEL[plane.id] }}</strong>
            <TxTag :label="STATE_LABEL[plane.state]" :color="STATE_COLOR[plane.state]" size="sm" />
          </div>
          <code class="mono">{{ plane.reason }}</code>
          <p v-if="plane.id === 'kernel'" class="plane-note">内核以 <code>HOME=&lt;runtime&gt;/home</code> 运行，不含本机 agent 配置。</p>
          <p v-else-if="plane.id === 'relay'" class="plane-note">中转站是否暴露 RTK 管理面由对方部署决定（当前实测 404）。</p>
          <p v-else class="plane-note">本机 = 控制台所在机器，开关真正生效的地方。</p>
          <p v-if="plane.detail" class="plane-detail">{{ plane.detail }}</p>
        </div>
      </div>

      <p v-if="status?.error" class="warn-line">{{ status.error }}</p>

      <div v-if="status" class="authority">
        <div class="authority-item">
          <span>权威平面连通</span>
          <strong>{{ status.connected ? `是${status.version ? ` (v${status.version})` : ''}` : '否' }}</strong>
        </div>
        <div class="authority-item">
          <span>本机 rtk</span>
          <strong>{{ status.local?.connected ? `已安装${status.local.version ? ` (v${status.local.version})` : ''}` : '未安装' }}</strong>
        </div>
        <div class="authority-item">
          <span>Token 节省</span>
          <strong>{{ status.gain && status.gain.commands > 0 ? `${status.gain.pct.toFixed(1)}% · ${fmtNumber(status.gain.saved)} tokens` : '暂无数据' }}</strong>
        </div>
        <div class="authority-item">
          <span>写入模式</span>
          <strong>{{ status.writeMode === 'off' ? '全只读' : status.writeMode === 'confirm' ? '需显式确认' : '本机可写' }}</strong>
        </div>
      </div>
    </TxCard>

    <TxCard :padding="0" class="board-card">
      <div class="board-head">
        <div>
          <h2>本机客户端钩子</h2>
          <p class="hint">开关直接改本机 agent 配置（写前备份、写后校验、失败回滚）。rtk 0.50.0 只有 11 个 agent 支持全局钩子，其余只能按项目初始化。</p>
        </div>
      </div>

      <div class="agent-list">
        <div v-for="agent in localAgents" :key="agent.id" class="agent-row" :class="{ 'agent-row--muted': !agent.supported }">
          <div class="agent-main">
            <span class="agent-name">{{ agent.name }}</span>
            <code class="mono agent-id">{{ agent.id }}</code>
            <TxTag v-if="!agent.supported" label="仅项目级" color="#94a3b8" size="sm" />
            <TxTag v-else-if="agent.installed === false" label="未检测到安装目录" color="#94a3b8" size="sm" />
            <TxTag v-if="agent.on" label="已挂载" color="#10b981" size="sm" />
          </div>
          <div class="agent-action">
            <span v-if="busy === `local:${agent.id}`" class="busy">处理中…</span>
            <TxSwitch
              v-else-if="agent.supported"
              :model-value="agent.on"
              @update:model-value="(value: boolean) => emit('toggle', agent.id, value)"
            />
            <span v-else class="muted">不可全局切换</span>
          </div>
        </div>
      </div>
    </TxCard>

    <TxCard :padding="0" class="board-card">
      <div class="board-head">
        <div>
          <h2>远端下发（默认只读）</h2>
          <p class="hint">写远端需要有对应接口 + 显式开关 + 请求级确认，全部操作进 audit_log。当前中转站为 CPA 主机，没有 RTK 接口，下发一定失败并如实报错。</p>
        </div>
      </div>
      <div class="remote-actions">
        <TxButton size="sm" variant="ghost" :disabled="busy === 'remote:kernel'" @click="emit('remote', 'kernel', true, 'codex')">
          下发 codex 到内核（沙箱 HOME）
        </TxButton>
        <TxButton size="sm" variant="ghost" :disabled="busy === 'remote:relay'" @click="emit('remote', 'relay', true, 'codex')">
          下发 codex 到中转站
        </TxButton>
        <TxButton size="sm" variant="ghost" :disabled="busy === 'install'" @click="emit('install', status?.plane || 'local')">安装 rtk</TxButton>
        <TxButton size="sm" variant="ghost" :disabled="busy === 'upgrade'" @click="emit('upgrade', status?.plane || 'local')">升级 rtk</TxButton>
      </div>
      <p class="warn-line">控制台不代为下载执行安装脚本：安装/升级一律返回 501 与人工命令，除非该平面自己提供接口。</p>
    </TxCard>

    <TxCard :padding="0" class="board-card">
      <div class="board-head">
        <div>
          <h2>权威平面 agent 视图</h2>
          <p class="hint">这是「{{ PLANE_LABEL[status?.plane || 'local'] }}」那台机器上的 RTK 状态，只读展示，与本机开关无关。</p>
        </div>
      </div>
      <div class="agent-list">
        <div v-for="agent in authorityAgents" :key="agent.id" class="agent-row">
          <div class="agent-main">
            <span class="agent-name">{{ agent.name }}</span>
            <code class="mono agent-id">{{ agent.id }}</code>
            <TxTag v-if="agent.on" label="已挂载" color="#10b981" size="sm" />
            <TxTag v-else label="未挂载" color="#94a3b8" size="sm" />
          </div>
        </div>
        <p v-if="!authorityAgents.length" class="hint">该平面没有上报 agent 列表。</p>
      </div>
    </TxCard>

    <TxCard :padding="0" class="board-card">
      <div class="board-head">
        <div>
          <h2>备份与回退</h2>
          <p class="hint">每次写入前把目标文件原样备份，失败自动还原；这里可以一键回退到某次备份。</p>
        </div>
      </div>
      <div class="backup-list">
        <div v-for="backup in backups" :key="backup.id" class="backup-row">
          <div>
            <code class="mono">{{ backup.id }}</code>
            <span class="muted"> · {{ backup.files.length }} 个文件</span>
          </div>
          <TxButton size="sm" variant="ghost" :disabled="busy === `rollback:${backup.id}`" @click="emit('rollback', backup.id)">回退</TxButton>
        </div>
        <p v-if="!backups.length" class="hint">还没有备份记录。</p>
      </div>
    </TxCard>
  </div>
</template>

<style scoped>
.rtk-board {
  display: flex;
  flex-direction: column;
  gap: 16px;
}
.board-card {
  display: flex;
  flex-direction: column;
  padding: 16px;
  gap: 12px;
}
.board-head {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 12px;
}
.board-head h2 {
  margin: 0;
  font-size: 15px;
  font-weight: 700;
  color: var(--tx-text-color-primary, #151b45);
}
.eyebrow {
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.05em;
  color: var(--tx-color-primary, #3346c8);
  margin: 0 0 2px;
}
.hint {
  margin: 4px 0 0;
  font-size: 12.5px;
  color: var(--tx-text-color-secondary, #535b85);
  line-height: 1.5;
}
.head-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}
.plane-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  gap: 10px;
}
.plane-item {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 10px;
  background: var(--tx-fill-color, #eceff8);
  border: 1px solid var(--tx-border-color, #d5daec);
  border-radius: 6px;
}
.plane-top {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 8px;
}
.plane-top strong {
  font-size: 13px;
}
.plane-note,
.plane-detail {
  margin: 0;
  font-size: 11.5px;
  color: var(--tx-text-color-secondary, #535b85);
  line-height: 1.45;
}
.plane-detail {
  color: #b45309;
}
.authority {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(170px, 1fr));
  gap: 10px;
}
.authority-item {
  display: flex;
  flex-direction: column;
  gap: 2px;
  font-size: 12px;
  color: var(--tx-text-color-secondary, #535b85);
}
.authority-item strong {
  color: var(--tx-text-color-primary, #151b45);
  font-size: 13px;
}
.warn-line {
  margin: 0;
  font-size: 12px;
  color: #b45309;
  line-height: 1.5;
}
.agent-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.agent-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 10px;
  padding: 8px 10px;
  border: 1px solid var(--tx-border-color, #d5daec);
  border-radius: 6px;
}
.agent-row--muted {
  opacity: 0.7;
}
.agent-main {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.agent-name {
  font-size: 13px;
  color: var(--tx-text-color-primary, #151b45);
}
.agent-id {
  font-size: 11.5px;
  color: var(--tx-text-color-secondary, #535b85);
}
.agent-action {
  display: flex;
  align-items: center;
  gap: 8px;
}
.busy,
.muted {
  font-size: 12px;
  color: var(--tx-text-color-secondary, #535b85);
}
.remote-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.backup-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.backup-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 10px;
  padding: 6px 10px;
  border: 1px solid var(--tx-border-color, #d5daec);
  border-radius: 6px;
  font-size: 12px;
}
.mono {
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
}
@media (max-width: 700px) {
  .board-head {
    flex-direction: column;
  }
  .agent-row {
    flex-direction: column;
    align-items: flex-start;
  }
}
</style>

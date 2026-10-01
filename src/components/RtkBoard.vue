<script setup lang="ts">
import { computed } from 'vue'
import { TxCard } from '@talex-touch/tuffex/card'
import MagpieUpdatePanel from './MagpieUpdatePanel.vue'
import { TxTag } from '@talex-touch/tuffex/tag'
import { TxButton } from '@talex-touch/tuffex/button'
import { TxSwitch } from '@talex-touch/tuffex/switch'
import type { MagpieUpdateStatus, RTKStatusResponse, RtkAgentStatus, RtkPlaneId, RtkPlaneProbe, RtkPlaneState } from '../types'

const props = withDefaults(defineProps<{
  status?: RTKStatusResponse | null
  loading?: boolean
  busy?: string | null
  /** magpie 内核更新状态（task-79；由 RtkPage 拉取后下发）。 */
  update?: MagpieUpdateStatus | null
  /** 更新动作进行中（按钮禁用 + 文案）。 */
  updateBusy?: boolean
}>(), {
  status: null,
  loading: false,
  busy: null,
  update: null,
  updateBusy: false,
})

const emit = defineEmits<{
  (e: 'toggle', agent: string, on: boolean): void
  (e: 'remote', plane: RtkPlaneId, on: boolean, agent: string): void
  (e: 'install', plane: RtkPlaneId): void
  (e: 'upgrade', plane: RtkPlaneId): void
  (e: 'rollback', backup: string): void
  (e: 'refresh'): void
  (e: 'update-check'): void
  (e: 'update-rehearse'): void
  (e: 'update-apply'): void
}>()

const PLANE_LABEL: Record<RtkPlaneId, string> = {
  kernel: '内核（沙箱 HOME）',
  relay: '远端网关',
  local: '本机',
}

const STATE_LABEL: Record<RtkPlaneState, string> = {
  available: '已接通',
  degraded: '可用但未装 rtk',
  not_configured: '未配置',
  unreachable: '不可达',
  unauthorized: '凭据被拒',
  not_supported: '未提供该接口',
}

const STATE_COLOR: Record<RtkPlaneState, string> = {
  available: '#065f46',
  degraded: '#92400e',
  not_configured: '#5b6b85',
  unreachable: '#92400e',
  unauthorized: '#ef4444',
  not_supported: '#92400e',
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
  if (status.plane === 'relay') return '权威数据来自远端网关那台机器，不是本机。'
  return '权威数据来自本机：内核与远端网关都不可用（或都没有 RTK 接口），已如实回退。'
})
</script>

<template>
  <div class="rtk-board">
    <TxCard :padding="0" class="board-card">
      <div class="board-head">
        <div>
          <h2>RTK 平面</h2>
          <p class="hint">{{ authorityHint }}</p>
        </div>
        <div class="head-actions">
          <TxTag v-if="status" :label="`权威平面：${PLANE_LABEL[status.plane]}${status.plane === 'local' ? '（回退）' : ''}`" :color="status.plane === 'local' ? '#92400e' : '#3346c8'" size="sm" />
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
          <p v-else-if="plane.id === 'relay'" class="plane-note">远端网关是否暴露 RTK 管理面由对方部署决定（当前实测 404）。</p>
          <p v-else class="plane-note">本机 = 控制台所在机器，开关真正生效的地方。</p>
          <p v-if="plane.detail" class="plane-detail">{{ plane.detail }}</p>
        </div>
      </div>

      <p v-if="status?.error" class="warn-line">{{ status.error }}</p>

      <div v-if="status" class="authority-block">
        <p class="authority-title">关键事实</p>
        <div class="authority">
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
      </div>
    </TxCard>

    <TxCard :padding="0" class="board-card">
      <div class="board-head">
        <div>
          <h2>本机客户端钩子</h2>
          <p class="hint">开关直接改本机 agent 配置（写前备份、写后校验、失败回滚）。rtk 0.50.0 只有 11 个 agent 支持全局钩子，其余只能按项目初始化。</p>
          <ul class="note-list">
            <li>改完要<strong>重启该客户端</strong>：运行中的进程不会热加载 hook。</li>
            <li>首次触发若客户端询问是否信任 hook，需要允许。</li>
            <li>想确认真的生效：新开一次会话，跑 <code class="mono">rtk gain --daily</code> 看 <code class="mono">total_saved</code> 有没有涨。</li>
          </ul>
        </div>
      </div>

      <div class="agent-list">
        <div v-for="agent in localAgents" :key="agent.id" class="agent-row" :class="{ 'agent-row--muted': !agent.supported }">
          <div class="agent-main">
            <span class="agent-name">{{ agent.name }}</span>
            <code class="mono agent-id">{{ agent.id }}</code>
            <TxTag v-if="!agent.supported" label="仅项目级" color="#475569" size="sm" />
            <TxTag v-else-if="agent.installed === false" label="未检测到安装目录" color="#475569" size="sm" />
            <TxTag v-if="agent.on" label="已挂载" color="#065f46" size="sm" />
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
          <p class="hint">写远端需要有对应接口 + 显式开关 + 请求级确认，全部操作进 audit_log。当前远端网关为 CPA 主机，没有 RTK 接口，下发一定失败并如实报错。</p>
        </div>
      </div>
      <div class="remote-actions">
        <TxButton size="sm" variant="ghost" :disabled="busy === 'remote:kernel'" @click="emit('remote', 'kernel', true, 'codex')">
          下发 codex 到内核（沙箱 HOME）
        </TxButton>
        <TxButton size="sm" variant="ghost" :disabled="busy === 'remote:relay'" @click="emit('remote', 'relay', true, 'codex')">
          下发 codex 到远端网关
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
            <TxTag v-if="agent.on" label="已挂载" color="#065f46" size="sm" />
            <TxTag v-else label="未挂载" color="#475569" size="sm" />
          </div>
        </div>
        <p v-if="!authorityAgents.length" class="hint">该平面没有上报 agent 列表。</p>
      </div>
    </TxCard>

    <TxCard :padding="0" class="board-card">
      <div class="board-head">
        <div>
          <h2>备份与回退</h2>
          <p class="hint">写入前原样备份，失败自动回填。</p>
          <dl class="fact-list">
            <div><dt>保留份数</dt><dd>{{ status?.backupKeep ?? 10 }} 份（RTK_BACKUP_KEEP 可调），超出自动轮转</dd></div>
            <div><dt>保护窗口</dt><dd>{{ Math.round((status?.backupGraceMs ?? 120000) / 1000) }} 秒内新建的备份不会被轮转删掉</dd></div>
            <div v-if="status?.backupOrphans"><dt>孤儿目录</dt><dd>{{ status.backupOrphans }} 个（无 manifest），过保护窗口自动清理</dd></div>
            <div v-if="status?.backupForeign"><dt>外来目录</dt><dd>{{ status.backupForeign }} 个，只计数不删</dd></div>
          </dl>
        </div>
      </div>
      <div class="backup-list">
        <div v-for="backup in backups" :key="backup.id" class="backup-row">
          <div>
            <code class="mono">{{ backup.id }}</code>
            <span class="muted"> · {{ backup.fileCount }} 个文件</span>
          </div>
          <TxButton size="sm" variant="ghost" :disabled="busy === `rollback:${backup.id}`" @click="emit('rollback', backup.id)">回退</TxButton>
        </div>
        <p v-if="!backups.length" class="hint">还没有备份记录。</p>
      </div>
    </TxCard>

    <!-- 相关设置：把维护类操作收在一起，别散落在几张卡片里 -->
    <TxCard :padding="0" class="board-card">
      <div class="board-head">
        <div>
          <h2>内核更新</h2>
          <p class="hint">从上游取最新 magpie，校验后原子替换；失败自动回滚。默认只读，替换需要显式确认。</p>
        </div>
      </div>
      <MagpieUpdatePanel
        :status="update"
        :available="update?.capability !== false"
        :busy="updateBusy"
        @check="emit('update-check')"
        @rehearse="emit('update-rehearse')"
        @apply="emit('update-apply')"
      />
      <p v-if="update && update.capability === false" class="warn-line">
        更新能力不可用：{{ update.reason || '未说明原因' }}
      </p>
    </TxCard>
  </div>
</template>

<style scoped>
.rtk-board {
  display: flex;
  flex-direction: column;
  /* 卡片之间 24px、卡片内 20px：**外部间隔 > 内部留白**，否则一排卡片会粘成一块。
     这是"紧凑粘连"的根因，别调回 16。 */
  gap: 24px;
}
.board-card {
  display: flex;
  flex-direction: column;
  padding: 20px 22px;
  gap: 16px;
}
.board-head {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 16px;
  /* 标题上方留白（卡片 padding 20px）大于下方（12px），符合"标题上多下少"的排版规范。 */
  margin-bottom: 4px;
}
.board-head h2 {
  margin: 0;
  font-size: 15px;
  font-weight: 700;
  color: var(--tx-text-color-primary, #151b45);
}
.hint {
  margin: 6px 0 0;
  font-size: 12.5px;
  color: var(--tx-text-color-secondary, #535b85);
  line-height: 1.5;
}
/* 「写完 ≠ 生效」：三条短句，扫一眼就能记住，不用读整段。 */
.note-list {
  margin: 10px 0 0;
  padding-left: 18px;
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 12.5px;
  line-height: 1.55;
  color: var(--tx-text-color-secondary, #535b85);
}
.note-list strong {
  color: var(--tx-text-color-primary, #1f2547);
}
/* 事实行：标签在左、值在右。把一整段说明拆成可逐行扫读的结构。 */
.fact-list {
  margin: 10px 0 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
  font-size: 12.5px;
}
.fact-list > div {
  display: flex;
  gap: 12px;
}
.fact-list dt {
  flex: none;
  width: 72px;
  color: var(--tx-text-color-secondary, #535b85);
}
.fact-list dd {
  margin: 0;
  color: var(--tx-text-color-primary, #1f2547);
}
.head-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}
.plane-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  gap: 12px;
}
.plane-item {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 14px;
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
  color: #78350f;
}
/* 关键事实：与上方平面卡片之间用一条分隔线 + 更大的上间距分开，
   否则两组数据在同一张卡里会读成连续的一坨（用户报的"紧凑粘连"）。 */
.authority-block {
  margin-top: 4px;
  padding-top: 16px;
  border-top: 1px solid var(--tx-border-color-light, #e3e7f3);
}
.authority-title {
  margin: 0 0 12px;
  font-size: 12px;
  font-weight: 600;
  color: var(--tx-text-color-secondary, #535b85);
}
.authority {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(170px, 1fr));
  gap: 20px;
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
  color: #78350f;
  line-height: 1.5;
}
.agent-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
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
  /* 字号交给全局行内 code 主角色（task-34：12px/18px），这里只保留颜色。
     原来写 11.5px 是 `/rtk` 行内 code 在全站的唯一例外。 */
  color: var(--tx-text-color-secondary, #535b85);
}
.agent-action {
  display: flex;
  align-items: center;
  gap: 8px;
}
.busy {
  /* 运行中指示是独立角色，保持紧凑的 12px。 */
  font-size: 12px;
  color: var(--tx-text-color-secondary, #535b85);
}
.muted {
  /* 不再覆盖字号：`.muted` 是全局次要文字主角色（task-34：13px/19.5px）。
     原来这里与 .busy 共用一条 12px，是 `/rtk` 在全站的唯一例外。 */
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

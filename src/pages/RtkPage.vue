<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { TxAlert } from '@talex-touch/tuffex/alert'
import { TxButton } from '@talex-touch/tuffex/button'
import { TxModal } from '@talex-touch/tuffex/modal'
import RtkBoard from '../components/RtkBoard.vue'
import { api, RtkApiError } from '../api'
import type { RTKStatusResponse, RtkPlaneId } from '../types'

const emit = defineEmits<{ (e: 'notify', message: string): void }>()

const status = ref<RTKStatusResponse | null>(null)
const loading = ref(false)
const busy = ref<string | null>(null)
const errorText = ref('')
const notice = ref('')

type PendingAction = { kind: 'local'; agent: string; on: boolean }
  | { kind: 'remote'; plane: RtkPlaneId; agent: string; on: boolean }
  | { kind: 'install' | 'upgrade'; plane: RtkPlaneId }
  | { kind: 'rollback'; backup: string }

const pending = ref<PendingAction | null>(null)

const PLANE_LABEL: Record<RtkPlaneId, string> = { kernel: '内核（沙箱 HOME）', relay: '中转站', local: '本机' }

function describeError(error: unknown): string {
  if (error instanceof RtkApiError) {
    const bits = [`HTTP ${error.status}`, error.message]
    if (error.plane) bits.push(`平面=${error.plane}`)
    if (error.reason) bits.push(`原因=${error.reason}`)
    if (error.backup) bits.push(`备份=${error.backup}`)
    return bits.join(' · ')
  }
  return error instanceof Error ? error.message : '未知错误'
}

async function load() {
  loading.value = true
  try {
    status.value = await api.getRTKStatus()
    errorText.value = ''
  } catch (error) {
    errorText.value = describeError(error)
  } finally {
    loading.value = false
  }
}

async function run(action: PendingAction) {
  busy.value = action.kind === 'local' || action.kind === 'remote' ? `${action.kind}:${(action as { agent: string }).agent}` : action.kind
  notice.value = ''
  try {
    if (action.kind === 'local') {
      const result = await api.toggleRTK(action.agent, action.on, { plane: 'local', confirm: true })
      const extra = result.mechanism ? `（机制：${result.mechanism}${result.fallbackReason ? '，CLI 失败后走已核实 schema 兜底' : ''}）` : ''
      const collateral = result.collateralRestored?.length ? `；已修复被 rtk 连带改动：${result.collateralRestored.join(', ')}` : ''
      notice.value = `${action.agent} 已${action.on ? '挂载' : '卸载'}${extra}${collateral}`
      status.value = result
    } else if (action.kind === 'remote') {
      const result = await api.toggleRTK(action.agent, action.on, { plane: action.plane, confirm: true })
      notice.value = `已下发到 ${PLANE_LABEL[action.plane]}：${action.agent} ${action.on ? 'ON' : 'OFF'}`
      status.value = result
    } else if (action.kind === 'install' || action.kind === 'upgrade') {
      const handler = action.kind === 'install' ? api.installRTK : api.upgradeRTK
      status.value = await handler({ plane: action.plane, confirm: true })
      notice.value = `${action.kind} 成功`
    } else {
      const result = await api.rollbackRTK(action.backup)
      notice.value = `已回退到 ${result.backupId}（${result.restored.join(', ') || '无文件'}）`
      status.value = result
    }
    errorText.value = ''
    emit('notify', notice.value)
  } catch (error) {
    errorText.value = describeError(error)
  } finally {
    busy.value = null
    await load()
  }
}

const confirmAction = () => {
  const action = pending.value
  pending.value = null
  if (action) void run(action)
}

onMounted(load)
</script>

<template>
  <div class="page-stack rtk-page">
    <section class="page-head">
      <div class="page-head__text">
        <p class="eyebrow">RTK</p>
        <h1>RTK Token 压缩</h1>
        <p>按「内核 → 中转站 → 本机」顺序解析权威平面，逐平面如实上报可用性；开关只写本机 agent 配置，远端默认只读。</p>
      </div>
    </section>

    <TxAlert v-if="errorText" type="error" title="操作失败（未做任何静默降级）" :closable="false">
      {{ errorText }}
    </TxAlert>
    <TxAlert v-else-if="notice" type="success" :closable="false">{{ notice }}</TxAlert>

    <RtkBoard :status="status" :loading="loading" :busy="busy" @refresh="load"
      @toggle="(agent: string, on: boolean) => (pending = { kind: 'local', agent, on })"
      @remote="(plane: RtkPlaneId, on: boolean, agent: string) => (pending = { kind: 'remote', plane, agent, on })"
      @install="(plane: RtkPlaneId) => (pending = { kind: 'install', plane })"
      @upgrade="(plane: RtkPlaneId) => (pending = { kind: 'upgrade', plane })"
      @rollback="(backup: string) => (pending = { kind: 'rollback', backup })" />

    <TxModal :model-value="pending !== null" title="确认操作" width="min(94vw, 520px)" @update:model-value="(value: boolean) => { if (!value) pending = null }">
      <div class="confirm-body">
        <template v-if="pending?.kind === 'local'">
          <p>将{{ pending.on ? '挂载' : '卸载' }} <strong>{{ pending.agent }}</strong> 的 RTK 钩子到<strong>本机</strong> agent 配置。</p>
          <p class="muted">写入前会备份 <code>~/.{{ pending.agent }}</code> 相关文件，只增删 rtk 自己那一条，第三方钩子保持不变；失败自动还原。</p>
        </template>
        <template v-else-if="pending?.kind === 'remote'">
          <p>将把 <strong>{{ pending.agent }}</strong> 的开关下发到 <strong>{{ PLANE_LABEL[pending.plane] }}</strong>。</p>
          <p class="muted">远端写入默认关闭：需要 RTK_ALLOW_REMOTE_WRITE=1（内核另需 RTK_ALLOW_KERNEL_WRITE=1）且本机中转站真的提供 RTK 接口；否则会如实返回 403/501。</p>
        </template>
        <template v-else-if="pending?.kind === 'install' || pending?.kind === 'upgrade'">
          <p>{{ pending.kind === 'install' ? '安装' : '升级' }} rtk（目标平面：{{ PLANE_LABEL[pending.plane] }}）。</p>
          <p class="muted">控制台不代为下载执行安装脚本：平面没有该接口时会返回 501 与人工命令。</p>
        </template>
        <template v-else-if="pending?.kind === 'rollback'">
          <p>用备份 <code>{{ pending.backup }}</code> 覆盖当前 agent 配置。</p>
          <p class="muted">写入过的文件回滚，原本不存在的文件会被删除。</p>
        </template>
        <div class="confirm-actions">
          <TxButton size="sm" variant="ghost" @click="pending = null">取消</TxButton>
          <TxButton size="sm" @click="confirmAction">确认执行</TxButton>
        </div>
      </div>
    </TxModal>
  </div>
</template>

<style scoped>
.rtk-page {
  display: flex;
  flex-direction: column;
  gap: 16px;
  width: 100%;
}
.page-head__text h1 {
  margin: 0;
  font-size: 24px;
  font-weight: 700;
  color: var(--tx-text-color-primary, #151b45);
}
.page-head__text p {
  margin: 4px 0 0;
  color: var(--tx-text-color-secondary, #535b85);
  font-size: 13.5px;
  line-height: 1.5;
}
.eyebrow {
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.05em;
  color: var(--tx-color-primary, #3346c8);
  margin: 0 0 2px;
}
.confirm-body {
  display: flex;
  flex-direction: column;
  gap: 8px;
  font-size: 13px;
  color: var(--tx-text-color-primary, #151b45);
}
.confirm-body p {
  margin: 0;
  line-height: 1.55;
}
.muted {
  color: var(--tx-text-color-secondary, #535b85);
  font-size: 12.5px;
}
.confirm-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 6px;
}
</style>

<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { TxAlert } from '@talex-touch/tuffex/alert'
import { TxButton } from '@talex-touch/tuffex/button'
import RtkBoard from '../components/RtkBoard.vue'
import { api, RtkApiError } from '../api'
import { confirm } from '../lib/confirm'
import type { RTKStatusResponse, RtkPlaneId } from '../types'

const emit = defineEmits<{ (e: 'notify', message: string): void }>()

const status = ref<RTKStatusResponse | null>(null)
const loading = ref(false)
const busy = ref<string | null>(null)
/** 失败原因必须持久可见：只有用户下一次操作或手动关闭才清除（load() 绝不清理它）。 */
const errorText = ref('')
const notice = ref('')

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

/** 加载状态：成功与失败都不动 errorText，避免把刚发生的失败提示冲掉（红队缺陷 5）。 */
async function load() {
  loading.value = true
  try {
    status.value = await api.getRTKStatus()
  } catch (error) {
    errorText.value = describeError(error)
  } finally {
    loading.value = false
  }
}

const dismissError = () => { errorText.value = '' }
const dismissNotice = () => { notice.value = '' }

async function toggleLocal(agent: string, on: boolean) {
  const ok = await confirm({
    title: `确认${on ? '挂载' : '卸载'} ${agent} 的 RTK 钩子？`,
    body: `将修改本机的 ${agent} agent 配置：只增删 rtk 自己那一条，第三方钩子保持不变；写入前会备份，失败会按备份回填。若 rtk 连带改动了别的客户端，控制台会把连带改动一并撤回并在结果里说明。`,
    confirmText: on ? '挂载' : '卸载',
    danger: !on,
  })
  if (!ok) return
  busy.value = `local:${agent}`
  errorText.value = ''
  notice.value = ''
  try {
    const result = await api.toggleRTK(agent, on, { plane: 'local', confirm: true })
    const bits: string[] = [`${agent} 已${on ? '挂载' : '卸载'}`]
    if (result.mechanism) bits.push(`机制=${result.mechanism}${result.fallbackReason ? '（CLI 失败后走已核实 schema 兜底）' : ''}`)
    // 连带改动只认 collateral 这一份数据（与 audit 同源），每个 agent 只有一个最终态
    const reverted = (result.collateral || []).filter(entry => entry.action === 'reverted')
    const restored = (result.collateral || []).filter(entry => entry.action === 'restored')
    if (reverted.length) {
      bits.push(`已撤回 rtk 连带打开的其他客户端：${reverted.map(entry => `${entry.agent}（${entry.files.join('、')}）`).join('；')}`)
    }
    if (restored.length) {
      bits.push(`已修复被 rtk 连带关掉的其他客户端：${restored.map(entry => `${entry.agent}（${entry.files.join('、')}）`).join('；')}`)
    }
    if (result.collateralSkipped?.length) {
      bits.push(`检测到并发修改/结构不认识，未自动还原（请人工确认）：${result.collateralSkipped.map(item => `${item.agent} ${item.file}（${item.reason}）`).join('；')}`)
    }
    if (result.preservedBak?.length) bits.push(`已还原你原有的备份文件：${result.preservedBak.join('、')}`)
    if (result.backupId) bits.push(`本次备份 ${result.backupId}（${result.backupFileCount ?? 0} 个文件）`)
    notice.value = bits.join('；')
    emit('notify', notice.value)
  } catch (error) {
    errorText.value = describeError(error)
  } finally {
    busy.value = null
    await load()
  }
}

async function toggleRemote(plane: RtkPlaneId, agent: string, on: boolean) {
  const ok = await confirm({
    title: `把 ${agent} 下发到${PLANE_LABEL[plane]}？`,
    body: '远端写入默认关闭：需要 RTK_ALLOW_REMOTE_WRITE=1（内核另需 RTK_ALLOW_KERNEL_WRITE=1），且目标确实提供 RTK 接口；否则会如实返回 403/501，不会静默成功。',
    confirmText: '下发',
    danger: true,
  })
  if (!ok) return
  busy.value = `remote:${plane}`
  errorText.value = ''
  notice.value = ''
  try {
    const result = await api.toggleRTK(agent, on, { plane, confirm: true })
    notice.value = `已下发到${PLANE_LABEL[plane]}：${agent} ${on ? 'ON' : 'OFF'}`
    status.value = result
    emit('notify', notice.value)
  } catch (error) {
    errorText.value = describeError(error)
  } finally {
    busy.value = null
    await load()
  }
}

async function binaryAction(kind: 'install' | 'upgrade', plane: RtkPlaneId) {
  const ok = await confirm({
    title: `要${kind === 'install' ? '安装' : '升级'} rtk 吗？`,
    body: `目标平面：${PLANE_LABEL[plane]}。控制台不代为下载执行安装脚本：该平面没有接口时会返回 501 与人工命令。`,
    confirmText: kind === 'install' ? '安装' : '升级',
    danger: true,
  })
  if (!ok) return
  busy.value = kind
  errorText.value = ''
  notice.value = ''
  try {
    const handler = kind === 'install' ? api.installRTK : api.upgradeRTK
    status.value = await handler({ plane, confirm: true })
    notice.value = `${kind} 成功`
    emit('notify', notice.value)
  } catch (error) {
    errorText.value = describeError(error)
  } finally {
    busy.value = null
    await load()
  }
}

async function rollback(backup: string) {
  const ok = await confirm({
    title: '回退到这次备份？',
    body: `用备份 ${backup} 覆盖当前 agent 配置：写入过的文件回滚，原本不存在的文件会被删除。`,
    confirmText: '回退',
    danger: true,
  })
  if (!ok) return
  busy.value = `rollback:${backup}`
  errorText.value = ''
  notice.value = ''
  try {
    const result = await api.rollbackRTK(backup)
    notice.value = `已回退到 ${result.backupId}（${result.restored.join('、') || '无文件'}）`
    status.value = result
    emit('notify', notice.value)
  } catch (error) {
    errorText.value = describeError(error)
  } finally {
    busy.value = null
    await load()
  }
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

    <!-- 失败提示常驻：只有下一次操作或手动关闭才消失（不再被随后的状态刷新清空） -->
    <TxAlert v-if="errorText" type="error" title="操作失败（未做任何静默降级）" :closable="false">
      <span data-testid="rtk-error-text">{{ errorText }}</span>
      <div class="alert-actions">
        <TxButton size="sm" variant="ghost" aria-label="关闭失败提示" @click="dismissError">关闭提示</TxButton>
      </div>
    </TxAlert>
    <TxAlert v-else-if="notice" type="success" :closable="false">
      <span data-testid="rtk-notice-text">{{ notice }}</span>
      <div class="alert-actions">
        <TxButton size="sm" variant="ghost" aria-label="关闭结果提示" @click="dismissNotice">关闭提示</TxButton>
      </div>
    </TxAlert>

    <RtkBoard :status="status" :loading="loading" :busy="busy" @refresh="load"
      @toggle="toggleLocal"
      @remote="(plane: RtkPlaneId, on: boolean, agent: string) => toggleRemote(plane, agent, on)"
      @install="(plane: RtkPlaneId) => binaryAction('install', plane)"
      @upgrade="(plane: RtkPlaneId) => binaryAction('upgrade', plane)"
      @rollback="rollback" />
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
.alert-actions {
  display: flex;
  justify-content: flex-end;
  margin-top: 6px;
}
</style>

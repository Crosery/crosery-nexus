<script setup lang="ts">
import { computed, ref, onMounted } from 'vue'
import { TxCard } from '@talex-touch/tuffex/card'
import { TxButton } from '@talex-touch/tuffex/button'
import { TxTag } from '@talex-touch/tuffex/tag'
import { TxStatusBadge } from '@talex-touch/tuffex/status-badge'
import { TxEmptyState } from '@talex-touch/tuffex/empty-state'
import { TxModal } from '@talex-touch/tuffex/modal'
import { TxAlert } from '@talex-touch/tuffex/alert'
import { api } from '../api'
import type { AccountQuota, MonitorData, QuotaShareWindow, QuotaWindow } from '../types'

const props = withDefaults(defineProps<{
  data?: MonitorData | null
  loading?: boolean
}>(), {
  data: null,
  loading: false,
})

const emit = defineEmits<{
  (e: 'refresh'): void
}>()

const internalData = ref<MonitorData | null>(props.data)
const internalLoading = ref(props.loading)

const confirmingAccount = ref<any>(null)
const confirmModalOpen = ref(false)
const resetting = ref(false)
const resultNotice = ref<{ type: 'success' | 'warning' | 'danger'; message: string } | null>(null)

const PROVIDERS: Record<string, { label: string; logo: string; color: string }> = {
  claude: { label: 'Claude', logo: 'AI', color: '#d97757' },
  codex: { label: 'Codex', logo: 'O', color: '#10b981' },
  antigravity: { label: 'AntiGravity', logo: 'AG', color: '#84cc16' },
}

const PROVIDER_ORDER = ['antigravity', 'claude', 'codex']

async function loadMonitor() {
  internalLoading.value = true
  try {
    const res = await api.monitor<MonitorData>()
    internalData.value = res
  } catch {
    // ignore
  } finally {
    internalLoading.value = false
  }
}

onMounted(() => {
  if (!props.data) loadMonitor()
})

const currentData = computed(() => props.data || internalData.value)
const accounts = computed(() => currentData.value?.accounts || [])
const quotaShare = computed(() => currentData.value?.quotaShare || null)

const providerGroups = computed(() => {
  return PROVIDER_ORDER
    .map(type => ({
      type,
      accounts: accounts.value.filter(a => a.type === type),
    }))
    .filter(g => g.accounts.length > 0)
})

function untilReset(resetsAt: string | null): string {
  if (!resetsAt) return ''
  const target = new Date(resetsAt).getTime()
  if (Number.isNaN(target)) return ''
  const minutes = Math.round((target - Date.now()) / 60000)
  if (minutes <= 0) return '即将重置'
  if (minutes < 60) return `还有 ${minutes} 分钟`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `还有 ${hours} 小时${minutes % 60 ? ` ${minutes % 60} 分钟` : ''}`
  const days = Math.floor(hours / 24)
  return `还有 ${days} 天${hours % 24 ? ` ${hours % 24} 小时` : ''}`
}

function resetClock(resetsAt: string | null) {
  if (!resetsAt) return ''
  const date = new Date(resetsAt)
  if (Number.isNaN(date.getTime())) return ''
  return date.toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

function compactTokens(value: number) {
  if (value >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(1)}B`
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`
  return value.toLocaleString('zh-CN')
}

function openResetConfirm(account: any) {
  confirmingAccount.value = account
  confirmModalOpen.value = true
}

async function executeQuotaReset() {
  if (!confirmingAccount.value) return
  const account = confirmingAccount.value
  resetting.value = true
  resultNotice.value = null

  try {
    if (account.type === 'claude') {
      await api.resetClaudeQuota(String(account.auth_index))
    } else {
      await api.resetCodexQuota(String(account.auth_index))
    }
    confirmModalOpen.value = false
    resultNotice.value = {
      type: 'success',
      message: `已成功重置「${account.email || account.name}」的额度。`,
    }
    emit('refresh')
    await loadMonitor()
  } catch (e) {
    resultNotice.value = {
      type: 'danger',
      message: `额度重置失败：${e instanceof Error ? e.message : '未知错误'}`,
    }
  } finally {
    resetting.value = false
  }
}
</script>

<template>
  <div class="page-stack monitor-page">
    <section class="page-head">
      <div class="page-head__text">
        <p class="eyebrow">UPSTREAM ACCOUNTS</p>
        <h1>上游账号与额度监控</h1>
        <p>按渠道查看 AntiGravity、Claude 与 Codex 官方 OAuth 账号健康度、额度重置倒计时与窗口占用。</p>
      </div>
      <div class="page-head__actions">
        <TxButton variant="secondary" :loading="props.loading || internalLoading" @click="() => { emit('refresh'); loadMonitor() }">
          刷新状态
        </TxButton>
      </div>
    </section>

    <TxAlert v-if="resultNotice" :type="resultNotice.type" :closable="true" @close="resultNotice = null">
      {{ resultNotice.message }}
    </TxAlert>

    <!-- 账号分组 -->
    <div v-if="providerGroups.length" class="provider-groups-stack">
      <div v-for="g in providerGroups" :key="g.type" class="group-section">
        <div class="group-header">
          <div class="group-title-line">
            <span class="provider-dot" :style="{ background: PROVIDERS[g.type]?.color }" />
            <h2>{{ PROVIDERS[g.type]?.label || g.type }}</h2>
          </div>
          <span class="text-muted text-xs">{{ g.accounts.length }} 个接入账号</span>
        </div>

        <!-- 账号卡片网格 -->
        <div class="accounts-grid">
          <TxCard v-for="acc in g.accounts" :key="String(acc.id || acc.auth_index || acc.name)" class="account-card" :padding="16">
            <div class="account-card-header">
              <div class="acc-avatar" :style="{ background: `${PROVIDERS[g.type]?.color}1a`, color: PROVIDERS[g.type]?.color }">
                {{ PROVIDERS[g.type]?.logo || 'AI' }}
              </div>
              <div class="acc-info">
                <span class="acc-email" :title="acc.email || acc.name">{{ acc.email || acc.name }}</span>
                <span class="acc-meta text-muted">
                  {{ acc.type }} · {{ acc.status || 'ready' }}
                  <em v-if="acc.normalizedQuota?.plan" class="plan-tag">{{ acc.normalizedQuota.plan }}</em>
                </span>
              </div>
              <TxStatusBadge :status="acc.disabled ? 'info' : 'success'" :text="acc.disabled ? '已停用' : '运行中'" size="sm" />
            </div>

            <!-- 主动重置可用次数 -->
            <div v-if="acc.normalizedQuota?.resetCredits" class="reset-box">
              <div class="reset-head">
                <span>主动重置次数: <strong>{{ acc.normalizedQuota.resetCredits.available }}</strong> 次</span>
                <TxButton
                  size="sm"
                  variant="outline"
                  :disabled="acc.normalizedQuota.resetCredits.available <= 0 || resetting"
                  @click="openResetConfirm(acc)"
                >
                  重置额度
                </TxButton>
              </div>
            </div>

            <!-- 额度窗口列表 -->
            <div class="windows-stack">
              <div v-for="w in (acc.normalizedQuota?.windows || [])" :key="w.id" class="window-item" :class="`sev-${w.severity}`">
                <div class="window-head">
                  <span class="window-label">{{ w.label }}</span>
                  <span class="window-rem mono">剩余 <strong>{{ Math.max(0, 100 - w.usedPercent) }}%</strong></span>
                </div>
                <div class="window-bar-wrap">
                  <span class="window-bar-fill" :style="{ width: `${Math.max(0, 100 - w.usedPercent)}%` }" />
                </div>
                <div class="window-foot text-xs text-muted">
                  <span>{{ w.resetsAt ? `${resetClock(w.resetsAt)} 重置` : '滚动重置' }}</span>
                  <span v-if="w.resetsAt" class="countdown-text">{{ untilReset(w.resetsAt) }}</span>
                </div>
              </div>
            </div>

            <!-- 错误提示 -->
            <div v-if="acc.normalizedQuota?.error" class="error-strip">
              <small>{{ acc.normalizedQuota.error }}</small>
            </div>
          </TxCard>
        </div>

        <!-- 本窗口各 Key 消耗占比 -->
        <TxCard v-if="quotaShare?.[g.type as 'codex' | 'claude' | 'antigravity']?.keys?.length" class="quota-share-card" :padding="14">
          <div class="share-head">
            <strong>本窗口各 Key 消耗占比</strong>
            <span class="text-xs text-muted">按全量 Token 体量统计</span>
          </div>
          <div class="share-list">
            <div
              v-for="k in quotaShare[g.type as 'codex' | 'claude' | 'antigravity'].keys.slice(0, 8)"
              :key="k.keyId || k.keyName"
              class="share-row"
            >
              <span class="share-name" :title="k.keyName">{{ k.keyName }}</span>
              <div class="share-bar-wrap">
                <span class="share-bar-fill" :style="{ width: `${Math.max(2, Math.round(k.share * 100))}%` }" />
              </div>
              <span class="share-pct mono">{{ (k.share * 100).toFixed(1) }}%</span>
            </div>
          </div>
        </TxCard>
      </div>
    </div>

    <!-- 空状态 -->
    <TxCard v-else :padding="40">
      <TxEmptyState
        title="暂未接入上游监控账号"
        description="系统检测到当前尚未配置或读取到 AntiGravity、Claude 或 Codex 账号凭据。"
      />
    </TxCard>

    <!-- 重置确认 Modal -->
    <TxModal v-model="confirmModalOpen" title="确认重置额度" width="min(90vw, 440px)">
      <div v-if="confirmingAccount" class="reset-confirm-body">
        <p>将消耗 <strong>1 次</strong> 主动重置额度，重置账号「<strong>{{ confirmingAccount.email || confirmingAccount.name }}</strong>」的窗口配额。此操作不可逆，是否继续？</p>
      </div>
      <template #footer>
        <TxButton variant="ghost" :disabled="resetting" @click="confirmModalOpen = false">取消</TxButton>
        <TxButton variant="primary" :loading="resetting" @click="executeQuotaReset">确认重置</TxButton>
      </template>
    </TxModal>
  </div>
</template>

<style scoped>
.monitor-page {
  display: flex;
  flex-direction: column;
  gap: 16px;
  width: 100%;
}
.page-head {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-end;
  justify-content: space-between;
  gap: 16px;
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
}
.eyebrow {
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.05em;
  color: var(--tx-color-primary, #3346c8);
  margin-bottom: 2px;
}
.provider-groups-stack {
  display: flex;
  flex-direction: column;
  gap: 24px;
}
.group-section {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.group-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.group-title-line {
  display: flex;
  align-items: center;
  gap: 8px;
}
.group-title-line h2 {
  margin: 0;
  font-size: 16px;
  font-weight: 700;
  color: var(--tx-text-color-primary, #151b45);
}
.provider-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
}
.accounts-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(360px, 1fr));
  gap: 14px;
}
.account-card {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.account-card-header {
  display: flex;
  align-items: center;
  gap: 10px;
}
.acc-avatar {
  width: 38px;
  height: 38px;
  border-radius: 8px;
  display: grid;
  place-items: center;
  font-weight: 700;
  font-size: 14px;
  flex-shrink: 0;
}
.acc-info {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-width: 0;
}
.acc-email {
  font-size: 13px;
  font-weight: 600;
  color: var(--tx-text-color-primary, #151b45);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.acc-meta {
  font-size: 11px;
}
.plan-tag {
  font-style: normal;
  background: var(--tx-fill-color, #eceff8);
  padding: 1px 4px;
  border-radius: 4px;
  margin-left: 4px;
}
.reset-box {
  padding: 8px 10px;
  background: var(--tx-fill-color, #eceff8);
  border-radius: 6px;
  font-size: 12px;
}
.reset-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.windows-stack {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.window-item {
  padding: 8px 10px;
  border-radius: 6px;
  background: var(--tx-fill-color-light, #f8f9fd);
  border: 1px solid var(--tx-border-color, #d5daec);
  display: flex;
  flex-direction: column;
  gap: 5px;
}
.window-item.sev-critical {
  border-color: #ef4444;
  background: rgba(239, 68, 68, 0.05);
}
.window-item.sev-warning {
  border-color: #f59e0b;
  background: rgba(245, 158, 11, 0.05);
}
.window-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  font-size: 12px;
}
.window-label {
  font-weight: 600;
}
.window-bar-wrap {
  height: 5px;
  border-radius: 999px;
  background: var(--tx-border-color, #d5daec);
  overflow: hidden;
}
.window-bar-fill {
  display: block;
  height: 100%;
  border-radius: 999px;
  background: #10b981;
  transition: width 0.3s ease;
}
.window-item.sev-critical .window-bar-fill {
  background: #ef4444;
}
.window-item.sev-warning .window-bar-fill {
  background: #f59e0b;
}
.window-foot {
  display: flex;
  justify-content: space-between;
}
.countdown-text {
  color: var(--tx-color-primary, #3346c8);
}
.error-strip {
  padding: 6px 10px;
  background: rgba(239, 68, 68, 0.1);
  color: #b91c1c;
  border-radius: 4px;
}
.quota-share-card {
  margin-top: 4px;
}
.share-head {
  display: flex;
  justify-content: space-between;
  font-size: 13px;
  margin-bottom: 8px;
}
.share-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.share-row {
  display: grid;
  grid-template-columns: 140px 1fr 60px;
  align-items: center;
  gap: 12px;
  font-size: 12px;
}
.share-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.share-bar-wrap {
  height: 5px;
  background: var(--tx-fill-color, #eceff8);
  border-radius: 999px;
  overflow: hidden;
}
.share-bar-fill {
  display: block;
  height: 100%;
  background: var(--tx-color-primary, #3346c8);
  border-radius: 999px;
}
.share-pct {
  text-align: right;
  color: var(--tx-text-color-secondary, #535b85);
}
.reset-confirm-body p {
  margin: 0;
  line-height: 1.6;
  font-size: 13.5px;
  color: var(--tx-text-color-primary, #151b45);
}
.text-xs { font-size: 11.5px; }
.text-muted { color: var(--tx-text-color-secondary, #535b85); }
.mono { font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; }
</style>

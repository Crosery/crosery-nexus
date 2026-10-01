<script setup lang="ts">
import { computed, ref } from 'vue'
import { TxCard } from '@talex-touch/tuffex/card'
import { TxButton } from '@talex-touch/tuffex/button'
import { TxStatusBadge } from '@talex-touch/tuffex/status-badge'
import { TxEmptyState } from '@talex-touch/tuffex/empty-state'
import { TxAlert } from '@talex-touch/tuffex/alert'
import PageHeader from '../components/PageHeader.vue'
import ErrorPanel from '../components/ErrorPanel.vue'
import LoadingBlock from '../components/LoadingBlock.vue'
import { api } from '../api'
import { confirm } from '../lib/confirm'
import { useResource } from '../lib/resource'
import { fmtClock, fmtCompact, fmtCountdown, fmtPercent } from '../lib/format'
import type { MonitorData } from '../types'

/**
 * 上游账号与额度监控。
 * 读取走 useResource：失败给持久错误态 + 重试（原来 `catch {}` 把失败吞成「没有账号」）。
 * 额度重置改走全局 `await confirm()`（红队 D26/D31：同一类不可逆操作不再各写一套弹窗）。
 */
const res = useResource(() => api.monitor<MonitorData>(), [])
const loadMonitor = () => res.reload()
const currentData = computed(() => res.data.value)
const accounts = computed(() => currentData.value?.accounts || [])
const quotaShare = computed(() => currentData.value?.quotaShare || null)

const resetting = ref(false)
// TxAlert 的 type 只认 info/success/warning/error，失败态原来是 'danger'（不生效）——改为 'error'。
const resultNotice = ref<{ type: 'success' | 'warning' | 'error'; message: string } | null>(null)

const PROVIDERS: Record<string, { label: string; logo: string; color: string }> = {
  claude: { label: 'Claude', logo: 'AI', color: '#d97757' },
  codex: { label: 'Codex', logo: 'O', color: '#10b981' },
  antigravity: { label: 'AntiGravity', logo: 'AG', color: '#84cc16' },
}

const PROVIDER_ORDER = ['antigravity', 'claude', 'codex']

const providerGroups = computed(() => {
  return PROVIDER_ORDER
    .map(type => ({
      type,
      accounts: accounts.value.filter(a => a.type === type),
    }))
    .filter(g => g.accounts.length > 0)
})

/** 倒计时与重置时刻都按固定时区渲染（src/lib/format.ts），不再跟浏览器时区走。 */
function untilReset(resetsAt: string | null): string {
  if (!resetsAt) return ''
  const target = new Date(resetsAt).getTime()
  if (Number.isNaN(target)) return ''
  const text = fmtCountdown(target - Date.now())
  return text === '即将重置' ? text : `还有 ${text}`
}

function resetClock(resetsAt: string | null) {
  return resetsAt ? fmtClock(resetsAt) : ''
}

function compactTokens(value: number) {
  return fmtCompact(value)
}

async function resetQuota(account: any) {
  const name = account.email || account.name
  const ok = await confirm({
    title: '重置账号窗口额度',
    body: `将消耗 1 次主动重置额度，重置账号「${name}」的窗口额度。此操作不可逆。`,
    confirmText: '重置额度',
    danger: true,
  })
  if (!ok) return
  resetting.value = true
  resultNotice.value = null
  try {
    // 服务端 20260928 补丁起会返回 cooldownCleared：重置成功了但上游失败冷却没清掉时，
    // 客户端仍会被 429 挡住（2026-09-27 那次冷却挂了 5.6 天没人发现）。所以必须把结果读出来，
    // 不能像原来那样把返回值丢掉、无条件报「成功」。
    const result = (account.type === 'claude'
      ? await api.resetClaudeQuota(String(account.auth_index))
      : await api.resetCodexQuota(String(account.auth_index))) as { ok?: boolean; cooldownCleared?: boolean } | undefined
    if (result?.cooldownCleared === true) {
      resultNotice.value = { type: 'success', message: `已重置「${name}」的额度，失败冷却已清除。` }
    } else {
      resultNotice.value = {
        type: 'warning',
        message:
          `已重置「${name}」的额度，但上游失败冷却可能仍未清除：客户端可能仍会被 429 挡住。` +
          '请稍后重试重置，或联系管理员检查 CPA 侧冷却状态。',
      }
    }
    await loadMonitor()
  } catch (e) {
    resultNotice.value = { type: 'error', message: `额度重置失败：${e instanceof Error ? e.message : '未知错误'}` }
  } finally {
    resetting.value = false
  }
}
</script>

<template>
  <div class="page-stack monitor-page">
    <PageHeader
      title="上游账号与额度监控"
      description="按渠道查看 AntiGravity、Claude 与 Codex 官方 OAuth 账号健康度、额度重置倒计时与窗口占用。"
    >
      <template #actions>
        <TxButton variant="secondary" :loading="res.loading.value" @click="loadMonitor">
          刷新状态
        </TxButton>
      </template>
    </PageHeader>

    <TxAlert v-if="resultNotice" :type="resultNotice.type" :closable="true" @close="resultNotice = null">
      {{ resultNotice.message }}
    </TxAlert>

    <!-- 失败：可读原因 + 重试；首次加载：骨架；其余：保留旧数据继续渲染 -->
    <ErrorPanel v-if="res.error.value && !currentData" :error="res.error.value" :retry="loadMonitor" />
    <LoadingBlock v-else-if="!currentData" :lines="6" label="正在读取上游账号状态" />

    <template v-else>
    <!-- R2：有旧数据时刷新失败不再顶掉内容，只在顶部给非阻断横幅（有意偏离 TUF 的阻断式错误态） -->
    <ErrorPanel v-if="res.error.value" inline :error="res.error.value" :retry="loadMonitor"
      stale-hint="下方仍是最近一次成功读取的账号状态，可以继续查看。" />

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
                  :aria-label="`重置额度：${acc.email || acc.name} 的窗口额度`"
                  @click="resetQuota(acc)"
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
              <span class="share-pct mono">{{ fmtPercent(k.share) }}</span>
            </div>
          </div>
        </TxCard>
      </div>
    </div>

    <!-- 空状态 -->
    <TxCard v-else :padding="32">
      <TxEmptyState
        title="暂未接入上游监控账号"
        description="系统检测到当前尚未配置或读取到 AntiGravity、Claude 或 Codex 账号凭据。先在 OAuth 登录池接入一个账号，这里就会出现额度与健康度。"
        primary-action="前往 OAuth 登录池"
        @primary="$router.push('/oauth')"
      />
    </TxCard>
    </template>
  </div>
</template>

<style scoped>
.monitor-page {
  display: flex;
  flex-direction: column;
  gap: 16px;
  width: 100%;
  min-width: 0;
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

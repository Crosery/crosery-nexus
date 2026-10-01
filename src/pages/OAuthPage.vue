<script setup lang="ts">
import { computed, ref, onUnmounted } from 'vue'
import { useRouter } from 'vue-router'
import { TxCard } from '@talex-touch/tuffex/card'
import { TxTag } from '@talex-touch/tuffex/tag'
import { TxButton } from '@talex-touch/tuffex/button'
import { TxInput } from '@talex-touch/tuffex/input'
import { TxAlert } from '@talex-touch/tuffex/alert'
import { TxFilterChips } from '@talex-touch/tuffex/filter-chips'
import { toast } from '@talex-touch/tuffex/utils'
import PageHeader from '../components/PageHeader.vue'
import ErrorPanel from '../components/ErrorPanel.vue'
import LoadingBlock from '../components/LoadingBlock.vue'
import EmptyState from '../components/EmptyState.vue'
import { api } from '../api'
import { useResource } from '../lib/resource'
import { useQueryState } from '../lib/listState'
import { fmtInt } from '../lib/format'
import type { ChannelsData, OAuthStartResult } from '../types'

const emit = defineEmits<{
  (e: 'navigate-channels'): void
  (e: 'notify', msg: string): void
}>()

const router = useRouter()

/**
 * D15/D17：迁移到共享原语。
 * - `useResource` 读上游账号池（`/api/channels`）：加载中 / 失败可重试 / 有旧数据时用非阻断横幅；
 * - `useQueryState` 把提供商与状态筛选写进 URL（可分享、可后退）；
 * - 空态给出下一步动作，而不是留一句「暂无数据」。
 */
const pool = useResource<ChannelsData>(() => api.channels())
const accounts = computed(() => pool.data.value?.credentials ?? [])

const scope = useQueryState({ provider: 'all', status: 'all' })

const providerOptions = computed(() => [
  { value: 'all', label: `全部提供商 (${PROVIDERS.length})` },
  ...PROVIDERS.map((item) => ({ value: item.id, label: item.label })),
])

const STATUS_FILTERS = [
  { value: 'all', label: '全部状态' },
  { value: 'idle', label: '未开始' },
  { value: 'waiting', label: '等待授权' },
  { value: 'success', label: '已授权' },
  { value: 'error', label: '需要处理' },
]

const providerGrid = ref<HTMLElement | null>(null)

const visibleProviders = computed(() => {
  const provider = scope.state.provider
  const status = scope.state.status
  return PROVIDERS.filter((item) => {
    if (provider !== 'all' && item.id !== provider) return false
    if (status !== 'all' && getSession(item.id).status !== status) return false
    return true
  })
})

const hasFilter = computed(() => scope.state.provider !== 'all' || scope.state.status !== 'all')

function clearFilters() {
  scope.patch({ provider: 'all', status: 'all' })
  scope.flush()
}

function scrollToProviders() {
  providerGrid.value?.scrollIntoView({ behavior: 'smooth', block: 'start' })
}

type ProviderItem = {
  id: string
  name: string
  label: string
  desc: string
  hint: string
  placeholder: string
  isDeviceFlow?: boolean
  icon: string
}

const PROVIDERS: ProviderItem[] = [
  {
    id: 'codex',
    name: 'OpenAI Codex',
    label: 'OpenAI / Codex',
    desc: '通过 OAuth 流程登录 Codex 服务，自动获取并保存认证文件。',
    hint: '远程服务器模式：在浏览器授权后页面会跳转到 http://localhost:1455/auth/callback?code=...，请从地址栏复制完整 URL 粘贴提交。',
    placeholder: 'http://localhost:1455/auth/callback?code=...&state=...',
    icon: 'i-carbon-logo-github text-emerald-600',
  },
  {
    id: 'claude',
    name: 'Anthropic (Claude)',
    label: 'Claude Pro / Team',
    desc: '通过 OAuth 流程登录 Anthropic (Claude) 服务，自动获取并保存认证文件。',
    hint: '远程服务器模式：在浏览器授权后页面会跳转到 http://localhost:54545/callback?code=...，请从地址栏复制完整 URL 粘贴提交。',
    placeholder: 'http://localhost:54545/callback?code=...&state=...',
    icon: 'i-carbon-bot text-amber-600',
  },
  {
    id: 'antigravity',
    name: 'Google Antigravity',
    label: 'Google Gemini',
    desc: '通过 OAuth 流程登录 Antigravity（Google 账号）服务，自动获取并保存认证文件。',
    hint: '远程服务器模式：在浏览器授权后页面会跳转到 http://localhost:51121/oauth-callback?code=...，请从地址栏复制完整 URL 粘贴提交。',
    placeholder: 'http://localhost:51121/oauth-callback?code=...&state=...',
    icon: 'i-carbon-logo-google text-blue-600',
  },
  {
    id: 'kimi',
    name: 'Kimi 国内站（kimi.com）',
    label: 'Moonshot Kimi',
    desc: '通过设备授权登录 kimi.com 国内站，自动获取并保存认证文件。国内站与国际站账号不互通。',
    hint: '打开授权链接并在页面中输入设备码确认授权即可，无需手动提交回调。',
    placeholder: '',
    isDeviceFlow: true,
    icon: 'i-carbon-moon text-indigo-600',
  },
  {
    id: 'kimi-ai',
    name: 'Kimi 国际站（kimi.ai）',
    label: 'Kimi Global',
    desc: '通过设备授权登录 kimi.ai 国际站，自动保存独立的 kimi-ai 认证文件。',
    hint: '打开授权链接并在页面中输入设备码确认授权即可，无需手动提交回调。',
    placeholder: '',
    isDeviceFlow: true,
    icon: 'i-carbon-earth-southeast-asia text-cyan-600',
  },
  {
    id: 'xai',
    name: 'xAI (Grok)',
    label: 'xAI Grok',
    desc: '通过设备授权或 OAuth 流程登录 xAI Grok 服务，自动获取并保存认证文件。',
    hint: '若显示设备码，请在打开的网页中输入确认；若跳转回环地址，可将地址栏完整 URL 粘贴提交。',
    placeholder: 'http://localhost:... 或输入页面 code',
    isDeviceFlow: true,
    icon: 'i-carbon-terminal text-neutral-600',
  },
  {
    id: 'devin',
    name: 'Cognition Devin',
    label: 'Devin AI',
    desc: '通过浏览器 OAuth 登录 Devin / Cognition，自动保存认证文件。请在 5 分钟内完成授权。',
    hint: '远程服务器模式：复制最终的完整 /callback?code=...&state=... URL 粘贴提交。',
    placeholder: 'http://127.0.0.1:8317/callback?code=...&state=...',
    icon: 'i-carbon-machine-learning text-purple-600',
  },
  {
    id: 'meta',
    name: 'Meta AI (Muse)',
    label: 'Meta Muse',
    desc: '打开授权链接，如有提示请输入设备码。授权完成后将自动获取并保存认证文件。',
    hint: '打开授权链接并在页面中输入设备码确认授权。',
    placeholder: '',
    isDeviceFlow: true,
    icon: 'i-carbon-virtual-column-key text-pink-600',
  },
]

type SessionState = {
  session: OAuthStartResult | null
  status: 'idle' | 'waiting' | 'success' | 'error'
  error?: string
  callbackUrl: string
  submittingCallback: boolean
  /** 本轮轮询开始时刻：用来实施 5 分钟上限（原来无上限，会无限期挂着）。 */
  pollStartedAt?: number
  /** 连续网络失败次数：不再 catch{} 静默吞，累计到阈值就停下报错。 */
  consecutiveErrors?: number
}

const POLL_INTERVAL_MS = 3000
/** 与页面文案一致：请在 5 分钟内完成授权；超过就停止轮询并给出「重新发起」。 */
const POLL_MAX_MS = 5 * 60 * 1000
const POLL_MAX_CONSECUTIVE_ERRORS = 3

const sessions = ref<Record<string, SessionState>>({})
const pollTimers = ref<Record<string, number>>({})

function getSession(id: string): SessionState {
  if (!sessions.value[id]) {
    sessions.value[id] = {
      session: null,
      status: 'idle',
      callbackUrl: '',
      submittingCallback: false,
    }
  }
  return sessions.value[id]
}

function clearPoll(id: string) {
  if (pollTimers.value[id]) {
    window.clearInterval(pollTimers.value[id])
    delete pollTimers.value[id]
  }
}

async function startLogin(item: ProviderItem) {
  clearPoll(item.id)
  const s = getSession(item.id)
  s.status = 'waiting'
  s.error = ''
  s.callbackUrl = ''
  s.pollStartedAt = Date.now()
  s.consecutiveErrors = 0

  try {
    const res = await api.startOAuth(item.id)
    s.session = res

    // Open auth URL in window
    if (res.url) {
      window.open(res.url, '_blank', 'noopener,noreferrer')
    }

    // Start polling
    pollTimers.value[item.id] = window.setInterval(async () => {
      const live = sessions.value[item.id]
      if (!live || live.status !== 'waiting') {
        clearPoll(item.id)
        return
      }
      // 上限 1/2：总时长超过 5 分钟就停止，别让「等待授权」无限期挂着。
      if (live.pollStartedAt && Date.now() - live.pollStartedAt > POLL_MAX_MS) {
        clearPoll(item.id)
        live.status = 'error'
        live.error = '授权超时：5 分钟内没有收到回调结果，已停止轮询。可以点「重新发起」，或改用下方的回调链接手动提交。'
        toast({ title: '授权超时', description: live.error, variant: 'warning' })
        return
      }
      try {
        const statusRes = await api.getOAuthStatus(res.state)
        live.consecutiveErrors = 0
        if (statusRes.status === 'ok') {
          clearPoll(item.id)
          live.status = 'success'
          toast({ title: '授权成功', description: `${item.name} 凭据已安全保存`, variant: 'success' })
        } else if (statusRes.status === 'error') {
          clearPoll(item.id)
          live.status = 'error'
          live.error = statusRes.error || '授权失败，会话已终止'
          toast({ title: '授权失败', description: live.error, variant: 'danger' })
        }
      } catch (err) {
        // 上限 2/2：网络失败不再静默吞掉，连续 3 次就停下来说清楚。
        live.consecutiveErrors = (live.consecutiveErrors || 0) + 1
        if (live.consecutiveErrors >= POLL_MAX_CONSECUTIVE_ERRORS) {
          clearPoll(item.id)
          live.status = 'error'
          live.error = `轮询授权状态连续失败 ${POLL_MAX_CONSECUTIVE_ERRORS} 次（${err instanceof Error ? err.message : '网络错误'}），已停止轮询。可以点「重新发起」，或改用下方的回调链接手动提交。`
          toast({ title: '授权状态轮询失败', description: live.error, variant: 'danger' })
        }
      }
    }, POLL_INTERVAL_MS)
  } catch (err) {
    s.status = 'error'
    s.error = err instanceof Error ? err.message : '发起登录失败'
    toast({ title: '发起登录失败', description: s.error, variant: 'danger' })
  }
}

async function submitCallback(item: ProviderItem) {
  const s = getSession(item.id)
  if (!s.callbackUrl.trim()) {
    toast({ title: '请输入回调链接', variant: 'warning' })
    return
  }

  s.submittingCallback = true
  try {
    await api.submitOAuthCallback(item.id, s.callbackUrl.trim(), s.session?.state)
    clearPoll(item.id)
    s.status = 'success'
    toast({ title: '回调提交成功', description: `${item.name} 账号已绑定并就绪`, variant: 'success' })
  } catch (err) {
    s.error = err instanceof Error ? err.message : '提交回调失败'
    toast({ title: '提交回调失败', description: s.error, variant: 'danger' })
  } finally {
    s.submittingCallback = false
  }
}

async function cancelLogin(item: ProviderItem) {
  clearPoll(item.id)
  const s = getSession(item.id)
  const state = s.session?.state
  s.status = 'idle'
  s.session = null
  s.callbackUrl = ''
  if (state) {
    try {
      await api.cancelOAuth(state)
    } catch {
      // ignore
    }
  }
  toast({ title: '已取消登录', variant: 'info' })
}

function copyText(text: string, title = '已复制') {
  void navigator.clipboard.writeText(text)
  toast({ title, variant: 'success' })
}

function handleGoChannels() {
  emit('navigate-channels')
  router.push('/channels')
}

onUnmounted(() => {
  Object.keys(pollTimers.value).forEach((id) => clearPoll(id))
})
</script>

<template>
  <div class="page">
    <PageHeader
      title="OAuth 授权登录"
      description="通过官方 OAuth 授权或设备码，把上游供应商账号接入网关并上线模型；授权完成后账号会出现在上游账号池里。"
      :crumbs="[{ label: '接入', to: '/channels' }, { label: 'OAuth 授权登录' }]"
    >
      <template #actions>
        <TxButton variant="secondary" icon="i-carbon-network-4" @click="handleGoChannels">
          查看渠道与上游账号池
        </TxButton>
      </template>
    </PageHeader>

    <!-- 上游账号池：加载中 / 失败 / 空态 / 列表 -->
    <section class="pool-section" aria-labelledby="pool-title">
      <div class="oauth-section-title">
        <div>
          <h2 id="pool-title" class="section-title">上游账号池</h2>
          <span class="muted text-12">已完成授权的上游账号会出现在这里；OAuth 授权结果与渠道页共用同一份账号数据。</span>
        </div>
        <div class="pool-actions">
          <TxTag size="sm" variant="soft" color="var(--tx-color-primary)" :label="`共 ${fmtInt(accounts.length)} 个账号`" />
          <TxButton variant="ghost" size="sm" icon="i-carbon-renew" @click="pool.reload()">刷新</TxButton>
        </div>
      </div>

      <!--
        顺序很重要：`useResource.initial` 的语义是「**从未成功加载过**」，只在成功时置 false；
        首次加载失败时它仍然是 true。若把 LoadingBlock 放在错误分支之前，读取失败会永远停在骨架上、
        错误态永远不可达（本轮实测踩到）。所以「失败且没有旧数据」必须排在骨架之前。
      -->
      <ErrorPanel
        v-if="pool.error.value && accounts.length === 0"
        :error="pool.error.value"
        title="上游账号池读取失败"
        :retry="pool.reload"
      />
      <LoadingBlock v-else-if="pool.initial.value" :lines="2" label="正在读取上游账号池" />
      <template v-else>
        <ErrorPanel
          v-if="pool.error.value"
          inline
          :error="pool.error.value"
          stale-hint="下方为最近一次成功读取的账号"
          :retry="pool.reload"
        />
        <EmptyState
          v-if="accounts.length === 0"
          title="还没有上游账号"
          description="选下面的提供商开始一次授权；授权成功后账号会自动进入上游账号池，并在渠道页可单独启停。"
          icon="i-carbon-user-multiple"
          action-label="去选择提供商"
          variant="empty"
          @action="scrollToProviders"
        />
        <ul v-else class="pool-list">
          <li v-for="account in accounts" :key="account.name" class="pool-item">
            <span :class="account.disabled ? 'i-carbon-pause-outline' : 'i-carbon-checkmark-outline'" class="pool-icon" />
            <div class="pool-text">
              <strong>{{ account.label || account.name }}</strong>
              <small class="muted text-12">{{ account.type }} · {{ fmtInt(account.modelCount) }} 个模型 · {{ account.status || '就绪' }}</small>
            </div>
            <TxTag
              size="sm"
              variant="soft"
              :color="account.disabled ? 'var(--tx-color-warning)' : 'var(--tx-color-success)'"
              :label="account.disabled ? '已停用' : '已启用'"
            />
          </li>
        </ul>
      </template>
    </section>

    <section ref="providerGrid" class="providers-section" aria-labelledby="providers-title">
      <div class="oauth-section-title">
        <div>
          <h2 id="providers-title" class="section-title">授权提供商</h2>
          <span class="muted text-12">支持浏览器授权、回调回填与设备码确认；筛选条件写在地址栏里，可直接分享。</span>
        </div>
        <TxTag size="sm" variant="soft" color="var(--tx-color-primary)" :label="`支持 ${PROVIDERS.length} 种认证方式`" />
      </div>

      <div class="provider-filters">
        <TxFilterChips
          :model-value="scope.state.provider"
          :items="providerOptions"
          aria-label="按提供商筛选"
          @update:model-value="(value) => { scope.patch({ provider: String(value) }); scope.flush() }"
        />
        <TxFilterChips
          :model-value="scope.state.status"
          :items="STATUS_FILTERS"
          aria-label="按授权状态筛选"
          @update:model-value="(value) => { scope.patch({ status: String(value) }); scope.flush() }"
        />
        <TxButton v-if="hasFilter" variant="ghost" size="sm" icon="i-carbon-close" @click="clearFilters">清除筛选</TxButton>
      </div>

      <EmptyState
        v-if="visibleProviders.length === 0"
        title="没有符合筛选的提供商"
        description="当前筛选条件下没有提供商；清除筛选即可看到全部认证方式。"
        variant="search-empty"
        action-label="清除筛选"
        @action="clearFilters"
      />

      <!-- 登录卡片网格 -->
      <div v-else class="oauth-grid">
      <TxCard
        v-for="item in visibleProviders"
        :key="item.id"
        class="oauth-card"
        :class="{
          'card-waiting': getSession(item.id).status === 'waiting',
          'card-success': getSession(item.id).status === 'success',
        }"
      >
        <!-- 卡片头部 -->
        <div class="card-top-head">
          <div class="provider-title-row">
            <span :class="item.icon" class="provider-icon" />
            <strong class="provider-name">{{ item.name }}</strong>
          </div>
          <TxTag size="sm" variant="outline" :label="item.label" />
        </div>

        <p class="provider-desc">{{ item.desc }}</p>

        <!-- 初始空闲状态 -->
        <div v-if="getSession(item.id).status === 'idle'" class="card-idle-footer">
          <TxButton
            variant="primary"
            size="sm"
            icon="i-carbon-login"
            @click="startLogin(item)"
          >
            开始登录
          </TxButton>
        </div>

        <!-- 等待授权状态 -->
        <div v-else-if="getSession(item.id).status === 'waiting'" class="card-waiting-body">
          <p class="muted text-11 polling-hint">
            正在每 3 秒检查授权结果，最多等待 5 分钟；超时或连续 3 次轮询失败会自动停止并在这里提示。
          </p>
          <!-- 设备码展示 -->
          <div v-if="item.isDeviceFlow && getSession(item.id).session?.user_code" class="device-code-box">
            <span class="muted text-11">请在授权页中输入此设备码：</span>
            <div class="code-copy-row">
              <strong class="mono code-highlight">{{ getSession(item.id).session?.user_code }}</strong>
              <TxButton
                size="sm"
                variant="secondary"
                icon="i-carbon-copy"
                @click="copyText(getSession(item.id).session?.user_code || '', '设备码已复制')"
              />
            </div>
          </div>

          <!-- 授权链接按钮 -->
          <div class="link-actions-box">
            <TxButton
              variant="secondary"
              size="sm"
              icon="i-carbon-launch"
              @click="window.open(getSession(item.id).session?.url || '', '_blank')"
            >
              打开授权页面
            </TxButton>
            <TxButton
              variant="secondary"
              size="sm"
              icon="i-carbon-copy"
              @click="copyText(getSession(item.id).session?.url || '', '授权链接已复制')"
            >
              复制链接
            </TxButton>
          </div>

          <!-- 轮询状态条 -->
          <div class="polling-indicator">
            <span class="i-carbon-circle-dash spin text-16 text-blue-600" />
            <span class="text-12">正在等待授权确认...（自动轮询中）</span>
          </div>

          <!-- 回调回填输入 -->
          <div v-if="!item.isDeviceFlow" class="callback-section">
            <small class="muted text-11">{{ item.hint }}</small>
            <div class="callback-input-row">
              <TxInput
                v-model="getSession(item.id).callbackUrl"
                :placeholder="item.placeholder"
              />
              <TxButton
                variant="primary"
                size="sm"
                :loading="getSession(item.id).submittingCallback"
                @click="submitCallback(item)"
              >
                提交回调
              </TxButton>
            </div>
          </div>

          <div class="cancel-row">
            <TxButton variant="ghost" size="sm" @click="cancelLogin(item)">取消登录</TxButton>
          </div>
        </div>

        <!-- 成功状态 -->
        <div v-else-if="getSession(item.id).status === 'success'" class="card-success-body">
          <span class="i-carbon-checkmark-filled text-28 text-emerald-600" />
          <strong>授权成功！</strong>
          <small class="muted text-12">账号凭据已安全持久化并生效到渠道池中。</small>
          <TxButton variant="primary" size="sm" @click="getSession(item.id).status = 'idle'">
            完成并关闭
          </TxButton>
        </div>

        <!-- 失败状态 -->
        <div v-else-if="getSession(item.id).status === 'error'" class="card-error-body">
          <TxAlert
            type="error"
            title="授权未完成"
            :message="getSession(item.id).error || '遇到错误，请重新尝试'"
          />
          <div class="error-actions-row">
            <TxButton variant="secondary" size="sm" @click="getSession(item.id).status = 'idle'">返回</TxButton>
            <TxButton variant="primary" size="sm" @click="startLogin(item)">重新发起</TxButton>
          </div>
        </div>
      </TxCard>
      </div>
    </section>

    <!-- 页面级失败提示：授权失败在卡片内已有出口，这里只兜住「手动提交回调」这条手动路径的提示 -->
    <p class="muted text-12 oauth-footnote">
      授权未完成时，卡片里始终有两条出路：点「重新发起」重来一次，或把浏览器地址栏里的完整回调链接粘贴到底部输入框后提交。
    </p>
  </div>
</template>

<style scoped>
.pool-section,
.providers-section {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.pool-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}

.pool-list {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
  gap: 8px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.pool-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 12px;
  border: 1px solid var(--tx-border-color);
  border-radius: 10px;
  background: var(--tx-fill-color-light);
}

.pool-icon {
  font-size: 18px;
  color: var(--tx-color-success);
}

.pool-text {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
  flex: 1;
}

.provider-filters {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  margin-bottom: 4px;
}

.oauth-footnote {
  margin: 4px 0 0;
}

.polling-hint {
  margin: 0 0 8px;
}
.oauth-section-title {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-top: 4px;
  margin-bottom: 8px;
}

.oauth-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(360px, 1fr));
  gap: 16px;
}

.oauth-card {
  display: flex;
  flex-direction: column;
  transition: all 0.2s ease;
}

.card-waiting {
  border-color: var(--tx-color-primary);
  box-shadow: 0 0 0 1px var(--tx-color-primary);
}

.card-success {
  border-color: var(--tx-color-success);
}

.card-top-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}

.provider-title-row {
  display: flex;
  align-items: center;
  gap: 8px;
}

.provider-icon {
  font-size: 20px;
}

.provider-name {
  font-size: 14.5px;
  color: var(--tx-text-color-primary);
}

.provider-desc {
  font-size: 12.5px;
  line-height: 1.5;
  color: var(--tx-text-color-secondary);
  margin: 10px 0 14px 0;
  flex: 1;
}

.card-idle-footer {
  display: flex;
  justify-content: flex-end;
  margin-top: auto;
}

.card-waiting-body {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 12px;
  background: var(--tx-fill-color-light);
  border-radius: var(--tx-border-radius-base);
}

.device-code-box {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.code-copy-row {
  display: flex;
  align-items: center;
  gap: 8px;
}

.code-highlight {
  font-size: 16px;
  letter-spacing: 0.1em;
  padding: 4px 8px;
  background: var(--tx-bg-color);
  border: 1px dashed var(--tx-border-color);
  border-radius: 4px;
  color: var(--tx-color-primary);
}

.link-actions-box {
  display: flex;
  gap: 8px;
}

.polling-indicator {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  background: var(--tx-bg-color);
  border-radius: var(--tx-border-radius-small);
}

.callback-section {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.callback-input-row {
  display: flex;
  gap: 8px;
}

.callback-input-row :deep(.tuff-input-wrap) {
  flex: 1;
}

.cancel-row {
  display: flex;
  justify-content: flex-end;
}

.card-success-body {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  text-align: center;
  padding: 20px;
  gap: 8px;
}

.card-error-body {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.error-actions-row {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}
</style>

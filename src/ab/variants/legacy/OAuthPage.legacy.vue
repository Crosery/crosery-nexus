<script setup lang="ts">
import { ref, onUnmounted } from 'vue'
import { useRouter } from 'vue-router'
import { TxCard } from '@talex-touch/tuffex/card'
import { TxTag } from '@talex-touch/tuffex/tag'
import { TxButton } from '@talex-touch/tuffex/button'
import { TxInput } from '@talex-touch/tuffex/input'
import { TxAlert } from '@talex-touch/tuffex/alert'
import { toast } from '@talex-touch/tuffex/utils'
import { api } from '../../../api'
import type { OAuthStartResult } from '../../../types'

defineProps<{
  onNavigateChannels?: () => void
}>()

const emit = defineEmits<{
  (e: 'navigate-channels'): void
  (e: 'notify', msg: string): void
}>()

const router = useRouter()

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
}

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

  try {
    const res = await api.startOAuth(item.id)
    s.session = res

    // Open auth URL in window
    if (res.url) {
      window.open(res.url, '_blank', 'noopener,noreferrer')
    }

    // Start polling
    pollTimers.value[item.id] = window.setInterval(async () => {
      try {
        const statusRes = await api.getOAuthStatus(res.state)
        if (statusRes.status === 'ok') {
          clearPoll(item.id)
          s.status = 'success'
          toast({ title: '授权成功', description: `${item.name} 凭据已安全保存`, variant: 'success' })
        } else if (statusRes.status === 'error') {
          clearPoll(item.id)
          s.status = 'error'
          s.error = statusRes.error || '授权失败，会话已终止'
          toast({ title: '授权失败', description: s.error, variant: 'danger' })
        }
      } catch {
        // network jitter during polling
      }
    }, 3000)
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
    <!-- 头部横幅 -->
    <header class="page-head">
      <div class="page-head__text">
        <div class="eyebrow-tag">AUTHENTICATION</div>
        <h2 class="page-head__title">OAuth 授权登录</h2>
        <p>通过官方 OAuth 授权或设备码机制将上游供应商账号连接至网关，安全接管并上线模型矩阵。</p>
      </div>
      <div class="page-head__actions">
        <TxButton variant="secondary" icon="i-carbon-network-4" @click="handleGoChannels">
          查看渠道与账号池
        </TxButton>
      </div>
    </header>

    <div class="oauth-section-title">
      <div>
        <h2 class="section-title">AI 提供商登录池</h2>
        <span class="muted text-12">支持浏览器授权、回调回填与设备码确认；每个账号均可独立配置出口代理。</span>
      </div>
      <TxTag size="sm" variant="soft" color="var(--tx-color-primary)" :label="`支持 ${PROVIDERS.length} 种认证方式`" />
    </div>

    <!-- 登录卡片网格 -->
    <div class="oauth-grid">
      <TxCard
        v-for="item in PROVIDERS"
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
            variant="danger"
            title="授权未完成"
            :description="getSession(item.id).error || '遇到错误，请重新尝试'"
          />
          <div class="error-actions-row">
            <TxButton variant="secondary" size="sm" @click="getSession(item.id).status = 'idle'">返回</TxButton>
            <TxButton variant="primary" size="sm" @click="startLogin(item)">重新发起</TxButton>
          </div>
        </div>
      </TxCard>
    </div>
  </div>
</template>

<style scoped>
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

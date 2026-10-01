<script setup lang="ts">
import { reactive, ref } from 'vue'
import { useRouter } from 'vue-router'
import { TxCard } from '@talex-touch/tuffex/card'
import { TxForm, TxFormItem } from '@talex-touch/tuffex/form'
import { TxInput } from '@talex-touch/tuffex/input'
import { TxButton } from '@talex-touch/tuffex/button'
import { TxAlert } from '@talex-touch/tuffex/alert'
import { api } from '../api'
import { updateAuthState } from '../router'

const router = useRouter()
const emit = defineEmits<{
  (e: 'success'): void
}>()

const form = reactive({
  username: 'admin',
  password: '',
})

const loading = ref(false)
const error = ref('')

async function handleSubmit() {
  if (!form.username || !form.password || loading.value) return
  loading.value = true
  error.value = ''
  try {
    await api.login(form.username, form.password)
    updateAuthState(true)
    emit('success')
    await router.replace('/dashboard')
  } catch (e) {
    error.value = e instanceof Error ? e.message : '登录失败，请检查账号密码'
  } finally {
    loading.value = false
  }
}
</script>

<template>
  <main class="login-wrapper">
    <div class="login-container">
      <TxCard class="login-card" :padding="32" variant="solid" background="glass" shadow="soft" :radius="16">
        <div class="login-brand-header">
          <div class="brand-badge">
            <i class="i-carbon-cloud-services text-24 text-[var(--tx-color-primary)]" />
          </div>
          <p class="eyebrow">CROSERY CONSOLE</p>
          <h1>欢迎登录</h1>
          <p class="login-subtitle">统一管理网关 API Key、模型路由、用量审计与账号额度。</p>
        </div>

        <!-- 错误提示：TxAlert 自带 role="alert"（实测渲染 `role: "alert"`），这里再给它一个 id，
             让输入框用 aria-describedby 指过来（聚焦时读屏会读错误文案），并用 aria-invalid 标记 -->
        <TxAlert v-if="error" id="login-error" type="danger" :title="error" :closable="false" class="mb-4" :aria-live="'assertive'" />

        <TxForm :model="form" class="login-form" @submit.prevent="handleSubmit">
          <TxFormItem label="管理员账号" prop="username">
            <TxInput
              v-model="form.username"
              placeholder="请输入管理员账号"
              autocomplete="username"
              class="w-full"
              :aria-invalid="error ? 'true' : undefined"
              :aria-describedby="error ? 'login-error' : undefined"
            />
          </TxFormItem>

          <TxFormItem label="登录密码" prop="password">
            <TxInput
              v-model="form.password"
              type="password"
              placeholder="请输入控制台密码"
              autocomplete="current-password"
              class="w-full"
              :aria-invalid="error ? 'true' : undefined"
              :aria-describedby="error ? 'login-error' : undefined"
              @keydown.enter="handleSubmit"
            />
          </TxFormItem>

          <div class="form-actions">
            <TxButton
              variant="primary"
              size="lg"
              block
              :loading="loading"
              :disabled="!form.username || !form.password"
              @click="handleSubmit"
            >
              {{ loading ? '正在验证...' : '进入控制台' }}
            </TxButton>
          </div>
        </TxForm>

        <div class="login-footer text-muted text-xs">
          <span><i class="i-carbon-locked text-xs mr-1" />12 小时安全加密会话 · 本地安全防护</span>
        </div>
      </TxCard>
    </div>
  </main>
</template>

<style scoped>
.login-wrapper {
  min-height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--tx-bg-color-page, #f4f6fc);
  padding: 24px 16px;
}
.login-container {
  width: 100%;
  max-width: 440px;
}
.login-card {
  width: 100%;
  background: var(--tx-bg-color, #ffffff);
  border: 1px solid var(--tx-border-color, #d5daec);
}
.login-brand-header {
  text-align: center;
  margin-bottom: 24px;
}
.brand-badge {
  width: 52px;
  height: 52px;
  border-radius: 12px;
  background: var(--tx-color-primary, #3346c8);
  display: grid;
  place-items: center;
  margin: 0 auto 12px;
  box-shadow: 0 4px 14px rgba(51, 70, 200, 0.35);
}
.brand-icon {
  font-size: 24px;
  color: #ffffff;
}
.eyebrow {
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.08em;
  color: var(--tx-color-primary, #3346c8);
  margin: 0 0 4px;
}
.login-brand-header h1 {
  margin: 0;
  font-size: 24px;
  font-weight: 700;
  color: var(--tx-text-color-primary, #151b45);
}
.login-subtitle {
  margin: 8px 0 0;
  font-size: 13px;
  color: var(--tx-text-color-secondary, #535b85);
  line-height: 1.5;
}
.mb-4 {
  margin-bottom: 16px;
}
.login-form {
  display: flex;
  flex-direction: column;
  gap: 16px;
}
.w-full {
  width: 100%;
}
.form-actions {
  margin-top: 12px;
}
.login-footer {
  margin-top: 24px;
  text-align: center;
  color: var(--tx-text-color-placeholder, #8a90b0);
}
.text-xs {
  font-size: 11.5px;
}
.text-muted {
  color: var(--tx-text-color-secondary, #535b85);
}
</style>

<script setup lang="ts">
import { ref } from 'vue'
import { useRouter } from 'vue-router'
import { TxCard } from '@talex-touch/tuffex/card'
import { TxButton } from '@talex-touch/tuffex/button'
import { TxInput } from '@talex-touch/tuffex/input'
import { TxForm, TxFormItem } from '@talex-touch/tuffex/form'
import { api } from '../api'
import { updateAuthState } from '../router'

const router = useRouter()
const username = ref('admin')
const password = ref('')
const loading = ref(false)
const error = ref('')

async function handleLogin() {
  if (!username.value || !password.value) {
    error.value = '请输入用户名和密码'
    return
  }
  loading.value = true
  error.value = ''
  try {
    const res = await api.login(username.value, password.value) as { ok?: boolean }
    if (res.ok) {
      updateAuthState(true)
      void router.replace('/dashboard')
    } else {
      error.value = '登录失败，请检查密码'
    }
  } catch (err: unknown) {
    error.value = err instanceof Error ? err.message : '登录请求失败'
  } finally {
    loading.value = false
  }
}
</script>

<template>
  <div class="login-wrapper console-ground">
    <TxCard class="login-card">
      <div class="login-header">
        <div class="login-logo">
          <i class="i-carbon-cloud-services text-2xl text-[var(--tx-color-primary)]" />
        </div>
        <h1>Crosery API Console</h1>
        <p>输入管理员凭据登录管理控制台</p>
      </div>

      <TxForm label-position="top" @submit.prevent="handleLogin">
        <TxFormItem label="用户名">
          <TxInput v-model="username" placeholder="admin" autofocus class="fill-width" />
        </TxFormItem>
        <TxFormItem label="密码">
          <TxInput v-model="password" type="password" placeholder="请输入密码" class="fill-width" />
        </TxFormItem>

        <p v-if="error" class="login-error">{{ error }}</p>

        <div class="login-actions">
          <TxButton
            variant="primary"
            class="fill-width"
            :loading="loading"
            @click="handleLogin"
          >
            登录
          </TxButton>
        </div>
      </TxForm>
    </TxCard>
  </div>
</template>

<style scoped>
.login-wrapper {
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 100vh;
  padding: 24px;
}

.login-card {
  width: 100%;
  max-width: 400px;
  padding: 32px !important;
}

.login-header {
  text-align: center;
  margin-bottom: 24px;
}

.login-logo {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 48px;
  height: 48px;
  border-radius: 12px;
  background: var(--tx-fill-color);
  margin-bottom: 12px;
}

.login-header h1 {
  margin: 0;
  font-size: 20px;
  font-weight: 600;
  color: var(--tx-text-color-primary);
}

.login-header p {
  margin: 6px 0 0;
  font-size: 13px;
  color: var(--tx-text-color-secondary);
}

.login-error {
  color: var(--tx-color-danger);
  font-size: 12px;
  margin: 8px 0;
}

.login-actions {
  margin-top: 20px;
}
</style>

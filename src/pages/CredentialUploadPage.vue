<script setup lang="ts">
import { computed, ref } from 'vue'
import { useRouter } from 'vue-router'
// 组件按子路径导入（与其它页面一致）：桶导入会让运行时报 undefined 且**页面整页空白**
import { TxButton } from '@talex-touch/tuffex/button'
import { TxCard } from '@talex-touch/tuffex/card'
import { TxTag } from '@talex-touch/tuffex/tag'
import { toast } from '@talex-touch/tuffex/utils'
import PageHeader from '../components/PageHeader.vue'
import EmptyState from '../components/EmptyState.vue'
import { api } from '../api'
import { useResource } from '../lib/resource'
import type { BootstrapPayload } from '../types'

/**
 * 凭据导入（task-77 恢复）。
 *
 * 旧 React 实现是 `src/pages/CredentialUploadPage.tsx`（Vue 重写时整页被砍：没有页面、
 * 没有路由、没有导航入口）。本页恢复它的**功能与信息**：
 * - 选择 `.json` / `.zip`（单个 JSON，或包含多个 JSON 的 ZIP），支持点击与拖拽；
 * - 前端先做格式与体积校验，服务端再按 maxEntries / maxEntryBytes / 展开体积上限校验；
 * - 上传结果按条目展示（已写入 / 已存在 / 失败 + 可读原因），并给成功、跳过、失败三项计数；
 * - 失败时给出**问题 + 恢复方式**（重试、换文件、按 Trace ID 查日志），而不是一句"上传失败"。
 *
 * 与旧版的差异（有意）：视觉全部改用当前 TUF 派生体系；上限信息从"一句话"改成可扫读标签；
 * 结果区增加失败条目的原因为可读列表。**功能与字段一个不少**。
 */
type UploadItem = {
  name: string
  label: string
  ok: boolean
  skipped?: boolean
  code?: string
  message?: string
}

type UploadResult = {
  traceId: string
  total: number
  uploaded: number
  skipped: number
  failed: number
  items: UploadItem[]
}

const router = useRouter()
const limitsRes = useResource(() => api.bootstrap<BootstrapPayload>(), [])
const limits = computed(() => limitsRes.data.value?.credentialUploadLimits ?? {
  maxBytes: 8 * 1024 * 1024,
  maxEntries: 200,
  maxEntryBytes: 0,
  maxExpandedBytes: 0,
})

const inputRef = ref<HTMLInputElement | null>(null)
const file = ref<File | null>(null)
const dragging = ref(false)
const uploading = ref(false)
const error = ref('')
const result = ref<UploadResult | null>(null)

const formatBytes = (bytes: number) => {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value >= 10 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`
}

/** 前端先校验：只允许 .json / .zip 且不超过服务端声明的单文件上限。 */
const selectFile = (next: File | null) => {
  error.value = ''
  result.value = null
  if (!next) {
    file.value = null
    return
  }
  if (!/\.(json|zip)$/i.test(next.name)) {
    file.value = null
    error.value = `「${next.name}」不是支持的格式：只接受 .json 或 .zip。请重新选择凭据包。`
    return
  }
  if (next.size > limits.value.maxBytes) {
    file.value = null
    error.value = `「${next.name}」有 ${formatBytes(next.size)}，超过单文件上限 ${formatBytes(limits.value.maxBytes)}。请压缩或拆分后再上传。`
    return
  }
  file.value = next
}

const onPick = (event: Event) => {
  const target = event.target as HTMLInputElement
  selectFile(target.files?.[0] ?? null)
}

const onDrop = (event: DragEvent) => {
  dragging.value = false
  selectFile(event.dataTransfer?.files?.[0] ?? null)
}

const reset = () => {
  file.value = null
  result.value = null
  error.value = ''
  if (inputRef.value) inputRef.value.value = ''
}

const upload = async () => {
  if (!file.value) return
  uploading.value = true
  error.value = ''
  result.value = null
  try {
    const response = await api.uploadCredentials<UploadResult>(file.value)
    result.value = response
    toast({
      title: response.failed ? '上传完成，部分条目失败' : '凭据已导入',
      description: `成功 ${response.uploaded} · 跳过 ${response.skipped} · 失败 ${response.failed}`,
      variant: response.failed ? 'warning' : 'success',
    })
    if (inputRef.value) inputRef.value.value = ''
  } catch (reason) {
    error.value = reason instanceof Error ? reason.message : '上传失败，请稍后重试'
  } finally {
    uploading.value = false
  }
}

const statusOf = (item: UploadItem) => (item.skipped ? '已存在' : item.ok ? '已写入' : '失败')
const statusVariant = (item: UploadItem) => (item.skipped ? 'soft' : item.ok ? 'success' : 'danger')
</script>

<template>
  <div class="page">
    <PageHeader
      title="凭据导入"
      description="上传 xAI / Grok 的 CPA 凭据包，服务端校验后写入生产网关。"
      :crumbs="[{ label: '接入', to: '/channels' }, { label: '凭据导入' }]"
    >
      <template #actions>
        <TxButton variant="secondary" icon="i-carbon-network-4" @click="router.push('/oauth')">
          查看上游账号池
        </TxButton>
      </template>
    </PageHeader>

    <!-- 1) 选择凭据包：上限用可扫读标签，不用一整句话 -->
    <section aria-labelledby="pick-title">
      <TxCard :padding="20" variant="solid">
        <div class="card-head">
          <div>
            <h2 id="pick-title" class="section-title">选择凭据包</h2>
            <p class="section-note muted">单个 JSON，或包含多个 JSON 的 ZIP。</p>
          </div>
          <div class="card-head__actions">
            <TxTag size="sm" variant="soft" label=".json / .zip" />
            <TxTag size="sm" variant="soft" :label="`单文件 ≤ ${formatBytes(limits.maxBytes)}`" />
            <TxTag size="sm" variant="soft" :label="`最多 ${limits.maxEntries} 个条目`" />
          </div>
        </div>

        <label
          class="dropzone"
          :class="{ 'dropzone--active': dragging, 'dropzone--filled': Boolean(file) }"
          @dragover.prevent="dragging = true"
          @dragleave.prevent="dragging = false"
          @drop.prevent="onDrop"
        >
          <input
            ref="inputRef"
            class="sr-only"
            type="file"
            accept=".json,.zip,application/json,application/zip"
            @change="onPick"
          />
          <i class="i-carbon-cloud-upload dropzone__icon" aria-hidden="true" />
          <span class="dropzone__title">{{ file ? file.name : '拖拽凭据包到此处，或点击选择文件' }}</span>
          <span class="dropzone__hint muted">
            {{ file ? `${formatBytes(file.size)} · ${file.type || '按扩展名识别'}` : '支持 .json / .zip；文件只在服务端校验' }}
          </span>
        </label>

        <p v-if="error" class="field-error" role="alert">{{ error }}</p>

        <div class="pick-actions">
          <TxButton variant="primary" icon="i-carbon-upload" :loading="uploading" :disabled="!file || uploading" @click="upload">
            {{ uploading ? '正在上传...' : '开始上传' }}
          </TxButton>
          <TxButton variant="ghost" :disabled="!file && !result" @click="reset">清空</TxButton>
        </div>
      </TxCard>
    </section>

    <!-- 2) 上传结果：三项计数 + 逐条状态（失败给可读原因） -->
    <section aria-labelledby="result-title">
      <TxCard :padding="20" variant="solid">
        <div class="card-head">
          <div>
            <h2 id="result-title" class="section-title">上传结果</h2>
            <p class="section-note muted">只展示文件名与账号标识，不返回 access token 或 refresh token。</p>
          </div>
          <div v-if="result" class="card-head__actions">
            <TxTag
              size="sm"
              :variant="result.failed ? 'danger' : 'success'"
              :label="result.failed ? '部分失败' : '全部成功'"
            />
          </div>
        </div>

        <template v-if="result">
          <div class="grid-stats result-stats">
            <div class="stat">
              <span class="stat__label muted">成功</span>
              <strong class="stat__value">{{ result.uploaded }}</strong>
            </div>
            <div class="stat">
              <span class="stat__label muted">跳过（同名已存在）</span>
              <strong class="stat__value">{{ result.skipped }}</strong>
            </div>
            <div class="stat">
              <span class="stat__label muted">失败</span>
              <strong class="stat__value">{{ result.failed }}</strong>
            </div>
          </div>

          <ul class="result-list">
            <li v-for="item in result.items" :key="item.name" class="result-item">
              <div class="result-item__main">
                <span class="result-item__label">{{ item.label }}</span>
                <span class="result-item__name muted">{{ item.name }}</span>
                <span v-if="item.message" class="result-item__message muted">{{ item.message }}</span>
                <span v-else-if="item.code" class="result-item__message muted">{{ item.code }}</span>
              </div>
              <TxTag size="sm" :variant="statusVariant(item)" :label="statusOf(item)" />
            </li>
          </ul>

          <p class="result-footnote muted">
            Trace ID <code>{{ result.traceId }}</code> —— 失败条目请按它查服务日志。
          </p>
        </template>

        <EmptyState
          v-else
          icon="i-carbon-document-import"
          title="还没有上传记录"
          description="选择凭据包并开始上传后，这里会逐条列出写入结果。"
        />
      </TxCard>
    </section>
  </div>
</template>

<style scoped>
/* 标题下留白小于上方：`.card-head` 之上由 `.page` 的 16px gap 提供，这里只补 4px 的下间距 */
.section-note {
  margin: 4px 0 0;
  font-size: 12px;
  line-height: 18px;
}

.dropzone {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  margin-top: 16px;
  padding: 24px;
  border: 1px dashed var(--tx-border-color, #d5d2cb);
  border-radius: 12px;
  background: var(--tx-fill-color-lighter, rgba(0, 0, 0, 0.02));
  cursor: pointer;
  text-align: center;
  transition: border-color 120ms ease, background 120ms ease;
}

.dropzone:hover,
.dropzone--active {
  border-color: var(--tx-color-primary);
  background: var(--tx-fill-color-light, rgba(0, 0, 0, 0.04));
}

.dropzone--filled {
  border-style: solid;
}

.dropzone__icon {
  font-size: 24px;
  color: var(--tx-color-primary);
}

.dropzone__title {
  font-size: 14px;
  line-height: 20px;
  font-weight: 600;
  color: var(--tx-text-color-primary);
  overflow-wrap: anywhere;
}

.dropzone__hint {
  font-size: 12px;
  line-height: 18px;
}

.pick-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 16px;
}

.result-stats {
  margin-top: 16px;
}

.stat {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.stat__value {
  font-size: 20px;
  line-height: 28px;
  font-weight: 600;
}

.result-list {
  list-style: none;
  margin: 16px 0 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.result-item {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  padding: 10px 12px;
  border: 1px solid var(--tx-border-color-lighter, #e3e1db);
  border-radius: 10px;
}

.result-item__main {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.result-item__label {
  font-size: 13px;
  line-height: 19.5px;
  font-weight: 600;
}

.result-item__name,
.result-item__message {
  font-size: 12px;
  line-height: 18px;
  overflow-wrap: anywhere;
}

.result-footnote {
  margin: 12px 0 0;
  font-size: 12px;
  line-height: 18px;
}

.result-footnote code {
  padding: 1px 5px;
  border-radius: 4px;
  background: var(--tx-fill-color-lighter);
  font-family: var(--console-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
  font-size: 12px;
}
</style>

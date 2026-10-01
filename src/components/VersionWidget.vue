<script setup lang="ts">
import { ref, onMounted, onUnmounted, computed, watch } from 'vue'
import { useRouter } from 'vue-router'
import { TxButton } from '@talex-touch/tuffex/button'
import { TxTag } from '@talex-touch/tuffex/tag'
import { TxCard } from '@talex-touch/tuffex/card'
import { api } from '../api'
import type { RtkPlaneId, RtkPlaneState, RTKStatusResponse, VersionsData } from '../types'

const props = defineProps<{
  initialVersions?: VersionsData
}>()

const emit = defineEmits<{
  refresh: []
}>()

const open = ref(false)
const checking = ref(false)
const syncingModels = ref(false)
const syncNotice = ref('')
const checkError = ref('')
const versions = ref<VersionsData | undefined>(props.initialVersions)
const popoverRef = ref<HTMLElement | null>(null)
const triggerRef = ref<HTMLElement | null>(null)
const router = useRouter()

/** RTK 三个平面的真实状态；失败时如实显示「状态未知 + 重试」，不降级成听起来像成功的话术。 */
const rtk = ref<RTKStatusResponse | null>(null)
const rtkLoading = ref(false)
const rtkError = ref('')
const PLANE_LABEL: Record<RtkPlaneId, string> = { kernel: '内核', relay: '中转站', local: '本机' }
const PLANE_STATE_TEXT: Record<RtkPlaneState, string> = {
  available: '可用',
  not_configured: '未配置',
  unreachable: '连不上',
  unauthorized: '未授权',
  not_supported: '未接通',
}

const rtkPlanes = computed(() => rtk.value?.planes ?? [])
const planeText = (state: RtkPlaneState) => PLANE_STATE_TEXT[state] ?? state

async function loadRtk() {
  rtkLoading.value = true
  rtkError.value = ''
  try {
    rtk.value = await api.getRTKStatus()
  } catch (err) {
    rtk.value = null
    rtkError.value = err instanceof Error ? err.message : '读取失败'
  } finally {
    rtkLoading.value = false
  }
}

/** RTK 状态只在浮层打开时读一次，避免每页冷启动都多打一个请求。 */
watch(open, (visible) => {
  if (visible && !rtk.value && !rtkLoading.value) void loadRtk()
})

function openRtkPage() {
  open.value = false
  void router.push('/rtk')
}

const cpa = computed(() => versions.value?.cpa)
const consoleVer = computed(() => versions.value?.console)
const engineName = computed(() => (cpa.value?.engine === 'magpie' ? 'Magpie' : 'CPA'))
const kernelUnavailable = computed(() => cpa.value?.engine === 'magpie' && cpa.value.version === 'offline')
const upstream = computed(() => cpa.value?.upstream)
const cpaShort = computed(() => (cpa.value?.version ? cpa.value.version.split('-')[0].replace(/^v/, '') : '未知'))
const hasUpdate = computed(() => Boolean(cpa.value?.hasUpdate))

const upstreamStatusText = computed(() => {
  const status = upstream.value?.status || 'not_checked'
  const map: Record<string, string> = {
    not_checked: '尚未检测',
    unchanged: '契约无版本变化',
    review_required: '候选契约已生成',
    error: '检测失败，保留当前版本',
    baseline_mismatch: '运行版本与契约不一致',
  }
  return map[status] || status
})

async function checkLatestVersion() {
  checking.value = true
  checkError.value = ''
  try {
    const data = await api.version()
    versions.value = data
    emit('refresh')
  } catch {
    checkError.value = '无法读取版本与检测结果，请稍后重试。'
  } finally {
    checking.value = false
  }
}

async function handleSyncModels() {
  syncingModels.value = true
  syncNotice.value = ''
  try {
    const res = await api.syncUpstreamModels()
    if (res.ok) {
      syncNotice.value = `同步成功：新增 ${res.result.addedModels.length} 个模型，现共 ${res.result.totalModels} 个`
      emit('refresh')
    }
  } catch {
    syncNotice.value = '同步失败，请检查上游网关连接'
  } finally {
    syncingModels.value = false
  }
}

function handleClickOutside(event: MouseEvent) {
  if (
    popoverRef.value &&
    !popoverRef.value.contains(event.target as Node) &&
    triggerRef.value &&
    !triggerRef.value.contains(event.target as Node)
  ) {
    open.value = false
  }
}

function handleEscape(event: KeyboardEvent) {
  if (event.key === 'Escape' && open.value) {
    open.value = false
    // 键盘关闭后焦点回到触发按钮，不留在已卸载的浮层里。
    triggerRef.value?.focus()
  }
}

onMounted(() => {
  document.addEventListener('mousedown', handleClickOutside)
  document.addEventListener('keydown', handleEscape)
  if (!versions.value) {
    void checkLatestVersion()
  }
})

onUnmounted(() => {
  document.removeEventListener('mousedown', handleClickOutside)
  document.removeEventListener('keydown', handleEscape)
})
</script>

<template>
  <div class="version-widget-wrap">
    <button
      ref="triggerRef"
      type="button"
      class="version-widget-trigger"
      :class="{ 'has-update': hasUpdate }"
      :aria-expanded="open"
      aria-haspopup="dialog"
      aria-label="查看系统与网关版本"
      @click="open = !open"
    >
      <span class="version-trigger-tag">
        <i class="i-carbon-terminal mr-1" />
        <span>{{ engineName }} {{ cpa?.engine === 'magpie' ? cpa?.version : `v${cpaShort}` }}</span>
        <span v-if="hasUpdate" class="version-dot-pulse" title="上游发现新版本" />
      </span>
      <span class="version-trigger-divider">/</span>
      <span class="version-trigger-tag">
        <i class="i-carbon-sparkles mr-1" />
        <span>v{{ consoleVer?.version || '0.1.0' }}</span>
      </span>
      <i class="i-carbon-chevron-down chevron" :class="{ open: open }" />
    </button>

    <div v-if="open" ref="popoverRef" class="version-popover" role="dialog" aria-label="系统与网关版本详情">
      <div class="version-popover-head">
        <div>
          <h3>系统版本与健康监控</h3>
          <p>{{ engineName }} 内核与 Crosery 管理端运行版本</p>
        </div>
        <TxButton
          variant="ghost"
          size="sm"
          :icon="checking ? 'i-carbon-renew animate-spin' : 'i-carbon-renew'"
          :disabled="checking"
          title="刷新版本与上游检测结果"
          @click="checkLatestVersion"
        />
      </div>

      <p v-if="checkError" class="form-error" role="status">{{ checkError }}</p>

      <div class="version-sections">
        <TxCard class="version-card">
          <div class="version-card-title">
            <div class="title-left">
              <i class="i-carbon-terminal" />
              <strong>{{ engineName }} 网关核心</strong>
            </div>
            <TxTag v-if="kernelUnavailable" type="warning" size="sm">内核不可用</TxTag>
            <TxTag v-else-if="hasUpdate" type="warning" size="sm">发现新版本</TxTag>
            <TxTag v-else type="success" size="sm">正常运行</TxTag>
          </div>

          <div class="version-props">
            <div class="prop-row">
              <span>当前运行版本</span>
              <code class="mono">{{ cpa?.version || '未知' }}</code>
            </div>
            <div v-if="cpa?.commit" class="prop-row">
              <span>Git Commit</span>
              <code class="mono">{{ cpa.commit.slice(0, 10) }}</code>
            </div>
            <div class="prop-row">
              <span>上游检测</span>
              <strong>{{ upstreamStatusText }}</strong>
            </div>
            <div class="prop-row">
              <span>OAuth 适配</span>
              <TxTag type="success" size="sm">已适配接入</TxTag>
            </div>
            <!--
              RTK 状态以 /api/rtk/status 的 planes 为真源（Lead/blue-rtk T12）：
              原来读 `cpa.rtk.connected`，而那个值来自「本机装了 rtk 二进制」，
              于是把「本机装了」显示成「已接通」——中转站侧其实没有 RTK 路由（404）。
            -->
            <div class="prop-row">
              <span>RTK 状态</span>
              <span v-if="rtkLoading" class="rtk-note">读取中…</span>
              <span v-else-if="rtkError" class="rtk-note" role="status">
                状态未知（{{ rtkError }}） ·
                <button type="button" class="link-btn" @click="loadRtk">重试</button>
              </span>
              <span v-else class="rtk-planes">
                <TxTag
                  v-for="plane in rtkPlanes"
                  :key="plane.id"
                  :type="plane.state === 'available' ? 'success' : 'info'"
                  size="sm"
                  :title="plane.reason"
                >
                  {{ PLANE_LABEL[plane.id] ?? plane.id }}：
                  {{ plane.state === 'available' ? `可用${plane.version ? ` (v${plane.version})` : ''}` : planeText(plane.state) }}
                </TxTag>
                <button type="button" class="link-btn" @click="openRtkPage">RTK 优化面板</button>
              </span>
            </div>
            <div v-if="rtk?.gain && rtk.gain.commands > 0" class="prop-row">
              <span>本机 RTK Token 节省</span>
              <strong>节省 {{ rtk.gain.pct.toFixed(1) }}% ({{ rtk.gain.saved.toLocaleString() }} tokens)</strong>
            </div>
          </div>

          <div class="version-actions">
            <TxButton
              variant="secondary"
              size="sm"
              class="sync-models-btn"
              :icon="syncingModels ? 'i-carbon-renew animate-spin' : 'i-carbon-renew'"
              :disabled="syncingModels"
              @click="handleSyncModels"
            >
              {{ syncingModels ? '正在同步上游模型...' : '动态同步上游最新模型' }}
            </TxButton>
            <small v-if="syncNotice" class="sync-notice">{{ syncNotice }}</small>
          </div>

          <div v-if="upstream" class="upstream-contract-status">
            <dl class="upstream-dl">
              <div><dt>源码路由</dt><dd>推理 {{ upstream.routes.inference }} / 管理 {{ upstream.routes.management }}</dd></div>
              <div><dt>登录 / RTK</dt><dd>{{ upstream.loginAgents.length }} 种登录 / {{ upstream.routes.rtk }} 个 RTK 接口</dd></div>
              <div v-if="upstream.checkedAt"><dt>上次检测</dt><dd>{{ new Date(upstream.checkedAt).toLocaleString('zh-CN') }}</dd></div>
              <div v-if="upstream.rtkRelease"><dt>RTK 上游版本</dt><dd>{{ upstream.rtkRelease }}</dd></div>
            </dl>
          </div>
        </TxCard>

        <TxCard class="version-card">
          <div class="version-card-title">
            <div class="title-left">
              <i class="i-carbon-sparkles" />
              <strong>Console 管理端</strong>
            </div>
            <TxTag type="success" size="sm">v{{ consoleVer?.version || '0.1.0' }}</TxTag>
          </div>
          <div class="version-props">
            <div class="prop-row">
              <span>软件版本</span>
              <code class="mono">v{{ consoleVer?.version || '0.1.0' }}</code>
            </div>
            <div v-if="consoleVer?.releaseDate" class="prop-row">
              <span>发布时间</span>
              <small>{{ new Date(consoleVer.releaseDate).toLocaleString('zh-CN') }}</small>
            </div>
          </div>
        </TxCard>
      </div>
    </div>
  </div>
</template>

<style scoped>
.version-widget-wrap {
  position: relative;
  display: inline-flex;
}

.version-widget-trigger {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 4px 10px;
  border-radius: var(--tx-border-radius-base);
  border: 1px solid var(--tx-border-color);
  background: var(--tx-bg-color);
  color: var(--tx-text-color-primary);
  font-size: 12px;
  cursor: pointer;
  transition: all 0.15s ease;
}

.version-widget-trigger:hover {
  border-color: var(--tx-color-primary);
}

.version-widget-trigger.has-update {
  border-color: var(--tx-color-warning);
}

.rtk-planes {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  justify-content: flex-end;
}

.rtk-note {
  color: var(--tx-text-color-secondary);
  font-size: 12px;
  text-align: right;
}

.link-btn {
  padding: 0;
  border: 0;
  background: transparent;
  color: var(--tx-color-primary);
  font: inherit;
  font-size: 12px;
  cursor: pointer;
  text-decoration: underline;
}

.version-trigger-tag {
  display: inline-flex;
  align-items: center;
  position: relative;
}

.version-trigger-divider {
  color: var(--tx-text-color-placeholder);
}

.version-dot-pulse {
  display: inline-block;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--tx-color-warning);
  margin-left: 4px;
}

.chevron {
  transition: transform 0.2s ease;
  font-size: 11px;
}

.chevron.open {
  transform: rotate(180deg);
}

.version-popover {
  position: absolute;
  top: calc(100% + 8px);
  right: 0;
  width: 360px;
  max-width: 90vw;
  background: var(--tx-bg-color-overlay);
  border: 1px solid var(--tx-border-color);
  border-radius: var(--tx-border-radius-base);
  box-shadow: 0 12px 32px rgba(0, 0, 0, 0.12);
  padding: 16px;
  z-index: 1000;
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.version-popover-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 8px;
}

.version-popover-head h3 {
  margin: 0;
  font-size: 14px;
  font-weight: 600;
  color: var(--tx-text-color-primary);
}

.version-popover-head p {
  margin: 2px 0 0;
  font-size: 12px;
  color: var(--tx-text-color-secondary);
}

.version-sections {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.version-card {
  padding: 12px !important;
}

.version-card-title {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 8px;
}

.title-left {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  color: var(--tx-text-color-primary);
}

.version-props {
  display: flex;
  flex-direction: column;
  gap: 6px;
  font-size: 12px;
}

.prop-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  color: var(--tx-text-color-secondary);
}

.prop-row code {
  color: var(--tx-text-color-primary);
}

.version-actions {
  margin-top: 10px;
  padding-top: 10px;
  border-top: 1px solid var(--tx-border-color-lighter);
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.sync-models-btn {
  width: 100%;
}

.sync-notice {
  text-align: center;
  font-size: 11px;
  color: var(--tx-color-success);
}

.upstream-contract-status {
  margin-top: 8px;
  padding-top: 8px;
  border-top: 1px dashed var(--tx-border-color-light);
  font-size: 11px;
}

.upstream-dl {
  margin: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.upstream-dl div {
  display: flex;
  justify-content: space-between;
}

.upstream-dl dt {
  color: var(--tx-text-color-secondary);
}

.upstream-dl dd {
  margin: 0;
  color: var(--tx-text-color-primary);
}

.form-error {
  color: var(--tx-color-danger);
  font-size: 12px;
  margin: 0;
}
</style>

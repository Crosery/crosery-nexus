<script setup lang="ts">
/**
 * task-78 ④ 的最小可见入口：magpie 内核更新状态面板。
 *
 * 挂载点由 Lead 统一收口（我不改 `src/pages/RtkPage.vue` 与 `src/styles/**`）——
 * 建议放在「系统维护 / RTK 设置」里，紧挨现有的版本小部件（VersionWidget）。
 *
 * 数据来自 `scripts/magpie-update.mjs status --json`（状态 JSON 字段固定：
 * lastCheckedAt / latestVersion / currentVersion / lastResult / backupPath / error）。
 * **真替换需要显式确认**：`apply` 只有在用户点开确认并勾选"我知道这会替换正在运行的内核"之后才允许发。
 */
import { computed, ref } from 'vue'
import { TxButton } from '@talex-touch/tuffex/button'
import { TxTag } from '@talex-touch/tuffex/tag'

const props = defineProps<{
  /** `magpie-update.mjs status --json` 的输出；null = 还没读过状态 */
  status: {
    currentVersion?: string | null
    latestVersion?: string | null
    lastCheckedAt?: string | null
    lastResult?: string | null
    backupPath?: string | null
    error?: string | null
  } | null
  /** 服务端能力是否可用（脚本存在 + 能读状态）；false 时禁用所有按钮并说明原因 */
  available?: boolean
  busy?: boolean
}>()

const emit = defineEmits<{ check: []; rehearse: []; apply: [] }>()

const confirming = ref(false)
const acknowledged = ref(false)

const RESULT_TEXT: Record<string, string> = {
  'up-to-date': '已是最新',
  'update-available': '发现新版本',
  updated: '已更新',
  rehearsed: '演练完成',
  'rolled-back': '已回滚',
  'failed-before-swap': '失败（替换前，旧版本未动）',
}

const resultText = computed(() => (props.status?.lastResult ? RESULT_TEXT[props.status.lastResult] || props.status.lastResult : '尚未检查'))
const updateAvailable = computed(() => Boolean(props.status?.latestVersion && props.status.currentVersion && props.status.latestVersion !== props.status.currentVersion))
const canApply = computed(() => props.available !== false && !props.busy && updateAvailable.value && acknowledged.value)

function askApply() {
  if (!confirming.value) { confirming.value = true; return }
  if (!acknowledged.value) return
  confirming.value = false
  acknowledged.value = false
  emit('apply')
}
</script>

<template>
  <div class="magpie-update-panel">
    <div class="mup-row">
      <strong>Magpie 内核更新</strong>
      <TxTag size="small" :type="updateAvailable ? 'warning' : 'success'">{{ resultText }}</TxTag>
    </div>

    <dl class="mup-grid">
      <dt>当前版本</dt><dd>{{ props.status?.currentVersion || '未知' }}</dd>
      <dt>上游最新</dt><dd>{{ props.status?.latestVersion || '未知' }}</dd>
      <dt>上次检查</dt><dd>{{ props.status?.lastCheckedAt || '尚未检查' }}</dd>
      <dt v-if="props.status?.backupPath">回滚备份</dt><dd v-if="props.status?.backupPath" class="mup-path">{{ props.status?.backupPath }}</dd>
    </dl>

    <p v-if="props.status?.error" class="mup-error">⚠ 上次失败：{{ props.status?.error }}（旧版本保持可用；失败不会破坏现有内核）</p>
    <p v-if="props.available === false" class="mup-note">此环境未启用内核更新能力（找不到更新脚本或状态不可读），按钮已禁用。</p>

    <div class="mup-actions">
      <TxButton size="small" :disabled="props.available === false || props.busy" @click="emit('check')">检查更新（只读）</TxButton>
      <TxButton size="small" :disabled="props.available === false || props.busy" @click="emit('rehearse')">临时目录演练</TxButton>
      <TxButton size="small" type="warning" :disabled="!canApply" @click="askApply">
        {{ confirming ? '确认替换正在运行的内核？' : '更新内核' }}
      </TxButton>
    </div>

    <label v-if="confirming" class="mup-confirm">
      <input v-model="acknowledged" type="checkbox" />
      我知道这会替换本机正在运行的内核（会先备份，失败自动回滚）
    </label>
    <p class="mup-note">默认只做只读检查与临时目录演练；真替换需要上面的显式确认。</p>
  </div>
</template>

<style scoped>
.magpie-update-panel { display: flex; flex-direction: column; gap: 8px; font-size: 13px; }
.mup-row { display: flex; align-items: center; gap: 8px; }
.mup-grid { display: grid; grid-template-columns: auto 1fr; gap: 2px 12px; margin: 0; }
.mup-grid dt { opacity: .7; }
.mup-grid dd { margin: 0; }
.mup-path { font-family: var(--font-mono, monospace); font-size: 11px; opacity: .8; word-break: break-all; }
.mup-error { color: var(--color-warning, #b26a00); margin: 0; }
.mup-note { margin: 0; opacity: .6; }
.mup-actions { display: flex; gap: 8px; flex-wrap: wrap; }
.mup-confirm { display: flex; align-items: center; gap: 6px; }
</style>

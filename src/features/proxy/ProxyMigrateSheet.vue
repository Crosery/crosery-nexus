<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { TxButton } from '@talex-touch/tuffex/button'
import Sheet from '../../ui/feedback/Sheet.vue'
import StateBlock from '../../ui/data/StateBlock.vue'
import { useBreakpoint } from '../../ui/composables/useBreakpoint'
import { notify } from '../../ui/feedback/toast'
import { errorMessage } from '../../lib/errors'
import { fmtDuration } from '../../ui/fmt'
import { api } from '../../api'
import type { DataState } from '../../ui/types'
import type { ProxyMigrationPreview } from '../../types'
import { byProviderLine, MIGRATE_ACTION } from './proxyModel'

/**
 * 从现有账号导入 (PROXY-SPEC §8): a dry-run scan of the exits accounts already use (read through the console's own
 * control plane; nothing is written), then 「导入（不改账号设置）」 adds the new exits to the pool and links the
 * accounts. Account settings never change here. The scan is cached for 10 min server-side (= its cooldown).
 */
const open = defineModel<boolean>({ default: false })
const emit = defineEmits<{ applied: [] }>()
const { isMobile } = useBreakpoint()

const scan = ref<ProxyMigrationPreview | null>(null)
const loading = ref(false)
const loadError = ref<unknown>(null)
const applying = ref(false)
const failure = ref('')

async function load() {
  loading.value = true
  loadError.value = null
  try {
    scan.value = await api.proxies.migratePreview()
  } catch (error) {
    loadError.value = error
  } finally {
    loading.value = false
  }
}
watch(open, (now) => {
  if (now) {
    failure.value = ''
    void load()
  } else {
    scan.value = null
  }
})

const state = computed<DataState>(() => (scan.value ? 'ready' : loadError.value ? 'error' : 'loading'))
/** what the import changes first (新建, 关联), then what it leaves (跳过, 已在池中) */
const ORDER = { create: 0, link: 1, skip: 2, unchanged: 3 } as const
const exits = computed(() => [...(scan.value?.exits ?? [])].sort((a, b) => ORDER[a.action] - ORDER[b.action] || b.accounts.total - a.accounts.total))
const willChange = computed(() => (scan.value ? scan.value.totals.create + scan.value.totals.link : 0))
const totalsLine = computed(() => {
  const t = scan.value?.totals
  if (!t) return ''
  const parts = [`${t.accounts} 个账号`, `${t.exits} 个出口`]
  if (t.inherit) parts.push(`继承全局 ${t.inherit}`)
  if (t.direct) parts.push(`直连 ${t.direct}`)
  if (t.invalid) parts.push(`地址无效 ${t.invalid}`)
  return parts.join(' · ')
})
const sourceNote = computed(() => {
  const s = scan.value?.sources
  if (!s) return ''
  const parts = [`读取 ${s.credentials} 个凭据`]
  if (s.readErrors) parts.push(`${s.readErrors} 个读取失败`)
  if (s.channelError) parts.push('渠道读取失败')
  if (s.presets) parts.push(`${s.presets} 个预设`)
  return parts.join(' · ')
})

async function apply() {
  if (!scan.value || applying.value) return
  applying.value = true
  failure.value = ''
  try {
    const result = await api.proxies.migrateApply(scan.value.scanId)
    notify(`✓ ${result.summary || `已导入 ${result.created} 个出口`}`, { tone: 'ok', description: '账号设置没有改动', id: 'cx-proxy' })
    emit('applied')
    open.value = false
  } catch (error) {
    const retry = (error as { retryAfterSec?: number | null }).retryAfterSec
    failure.value = retry ? `${errorMessage(error) || '冷却中'} · ${fmtDuration(retry * 1000)} 后再试` : errorMessage(error) || '导入失败'
  } finally {
    applying.value = false
  }
}
</script>

<template>
  <Sheet v-model="open" title="从现有账号导入" size="600px" :height="isMobile ? '92vh' : 'auto'">
    <div class="px-mg">
      <p class="px-mg__lead">把账号里已经配置的代理出口收进代理池，方便以后统一检测、迁移和分配。只读取，不改任何账号的设置。</p>
      <StateBlock v-if="state !== 'ready'" :state="state" :error="loadError" :rows="4" @retry="load" />
      <template v-else-if="scan">
        <p class="px-mg__totals num">{{ totalsLine }}</p>
        <ul v-if="exits.length" class="px-mg__rows" aria-label="出口">
          <li v-for="exit in exits" :key="exit.key" :class="{ 'is-skip': exit.action === 'skip' || exit.action === 'unchanged' }">
            <span class="px-mg__url mono ellip" :title="exit.maskedUrl">{{ exit.maskedUrl }}</span>
            <span class="px-mg__act">{{ MIGRATE_ACTION[exit.action] }}</span>
            <span class="px-mg__n num">{{ exit.accounts.total }} 个账号</span>
            <span class="px-mg__sub dim">
              {{ byProviderLine(exit.accounts.byProvider) }}<template v-if="exit.others.length">{{ exit.accounts.total ? ' · ' : '' }}{{ exit.others.join('、') }}</template>
              <template v-if="exit.external"> · 依赖该主机上的其它代理程序</template>
              <template v-if="exit.reason"> · {{ exit.reason }}</template>
            </span>
          </li>
        </ul>
        <p v-else class="px-mg__none">— 账号里没有可导入的代理出口</p>
        <p class="px-mg__note dim">{{ sourceNote }} · 继承全局和直连的账号只计数</p>
      </template>
      <p v-if="failure" class="px-add__fail" role="alert">◆ {{ failure }}</p>
    </div>
    <template #footer>
      <div class="px-add__foot">
        <span class="px-add__fh">{{ scan ? (willChange ? `新建 ${scan.totals.create} · 关联 ${scan.totals.link}` : '代理池已包含这些出口') : '' }}</span>
        <TxButton variant="primary" :loading="applying" :disabled="applying || !scan || !willChange" @click="apply">导入（不改账号设置）</TxButton>
      </div>
    </template>
  </Sheet>
</template>

<style>
.px-mg { display: grid; gap: 12px; min-width: 0; }
.px-mg__lead { margin: 0; font-size: var(--fs-sm); line-height: 1.55; color: var(--ink-2); }
.px-mg__totals { margin: 0; font-size: var(--fs-sm); color: var(--ink); }
.px-mg__rows { margin: 0; padding: 0; list-style: none; }
.px-mg__rows li {
  display: grid; grid-template-columns: minmax(0, 1fr) 64px 72px; grid-template-areas: 'url act n' 'sub sub sub';
  align-items: center; gap: 2px 12px; padding: 7px 0; border-top: 1px solid var(--rule); font-size: var(--fs-sm); color: var(--ink);
}
.px-mg__rows li.is-skip { color: var(--ink-3); }
.px-mg__url { grid-area: url; font-size: var(--fs-sm); }
.px-mg__act { grid-area: act; font-size: var(--fs-xs); }
.px-mg__n { grid-area: n; justify-self: end; font-size: var(--fs-xs); color: var(--ink-2); }
.px-mg__sub { grid-area: sub; font-size: var(--fs-xs); min-width: 0; overflow-wrap: anywhere; }
.px-mg__none { margin: 0; font-size: var(--fs-sm); color: var(--ink-3); }
.px-mg__note { margin: 0; font-size: var(--fs-xs); }
</style>

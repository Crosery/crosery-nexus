<script setup lang="ts">
import { computed, reactive, ref, useId, watch } from 'vue'
import { TxButton } from '@talex-touch/tuffex/button'
import { TxCheckbox } from '@talex-touch/tuffex/checkbox'
import { TxCollapse, TxCollapseItem } from '@talex-touch/tuffex/collapse'
import { TxInput } from '@talex-touch/tuffex/input'
import { TxTag } from '@talex-touch/tuffex/tag'
import Sheet from '../../ui/feedback/Sheet.vue'
import FilterField from '../../ui/form/FilterField.vue'
import { useBreakpoint } from '../../ui/composables/useBreakpoint'
import { notify } from '../../ui/feedback/toast'
import { confirmSheet } from '../../ui/feedback/confirmSheet'
import { errorMessage } from '../../lib/errors'
import { api } from '../../api'
import type { ProxyImportResult, ProxyPreview, ProxyPreviewRow } from '../../types'
import { FORMAT_WORD, importRows, INTERVAL_OPTIONS, previewCountLine, protocolLabel, protocolTags, quotaLine, restorePlan, rowEndpoint } from './proxyModel'

/**
 * 添加代理: ONE paste box → 解析 (server-side, nothing saved, the parsed data stays there for 10 min) → preview →
 * 导入 N 个. Subscriptions found in the paste are fetched once by 解析 and reused by 导入. Secrets never come back:
 * the preview carries names, types and host:port only. The paste is wiped when the sheet closes.
 */
const open = defineModel<boolean>({ default: false })
const emit = defineEmits<{ imported: [] }>()
const { isMobile } = useBreakpoint()
const uid = useId()

const text = ref('')
const tags = ref('')
const step = ref<'input' | 'preview'>('input')
const preview = ref<ProxyPreview | null>(null)
const parsing = ref(false)
const importing = ref(false)
const failure = ref<{ message: string; hint: string | null } | null>(null)
/** subscription key → included / interval */
const excluded = ref(new Set<string>())
const intervals = reactive<Record<string, string>>({})
const disclosure = ref<string[]>([])

function reset() {
  text.value = ''
  tags.value = ''
  step.value = 'input'
  preview.value = null
  failure.value = null
  excluded.value = new Set()
  for (const key of Object.keys(intervals)) delete intervals[key]
  disclosure.value = []
}
watch(open, (now) => { if (!now) reset() })

async function parse() {
  if (parsing.value || !text.value.trim()) return
  parsing.value = true
  failure.value = null
  try {
    const result = await api.proxies.parse(text.value)
    preview.value = result
    excluded.value = new Set()
    for (const sub of result.subscriptions) intervals[sub.key] = String(sub.intervalH)
    step.value = 'preview'
  } catch (error) {
    const body = (error as { body?: Record<string, unknown> }).body
    failure.value = { message: errorMessage(error) || '解析失败', hint: typeof body?.hint === 'string' ? body.hint : null }
  } finally {
    parsing.value = false
  }
}

function back() {
  step.value = 'input'
  failure.value = null
}

const rows = computed(() => (preview.value ? importRows(preview.value, excluded.value) : []))
const count = computed(() => rows.value.length)
/** an export file whose exits are all here already can still bring its account assignments back */
const assignmentsOnly = computed(() => !count.value && Boolean(preview.value?.assignments))
const countLine = computed(() => (preview.value ? previewCountLine(preview.value) : ''))
const protocols = computed(() => (preview.value ? protocolTags(preview.value) : []))
const kernelNote = computed(() => {
  const p = preview.value
  if (!p || p.kernelAvailable || !p.needsKernel) return null
  return `其中 ${p.needsKernel} 个需要 mihomo 内核：可先保存，暂不可用`
})
const SHOWN = 8
const shownRows = computed(() => rows.value.slice(0, SHOWN))
const others = computed(() => {
  const p = preview.value
  if (!p) return []
  const pick = (status: ProxyPreviewRow['status']) => p.rows.filter(row => row.status === status)
  return [
    { key: 'duplicate', title: '已在代理池', rows: pick('duplicate') },
    { key: 'unsupported', title: '不支持', rows: pick('unsupported') },
    { key: 'invalid', title: '无效', rows: pick('invalid') },
    { key: 'info', title: '订阅提示行（流量 / 到期），不导入', rows: pick('info') },
  ].filter(group => group.rows.length)
})

function toggleSub(key: string, on: boolean) {
  const next = new Set(excluded.value)
  if (on) next.delete(key)
  else next.add(key)
  excluded.value = next
}

const footHint = computed(() => {
  if (step.value === 'input') return text.value.trim() ? '只解析，不保存' : '先粘贴内容'
  if (assignmentsOnly.value) return `出口都已在代理池 · 文件里有 ${preview.value?.assignments} 条账号分配`
  if (!count.value) return '没有可导入的新出口'
  return '导入后可在表格里检测和分配'
})

async function commit() {
  const p = preview.value
  if (!p || importing.value || (!count.value && !assignmentsOnly.value)) return
  importing.value = true
  failure.value = null
  try {
    const result = await api.proxies.import(p.previewId, {
      tags: tags.value.split(/[,，\s]+/).map(tag => tag.trim()).filter(Boolean),
      subscriptions: p.subscriptions.map(sub => ({ key: sub.key, include: !excluded.value.has(sub.key), intervalH: Number(intervals[sub.key] ?? sub.intervalH) })),
    })
    if (count.value) {
      const parts = [`新增 ${result.added}`]
      if (result.updated) parts.push(`更新 ${result.updated}`)
      if (result.subscriptions.length) parts.push(`${result.subscriptions.length} 个订阅`)
      notify(`✓ 已导入 · ${parts.join(' · ')}`, { tone: 'ok', id: 'cx-proxy' })
    }
    emit('imported')
    open.value = false
    if (result.assignPlan.length) void restoreAssignments(result.assignPlan)
  } catch (error) {
    const code = (error as { code?: string | null }).code
    if (code === 'preview_expired') {
      step.value = 'input'
      failure.value = { message: '预览已过期（10 分钟），请重新解析', hint: null }
    } else {
      failure.value = { message: errorMessage(error) || '导入失败', hint: null }
    }
  } finally {
    importing.value = false
  }
}

/** after the import (sheet closed): put the file's accounts back on their exits, once confirmed */
async function restoreAssignments(plan: ProxyImportResult['assignPlan']) {
  let restore: ReturnType<typeof restorePlan>
  try {
    restore = restorePlan(plan, (await api.proxies.accounts()).accounts)
  } catch (error) {
    notify('◇ 文件里的账号分配没有恢复', { tone: 'warn', description: errorMessage(error) || '读取账号失败 · 可在 ⋯ 分配给账号 里手动处理', id: 'cx-proxy-restore' })
    return
  }
  if (!restore.accounts) {
    if (restore.missing) notify(`◇ 文件里的 ${restore.missing} 个账号这台控制台没有，分配已跳过`, { tone: 'warn', id: 'cx-proxy-restore' })
    else if (restore.linked && !count.value) notify(`✓ ${restore.linked} 个账号已经在用文件里的出口`, { tone: 'ok', id: 'cx-proxy-restore' })
    return
  }
  const facts = [{ k: '账号', v: `${restore.accounts} 个` }, { k: '出口', v: `${restore.groups.length} 个` }]
  if (restore.linked) facts.push({ k: '已在用', v: `${restore.linked} 个` })
  if (restore.missing) facts.push({ k: '跳过', v: `${restore.missing} 个（这台控制台没有或只读）` })
  const ok = await confirmSheet({
    title: `按文件恢复 ${restore.accounts} 个账号的出口？`,
    body: '导出文件记着每个账号用的出口。恢复后这些账号改走对应出口。',
    facts,
    consequence: '可随时撤销 · 原出口已记下，可一键还原',
    confirmText: '恢复',
  })
  if (!ok) return
  let updated = 0
  let failed = 0
  for (const group of restore.groups) {
    try {
      const result = await api.proxies.assign(group.entryId, group.refs)
      updated += result.updated
      failed += result.failed
    } catch {
      failed += group.refs.length
    }
  }
  if (failed) notify(`◇ 已恢复 ${updated} 个 · ${failed} 个失败`, { tone: 'warn', description: '可在 ⋯ 分配给账号 里重试', id: 'cx-proxy-restore' })
  else notify(`✓ 已恢复 ${updated} 个账号的出口`, { tone: 'ok', id: 'cx-proxy-restore' })
  emit('imported')
}
</script>

<template>
  <Sheet v-model="open" title="添加代理" size="600px" :height="isMobile ? '92vh' : 'auto'">
    <div class="px-add">
      <template v-if="step === 'input'">
        <label class="px-add__k" :for="`${uid}-paste`">粘贴内容</label>
        <TxInput
          :id="`${uid}-paste`"
          v-model="text"
          type="textarea"
          :rows="isMobile ? 8 : 10"
          class="px-add__paste"
          placeholder="粘贴 Clash 配置、订阅链接、ss:// vmess:// trojan:// 等链接，或 http / socks5 地址"
          spellcheck="false"
          autocomplete="off"
          :disabled="parsing"
        />
        <p class="px-add__hint">Clash / mihomo 配置（proxies、proxy-providers）· 订阅链接 · 分享链接 · Base64 订阅 · 代理池导出文件。在服务端解析，页面上不显示密码。</p>
      </template>

      <template v-else-if="preview">
        <div class="px-pv__head">
          <span class="px-pv__fmt">{{ FORMAT_WORD[preview.format] }}</span>
          <span class="num">{{ countLine || '没有找到代理' }}</span>
        </div>
        <div v-if="protocols.length" class="px-pv__protos" aria-label="按协议">
          <TxTag v-for="p in protocols" :key="p.label" size="sm" variant="outline" :label="`${p.label} ${p.n}`" />
        </div>
        <p v-if="kernelNote" class="px-pv__note">◇ {{ kernelNote }}</p>
        <p v-for="note in preview.notes" :key="note" class="px-pv__note">{{ note }}</p>
        <p v-if="preview.ignoredSections.length" class="px-pv__note dim">已忽略 {{ preview.ignoredSections.join('、') }}</p>

        <section v-if="preview.subscriptions.length" class="px-pv__subs" aria-label="订阅">
          <h3 class="px-add__k">订阅</h3>
          <div v-for="sub in preview.subscriptions" :key="sub.key" class="px-pv__sub">
            <TxCheckbox
              :model-value="sub.ok && !excluded.has(sub.key)"
              :disabled="!sub.ok"
              :aria-label="`导入订阅 ${sub.name}`"
              @update:model-value="(on: boolean) => toggleSub(sub.key, on)"
            >
              <span class="px-pv__subn ellip">{{ sub.name }}</span>
            </TxCheckbox>
            <span class="px-pv__url mono ellip" :title="sub.maskedUrl">{{ sub.maskedUrl }}</span>
            <span v-if="sub.ok" class="num dim">{{ sub.nodeCount }} 个节点{{ quotaLine(sub.info) ? ` · ${quotaLine(sub.info)}` : '' }}</span>
            <span v-else class="px-pv__bad">◆ {{ sub.error || '拉取失败' }}</span>
            <span v-if="sub.insecureHttp" class="px-pv__bad">◇ http 明文订阅</span>
            <FilterField v-if="sub.ok" v-model="intervals[sub.key]" class="px-pv__iv" label="更新" :options="INTERVAL_OPTIONS" :all-label="null" :searchable="false" />
          </div>
        </section>

        <section v-if="rows.length" class="px-pv__list" aria-label="将导入">
          <h3 class="px-add__k">将导入 <span class="dim num">{{ count }}</span></h3>
          <ul>
            <li v-for="row in shownRows" :key="row.key">
              <span class="ellip">{{ row.name || '未命名' }}</span>
              <span class="px-pv__proto">{{ protocolLabel(row.protocol ?? row.type) }}</span>
              <span class="mono dim ellip">{{ rowEndpoint(row) }}</span>
              <span class="px-pv__st" :class="{ 'is-up': row.status === 'update' }">{{ row.status === 'update' ? '更新' : row.external ? '外部本机' : '新' }}</span>
            </li>
            <li v-if="rows.length > SHOWN" class="dim">… 还有 {{ rows.length - SHOWN }} 个</li>
          </ul>
        </section>

        <TxCollapse v-if="others.length" v-model="disclosure" class="px-pv__more">
          <TxCollapseItem v-for="group in others" :key="group.key" :name="group.key">
            <template #title>
              <span class="px-pv__mk">{{ group.title }}</span>
              <span class="num dim">{{ group.rows.length }}</span>
            </template>
            <ul class="px-pv__why">
              <li v-for="row in group.rows" :key="row.key">
                <span class="ellip">{{ row.name || '未命名' }}</span>
                <span class="mono dim ellip">{{ rowEndpoint(row) || row.type }}</span>
                <span class="dim">{{ row.reason || (row.status === 'duplicate' ? '已存在' : '') }}</span>
              </li>
            </ul>
          </TxCollapseItem>
        </TxCollapse>

        <div v-if="count" class="px-pv__tags">
          <label class="px-add__k" :for="`${uid}-tags`">标签 <span class="px-add__opt">可选 · 逗号分隔</span></label>
          <TxInput :id="`${uid}-tags`" v-model="tags" placeholder="如 日本, 住宅" autocomplete="off" />
        </div>
      </template>

      <p v-if="failure" class="px-add__fail" role="alert">◆ {{ failure.message }}<template v-if="failure.hint"> · {{ failure.hint }}</template></p>
    </div>

    <template #footer>
      <div class="px-add__foot">
        <span class="px-add__fh">{{ footHint }}</span>
        <TxButton v-if="step === 'preview'" variant="ghost" :disabled="importing" @click="back">返回修改</TxButton>
        <TxButton v-if="step === 'input'" variant="primary" :loading="parsing" :disabled="parsing || !text.trim()" @click="parse">解析</TxButton>
        <TxButton v-else variant="primary" :loading="importing" :disabled="importing || (!count && !assignmentsOnly)" @click="commit">{{ assignmentsOnly ? '恢复账号分配' : `导入 ${count} 个` }}</TxButton>
      </div>
    </template>
  </Sheet>
</template>

<style>
.px-add { display: grid; gap: 12px; min-width: 0; }
.px-add__k { display: flex; align-items: baseline; gap: 8px; margin: 0; font-size: var(--fs-sm); font-weight: 600; color: var(--ink); }
.px-add__opt { font-size: var(--fs-xs); font-weight: 400; color: var(--ink-3); }
.px-add__hint { margin: 0; font-size: var(--fs-xs); line-height: 1.55; color: var(--ink-3); }
html:root .px-add__paste textarea, html:root .px-add__paste .tx-input__inner { font-family: var(--font-mono); font-size: var(--fs-sm); line-height: 1.5; min-height: 180px; resize: vertical; }
.px-add__fail { margin: 0; padding: 8px 10px; border-left: 2px solid var(--signal); background: var(--paper-2); font-size: var(--fs-sm); color: var(--ink); overflow-wrap: anywhere; }
.px-add__foot { display: flex; align-items: center; gap: 8px; width: 100%; }
.px-add__fh { margin-right: auto; font-size: var(--fs-xs); color: var(--ink-3); min-width: 0; }
html:root .px-add__foot > :not(.px-add__fh) { flex: none; }
@media (max-width: 599px) {
  .px-add__foot { flex-wrap: wrap; justify-content: flex-end; row-gap: 10px; }
  .px-add__fh { flex: 1 0 100%; }
}

.px-pv__head { display: flex; align-items: baseline; gap: 12px; flex-wrap: wrap; font-size: var(--fs-sm); color: var(--ink); }
.px-pv__fmt { font-weight: 600; }
.px-pv__protos { display: flex; flex-wrap: wrap; gap: 6px; }
.px-pv__note { margin: 0; font-size: var(--fs-xs); line-height: 1.5; color: var(--ink-2); }
.px-pv__subs, .px-pv__list { display: grid; gap: 6px; min-width: 0; }
.px-pv__sub { display: flex; align-items: center; flex-wrap: wrap; gap: 4px 12px; min-height: 40px; padding: 4px 0; border-top: 1px solid var(--rule); font-size: var(--fs-sm); min-width: 0; }
.px-pv__subn { max-width: 180px; font-weight: 500; }
.px-pv__url { flex: 1 1 160px; min-width: 0; font-size: var(--fs-xs); color: var(--ink-3); }
.px-pv__bad { font-size: var(--fs-xs); color: var(--signal-ink); }
.px-pv__iv { margin-left: auto; }
.px-pv__list ul, .px-pv__why { margin: 0; padding: 0; list-style: none; }
.px-pv__list li, .px-pv__why li {
  display: grid; grid-template-columns: minmax(0, 1.3fr) 72px minmax(0, 1.4fr) 56px; align-items: center; gap: 10px;
  min-height: 32px; border-top: 1px solid var(--rule); font-size: var(--fs-sm); color: var(--ink);
}
.px-pv__why li { grid-template-columns: minmax(0, 1fr) minmax(0, 1fr) minmax(0, 1.2fr); font-size: var(--fs-xs); }
.px-pv__list li.dim { display: block; padding-top: 6px; color: var(--ink-3); font-size: var(--fs-xs); }
.px-pv__proto { font-size: var(--fs-xs); color: var(--ink-2); }
.px-pv__st { justify-self: end; font-size: var(--fs-xs); color: var(--ink-3); }
.px-pv__st.is-up { color: var(--ink); }
html:root .px-pv__more { border-top: 1px solid var(--rule); }
html:root .px-pv__more .tx-collapse-item__header { min-height: 38px; gap: 10px; }
html:root .px-pv__more .tx-collapse-item__title { display: flex; align-items: baseline; gap: 8px; }
html:root .px-pv__more .tx-collapse-item__content-inner { padding: 0 0 6px; }
.px-pv__mk { font-size: var(--fs-sm); color: var(--ink); }
.px-pv__tags { display: grid; gap: 6px; }

@media (max-width: 599px) {
  .px-pv__list li { grid-template-columns: minmax(0, 1fr) auto; row-gap: 0; padding: 4px 0; }
  .px-pv__list li .mono { grid-column: 1 / -1; font-size: var(--fs-xs); }
  .px-pv__list li .px-pv__st { grid-row: 1; grid-column: 2; }
  .px-pv__list li .px-pv__proto { display: none; }
  .px-pv__why li { grid-template-columns: minmax(0, 1fr); gap: 0; padding: 4px 0; }
  .px-pv__iv { margin-left: 0; }
}
</style>

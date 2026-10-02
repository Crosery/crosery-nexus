<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'
import { RouterLink } from 'vue-router'
import { TxButton } from '@talex-touch/tuffex/button'
import { TxInput } from '@talex-touch/tuffex/input'
import { TxSelect } from '@talex-touch/tuffex/select'
import Plate from '../../ui/data/Plate.vue'
import Segmented from '../../ui/form/Segmented.vue'
import Switch from '../../ui/form/Switch.vue'
import { CALM_PANEL } from '../../ui/form/anchor'
import { api } from '../../api'
import { errorMessage } from '../../lib/errors'
import { useLive } from '../../ui/composables/useLive'
import { notify } from '../../ui/feedback/toast'
import type { GatewayModelChoice, GatewaySettingItem, GatewaySettings, GatewaySettingValues } from '../../types'

/**
 * 网关功能 (#gateway-features): Magpie's own gateway features — 识图 / 生图模型, 脱敏 — mirrored from Magpie's
 * Settings with its zh copy (deploy/magpie/catalog.json `settings`, regenerated on each pin bump). Values live in
 * the kernel's settings.json, read and written through /api/gateway/settings; a change applies from the next
 * request. CPA gateway: one honest line, no controls. Desktop-only rows (外观, 托盘, 预热, 局域网…) are not shown.
 */
const emit = defineEmits<{ index: [value: { value: string; hot: boolean }] }>()

const live = useLive<GatewaySettings>((signal) => api.gatewaySettings(signal), { intervalMs: 0 })
const data = computed(() => live.data.value)
const values = computed(() => data.value?.values ?? null)
const catalog = computed(() => data.value?.catalog ?? null)
const zh = (key: string, fallback = '') => catalog.value?.copy[key]?.zh ?? fallback

const shortRev = computed(() => (data.value?.revision ?? '').slice(0, 7))
const upstreamLine = computed(() => {
  const u = data.value?.upstream
  if (!u) return ''
  if (u.added.length) return `上游新增 ${u.added.length} 项设置，待评审`
  if (u.changed.length + u.removed.length) return `上游改动 ${u.changed.length + u.removed.length} 项设置，待评审`
  return ''
})

const groups = computed(() => (catalog.value?.groups ?? []).map((group) => ({
  ...group,
  items: (catalog.value?.items ?? []).filter((item) => item.group === group.id),
})))
const featureNames = computed(() => (catalog.value?.items ?? []).filter((item) => item.class === 'gateway').map((item) => item.name.zh).join(' · '))

watch(data, (view) => {
  if (!view) return
  emit('index', view.available && view.values
    ? { value: view.values.redact ? '脱敏 开' : '脱敏 关', hot: false }
    : { value: view.reason === 'cpa_engine' ? '仅 Magpie' : '不可用', hot: view.reason !== 'cpa_engine' })
})

/* ── writes: one key per request, the server answers with the whole new view ── */
const busy = reactive<Record<string, boolean>>({})
async function save(patch: Partial<GatewaySettingValues>, done?: () => void) {
  const key = Object.keys(patch)[0]
  if (busy[key]) return false
  busy[key] = true
  try {
    live.data.value = await api.setGatewaySettings(patch)
    done?.()
    notify('◆ 已保存 · 从下一个请求生效', { tone: 'ok', id: 'cx-gwf' })
    return true
  } catch (error) {
    notify(`◆ 未保存 · ${errorMessage(error) || '请求失败'}`, { tone: 'bad', id: 'cx-gwf' })
    return false
  } finally {
    busy[key] = false
  }
}

/* 识图 / 生图: 自动 · <its pick>, 关闭, or a model the gateway serves */
function modelOf(key: string): GatewayModelChoice | null {
  const models = data.value?.models
  return key === 'vision' ? models?.vision ?? null : key === 'imageGen' ? models?.imageGen ?? null : null
}
function labelOf(choice: GatewayModelChoice, id: string) {
  const option = choice.options.find((entry) => entry.id === id)
  return option ? `${option.label}${option.provider ? ` · ${option.provider}` : ''}` : id.slice(id.indexOf('/') + 1)
}
function modelOptions(item: GatewaySettingItem) {
  const choice = modelOf(item.key)
  if (!choice) return []
  const none = item.key === 'vision' ? zh('noModelSees', '没有能看图的模型') : zh('noModelDraws', '没有能生图的模型')
  const current = modelValue(item.key)
  // a stored model the gateway no longer serves stays selectable, marked, so the box never reads 请选择
  const gone = current && current !== 'off' && !choice.options.some((option) => option.id === current)
  return [
    { value: '', label: `${zh('automatic', '自动')} · ${choice.auto ? labelOf(choice, choice.auto) : none}` },
    { value: 'off', label: zh('off', '关闭') },
    ...(gone ? [{ value: current, label: `${labelOf(choice, current)}（已失效）` }] : []),
    ...choice.options.map((option) => ({ value: option.id, label: `${option.label}${option.provider ? ` · ${option.provider}` : ''}` })),
  ]
}
const modelValue = (key: string) => (values.value ? (values.value[key as 'vision' | 'imageGen'] ?? '') : '')
function setModel(key: string, value: unknown) {
  if (typeof value !== 'string' || value === modelValue(key)) return
  void save({ [key]: value })
}
function subOf(item: GatewaySettingItem) {
  return item.control === 'model' && modelValue(item.key) === 'off' && item.subOff ? item.subOff.zh : item.sub.zh
}
/** warn: the setting is not doing what it shows; quiet: a standing fact about it */
function notesOf(item: GatewaySettingItem) {
  const notes: Array<{ text: string; warn: boolean }> = []
  if (modelOf(item.key)?.stale) notes.push({ text: '所选模型已不在网关里，正在用自动选择', warn: true })
  if (item.key === 'redactRules' && values.value && !values.value.redact && values.value.redactRules.length) notes.push({ text: '「脱敏密钥」未开启，规则暂未生效', warn: true })
  if (item.key === 'imageGen' && data.value?.models && !data.value.models.imageGen.admitted) notes.push({ text: '控制台网关暂未开放 /v1/images，这一项暂不影响控制台客户端', warn: false })
  return notes
}

/* 脱敏词: comma / 中文逗号 / newline separated, saved on Enter or blur */
const wordsText = ref('')
watch(values, (v) => { wordsText.value = (v?.redactWords ?? []).join(', ') }, { immediate: true })
function saveWords() {
  const words = wordsText.value.split(/[,，\n]/).map((word) => word.trim()).filter(Boolean)
  if (words.join(', ') === (values.value?.redactWords ?? []).join(', ')) return
  void save({ redactWords: words })
}

/* 自定义脱敏规则: name + 前缀/正则 + pattern; the whole list is sent each time, a bad pattern keeps the draft */
const draft = reactive({ kind: '', by: 'prefix' as 'prefix' | 'regex', match: '' })
const BY = computed(() => [{ value: 'prefix', label: zh('prefix', '前缀') }, { value: 'regex', label: zh('regex', '正则') }])
const rules = computed(() => values.value?.redactRules ?? [])
function ruleText(rule: { prefix?: string; regex?: string }) {
  return rule.prefix ? zh('startsWith', '以 {p} 开头').replace('{p}', rule.prefix) : zh('matches', '匹配 {re}').replace('{re}', rule.regex ?? '')
}
function addRule() {
  const match = draft.match.trim()
  if (!match) return
  const rule = { kind: draft.kind.trim(), [draft.by]: match }
  void save({ redactRules: [...rules.value, rule] }, () => { draft.kind = ''; draft.match = '' })
}
function removeRule(index: number) {
  void save({ redactRules: rules.value.filter((_, at) => at !== index) })
}
function setBy(value: string | number | null | undefined) {
  if (value === 'prefix' || value === 'regex') draft.by = value
}
</script>

<template>
  <Plate id="gateway-features" title="网关功能" class="set-sec set-gwf" :state="live.state.value" :error="live.error.value" :rows="6" @retry="live.refresh">
    <template #meta>
      <span class="num">来自 Magpie {{ shortRev }}</span>
      <RouterLink v-if="upstreamLine" :to="{ hash: '#magpie' }" class="ui-link set-gwf__up">{{ upstreamLine }}</RouterLink>
    </template>

    <div v-if="data && !data.available" class="set-gwf__off">
      <p class="set-gwf__off-l">{{ data.message ?? '仅 Magpie 网关可用' }}</p>
      <p v-if="featureNames" class="set-gwf__off-s dim">{{ featureNames }}</p>
    </div>

    <template v-else-if="data && values">
      <section v-for="group in groups" :key="group.id" class="set-gwf__group" :aria-labelledby="`gwf-${group.id}`">
        <h3 :id="`gwf-${group.id}`" class="set-gwf__gh">{{ group.title.zh }}</h3>
        <template v-for="item in group.items" :key="item.key">
          <div class="set-gwf__row" :class="{ 'set-gwf__row--stack': item.control === 'rules' || item.control === 'words' }">
            <div class="set-gwf__who">
              <span class="set-gwf__name">{{ item.name.zh }}</span>
              <span class="set-gwf__sub">{{ subOf(item) }}</span>
              <span v-for="note in notesOf(item)" :key="note.text" class="set-gwf__note" :class="{ 'is-warn': note.warn }">{{ note.text }}</span>
            </div>

            <div class="set-gwf__val">
              <Switch
                v-if="item.control === 'switch'"
                :model-value="values[item.key as 'redact' | 'redactPersonal']"
                :aria-label="item.name.zh"
                :loading="busy[item.key]"
                @update:model-value="(on: boolean) => void save({ [item.key]: on })"
              />
              <TxSelect
                v-else-if="item.control === 'model'"
                class="set-gwf__sel"
                v-bind="CALM_PANEL"
                :model-value="modelValue(item.key)"
                :options="modelOptions(item)"
                :searchable="modelOptions(item).length > 8"
                :disabled="busy[item.key]"
                placeholder="请选择"
                search-placeholder="筛选…"
                empty-text="没有匹配项"
                loading-text="加载中…"
                :dropdown-offset="4"
                :aria-label="item.name.zh"
                @update:model-value="(v: unknown) => setModel(item.key, v)"
              />
              <span v-else-if="item.control === 'forced-off'" class="set-gwf__forced">已关闭（控制台强制）</span>
              <TxInput
                v-else-if="item.control === 'words'"
                v-model="wordsText"
                class="set-gwf__words"
                :placeholder="item.placeholder?.zh ?? ''"
                :disabled="busy.redactWords"
                :aria-label="item.name.zh"
                @blur="saveWords"
                @keydown.enter="saveWords"
              />
              <div v-else-if="item.control === 'rules'" class="set-gwf__add">
                <TxInput v-model="draft.kind" class="set-gwf__kind" placeholder="API_KEY" aria-label="规则名称" @keydown.enter="addRule" />
                <Segmented :model-value="draft.by" :items="BY" label="匹配方式" @update:model-value="setBy" />
                <TxInput
                  v-model="draft.match"
                  class="set-gwf__match"
                  :placeholder="draft.by === 'prefix' ? 'oc_sk_' : 'oc_sk_[A-Za-z0-9]{20,}'"
                  :aria-label="draft.by === 'prefix' ? '前缀' : '正则'"
                  @keydown.enter="addRule"
                />
                <TxButton size="sm" variant="secondary" :loading="busy.redactRules" :disabled="busy.redactRules || !draft.match.trim()" @click="addRule">
                  {{ zh('add', '添加') }}
                </TxButton>
              </div>
            </div>
          </div>
          <ul v-if="item.control === 'rules' && rules.length" class="set-gwf__rules">
            <li v-for="(rule, index) in rules" :key="`${rule.kind}-${index}`" class="set-gwf__rule">
              <span class="set-gwf__rk num">{{ rule.kind }}</span>
              <span class="set-gwf__rt">{{ ruleText(rule) }}</span>
              <TxButton size="sm" variant="ghost" :disabled="busy.redactRules" @click="removeRule(index)">{{ zh('remove', '移除') }}</TxButton>
            </li>
          </ul>
        </template>
      </section>
    </template>
  </Plate>
</template>

<style>
.set-gwf__up { margin-left: 10px; font-size: var(--fs-xs); }
.set-gwf__off { display: grid; gap: 4px; padding: 6px 0 4px; }
.set-gwf__off-l { margin: 0; font-size: var(--fs-base); color: var(--ink); }
.set-gwf__off-s { margin: 0; font-size: var(--fs-xs); }

.set-gwf__group + .set-gwf__group { margin-top: 14px; }
.set-gwf__gh { margin: 0 0 2px; font-size: var(--fs-xs); font-weight: 600; color: var(--ink-3); letter-spacing: 0.02em; }
.set-gwf__row { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: center; gap: 6px 24px; min-height: 52px; padding: 8px 0; }
.set-gwf__row + .set-gwf__row, .set-gwf__rules + .set-gwf__row { border-top: 1px solid var(--rule); }
.set-gwf__row--stack { grid-template-columns: minmax(0, 1fr) minmax(0, 1.25fr); }
.set-gwf__who { display: grid; gap: 2px; min-width: 0; }
.set-gwf__name { font-size: var(--fs-base); color: var(--ink); }
.set-gwf__sub { font-size: var(--fs-xs); color: var(--ink-3); }
.set-gwf__note { font-size: var(--fs-xs); color: var(--ink-3); }
.set-gwf__note.is-warn { color: var(--signal-ink); }
.set-gwf__val { display: flex; align-items: center; justify-content: flex-end; gap: 8px; min-width: 0; }
.set-gwf__forced { font-size: var(--fs-sm); color: var(--ink-2); white-space: nowrap; }
html:root .set-gwf .set-gwf__sel { width: 300px; max-width: 100%; }
html:root .set-gwf .set-gwf__words { width: 100%; }
.set-gwf__add { display: flex; flex-wrap: wrap; align-items: center; justify-content: flex-end; gap: 8px; width: 100%; }
html:root .set-gwf .set-gwf__kind { width: 120px; flex: 0 0 auto; }
html:root .set-gwf .set-gwf__match { flex: 1 1 160px; min-width: 0; }

.set-gwf__rules { list-style: none; margin: 0 0 6px; padding: 0; }
.set-gwf__rule { display: grid; grid-template-columns: minmax(80px, max-content) minmax(0, 1fr) auto; align-items: center; gap: 12px; min-height: 36px; padding-left: 12px; font-size: var(--fs-sm); }
.set-gwf__rk { color: var(--ink); }
.set-gwf__rt { color: var(--ink-2); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

@media (max-width: 959px) {
  .set-gwf__row--stack { grid-template-columns: minmax(0, 1fr); }
  .set-gwf__row--stack .set-gwf__val { justify-content: flex-start; }
}
@media (max-width: 599px) {
  .set-gwf__row { grid-template-columns: minmax(0, 1fr); }
  .set-gwf__val { justify-content: flex-start; }
  .set-gwf__row:has(.ui-switch) { grid-template-columns: minmax(0, 1fr) auto; }
  .set-gwf__row:has(.ui-switch) .set-gwf__val { justify-content: flex-end; }
  html:root .set-gwf .set-gwf__sel { width: 100%; }
  .set-gwf__add { justify-content: flex-start; }
  .set-gwf__rule { padding-left: 0; }
}
</style>

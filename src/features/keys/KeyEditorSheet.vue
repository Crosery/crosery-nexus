<script setup lang="ts">
import { computed, nextTick, reactive, ref, useId, watch } from 'vue'
import { TxButton } from '@talex-touch/tuffex/button'
import { TxCheckbox } from '@talex-touch/tuffex/checkbox'
import { TxInput } from '@talex-touch/tuffex/input'
import Sheet from '../../ui/feedback/Sheet.vue'
import Switch from '../../ui/form/Switch.vue'
import { errorMessage } from '../../lib/errors'
import { useSheetWrite } from '../../lib/resource'
import { notify } from '../../ui/feedback/toast'
import type { ApiKeyItem, GatewayModelAccess, Group } from '../../types'
import { keysApi } from './keysApi'
import './keys.css'
import {
  createKeyWithQuota,
  defaultGroupCap,
  editorPayload,
  NAME_MAX,
  NOTE_MAX,
  validateEditor,
  validateQuotaDraft,
  type EditorDraft,
  type QuotaDraft,
} from './keysModel'

/**
 * 新建 / 编辑 Key (DESIGN §6.3 dialogs): a right sheet (bottom under 960). Name, note, authorised channels,
 * concurrency (不限 or a total plus a cap per channel — the server rejects a limited Key without per-channel
 * caps, so they are shown, not hidden) and, on create, the three quotas. Field errors sit under their field;
 * submit focuses the first one. Creating hands the full key to the reveal sheet.
 * One write at a time (useSheetWrite): Enter, a held Enter or a close-and-reopen mid-request never sends a second
 * create; a write that lands after the sheet was reopened still reaches the page but leaves the new draft alone.
 */
const props = defineProps<{
  mode: 'create' | 'edit'
  item: ApiKeyItem | null
  groups: Group[]
  keys: ApiKeyItem[]
  gatewayModelAccess: GatewayModelAccess
}>()
const open = defineModel<boolean>({ default: false })
const emit = defineEmits<{
  created: [result: { name: string; key: string; quotaError: string | null }]
  saved: [name: string]
}>()

const uid = useId()
const draft = reactive<EditorDraft>({ name: '', note: '', groups: [], unlimited: true, totalConcurrency: '4', groupConcurrency: {} })
const quota = reactive<QuotaDraft>({ daily: '', weekly: '', total: '' })
const errors = ref<Record<string, string>>({})
const quotaErrors = ref<Partial<Record<keyof QuotaDraft, string>>>({})
const touched = ref(false)
const rtkCompress = ref(false)
const write = useSheetWrite()
const { busy, stale } = write
const failure = ref('')
const body = ref<HTMLElement | null>(null)

function reset() {
  const item = props.mode === 'edit' ? props.item : null
  draft.name = item?.name ?? ''
  draft.note = item?.note ?? ''
  draft.groups = item ? [...item.groups] : props.groups.map((g) => g.id)
  draft.unlimited = item ? !item.totalConcurrency : true
  draft.totalConcurrency = item?.totalConcurrency ? String(item.totalConcurrency) : '4'
  draft.groupConcurrency = Object.fromEntries(
    draft.groups.map((id) => [id, item?.groupConcurrency?.[id] ? String(item.groupConcurrency[id]) : defaultGroupCap(draft.totalConcurrency)]),
  )
  quota.daily = ''
  quota.weekly = ''
  quota.total = ''
  rtkCompress.value = item?.rtkCompress ?? false
  errors.value = {}
  quotaErrors.value = {}
  touched.value = false
  failure.value = ''
  write.renew()
}

watch(open, (value) => {
  if (!value) {
    // dismissed mid-write: the write's outcome now arrives as a toast instead of on a hidden sheet
    write.renew()
    return
  }
  reset()
  void nextTick(() => body.value?.querySelector<HTMLInputElement>('input')?.focus())
}, { immediate: true })

/* create opened before the Key list loaded: authorise every channel once the groups arrive */
watch(() => props.groups.length, (n, before) => {
  if (open.value && props.mode === 'create' && n && !before && !draft.groups.length) {
    draft.groups = props.groups.map((g) => g.id)
    for (const id of draft.groups) draft.groupConcurrency[id] ??= defaultGroupCap(draft.totalConcurrency)
  }
})

const others = computed(() => props.keys.filter((k) => k.id !== props.item?.id || props.mode === 'create'))
const title = computed(() => (props.mode === 'create' ? '新建 Key' : `编辑 ${props.item?.name ?? ''}`))
const allOn = computed(() => props.groups.length > 0 && props.groups.every((g) => draft.groups.includes(g.id)))
/* groups this Key still references that are no longer configured (shown so they can be dropped) */
const orphanGroups = computed(() => draft.groups.filter((id) => !props.groups.some((g) => g.id === id)))

function toggleGroup(id: string) {
  draft.groups = draft.groups.includes(id) ? draft.groups.filter((g) => g !== id) : [...draft.groups, id]
  if (draft.groups.includes(id)) draft.groupConcurrency[id] ??= defaultGroupCap(draft.totalConcurrency)
  if (touched.value) check()
}
function toggleAll() {
  draft.groups = allOn.value ? [] : props.groups.map((g) => g.id)
  for (const id of draft.groups) draft.groupConcurrency[id] ??= defaultGroupCap(draft.totalConcurrency)
  if (touched.value) check()
}

function check(): boolean {
  errors.value = validateEditor(draft, others.value) as Record<string, string>
  const q = props.mode === 'create' ? validateQuotaDraft(quota) : { errors: {} }
  quotaErrors.value = q.errors
  return !Object.keys(errors.value).length && !Object.keys(quotaErrors.value).length
}
function blurCheck() {
  if (touched.value || draft.name) check()
}

const ORDER = ['name', 'note', 'groups', 'totalConcurrency', 'groupConcurrency', 'q-daily', 'q-weekly', 'q-total']
function focusFirstError() {
  const keys = [...Object.keys(errors.value).map((k) => (k.startsWith('group:') ? 'groupConcurrency' : k)), ...Object.keys(quotaErrors.value).map((k) => `q-${k}`)]
  const first = ORDER.find((k) => keys.includes(k))
  if (!first) return
  const field = body.value?.querySelector<HTMLElement>(`[data-field="${first}"]`)
  field?.querySelector<HTMLElement>('input, button')?.focus()
  field?.scrollIntoView({ block: 'center' })
}

async function submit() {
  if (busy.value) return
  touched.value = true
  failure.value = ''
  if (!check()) {
    await nextTick()
    focusFirstError()
    return
  }
  const mode = props.mode
  const item = props.item
  if (mode === 'edit' && !item) return
  const payload = { ...editorPayload(draft), rtkCompress: rtkCompress.value }
  // the quota is taken from what check() just validated, before the first await (FF-02)
  const quotaValues = mode === 'create' ? validateQuotaDraft(quota).values : null
  const verb = mode === 'create' ? '创建' : '保存'
  await write.run(
    async () => {
      if (mode === 'create') {
        const { created, quotaError } = await createKeyWithQuota(keysApi, payload, quotaValues, errorMessage)
        return { key: created.key, quotaError }
      }
      await keysApi.update(item!.id, payload)
      return null
    },
    {
      done: (result, current) => {
        if (current) open.value = false
        if (result) emit('created', { name: payload.name, key: result.key, quotaError: result.quotaError })
        else emit('saved', payload.name)
      },
      failed: (error, current) => {
        const reason = errorMessage(error) || '稍后重试'
        if (current) failure.value = reason
        else notify(`◆ ${payload.name} ${verb}失败 · ${reason}`, { tone: 'bad' })
      },
    },
  )
}

const fid = (name: string) => `${uid}-${name}`
const QUOTA_WINDOWS: Array<{ key: keyof QuotaDraft; label: string }> = [
  { key: 'daily', label: '日' },
  { key: 'weekly', label: '周' },
  { key: 'total', label: '累计' },
]
</script>

<template>
  <Sheet v-model="open" :title="title">
    <form ref="body" class="kx-form" novalidate @submit.prevent="submit">
      <fieldset class="kx-form__lock" :disabled="busy && !stale">
      <div class="kx-field" data-field="name">
        <label :for="fid('name')" class="kx-field__k">名称</label>
        <TxInput
          :id="fid('name')"
          v-model="draft.name"
          :maxlength="NAME_MAX + 10"
          autocomplete="off"
          placeholder="如 growth-team-batch"
          :aria-invalid="errors.name ? 'true' : undefined"
          :aria-describedby="errors.name ? fid('name-e') : undefined"
          @blur="blurCheck"
        />
        <p v-if="errors.name" :id="fid('name-e')" class="kx-field__err" role="alert">◆ {{ errors.name }}</p>
        <p v-else-if="mode === 'create'" class="kx-field__hint">Key 前缀取自名称 · 创建后显示完整 Key</p>
      </div>

      <div class="kx-field" data-field="note">
        <label :for="fid('note')" class="kx-field__k">备注 <span class="kx-field__opt">可选</span></label>
        <TxInput
          :id="fid('note')"
          v-model="draft.note"
          :maxlength="NOTE_MAX + 10"
          autocomplete="off"
          placeholder="谁在用 · 用在哪"
          :aria-invalid="errors.note ? 'true' : undefined"
          @blur="blurCheck"
        />
        <p v-if="errors.note" class="kx-field__err" role="alert">◆ {{ errors.note }}</p>
      </div>

      <fieldset class="kx-field" data-field="groups">
        <legend class="kx-field__k">
          渠道 <span class="kx-field__opt">{{ draft.groups.length }} / {{ groups.length }}</span>
          <button v-if="groups.length > 1" type="button" class="ui-link kx-field__all" @click="toggleAll">{{ allOn ? '全不选' : '全选' }}</button>
        </legend>
        <div v-if="groups.length || orphanGroups.length" class="kx-chips">
          <TxCheckbox
            v-for="g in groups"
            :key="g.id"
            class="kx-chip"
            :model-value="draft.groups.includes(g.id)"
            @update:model-value="toggleGroup(g.id)"
          >
            <span class="kx-chip__name">{{ g.name }}</span>
            <span class="kx-chip__n num">{{ g.models.length }} 模型</span>
          </TxCheckbox>
          <TxCheckbox
            v-for="id in orphanGroups"
            :key="id"
            class="kx-chip is-orphan"
            :model-value="true"
            @update:model-value="toggleGroup(id)"
          >
            <span class="kx-chip__name">{{ id }}</span>
            <span class="kx-chip__n">已下线</span>
          </TxCheckbox>
        </div>
        <p v-else class="kx-field__hint">— 还没有渠道 · 先在「渠道」页添加</p>
        <p v-if="errors.groups" class="kx-field__err" role="alert">◆ {{ errors.groups }}</p>
        <p v-else-if="gatewayModelAccess === 'unavailable'" class="kx-field__hint">网关未启用按 Key 隔离模型 · 渠道只用于并发与计费</p>
      </fieldset>

      <fieldset class="kx-field" data-field="totalConcurrency">
        <legend class="kx-field__k">并发</legend>
        <div class="kx-conc">
          <Switch v-model="draft.unlimited" label="不限" />
          <template v-if="!draft.unlimited">
            <label :for="fid('total')" class="kx-conc__k">总并发</label>
            <TxInput
              :id="fid('total')"
              v-model="draft.totalConcurrency"
              class="kx-num"
              inputmode="numeric"
              autocomplete="off"
              :aria-invalid="errors.totalConcurrency ? 'true' : undefined"
              @blur="blurCheck"
            />
          </template>
        </div>
        <p v-if="errors.totalConcurrency" class="kx-field__err" role="alert">◆ {{ errors.totalConcurrency }}</p>
        <div v-if="!draft.unlimited && draft.groups.length" class="kx-conc__per" data-field="groupConcurrency">
          <span class="kx-field__hint">每个渠道上限</span>
          <label v-for="id in draft.groups" :key="id" class="kx-conc__g">
            <span class="kx-conc__gn">{{ groups.find((g) => g.id === id)?.name ?? id }}</span>
            <TxInput
              v-model="draft.groupConcurrency[id]"
              class="kx-num"
              inputmode="numeric"
              autocomplete="off"
              :aria-label="`${groups.find((g) => g.id === id)?.name ?? id} 并发上限`"
              :aria-invalid="errors[`group:${id}`] ? 'true' : undefined"
              @blur="blurCheck"
            />
          </label>
          <p v-if="errors.groupConcurrency" class="kx-field__err" role="alert">◆ {{ errors.groupConcurrency }}</p>
        </div>
      </fieldset>

      <div class="kx-field" data-field="rtkCompress">
        <span class="kx-field__k">RTK 压缩</span>
        <Switch v-model="rtkCompress" label="压缩这个 Key 请求里的工具输出" />
        <p class="kx-field__hint">重复行与进度输出折叠后再转发 · 只在 RTK 中转启用时生效</p>
      </div>

      <fieldset v-if="mode === 'create'" class="kx-field">
        <legend class="kx-field__k">额度 <span class="kx-field__opt">美元 · 留空 = 不限</span></legend>
        <div class="kx-quota3">
          <label v-for="w in QUOTA_WINDOWS" :key="w.key" class="kx-quota3__f" :data-field="`q-${w.key}`">
            <span class="kx-quota3__k">{{ w.label }}</span>
            <TxInput
              v-model="quota[w.key]"
              class="kx-num kx-money"
              inputmode="decimal"
              autocomplete="off"
              placeholder="不限"
              :aria-label="`${w.label}额度（美元）`"
              :aria-invalid="quotaErrors[w.key] ? 'true' : undefined"
              @blur="blurCheck"
            >
              <template #prefix><span class="kx-money__cur" aria-hidden="true">$</span></template>
            </TxInput>
          </label>
        </div>
        <template v-for="w in QUOTA_WINDOWS" :key="w.key">
          <p v-if="quotaErrors[w.key]" class="kx-field__err" role="alert">◆ {{ w.label }} · {{ quotaErrors[w.key] }}</p>
        </template>
      </fieldset>

      <p v-if="failure" class="kx-form__fail" role="alert">◆ {{ mode === 'create' ? '创建失败' : '保存失败' }} · {{ failure }}</p>
      </fieldset>
      <button type="submit" class="kx-form__submit" tabindex="-1" aria-hidden="true" :disabled="busy" />
    </form>
    <template #footer="{ close }">
      <TxButton variant="secondary" @click="close">取消</TxButton>
      <TxButton variant="primary" :disabled="busy" @click="submit">
        {{ stale ? '上一次还在提交···' : busy ? (mode === 'create' ? '创建中···' : '保存中···') : mode === 'create' ? '创建' : '保存' }}
      </TxButton>
    </template>
  </Sheet>
</template>

<style>
.kx-form { display: grid; gap: 18px; }
.kx-field__all { margin-left: auto; font-size: var(--fs-xs); font-weight: 400; }
/* channels: a plain wrap of checkboxes (TxCheckbox), no box per chip */
.kx-chips { display: flex; flex-wrap: wrap; gap: 6px 20px; }
html:root .kx-chip { max-width: 100%; min-height: 28px; }
html:root .kx-chip .tx-checkbox__label { display: inline-flex; align-items: baseline; gap: 7px; min-width: 0; }
.kx-chip__name { font-family: var(--font-mono); color: var(--ink); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.kx-chip__n { font-size: var(--fs-xs); color: var(--ink-3); white-space: nowrap; }
.kx-conc { display: flex; flex-wrap: wrap; align-items: center; gap: 10px 14px; }
.kx-conc__k { font-size: var(--fs-sm); color: var(--ink-2); }
.kx-conc__per { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 14px; padding-top: 4px; }
.kx-conc__per .kx-field__hint, .kx-conc__per .kx-field__err { flex-basis: 100%; }
.kx-conc__g { display: inline-flex; align-items: center; gap: 8px; min-width: 0; }
.kx-conc__gn { font-family: var(--font-mono); font-size: var(--fs-xs); color: var(--ink-2); max-width: 160px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.kx-quota3 { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 10px; }
.kx-quota3__f { display: grid; gap: 4px; min-width: 0; }
.kx-quota3__k { font-size: var(--fs-xs); color: var(--ink-3); }
@media (pointer: coarse) {
  html:root .kx-chip { min-height: var(--tap); }
}
@media (max-width: 599px) {
  .kx-quota3 { grid-template-columns: minmax(0, 1fr); }
}
</style>

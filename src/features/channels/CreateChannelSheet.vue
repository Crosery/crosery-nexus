<script setup lang="ts">
import { computed, nextTick, ref, useId, watch } from 'vue'
import { TxInput } from '@talex-touch/tuffex/input'
import { TxButton } from '@talex-touch/tuffex/button'
import { TxCheckbox } from '@talex-touch/tuffex/checkbox'
import Sheet from '../../ui/feedback/Sheet.vue'
import Segmented from '../../ui/form/Segmented.vue'
import SecretField from '../../ui/form/SecretField.vue'
import SearchField from '../../ui/form/SearchField.vue'
import { useBreakpoint } from '../../ui/composables/useBreakpoint'
import { fmtInt } from '../../ui/fmt'
import { notify } from '../../ui/feedback/toast'
import { errorReason } from '../../lib/errors'
import { useSheetWrite } from '../../lib/resource'
import { api } from '../../api'
import type { SegmentItem } from '../../ui/types'
import { CHANNEL_NAME_RE, suggestName } from './channelModel'

/**
 * 添加渠道 (DESIGN §6.4): 地址 → 探测 → 选模型 → 创建 (the form reveals each step; the footer hint says
 * what is missing next, so there is no separate step rail). Probing calls the upstream's /models once with the
 * key typed here (POST /api/channels/discover); nothing is saved until 创建. The key never leaves the masked
 * field except in those two requests, and the form is wiped when the sheet closes.
 */
const props = defineProps<{ existing: string[] }>()
const open = defineModel<boolean>({ default: false })
const emit = defineEmits<{ created: [name: string] }>()
const { isMobile } = useBreakpoint()
const uid = useId()

type Protocol = 'openai' | 'claude'
const PROTOCOLS: SegmentItem[] = [
  { value: 'openai', label: 'OpenAI 兼容' },
  { value: 'claude', label: 'Anthropic' },
]

const protocol = ref<Protocol>('openai')
const baseUrl = ref('')
const apiKey = ref('')
const name = ref('')
const nameTouched = ref(false)
const probing = ref(false)
/* one create in flight per sheet, across reopen: an older create never closes or clears a reopened sheet (FF-13) */
const write = useSheetWrite()
const { busy, stale } = write
const creating = computed(() => busy.value && !stale.value)
/** bumped on every open: an older probe's answer is dropped instead of filling the reopened sheet */
let probeGen = 0
const probeError = ref('')
const submitError = ref('')
const discovered = ref<Array<{ id: string; alias: string }>>([])
const probedFor = ref('')
const selected = ref(new Set<string>())
const filter = ref('')
const urlField = ref<InstanceType<typeof TxInput> | null>(null)
const secret = ref<InstanceType<typeof SecretField> | null>(null)

function reset() {
  protocol.value = 'openai'
  baseUrl.value = ''
  apiKey.value = ''
  name.value = ''
  nameTouched.value = false
  probing.value = false
  probeGen += 1
  write.renew()
  probeError.value = ''
  submitError.value = ''
  discovered.value = []
  probedFor.value = ''
  selected.value = new Set()
  filter.value = ''
}
watch(open, (isOpen) => {
  if (isOpen) {
    reset()
    void nextTick(() => urlField.value?.focus?.())
  } else {
    secret.value?.mask()
    // the key must not linger in memory after the sheet is gone
    apiKey.value = ''
    // dismissed mid-create: its outcome now arrives as a toast instead of on a hidden sheet
    write.renew()
  }
})

const urlValid = computed(() => {
  try {
    const url = new URL(baseUrl.value.trim())
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch {
    return false
  }
})
const probeKey = computed(() => `${protocol.value}|${baseUrl.value.trim()}|${apiKey.value.trim()}`)
/** a probe result only counts for the exact address + key + protocol it was made with */
const probeFresh = computed(() => discovered.value.length > 0 && probedFor.value === probeKey.value)

watch(baseUrl, (value) => {
  if (!nameTouched.value) name.value = suggestName(value.trim())
})

const nameError = computed(() => {
  const value = name.value.trim()
  if (!value) return ''
  if (!CHANNEL_NAME_RE.test(value)) return '只能用字母、数字、. _ -，最长 48 位'
  if (props.existing.includes(value)) return `「${value}」已存在`
  return ''
})

const visible = computed(() => {
  const term = filter.value.trim().toLowerCase()
  return term ? discovered.value.filter((m) => m.id.toLowerCase().includes(term) || m.alias.toLowerCase().includes(term)) : discovered.value
})

async function probe() {
  probeError.value = ''
  submitError.value = ''
  if (!urlValid.value) {
    probeError.value = '地址要以 http:// 或 https:// 开头'
    return
  }
  if (!apiKey.value.trim()) {
    probeError.value = '先填上游 Key'
    secret.value?.focus()
    return
  }
  probing.value = true
  const key = probeKey.value
  const mine = probeGen
  try {
    const result = await api.discoverChannelModels({ protocol: protocol.value, baseUrl: baseUrl.value.trim(), apiKey: apiKey.value.trim() })
    if (mine !== probeGen) return
    discovered.value = result.models ?? []
    probedFor.value = key
    selected.value = new Set(discovered.value.map((m) => m.id))
    if (!discovered.value.length) probeError.value = '上游没有返回模型 · 检查地址是否到 /v1'
  } catch (error) {
    if (mine !== probeGen) return
    discovered.value = []
    probedFor.value = ''
    probeError.value = errorReason(error) || '探测失败 · 检查地址和 Key'
  } finally {
    if (mine === probeGen) probing.value = false
  }
}

function toggle(id: string, on: boolean) {
  const next = new Set(selected.value)
  if (on) next.add(id)
  else next.delete(id)
  selected.value = next
}
function selectVisible(on: boolean) {
  const next = new Set(selected.value)
  for (const m of visible.value) {
    if (on) next.add(m.id)
    else next.delete(m.id)
  }
  selected.value = next
}

const canCreate = computed(() =>
  probeFresh.value && selected.value.size > 0 && Boolean(name.value.trim()) && !nameError.value && !busy.value,
)
const createHint = computed(() => {
  if (stale.value) return '上一次创建还没返回 · 稍等'
  if (!probeFresh.value) return discovered.value.length ? '地址或 Key 改过 · 重新探测' : '先探测模型'
  if (!selected.value.size) return '至少选 1 个模型'
  if (!name.value.trim()) return '填渠道名'
  if (nameError.value) return nameError.value
  return `将接入 ${fmtInt(selected.value.size)} 个模型`
})

async function create() {
  if (!canCreate.value) return
  submitError.value = ''
  const channelName = name.value.trim()
  const payload = {
    name: channelName,
    protocol: protocol.value,
    baseUrl: baseUrl.value.trim(),
    apiKey: apiKey.value.trim(),
    models: discovered.value.filter((m) => selected.value.has(m.id)).map((m) => ({ id: m.id, alias: m.alias || m.id })),
  }
  await write.run(() => api.createChannel(payload), {
    done: (_result, current) => {
      notify(`✓ 已添加 ${channelName} · ${fmtInt(payload.models.length)} 个模型`)
      emit('created', channelName)
      if (current) open.value = false
    },
    failed: (error, current) => {
      const reason = errorReason(error) || '创建失败'
      if (current) submitError.value = reason
      else notify(`◆ ${channelName} 创建失败 · ${reason}`, { tone: 'bad' })
    },
  })
}
</script>

<template>
  <Sheet v-model="open" title="添加渠道" size="560px" :height="isMobile ? '92vh' : 'auto'">
    <form class="cx-new" novalidate @submit.prevent="create">
      <div class="cx-new__field">
        <span class="cx-new__label">协议</span>
        <Segmented v-model="protocol" :items="PROTOCOLS" label="上游协议" />
        <span class="cx-new__hint">{{ protocol === 'claude' ? 'Anthropic /v1/messages · 渠道名由地址决定' : '/v1/chat/completions 兼容端点' }}</span>
      </div>

      <div class="cx-new__field">
        <label class="cx-new__label" :for="`${uid}-url`">地址</label>
        <TxInput
          :id="`${uid}-url`"
          ref="urlField"
          v-model="baseUrl"
          class="cx-new__mono"
          placeholder="https://api.example.com/v1"
          autocomplete="off"
          spellcheck="false"
          inputmode="url"
        />
        <span class="cx-new__hint">填到 /v1 为止 · 根地址也行</span>
      </div>

      <div class="cx-new__field">
        <label class="cx-new__label" :for="`${uid}-key`">上游 Key</label>
        <SecretField :id="`${uid}-key`" ref="secret" v-model="apiKey" name="channel-key" autocomplete="off" noun="Key" placeholder="sk-…" mono :describedby="`${uid}-key-hint`" />
        <span :id="`${uid}-key-hint`" class="cx-new__hint">只用于探测和保存 · 不会显示在页面上</span>
      </div>

      <div class="cx-new__probe">
        <TxButton variant="secondary" :disabled="probing || !baseUrl.trim() || !apiKey.trim()" @click="probe">
          {{ probing ? '探测中···' : probeFresh ? '重新探测' : '探测模型' }}
        </TxButton>
        <span v-if="probeFresh" class="cx-new__ok num">✓ 上游返回 {{ fmtInt(discovered.length) }} 个模型</span>
      </div>
      <p v-if="probeError" class="cx-new__err" role="alert">◆ {{ probeError }}</p>

      <template v-if="discovered.length">
        <div class="cx-new__field">
          <label class="cx-new__label" :for="`${uid}-name`">渠道名</label>
          <TxInput
            :id="`${uid}-name`"
            v-model="name"
            class="cx-new__mono"
            placeholder="openrouter-hk"
            autocomplete="off"
            spellcheck="false"
            :aria-invalid="nameError ? 'true' : undefined"
            @input="nameTouched = true"
          />
          <span class="cx-new__hint" :class="{ sig: nameError }">{{ nameError || '字母、数字、. _ - · 最长 48 位' }}</span>
        </div>

        <div class="cx-new__field">
          <span class="cx-new__label">模型 <span class="dim num">已选 {{ fmtInt(selected.size) }} / {{ fmtInt(discovered.length) }}</span></span>
          <div class="cx-new__tools">
            <SearchField v-model="filter" placeholder="筛选模型 id" label="筛选模型" :slash="false" class="cx-new__filter" />
            <TxButton variant="ghost" size="sm" @click="selectVisible(true)">全选</TxButton>
            <TxButton variant="ghost" size="sm" @click="selectVisible(false)">全不选</TxButton>
          </div>
          <ul class="cx-new__models" aria-label="探测到的模型">
            <li v-for="m in visible" :key="m.id">
              <TxCheckbox class="cx-new__model" :model-value="selected.has(m.id)" @update:model-value="(on: boolean) => toggle(m.id, on)">
                <span class="mono ellip" :title="m.id">{{ m.id }}</span>
                <span v-if="m.alias && m.alias !== m.id" class="cx-new__alias mono ellip">→ {{ m.alias }}</span>
              </TxCheckbox>
            </li>
            <li v-if="!visible.length" class="cx-new__none">— 没有匹配的模型</li>
          </ul>
        </div>
      </template>

      <p v-if="submitError" class="cx-new__err" role="alert">◆ {{ submitError }}</p>
      <button type="submit" hidden aria-hidden="true" tabindex="-1" />
    </form>

    <template #footer="{ close }">
      <div class="cx-new__foot">
        <span class="cx-new__foot-hint" :class="{ sig: nameError && probeFresh }">{{ createHint }}</span>
        <span class="cx-new__foot-r">
          <TxButton variant="secondary" @click="close">取消</TxButton>
          <TxButton variant="primary" :disabled="!canCreate" @click="create">{{ creating ? '创建中···' : stale ? '上一次还在创建···' : '创建渠道' }}</TxButton>
        </span>
      </div>
    </template>
  </Sheet>
</template>

<style>
.cx-new { display: flex; flex-direction: column; gap: 14px; min-width: 0; }
.cx-new__field { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
.cx-new__label { font-size: var(--fs-xs); color: var(--ink-2); font-weight: 500; }
.cx-new__label .dim { font-weight: 400; margin-left: 6px; }
.cx-new__hint { font-size: var(--fs-xs); color: var(--ink-3); }
.cx-new__mono input { font-family: var(--font-mono); }
.cx-new__probe { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; }
.cx-new__ok { font-size: var(--fs-xs); color: var(--ink-2); }
.cx-new__err { margin: 0; font-size: var(--fs-sm); color: var(--signal-ink); overflow-wrap: anywhere; }
.cx-new__tools { display: flex; align-items: center; gap: 6px; min-width: 0; }
.cx-new__tools .cx-new__filter { flex: 1 1 auto; width: auto; }
/* the scroll area keeps one hairline top and bottom (its bounds); rows are separated by spacing alone */
.cx-new__models { list-style: none; margin: 0; padding: 2px 0; max-height: min(320px, 40vh); overflow: auto; border-top: 1px solid var(--rule); border-bottom: 1px solid var(--rule); }
html:root .cx-new__model { display: flex; align-items: center; gap: 10px; width: 100%; min-height: 34px; padding: 0 4px; min-width: 0; border-radius: var(--r-1); }
html:root .cx-new__model:hover { background: var(--paper-2); }
html:root .cx-new__model .tx-checkbox__box { flex: none; }
html:root .cx-new__model .tx-checkbox__label { display: flex; align-items: center; gap: 10px; flex: 1 1 auto; min-width: 0; font-size: var(--fs-sm); color: var(--ink); text-align: left; }
.cx-new__model .ellip { min-width: 0; }
.cx-new__alias { flex: 0 1 auto; color: var(--ink-3); font-size: var(--fs-xs); }
.cx-new__none { padding: 10px 4px; font-size: var(--fs-sm); color: var(--ink-3); }
.cx-new__foot { display: flex; align-items: center; justify-content: space-between; gap: 10px; width: 100%; min-width: 0; }
.cx-new__foot-hint { font-size: var(--fs-xs); color: var(--ink-3); min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cx-new__foot-r { display: inline-flex; gap: 8px; flex: none; }
.cx-new .sig, .cx-new__foot-hint.sig { color: var(--signal-ink); }
@media (pointer: coarse) {
  html:root .cx-new__model { min-height: 44px; }
}
</style>

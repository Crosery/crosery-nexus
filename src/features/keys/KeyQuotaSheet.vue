<script setup lang="ts">
import { computed, nextTick, reactive, ref, watch } from 'vue'
import { TxButton } from '@talex-touch/tuffex/button'
import { TxInput } from '@talex-touch/tuffex/input'
import Sheet from '../../ui/feedback/Sheet.vue'
import TickMeter from '../../ui/viz/TickMeter.vue'
import { confirmSheet } from '../../ui/feedback/confirmSheet'
import { notify } from '../../ui/feedback/toast'
import { clockParts, fmtUsd } from '../../ui/fmt'
import { errorMessage } from '../../lib/errors'
import { useSheetWrite } from '../../lib/resource'
import type { ApiKeyItem } from '../../types'
import { keysApi } from './keysApi'
import './keys.css'
import { keyTail, limited, quotaDraftOf, resetLabel, validateQuotaDraft, windowRatio, WINDOW_NOUN, type QuotaDraft, type WindowKey } from './keysModel'

/**
 * 调整额度 (DESIGN §6.3): the three USD windows of one Key. Empty = 不限. Each window shows what it has used
 * and when it rolls over, and a 重置 that zeroes that window's tally after a confirm that spells out the
 * effect. Saving or resetting re-runs the server's enforcement, so an over-limit Key comes back by itself.
 * One save at a time (useSheetWrite); a window left as prefilled keeps its stored precision.
 */
const props = defineProps<{ item: ApiKeyItem | null }>()
const open = defineModel<boolean>({ default: false })
const emit = defineEmits<{ changed: [] }>()

const WINDOWS: Array<{ key: WindowKey; label: string; hint: string }> = [
  { key: 'daily', label: '日额度', hint: '每天 00:00 归零' },
  { key: 'weekly', label: '周额度', hint: '每周一 00:00 归零' },
  { key: 'total', label: '累计额度', hint: '只能手动重置' },
]

const draft = reactive<QuotaDraft>({ daily: '', weekly: '', total: '' })
const errors = ref<Partial<Record<WindowKey, string>>>({})
const write = useSheetWrite()
const { busy, stale } = write
const failure = ref('')
const body = ref<HTMLElement | null>(null)
/** the values as prefilled: an untouched window is saved as stored (see validateQuotaDraft) */
const original = ref<QuotaDraft>({ daily: '', weekly: '', total: '' })

watch(open, (value) => {
  if (!value) {
    // dismissed mid-write: the write's outcome now arrives as a toast instead of on a hidden sheet
    write.renew()
    return
  }
  original.value = quotaDraftOf(props.item)
  Object.assign(draft, original.value)
  errors.value = {}
  failure.value = ''
  write.renew()
  void nextTick(() => body.value?.querySelector<HTMLInputElement>('input')?.focus())
}, { immediate: true })

const rows = computed(() =>
  WINDOWS.map((w) => {
    const state = props.item?.quotaState?.[w.key]
    const isLimited = limited(state)
    let used = ''
    if (state && (w.key !== 'total' || isLimited)) used = `已用 ${fmtUsd(state.spentUsd)}`
    else if (w.key === 'total') used = '未设上限时不统计累计'
    const reset = w.key !== 'total' ? resetLabel(state?.resetsAt, Date.now(), clockParts) : ''
    return { ...w, state, isLimited, ratio: windowRatio(state), used, reset, canReset: Boolean(state && (isLimited || state.exceeded) && state.spentUsd > 0) }
  }),
)
const allEmpty = computed(() => !draft.daily.trim() && !draft.weekly.trim() && !draft.total.trim())

function clearAll() {
  Object.assign(draft, { daily: '', weekly: '', total: '' })
  errors.value = {}
}

function check(): boolean {
  errors.value = validateQuotaDraft(draft, original.value).errors
  return !Object.keys(errors.value).length
}

async function save() {
  const item = props.item
  if (!item || busy.value) return
  failure.value = ''
  const outcome = validateQuotaDraft(draft, original.value)
  errors.value = outcome.errors
  if (!outcome.values) {
    await nextTick()
    body.value?.querySelector<HTMLInputElement>('[aria-invalid="true"]')?.focus()
    return
  }
  const values = outcome.values
  await write.run(() => keysApi.quota(item.id, values), {
    done: (_result, current) => {
      notify(`✓ 额度已更新 · ${item.name}`)
      if (current) open.value = false
      emit('changed')
    },
    failed: (error, current) => {
      const reason = errorMessage(error) || '稍后重试'
      if (current) failure.value = reason
      else notify(`◆ ${item.name} 额度没保存上 · ${reason}`, { tone: 'bad' })
    },
  })
}

async function resetWindow(key: WindowKey) {
  const item = props.item
  const state = item?.quotaState?.[key]
  if (!item || !state) return
  const noun = WINDOW_NOUN[key]
  const ok = await confirmSheet({
    title: `重置 ${item.name} 的${noun}用量？`,
    facts: [
      { k: 'Key', v: `${item.name}  ${keyTail(item.maskedKey)}` },
      { k: `${noun}已用`, v: `${fmtUsd(state.spentUsd)} → $0.00` },
      ...(limited(state) ? [{ k: '上限', v: fmtUsd(state.limitUsd) }] : []),
    ],
    consequence: key === 'total'
      ? '累计已用归零 · 因累计超额停用的 Key 会自动恢复 · 不可撤销'
      : `${noun}已用记为 $0 · 因此停用的 Key 会自动恢复 · 不可撤销`,
    confirmText: `重置${noun}`,
  })
  if (!ok) return
  try {
    await keysApi.resetQuota(item.id, key)
    notify(`✓ 已重置${noun}用量 · ${item.name}`)
    emit('changed')
  } catch (error) {
    notify(`◆ 重置失败 · ${errorMessage(error) || '稍后重试'}`, { tone: 'bad' })
  }
}
</script>

<template>
  <Sheet v-model="open" :title="item ? `调整额度 · ${item.name}` : '调整额度'">
    <form v-if="item" ref="body" class="kx-quota" novalidate @submit.prevent="save">
      <fieldset class="kx-form__lock" :disabled="busy && !stale">
      <p class="kx-quota__id">
        <span class="mono">{{ keyTail(item.maskedKey) }}</span>
        <span class="dim">美元 · 留空 = 不限 · 按 Asia/Shanghai 计</span>
      </p>
      <p v-if="item.blockedReason" class="kx-quota__blocked">
        <span aria-hidden="true">◆</span> 超额停用 · {{ item.blockedReason }} · 调高上限或重置后自动恢复
      </p>
      <ul class="kx-quota__rows">
        <li v-for="r in rows" :key="r.key" class="kx-quota__row">
          <label class="kx-quota__k" :for="`kx-q-${r.key}`">{{ r.label }}<span class="kx-quota__hint">{{ r.hint }}</span></label>
          <TxInput
            :id="`kx-q-${r.key}`"
            v-model="draft[r.key]"
            class="kx-num kx-money kx-quota__in"
            inputmode="decimal"
            autocomplete="off"
            placeholder="不限"
            :aria-invalid="errors[r.key] ? 'true' : undefined"
            @blur="check"
          >
            <template #prefix><span class="kx-money__cur" aria-hidden="true">$</span></template>
          </TxInput>
          <span class="kx-quota__now">
            <TickMeter :value="r.ratio" :unlimited="!r.isLimited" :width="84" :aria-label="`${r.label}当前`" />
            <span class="kx-quota__used num">{{ r.used }}<template v-if="r.reset"> · {{ r.reset }}</template></span>
          </span>
          <TxButton
            v-if="r.canReset"
            variant="secondary"
            size="sm"
            class="kx-quota__reset"
            :aria-label="`重置${WINDOW_NOUN[r.key]}用量`"
            @click="resetWindow(r.key)"
          >重置</TxButton>
          <p v-if="errors[r.key]" class="kx-field__err kx-quota__err" role="alert">◆ {{ errors[r.key] }}</p>
        </li>
      </ul>
      <button v-if="!allEmpty" type="button" class="ui-link kx-quota__clear" @click="clearAll">全部设为不限</button>
      <p v-if="failure" class="kx-form__fail" role="alert">◆ 保存失败 · {{ failure }}</p>
      </fieldset>
      <button type="submit" class="kx-form__submit" tabindex="-1" aria-hidden="true" :disabled="busy" />
    </form>
    <template #footer="{ close }">
      <TxButton variant="secondary" @click="close">取消</TxButton>
      <TxButton variant="primary" :disabled="busy || !item" @click="save">{{ stale ? '上一次还在保存···' : busy ? '保存中···' : '保存额度' }}</TxButton>
    </template>
  </Sheet>
</template>

<style>
.kx-quota { display: grid; gap: 14px; }
.kx-quota__id { margin: 0; display: flex; flex-wrap: wrap; gap: 4px 12px; font-size: var(--fs-xs); color: var(--ink-2); }
.kx-quota__blocked { margin: 0; font-size: var(--fs-sm); color: var(--ink); }
.kx-quota__blocked span { color: var(--signal); }
.kx-quota__rows { list-style: none; margin: 0; padding: 0; }
.kx-quota__row { display: grid; grid-template-columns: 96px 120px minmax(0, 1fr) auto; align-items: center; gap: 6px 14px; padding: 12px 0; min-width: 0; }
.kx-quota__row + .kx-quota__row { border-top: 1px solid var(--rule); }
.kx-quota__k { display: grid; gap: 2px; font-size: var(--fs-sm); font-weight: 600; color: var(--ink); }
.kx-quota__hint { font-size: var(--fs-xs); font-weight: 400; color: var(--ink-3); }
html:root .kx-quota .tx-input.kx-quota__in { width: 120px; }
.kx-quota__now { display: grid; gap: 3px; min-width: 0; }
.kx-quota__used { font-size: var(--fs-xs); color: var(--ink-3); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.kx-quota__reset { grid-column: 4; }
.kx-quota__err { grid-column: 1 / -1; }
.kx-quota__clear { justify-self: start; font-size: var(--fs-xs); }
@media (max-width: 599px) {
  .kx-quota__row { grid-template-columns: minmax(0, 1fr) 120px; }
  .kx-quota__now { grid-column: 1 / -1; grid-row: 2; }
  .kx-quota__reset { grid-column: 2; grid-row: 2; justify-self: end; }
}
</style>

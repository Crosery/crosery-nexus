<script setup lang="ts">
import { ref, watch } from 'vue'

/**
 * 调度权重输入：整数，默认 0，越小越优先（网关先用权重最小的一档，同档内轮询）。
 * 回车或离开输入框时提交；不是整数 / 超范围就退回原值，不提交。`mixed` = 账号池里各账号权重不一致，只读展示最小值。
 */
const props = withDefaults(defineProps<{
  modelValue: number
  label: string
  disabled?: boolean
  mixed?: boolean
  /** hover 说明：这个权重管谁 */
  hint?: string
}>(), { disabled: false, mixed: false, hint: undefined })
const emit = defineEmits<{ commit: [weight: number] }>()
const MAX = 100_000

const draft = ref<string | number>(String(props.modelValue))
watch(() => props.modelValue, (value) => { draft.value = String(value) })

function commit() {
  const text = String(draft.value ?? '').trim()
  const next = Number(text)
  if (text === '' || !Number.isInteger(next) || Math.abs(next) > MAX) {
    draft.value = String(props.modelValue)
    return
  }
  draft.value = String(next)
  if (next !== props.modelValue) emit('commit', next)
}
</script>

<template>
  <span v-if="mixed" class="ui-weight is-mixed" :title="hint ?? '各账号权重不一致 · 到账号上单独调整'">
    <span class="ui-weight__k">权重</span><span class="num">{{ modelValue }}+</span><span class="ui-weight__n">账号分档</span>
  </span>
  <label v-else class="ui-weight" :title="hint">
    <span class="ui-weight__k">权重</span>
    <input
      v-model="draft"
      class="ui-weight__in"
      type="number"
      inputmode="numeric"
      autocomplete="off"
      step="1"
      :disabled="disabled"
      :aria-label="label"
      @keydown.enter.prevent="commit"
      @blur="commit"
    />
  </label>
</template>

<style>
.ui-weight { display: inline-flex; align-items: center; gap: 6px; flex: none; white-space: nowrap; }
.ui-weight__k { font-size: var(--fs-xs); color: var(--ink-3); }
.ui-weight__n { font-size: var(--fs-xs); color: var(--ink-3); }
.ui-weight__in {
  box-sizing: border-box; width: 76px; height: 32px; padding: 0 8px; text-align: right;
  font: inherit; font-family: var(--font-mono); font-size: var(--fs-sm); color: var(--ink);
  background: transparent; border: 1px solid var(--ctl); border-radius: var(--r-1); outline: 0;
  -moz-appearance: textfield; appearance: textfield;
}
.ui-weight__in::-webkit-outer-spin-button, .ui-weight__in::-webkit-inner-spin-button { -webkit-appearance: none; margin: 0; }
.ui-weight__in:hover:not(:disabled) { border-color: var(--ink-3); }
.ui-weight__in:focus-visible { border-color: var(--ink); box-shadow: 0 0 0 2px var(--focus, rgba(0,0,0,.12)); }
.ui-weight__in:disabled { opacity: .5; }
@media (pointer: coarse) { .ui-weight__in { height: 40px; } }
.ui-weight.is-mixed { color: var(--ink-2); font-size: var(--fs-sm); }
</style>

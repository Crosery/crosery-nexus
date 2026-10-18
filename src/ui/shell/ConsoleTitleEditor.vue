<script setup lang="ts">
import { nextTick, ref, watch, useTemplateRef } from 'vue'
import { TxModal } from '@talex-touch/tuffex/modal'
import { TxInput } from '@talex-touch/tuffex/input'
import { TxButton } from '@talex-touch/tuffex/button'
import { useTitlePref, DEFAULT_TITLE } from '../../lib/title'

/**
 * 用户编辑 Minimal 皮肤的控制台标题（品牌名）。原生 TxModal + TxInput，v-model 草稿，
 * 保存后写 localStorage / 恢复默认；关闭丢弃草稿。标题在侧栏品牌、面包屑首页与
 * 浏览器标题上实时生效，blank 保存 / 重置恢复为「Crosery」。
 */
const props = withDefaults(defineProps<{ modelValue: boolean }>(), { modelValue: false })
const emit = defineEmits<{ 'update:modelValue': [v: boolean] }>()
const title = useTitlePref()
const input = useTemplateRef<InstanceType<typeof TxInput>>('input')
const draft = ref('')

watch(
  () => props.modelValue,
  (v) => {
    if (v) {
      draft.value = title.pref.value
      nextTick(() => input.value?.focus())
    }
  },
)

function onSave() {
  title.set(draft.value)
  emit('update:modelValue', false)
}

function onReset() {
  title.reset()
  emit('update:modelValue', false)
}

</script>

<template>
  <TxModal
    :model-value="props.modelValue"
    @update:model-value="emit('update:modelValue', $event)"
    title="编辑控制台标题"
    width="min(92vw, 420px)"
  >
    <div class="cte">
      <p class="cte__note">标题仅保存在此设备；留空保存或重置恢复 {{ DEFAULT_TITLE }}。</p>
      <TxInput
        ref="input"
        v-model="draft"
        class="cte__in"
        :placeholder="DEFAULT_TITLE"
        :maxlength="40"
        autocomplete="off"
        spellcheck="false"
        aria-label="控制台标题"
      />
    </div>
    <template #footer>
      <TxButton variant="text" size="sm" @click="onReset">重置为 Crosery</TxButton>
      <TxButton variant="primary" size="sm" @click="onSave">保存</TxButton>
    </template>
  </TxModal>
</template>

<style>
@scope (html[data-skin="minimal"]) {
  .cte { display: flex; flex-direction: column; gap: 12px; }
  .cte__note { margin: 0; font-size: 13px; color: var(--tx-text-color-secondary); line-height: 1.5; }
  .cte__in { width: 100%; }
}
</style>
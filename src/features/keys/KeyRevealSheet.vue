<script setup lang="ts">
import { nextTick, ref, watch } from 'vue'
import { TxButton } from '@talex-touch/tuffex/button'
import Sheet from '../../ui/feedback/Sheet.vue'
import Icon from '../../ui/Icon.vue'
import { copyText } from '../../ui/feedback/toast'

/**
 * The only place a full API key is ever on screen (DESIGN §7.1): right after 创建, or after a confirmed
 * 显示完整 Key. The value lives in the parent only while this sheet is open and is wiped on close; it is never
 * put in the URL, a toast, the console or storage. Copy says `已复制 API Key`, never the key.
 * The key stays a plain selectable <output> (not TxSensitiveInput: that masks until hover, and here the person
 * already confirmed they want it shown).
 */
const props = defineProps<{ name: string; value: string; mode: 'created' | 'revealed'; note?: string | null }>()
const open = defineModel<boolean>({ default: false })
const emit = defineEmits<{ done: [] }>()

const copied = ref(false)
const done = ref<{ $el: HTMLElement } | null>(null)

watch(open, (value) => {
  copied.value = false
  if (!value) emit('done')
  else void nextTick(() => done.value?.$el?.focus())
})

async function copy() {
  if (!props.value) return
  copied.value = await copyText(props.value, 'API Key')
}

function selectAll(event: Event) {
  const range = document.createRange()
  range.selectNodeContents(event.currentTarget as Node)
  const selection = window.getSelection()
  selection?.removeAllRanges()
  selection?.addRange(range)
}
</script>

<template>
  <Sheet v-model="open" :title="mode === 'created' ? `已创建 · ${name}` : `完整 Key · ${name}`" :close-on-mask="mode !== 'created'">
    <div class="kx-reveal">
      <p class="kx-reveal__warn">
        <span aria-hidden="true">◆</span>
        <template v-if="mode === 'created'">现在复制保存 · 关闭后需确认才能再次显示</template>
        <template v-else>明文显示中 · 关闭后从屏幕清除</template>
      </p>
      <output class="kx-reveal__key mono" tabindex="0" aria-label="完整 API Key" @focus="selectAll" @click="selectAll">{{ value }}</output>
      <div class="kx-reveal__row">
        <TxButton variant="secondary" @click="copy">
          <Icon :name="copied ? 'check' : 'copy'" />{{ copied ? '已复制' : '复制' }}
        </TxButton>
        <span class="kx-reveal__hint">放进客户端的环境变量 · 不要贴进聊天或代码库</span>
      </div>
      <p v-if="note" class="kx-reveal__note">◇ {{ note }}</p>
    </div>
    <template #footer="{ close }">
      <TxButton ref="done" variant="primary" @click="close">{{ mode === 'created' ? '我已保存' : '完成' }}</TxButton>
    </template>
  </Sheet>
</template>

<style>
.kx-reveal { display: grid; gap: 14px; }
.kx-reveal__warn { margin: 0; font-size: var(--fs-sm); color: var(--ink); }
.kx-reveal__warn span { color: var(--signal); margin-right: 4px; }
.kx-reveal__key {
  display: block; padding: 12px 14px; border-radius: var(--r-1); background: var(--paper-2);
  font-size: 14px; line-height: 1.5; color: var(--ink); overflow-wrap: anywhere; word-break: break-all; user-select: all; cursor: text;
}
.kx-reveal__row { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 14px; }
.kx-reveal__hint { font-size: var(--fs-xs); color: var(--ink-3); }
.kx-reveal__note { margin: 0; padding: 8px 10px; border-left: 2px solid var(--signal); background: var(--paper-2); font-size: var(--fs-sm); color: var(--ink); }
</style>

<script setup lang="ts">
import { computed, ref, useId, watch } from 'vue'
import { TxButton } from '@talex-touch/tuffex/button'
import { TxInput } from '@talex-touch/tuffex/input'
import Sheet from '../../ui/feedback/Sheet.vue'
import SecretField from '../../ui/form/SecretField.vue'
import { confirmSheet } from '../../ui/feedback/confirmSheet'
import { notify } from '../../ui/feedback/toast'
import { errorMessage } from '../../lib/errors'
import { api } from '../../api'
import type { ProxyEntryView } from '../../types'

/**
 * 重命名 / 标签 (and, for an address exit, a new address). A new address is written to the accounts that still use
 * the old one (the server re-reads each and skips the ones changed since); that needs a confirm with the count.
 * The stored address is never shown: the field starts empty and an empty field keeps it.
 */
const props = defineProps<{ entry: ProxyEntryView | null }>()
const open = defineModel<boolean>({ default: false })
const emit = defineEmits<{ saved: [] }>()
const uid = useId()

const name = ref('')
const tags = ref('')
const url = ref('')
const busy = ref(false)
const failure = ref('')

watch(open, (now) => {
  if (!now || !props.entry) return
  name.value = props.entry.name
  tags.value = props.entry.tags.join(', ')
  url.value = ''
  failure.value = ''
})

const isUrl = computed(() => props.entry?.kind === 'url')

async function save(confirmed = false): Promise<void> {
  const entry = props.entry
  if (!entry || busy.value) return
  const patch: { name?: string; tags?: string[]; url?: string; confirm?: boolean } = {}
  if (name.value.trim() && name.value.trim() !== entry.name) patch.name = name.value.trim()
  const nextTags = tags.value.split(/[,，]+/).map(tag => tag.trim()).filter(Boolean)
  if (nextTags.join('\n') !== entry.tags.join('\n')) patch.tags = nextTags
  if (isUrl.value && url.value.trim()) patch.url = url.value.trim()
  if (!Object.keys(patch).length) {
    open.value = false
    return
  }
  if (confirmed) patch.confirm = true
  busy.value = true
  failure.value = ''
  let ask: number | null = null
  try {
    const result = await api.proxies.update(entry.id, patch)
    const re = result.reapplied
    notify(re ? `✓ 已保存 · 更新 ${re.updated} 个账号${re.drifted ? ` · ${re.drifted} 个已改过，没动` : ''}` : '✓ 已保存', { tone: re?.failed ? 'warn' : 'ok', id: 'cx-proxy' })
    emit('saved')
    open.value = false
  } catch (error) {
    const err = error as { code?: string | null; body?: Record<string, unknown> }
    if (err.code === 'confirm_required' && !confirmed) ask = Number(err.body?.accounts ?? 0)
    else failure.value = errorMessage(error) || '保存失败'
  } finally {
    busy.value = false
  }
  if (ask !== null) {
    const ok = await confirmSheet({
      title: `将更新 ${ask} 个账号`,
      body: '新地址会写入仍在用旧地址的账号；之后被改过的账号保持不变。',
      facts: [{ k: '出口', v: entry.name }, { k: '账号', v: `${ask} 个` }],
      consequence: '账号会立即改走新地址',
      confirmText: '保存并更新',
    })
    if (ok) return save(true)
  }
}
</script>

<template>
  <Sheet v-model="open" :title="entry ? `编辑 · ${entry.name}` : '编辑'" size="480px">
    <form class="px-ed" novalidate @submit.prevent="save()">
      <div class="px-ed__f">
        <label class="px-add__k" :for="`${uid}-name`">名称</label>
        <TxInput :id="`${uid}-name`" v-model="name" maxlength="64" autocomplete="off" />
        <p v-if="entry?.nameAuto" class="px-add__hint">自动命名 · 检测到出口国家后会写成「主机 · 国家」，改名后不再自动</p>
      </div>
      <div class="px-ed__f">
        <label class="px-add__k" :for="`${uid}-tags`">标签 <span class="px-add__opt">逗号分隔</span></label>
        <TxInput :id="`${uid}-tags`" v-model="tags" placeholder="如 日本, 住宅" autocomplete="off" />
      </div>
      <div v-if="isUrl" class="px-ed__f">
        <label class="px-add__k" :for="`${uid}-url`">新地址 <span class="px-add__opt">留空不改</span></label>
        <SecretField :id="`${uid}-url`" v-model="url" name="proxy-url" autocomplete="off" noun="地址" placeholder="socks5://user:pass@host:port" mono :describedby="`${uid}-url-hint`" />
        <p :id="`${uid}-url-hint`" class="px-add__hint">当前 {{ entry?.display }} · 在用 {{ entry?.usedBy.total ?? 0 }} 个账号</p>
      </div>
      <p v-if="failure" class="px-add__fail" role="alert">◆ {{ failure }}</p>
      <button type="submit" hidden aria-hidden="true" tabindex="-1" />
    </form>
    <template #footer="{ close }">
      <div class="px-add__foot">
        <span class="px-add__fh" />
        <TxButton variant="ghost" :disabled="busy" @click="close">取消</TxButton>
        <TxButton variant="primary" :loading="busy" :disabled="busy" @click="save()">保存</TxButton>
      </div>
    </template>
  </Sheet>
</template>

<style>
.px-ed { display: grid; gap: 16px; }
.px-ed__f { display: grid; gap: 6px; min-width: 0; }
</style>

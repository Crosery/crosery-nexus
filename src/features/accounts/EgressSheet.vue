<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { TxButton } from '@talex-touch/tuffex/button'
import Sheet from '../../ui/feedback/Sheet.vue'
import Pii from '../../ui/data/Pii.vue'
import FilterField from '../../ui/form/FilterField.vue'
import { confirmSheet } from '../../ui/feedback/confirmSheet'
import { notify } from '../../ui/feedback/toast'
import { errorReason } from '../../lib/errors'
import { maskPii, useMask } from '../../lib/privacy'
import { proxyApi } from '../../api/proxy'
import type { EgressData, MagpieAccount } from '../../types'
import EgressTag from './EgressTag.vue'
import { checkMark, choiceName, EGRESS_CUSTOM, EGRESS_UNKNOWN, egressBadge, egressChoice, egressOptions, egressWarning, magpieRef, readLabel, regionName, serviceOf } from './egressModel'
import { knowProxy, proxyRead, readProxy } from './proxyStore'

/**
 * 出口 of one Magpie account: the exit it goes out through now (read from the registry when the sheet opens), where
 * that lands and whether it reaches this account's vendor, and the pool's exits to move it to. The pick is written
 * through the pool (registry + kernel push, linked by entry id, previous value kept for undo).
 */
const props = defineProps<{ account: MagpieAccount | null; egress: EgressData | null; serviceName?: string }>()
const open = defineModel<boolean>({ default: false })
const emit = defineEmits<{ changed: [] }>()
const { on: masked } = useMask()

const ref_ = computed(() => (props.account ? magpieRef(props.account.agent, props.account.user) : ''))
const service = computed(() => serviceOf(props.account?.agent))
const read = computed(() => (ref_.value ? proxyRead(ref_.value) : null))
const current = computed(() => (read.value?.state === 'ready' ? read.value.value : null))
const choice = ref(EGRESS_UNKNOWN)
const busy = ref(false)

watch(open, (value) => {
  if (!value || !props.account) return
  choice.value = EGRESS_UNKNOWN
  void readProxy(ref_.value, props.account.agent)
})
watch(current, (value) => {
  if (!busy.value) choice.value = egressChoice(value, props.egress)
}, { immediate: true })
// the pool view polls: it may resolve a value read before it arrived, but never undoes a pick not yet applied
watch(() => props.egress, (egress) => {
  if (!busy.value && (choice.value === EGRESS_UNKNOWN || choice.value === EGRESS_CUSTOM)) choice.value = egressChoice(current.value, egress)
})

const options = computed(() => {
  const items = egressOptions(props.egress, ref_.value, service.value, { current: choice.value })
  if (choice.value === EGRESS_CUSTOM) items.push({ value: EGRESS_CUSTOM, label: current.value?.masked ? `不在代理池 · ${current.value.masked}` : '不在代理池', disabled: true })
  return items
})
const badge = computed(() => (current.value ? egressBadge(props.egress, ref_.value, service.value, current.value) : null))
const target = computed(() => props.egress?.entries.find((entry) => entry.id === choice.value) ?? null)
const targetMark = computed(() => checkMark(target.value, service.value))
const changed = computed(() => choice.value !== EGRESS_UNKNOWN && choice.value !== EGRESS_CUSTOM && choice.value !== egressChoice(current.value, props.egress))
const who = computed(() => (props.account ? (masked.value ? maskPii(props.account.user) : props.account.user) : ''))

async function apply() {
  const account = props.account
  if (!account || !changed.value || busy.value) return
  const warning = egressWarning(props.egress, choice.value, service.value)
  if (warning) {
    const ok = await confirmSheet({
      title: '这个出口最近一次检测不通，仍然使用？',
      facts: [{ k: '账号', v: who.value }, { k: '出口', v: choiceName(props.egress, ref_.value, choice.value) }, { k: '检测', v: warning }],
      consequence: '可随时改回 · 原出口已记下',
      confirmText: '仍然使用',
    })
    if (!ok) return
  }
  busy.value = true
  try {
    const target = choice.value === '' ? 'inherit' : choice.value
    const result = await proxyApi.assign(target, [ref_.value])
    const failed = result.results.find((item) => item.status === 'failed')
    if (failed) throw new Error(failed.error || '出口没改成')
    const saved = await proxyApi.egressAccount(ref_.value, account.agent)
    knowProxy(ref_.value, saved)
    notify(`✓ 出口已改为 ${readLabel(saved, props.egress)}`, { id: 'cx-acc-proxy' })
    emit('changed')
    open.value = false
  } catch (error) {
    notify(`◆ 出口没改成 · ${errorReason(error)}`, { tone: 'bad', id: 'cx-acc-proxy' })
    void readProxy(ref_.value, account.agent)
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <Sheet v-model="open" title="出口" size="480px">
    <div v-if="account" class="egs">
      <p class="egs__who"><Pii :value="account.user" /><span class="egs__svc">{{ serviceName || account.agent }}</span></p>
      <dl class="egs__facts">
        <div>
          <dt>现在</dt>
          <dd>
            <template v-if="read?.state === 'error'">没读到 · <button type="button" class="ui-link" @click="readProxy(ref_, account.agent)">重读</button></template>
            <template v-else-if="!current">读取中···</template>
            <EgressTag v-else-if="badge" :badge="badge" bare />
            <template v-else>{{ readLabel(current, egress) }}</template>
          </dd>
        </div>
      </dl>
      <FilterField v-model="choice" class="egs__pick" label="改为" :all-label="null" :options="options" />
      <p v-if="target && service && changed" class="egs__note" :class="{ sig: targetMark.ok === false }">
        {{ targetMark.title }}<template v-if="target.country"> · 落地 {{ regionName(target.country) }}</template>
      </p>
      <p class="egs__note">内核用这个出口为这个账号查用量、刷新登录和转发请求；登录本身不经代理。</p>
    </div>
    <template #footer>
      <TxButton variant="secondary" @click="open = false">取消</TxButton>
      <TxButton variant="primary" :loading="busy" :disabled="!changed || busy" @click="apply">应用</TxButton>
    </template>
  </Sheet>
</template>

<style>
.egs { display: grid; gap: 14px; min-width: 0; }
.egs__who { margin: 0; display: flex; align-items: baseline; gap: 10px; min-width: 0; font-size: var(--fs-row); color: var(--ink); }
.egs__who .pii { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.egs__svc { flex: none; font-size: var(--fs-xs); color: var(--ink-3); }
.egs__facts { margin: 0; display: grid; gap: 6px; }
.egs__facts > div { display: flex; align-items: baseline; gap: 12px; min-width: 0; }
.egs__facts dt { flex: none; width: 3em; font-size: var(--fs-xs); color: var(--ink-3); }
.egs__facts dd { margin: 0; min-width: 0; font-size: var(--fs-sm); color: var(--ink); }
.egs__facts .eg { font-size: var(--fs-sm); }
.egs__pick .ui-ff__k { width: 3em; font-size: var(--fs-xs); }
html:root .egs__pick .tuff-select { width: 320px; max-width: 100%; }
.egs__note { margin: 0; font-size: var(--fs-xs); line-height: 1.6; color: var(--ink-3); }
.egs__note.sig { color: var(--signal-ink); }
</style>

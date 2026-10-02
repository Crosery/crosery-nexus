<script setup lang="ts">
import { computed, nextTick, ref, useTemplateRef, watch } from 'vue'
import { TxButton, TxIconButton } from '@talex-touch/tuffex/button'
import { TxInput } from '@talex-touch/tuffex/input'
import CopyField from '../../ui/form/CopyField.vue'
import Pii from '../../ui/data/Pii.vue'
import StatusMark from '../../ui/data/StatusMark.vue'
import Icon from '../../ui/Icon.vue'
import { fmtCountdownClock } from '../../ui/composables/useNow'
import { copyText } from '../../ui/feedback/toast'
import type { MagpieCatalogItem } from '../../types'
import { fillCopy, shortUrl } from './magpieModel'
import { remainingMs, waitingHint, type FlowState } from './signIn'

/**
 * One panel per sign-in step (Magpie `renderSigning`): risk card → site pick → 正在启动 → 正在安装 → 等待
 * (login link to open in this browser, device code, the paste-the-final-address field for host-loopback flows)
 * → 已登录 | 登录未完成 | 已取消. Presentational: the sheet owns the flow and passes it in.
 */
const props = defineProps<{
  state: FlowState
  item: MagpieCatalogItem | null
  /** Magpie's zh strings from the catalog */
  copy: Record<string, string>
  now: number
}>()
const emit = defineEmits<{
  confirmRisk: []
  pickSite: [site: string]
  back: []
  cancel: []
  retry: []
  callback: [url: string]
}>()

const t = (key: string, fallback: string, values: Record<string, string> = {}) => fillCopy(props.copy[key] || fallback, values)
const name = computed(() => props.state.name)
const view = computed(() => props.state.view)
const left = computed(() => remainingMs(props.state, props.now))
const hostOnly = computed(() => props.item?.completion === 'local')
const hint = computed(() => {
  switch (waitingHint(props.state)) {
    case 'code-confirm': return `在 ${name.value} 的确认页核对它显示的是这个代码，然后确认`
    case 'code-enter': return '在打开的页面输入这个代码，完成后账号会出现在列表里'
    default: return '在你的浏览器里打开登录页，完成后账号会出现在列表里'
  }
})

/* ── paste the final address (relay / Magpie's own paste) ── */
const callbackUrl = ref('')
const inputId = computed(() => `sf-cb-${props.state.agent}`)
function submit() {
  const text = callbackUrl.value.trim()
  if (!text || props.state.callbackBusy || props.state.callbackLocked) return
  emit('callback', text)
}
watch(() => view.value?.next, (next) => { if (next) callbackUrl.value = '' })

/* ── done: Magpie's sentence with the account through <Pii> (the privacy mask applies) ── */
const doneParts = computed(() => {
  const template = view.value?.using ? t('signedIn', '已登录 {user}') : t('added', '已添加 {user}，随时可以切换')
  const at = template.indexOf('{user}')
  return at === -1 ? { before: template, after: '' } : { before: template.slice(0, at), after: template.slice(at + '{user}'.length) }
})

/* focus the first useful control of each panel, so keyboard users land where the next action is */
const root = useTemplateRef<HTMLElement>('root')
watch(() => props.state.step, () => {
  void nextTick(() => {
    const target = root.value?.querySelector<HTMLElement>('[data-autofocus] button, [data-autofocus] a, [data-autofocus] input, button[data-autofocus], a[data-autofocus]')
    target?.focus({ preventScroll: true })
  })
}, { immediate: true, flush: 'post' })
</script>

<template>
  <div ref="root" class="sf" :data-step="state.step">
    <!-- risk: Magpie's card, verbatim -->
    <template v-if="state.step === 'risk' && state.risk">
      <h3 class="sf-title"><span class="sf-mark" aria-hidden="true">◆</span>{{ state.risk.title }}</h3>
      <p class="sf-note">{{ state.risk.note }}</p>
      <div class="sf-actions">
        <TxButton variant="secondary" @click="emit('back')">{{ t('cancel', '取消') }}</TxButton>
        <TxButton variant="primary" data-autofocus @click="emit('confirmRisk')">{{ t('riskConfirm', '仍然登录') }}</TxButton>
      </div>
    </template>

    <!-- site: ZCode -->
    <template v-else-if="state.step === 'site'">
      <h3 class="sf-title">{{ t('sitePrompt', '你的 {name} 账号在哪个站点？', { name }) }}</h3>
      <p v-if="copy.siteHint" class="sf-note">{{ copy.siteHint }}</p>
      <div class="sf-sites" data-autofocus>
        <TxButton v-for="s in state.sites" :key="s.id" variant="secondary" @click="emit('pickSite', s.id)">
          {{ s.label }}<span v-if="s.host" class="sf-host">{{ s.host }}</span>
        </TxButton>
      </div>
    </template>

    <!-- starting -->
    <template v-else-if="state.step === 'starting'">
      <p class="sf-wait" role="status"><StatusMark state="busy" label="正在启动…" /></p>
      <div class="sf-actions"><TxButton variant="ghost" data-autofocus @click="emit('cancel')">{{ t('cancel', '取消') }}</TxButton></div>
    </template>

    <!-- installing (host-exec agents, only when the server allows them) -->
    <template v-else-if="state.step === 'installing'">
      <p class="sf-wait" role="status"><StatusMark state="busy" :label="t('installing', '正在安装 {cli}…', { cli: view?.installing || '命令行工具' })" /></p>
      <p class="sf-note">{{ name }} 要用它自己的命令行工具，服务器上还没有，正在用官方安装器安装；装好后这里会给出登录链接。</p>
      <div class="sf-actions"><TxButton variant="ghost" data-autofocus @click="emit('cancel')">{{ t('cancel', '取消') }}</TxButton></div>
    </template>

    <!-- waiting -->
    <template v-else-if="state.step === 'waiting'">
      <h3 class="sf-title">{{ t('waitingTitle', '请在浏览器中完成 {name} 登录', { name }) }}</h3>
      <p class="sf-note">{{ hint }}</p>

      <div v-if="view?.code" class="sf-code">
        <span class="sf-code__k">设备码</span>
        <div class="sf-code__row">
          <code class="sf-code__v">{{ view.code }}</code>
          <TxIconButton label="复制设备码" title="复制设备码" size="sm" @click="copyText(view.code, '设备码')"><Icon name="copy" /></TxIconButton>
        </div>
      </div>

      <div v-if="view?.url" class="sf-link">
        <CopyField class="sf-link__f" label="登录链接" :value="shortUrl(view.url)" :copy-value="view.url" />
        <a class="ui-btn ui-btn--primary sf-link__open" :href="view.url" target="_blank" rel="noopener noreferrer" data-autofocus>打开<Icon name="external" :size="14" /></a>
      </div>
      <p v-if="hostOnly" class="sf-note sf-note--ink">需在服务器本机的浏览器完成</p>

      <div v-if="view?.next" class="sf-next">
        <p class="sf-note sf-note--ink">还差一步：打开下一个页面，完成后把它跳转到的地址再粘贴一次。</p>
        <a class="ui-btn sf-next__open" :href="view.next" target="_blank" rel="noopener noreferrer">打开下一步<Icon name="external" :size="14" /></a>
      </div>

      <form v-if="view?.pasteCallback" class="sf-paste" novalidate @submit.prevent="submit">
        <label :for="inputId" class="sf-paste__k">{{ t('callbackLabel', '回调地址') }}</label>
        <p v-if="state.callbackLocked" class="sf-paste__done" role="status"><span aria-hidden="true">✓ </span>已提交</p>
        <p v-else :id="`${inputId}-hint`" class="sf-paste__hint">如果浏览器停在一个打不开的 localhost 地址，把地址栏里的完整地址粘贴到这里。</p>
        <div v-if="!state.callbackLocked" class="sf-paste__row">
          <TxInput
            :id="inputId"
            v-model="callbackUrl"
            class="sf-paste__in mono"
            type="text"
            inputmode="url"
            autocomplete="off"
            spellcheck="false"
            placeholder="http://localhost:…"
            :aria-describedby="`${inputId}-hint`"
            :disabled="state.callbackBusy"
          />
          <TxButton variant="secondary" native-type="submit" :loading="state.callbackBusy" :disabled="!callbackUrl.trim() || state.callbackBusy">{{ t('callbackSubmit', '完成登录') }}</TxButton>
        </div>
        <p v-if="state.callbackError" class="sf-err" role="alert">◆ {{ state.callbackError }}</p>
      </form>

      <div class="sf-foot">
        <span class="sf-foot__left num" role="status"><StatusMark state="busy" :label="state.callbackLocked ? '正在完成登录…' : '等待完成'" /><template v-if="left !== null"> · 剩余 {{ fmtCountdownClock(left) }}</template></span>
        <TxButton variant="ghost" size="sm" @click="emit('cancel')">{{ t('cancel', '取消') }}</TxButton>
      </div>
    </template>

    <!-- done -->
    <template v-else-if="state.step === 'done'">
      <p class="sf-done" role="status"><span class="sf-ok" aria-hidden="true">✓</span>{{ doneParts.before }}<Pii :value="view?.user ?? ''" />{{ doneParts.after }}</p>
    </template>

    <!-- failed -->
    <template v-else-if="state.step === 'failed'">
      <h3 class="sf-title">{{ t('failedTitle', '登录未完成') }}</h3>
      <p class="sf-err" role="alert">◆ {{ state.reason }}</p>
      <p v-if="state.detail" class="sf-detail">{{ state.detail }}</p>
      <div class="sf-actions">
        <TxButton variant="secondary" @click="emit('back')">{{ t('cancel', '取消') }}</TxButton>
        <TxButton variant="primary" data-autofocus @click="emit('retry')">{{ t('retry', '重试') }}</TxButton>
      </div>
    </template>

    <!-- canceled elsewhere (a person's own cancel closes the sheet) -->
    <template v-else-if="state.step === 'canceled'">
      <h3 class="sf-title">登录已取消</h3>
      <p v-if="state.reason" class="sf-note">{{ state.reason }}</p>
      <div class="sf-actions">
        <TxButton variant="secondary" @click="emit('back')">返回</TxButton>
        <TxButton variant="primary" data-autofocus @click="emit('retry')">重新开始</TxButton>
      </div>
    </template>
  </div>
</template>

<style>
.sf { display: grid; gap: 14px; min-width: 0; }
.sf-title { margin: 0; font-size: var(--fs-md); font-weight: 650; line-height: 1.4; color: var(--ink); }
.sf-mark { margin-right: 8px; color: var(--signal); font-size: 12px; vertical-align: 1px; }
.sf-note { margin: 0; font-size: var(--fs-sm); line-height: 1.65; color: var(--ink-2); }
.sf-note--ink { color: var(--ink); }
.sf-actions { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 8px; padding-top: 2px; }
.sf-sites { display: flex; flex-wrap: wrap; gap: 8px; }
.sf-host { margin-left: 8px; font-family: var(--font-mono); font-size: var(--fs-xs); color: var(--ink-3); font-weight: 400; }
.sf-wait { margin: 0; min-height: 28px; display: flex; align-items: center; }
.sf-code { display: grid; gap: 4px; }
.sf-code__k, .sf-paste__k { font-size: var(--fs-xs); color: var(--ink-3); }
.sf-code__row { display: flex; align-items: center; gap: 8px; }
.sf-code__v { font-family: var(--font-mono); font-size: 28px; line-height: 40px; letter-spacing: .08em; color: var(--ink); background: none; overflow-wrap: anywhere; }
.sf-link { display: flex; align-items: flex-end; gap: 8px; min-width: 0; }
.sf-link__f { flex: 1 1 auto; }
.sf-link__open, .sf-next__open { flex: none; gap: 6px; text-decoration: none; }
.sf-next { display: grid; gap: 8px; justify-items: start; }
.sf-paste { display: grid; gap: 6px; border-top: 1px solid var(--rule); padding-top: 14px; }
.sf-paste__done { margin: 0; font-size: var(--fs-sm); color: var(--ink); }
.sf-paste__hint { margin: 0; font-size: var(--fs-xs); line-height: 1.6; color: var(--ink-3); }
.sf-paste__row { display: flex; gap: 8px; min-width: 0; }
.sf-paste__in { flex: 1 1 auto; min-width: 0; }
html:root .sf-paste__in .tx-input__inner { font-family: var(--font-mono); font-size: var(--fs-xs); }
.sf-err { margin: 0; font-size: var(--fs-sm); line-height: 1.6; color: var(--signal-ink); }
.sf-detail { margin: 0; font-family: var(--font-mono); font-size: var(--fs-xs); color: var(--ink-3); overflow-wrap: anywhere; }
.sf-foot { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding-top: 10px; border-top: 1px solid var(--rule); font-size: var(--fs-xs); color: var(--ink-3); }
.sf-foot__left { display: inline-flex; align-items: center; gap: 4px; min-width: 0; }
.sf-done { margin: 0; display: flex; align-items: baseline; flex-wrap: wrap; gap: 0 2px; font-size: var(--fs-md); color: var(--ink); }
.sf-ok { margin-right: 8px; font-family: var(--font-mono); }
@media (max-width: 599px) {
  .sf-link { flex-direction: column; align-items: stretch; }
  .sf-link__open { justify-content: center; min-height: var(--tap); }
  .sf-paste__row { flex-direction: column; }
  .sf-code__v { font-size: 24px; }
  html:root .sf-actions .tx-button { flex: 1; min-height: var(--tap); }
}
</style>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, useTemplateRef, watch } from 'vue'
import Segmented from '../form/Segmented.vue'
import SecretField from '../form/SecretField.vue'
import type { LoginMode } from '../types'

/**
 * Login plate (DESIGN.md §6.1): brand row + `v3.0`, h1 `进入中转控制台`, a mode sub-line, Segmented
 * `API Key | 管理员` (40px), the fields, a 42px ink `登录 ↵` button (`验证中···` mono ticker while busy, no
 * spinner) and a dashed footer `MODE · KEY` / `Tab 切换字段 · ↵ 提交`.
 * - Default mode = last used on this device (first visit: API Key).
 * - Pasting an `sk-…` value into an admin field switches to Key mode, moves the value, and says
 *   `已识别为 API Key` for 2s.
 * - Errors are inline under the field (signal-ink, `◆ …`), the field gets a signal underline and focus
 *   returns to it. No shake. One persistent visually-hidden alert announces each error once: a ticking text such as
 *   the 429 countdown passes a fixed `live` sentence, so neither speech nor focus repeats every second.
 * - `locked` (429 window) disables 登录 until the page lifts it.
 * The page owns the request: listen to `submit`, set `busy`, pass `error`, then `await globe.exit()`.
 * Both secrets are SecretField (masked `<input type=password>` + eye toggle): the key is never echoed while
 * typing, password managers can fill / save either mode (key mode carries a hidden `username` = `API Key`),
 * and Enter submits the native form. Fields re-mask on submit and on a mode switch.
 */
const props = withDefaults(
  defineProps<{
    busy?: boolean
    /** inline error: which field and the sentence (e.g. `◆ 密码不对`); `live` = what to announce when `text` ticks */
    error?: { field: 'key' | 'username' | 'password'; text: string; live?: string } | null
    /** too many attempts: submit stays disabled until the page clears it */
    locked?: boolean
    /** `会话已过期 · 登录后回到 ‹页面›` */
    notice?: string | null
    version?: string
  }>(),
  { busy: false, error: null, locked: false, notice: null, version: 'v3.0' },
)
const emit = defineEmits<{ submit: [payload: { mode: LoginMode; key?: string; username?: string; password?: string }] }>()

const MODE_KEY = 'cx-login-mode'
function initialMode(): LoginMode {
  try {
    return window.localStorage.getItem(MODE_KEY) === 'admin' ? 'admin' : 'key'
  } catch {
    return 'key'
  }
}
const mode = defineModel<LoginMode>('mode', { default: undefined })
if (!mode.value) mode.value = initialMode()
watch(mode, (m) => {
  maskAll()
  try {
    window.localStorage.setItem(MODE_KEY, m ?? 'key')
  } catch {
    /* private mode */
  }
})

const key = ref('')
const username = ref('admin')
const password = ref('')
const recognized = ref(false)
let recognizedTimer: ReturnType<typeof setTimeout> | null = null
const root = useTemplateRef<HTMLElement>('root')
const keyField = useTemplateRef<InstanceType<typeof SecretField>>('keyField')
const pwField = useTemplateRef<InstanceType<typeof SecretField>>('pwField')
function maskAll() {
  keyField.value?.mask()
  pwField.value?.mask()
}

const MODES = [
  { value: 'key', label: 'API Key' },
  { value: 'admin', label: '管理员' },
]
const sub = computed(() => (mode.value === 'admin' ? '管理账号、Key、渠道与同步任务' : '粘贴你的 API Key · 只看这把 Key 的额度与用量'))

function onPaste(event: ClipboardEvent) {
  const text = event.clipboardData?.getData('text')?.trim() ?? ''
  if (!/^sk-[\w-]{8,}/.test(text)) return
  event.preventDefault()
  mode.value = 'key'
  key.value = text
  password.value = ''
  recognized.value = true
  if (recognizedTimer) clearTimeout(recognizedTimer)
  recognizedTimer = setTimeout(() => (recognized.value = false), 2000)
  void nextTick(() => root.value?.querySelector<HTMLInputElement>('.ui-lp__key input')?.focus())
}
onBeforeUnmount(() => {
  if (recognizedTimer) clearTimeout(recognizedTimer)
})

async function pasteKey() {
  try {
    const text = (await navigator.clipboard.readText()).trim()
    if (text) key.value = text
  } catch {
    root.value?.querySelector<HTMLInputElement>('.ui-lp__key input')?.focus()
  }
}

function submit() {
  if (props.busy || props.locked) return
  maskAll()
  if (mode.value === 'key') emit('submit', { mode: 'key', key: key.value.trim() })
  else emit('submit', { mode: 'admin', username: username.value.trim(), password: password.value })
}

/* focus returns to the failing field, once per error (not on every tick of a countdown, and not when an error
   reappears because the person switched modes — focus stays on the switch) */
const announce = computed(() => (props.error ? (props.error.live ?? props.error.text) : ''))
watch(
  [() => mode.value, () => (props.error ? `${props.error.field}|${announce.value}` : '')],
  async ([m, sig], [prevMode]) => {
    const err = props.error
    if (!sig || !err || m !== prevMode) return
    await nextTick()
    const sel = err.field === 'key' ? '.ui-lp__key input' : err.field === 'username' ? '#ui-lp-user' : '.ui-lp__pw input'
    root.value?.querySelector<HTMLInputElement>(sel)?.focus()
  },
)
const errFor = (field: 'key' | 'username' | 'password') => (props.error?.field === field ? props.error.text : '')
/* the field's message line: its error when there is one, else the key hint */
const msgId = (field: 'key' | 'username' | 'password') => `ui-lp-${field}-msg`
</script>

<template>
  <form ref="root" class="ui-lp" novalidate :aria-busy="busy" @submit.prevent="submit" @paste.capture="mode === 'admin' && onPaste($event)">
    <div class="ui-lp__brand">
      <span class="ui-lp__word">
        <svg class="ui-lp__mark" viewBox="0 0 22 22" width="18" height="18" aria-hidden="true">
          <circle cx="11" cy="11" r="8.5" fill="none" stroke="currentColor" stroke-width="1.5" />
          <path d="M11 0.5v5M11 16.5v5M0.5 11h5M16.5 11h5" stroke="currentColor" stroke-width="1.5" />
          <circle cx="11" cy="11" r="2.6" class="ui-lp__core" />
        </svg>
        <b>CROSERY</b> / console
      </span>
      <span class="ui-lp__ver">{{ version }}</span>
    </div>
    <h1 class="ui-lp__h">进入中转控制台</h1>
    <p class="ui-lp__sub">{{ sub }}</p>
    <p v-if="notice" class="ui-lp__notice">{{ notice }}</p>
    <Segmented v-model="mode" :items="MODES" label="登录方式" block class="ui-lp__seg" />

    <div v-if="mode === 'key'" class="ui-lp__fields">
      <!-- password managers file a password-only form under this username -->
      <input type="text" name="username" autocomplete="username" value="API Key" hidden readonly tabindex="-1" aria-hidden="true">
      <div class="ui-lp__key" :class="{ 'is-err': errFor('key') }">
        <label class="ui-lp__lbl" for="ui-lp-key">API Key</label>
        <SecretField
          id="ui-lp-key"
          ref="keyField"
          v-model="key"
          class="ui-lp__in"
          name="apiKey"
          autocomplete="current-password"
          placeholder="sk-…"
          noun="Key"
          mono
          :invalid="Boolean(errFor('key'))"
          :describedby="msgId('key')"
        />
        <button type="button" class="ui-btn ui-btn--text ui-btn--sm ui-lp__paste" @click="pasteKey">粘贴</button>
      </div>
      <p v-if="errFor('key')" :id="msgId('key')" class="ui-lp__err">{{ errFor('key') }}</p>
      <p v-else-if="recognized" :id="msgId('key')" class="ui-lp__hint" role="status">已识别为 API Key</p>
      <p v-else :id="msgId('key')" class="ui-lp__hint">Key 不会显示在页面上</p>
    </div>
    <div v-else class="ui-lp__fields">
      <label class="ui-lp__lbl" for="ui-lp-user">账号</label>
      <input
        id="ui-lp-user"
        v-model="username"
        class="ui-input ui-lp__in"
        :class="{ 'is-err': errFor('username') }"
        name="username"
        autocomplete="username"
        autocapitalize="off"
        spellcheck="false"
        :aria-invalid="errFor('username') ? 'true' : undefined"
        :aria-describedby="errFor('username') ? msgId('username') : undefined"
      >
      <p v-if="errFor('username')" :id="msgId('username')" class="ui-lp__err">{{ errFor('username') }}</p>
      <label class="ui-lp__lbl ui-lp__lbl--gap" for="ui-lp-pw">密码</label>
      <div class="ui-lp__pw" :class="{ 'is-err': errFor('password') }">
        <SecretField
          id="ui-lp-pw"
          ref="pwField"
          v-model="password"
          class="ui-lp__in"
          name="password"
          autocomplete="current-password"
          noun="密码"
          :invalid="Boolean(errFor('password'))"
          :describedby="errFor('password') ? msgId('password') : undefined"
        />
      </div>
      <p v-if="errFor('password')" :id="msgId('password')" class="ui-lp__err">{{ errFor('password') }}</p>
    </div>

    <p class="sr-only" role="alert">{{ announce }}</p>
    <button type="submit" class="ui-btn ui-btn--primary ui-btn--block ui-lp__go" :class="{ 'is-busy': busy }" :disabled="busy || locked">
      <template v-if="busy">验证中<span class="ui-lp__dots" aria-hidden="true"><i>·</i><i>·</i><i>·</i></span></template>
      <template v-else>登录 <span aria-hidden="true">↵</span></template>
    </button>
    <div class="ui-lp__foot" aria-hidden="true">Tab 切换字段 · ↵ 提交</div>
  </form>
</template>

<style>
.ui-lp { position: relative; width: 420px; max-width: 100%; display: grid; gap: 12px; padding: 26px 28px 18px; background: var(--sheet); box-shadow: var(--shadow-pop); }
.ui-lp__brand { display: flex; justify-content: space-between; align-items: center; padding-bottom: 12px; border-bottom: 1px solid var(--rule); font-family: var(--font-mono); font-size: 12px; letter-spacing: .06em; color: var(--ink-2); }
.ui-lp__word { display: inline-flex; align-items: center; gap: 8px; white-space: nowrap; }
.ui-lp__mark { color: var(--ink); flex: none; }
.ui-lp__core { fill: var(--signal); }
.ui-lp__brand b { color: var(--ink); }
.ui-lp__ver { font-size: var(--fs-micro); color: var(--ink-3); }
.ui-lp__h { margin: 6px 0 0; font-size: 21px; font-weight: 650; }
.ui-lp__sub { margin: -6px 0 4px; font-size: var(--fs-sm); color: var(--ink-3); text-wrap: balance; }
.ui-lp__notice { margin: 0; padding: 6px 10px; background: var(--paper-2); box-shadow: inset 2px 0 0 var(--ink); font-size: var(--fs-sm); }
html:root .ui-lp__seg .tx-bui-filter-chips__chip { height: 34px; }
.ui-lp__fields { display: grid; gap: 6px; }
/* label + 粘贴 on one row above the field; 粘贴 comes after the field in DOM (Tab: field → eye → 粘贴) */
.ui-lp__key { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: center; gap: 6px 8px; }
.ui-lp__key .ui-lp__lbl { grid-row: 1; grid-column: 1; }
.ui-lp__key .ui-lp__paste { grid-row: 1; grid-column: 2; }
.ui-lp__key .ui-lp__in { grid-row: 2; grid-column: 1 / -1; }
.ui-lp__paste { height: 22px; min-height: 22px; margin: -4px -6px -4px 0; }
/* touch: a 40px hit area that does not grow the label row */
@media (pointer: coarse) { .ui-lp__paste { height: 40px; min-height: 40px; margin: -13px -6px -13px 0; } }
.ui-lp__lbl { font-size: var(--fs-xs); color: var(--ink-3); }
.ui-lp__lbl--gap { margin-top: 6px; }
html:root .ui-lp .ui-lp__in { height: 40px; width: 100%; }
html:root .ui-lp .ui-input.ui-lp__in { font-size: 14px; }
html:root .ui-lp .tx-input.ui-lp__in .tx-input__inner { font-size: 14px; }
.ui-lp__in.is-err { box-shadow: inset 0 -1px 0 var(--signal); }
.ui-lp__err { margin: 0; font-size: var(--fs-sm); color: var(--signal-ink); text-wrap: balance; }
.ui-lp__hint { margin: 0; font-size: var(--fs-xs); color: var(--ink-3); }
.ui-lp__go { height: 42px; margin-top: 6px; font-size: 14px; }
/* verifying is work in progress, not an unavailable action: the button keeps its ink fill */
.ui-lp__go.is-busy:disabled { background: var(--ink); border: 1px solid var(--ink); color: var(--paper); cursor: progress; }
.ui-lp__dots { display: inline-flex; margin-left: 2px; font-family: var(--font-mono); }
.ui-lp__dots i { font-style: normal; animation: ui-blink 1.2s steps(1) infinite; }
.ui-lp__dots i:nth-child(2) { animation-delay: .2s; }
.ui-lp__dots i:nth-child(3) { animation-delay: .4s; }
.ui-lp__foot { display: flex; justify-content: flex-end; margin-top: 2px; font-family: var(--font-mono); font-size: var(--fs-micro); letter-spacing: .06em; color: var(--ink-3); }
@media (max-width: 760px) {
  .ui-lp { width: 100%; padding: 18px 18px 14px; gap: 10px; }
  .ui-lp__brand { padding-bottom: 10px; }
  html:root .ui-lp__seg .tx-bui-filter-chips__chip { height: 40px; }
  html:root .ui-lp .ui-lp__in { height: 44px; }
  html:root .ui-lp .ui-input.ui-lp__in, html:root .ui-lp .tx-input.ui-lp__in .tx-input__inner { font-size: 16px; }
  .ui-lp__go { height: 48px; }
  .ui-lp__foot { display: none; }
}
</style>

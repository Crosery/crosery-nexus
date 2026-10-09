<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, shallowRef, useTemplateRef, watch } from 'vue'
import { TxButton } from '@talex-touch/tuffex/button'
import { TxCheckbox } from '@talex-touch/tuffex/checkbox'
import { TxTag } from '@talex-touch/tuffex/tag'
import Sheet from '../../ui/feedback/Sheet.vue'
import ProviderMark from '../../ui/data/ProviderMark.vue'
import StatusMark from '../../ui/data/StatusMark.vue'
import Icon from '../../ui/Icon.vue'
import { useNow, fmtCountdownClock } from '../../ui/composables/useNow'
import { copyText } from '../../ui/feedback/toast'
import { errorReason } from '../../lib/errors'
import { maskEmail, useMask } from '../../lib/privacy'
import { api } from '../../api'
import type { EgressData, OAuthStartResult } from '../../types'
import { flowLabel, PROVIDERS, providerById, type ProviderInfo, type VerifyResult } from './model'
import { choiceName, cpaRef, serviceOf } from './egressModel'
import { useClipboardCallback } from './useClipboardCallback'
import SigninEgress from './SigninEgress.vue'

/**
 * Add-account sheet (DESIGN §6.5): 选择服务 → 风险确认 (Claude, Antigravity) → 授权 → 服务端验证 → 就地出现.
 * It drives the existing flows only: POST /api/cpa/oauth/start, GET …/status (polled), POST …/callback
 * (paste the localhost redirect when the gateway runs elsewhere), POST …/cancel. Nothing is started until the
 * person presses 开始授权; closing the sheet cancels a session that is still waiting.
 */
const props = withDefaults(defineProps<{
  provider?: string | null
  reauthEmail?: string | null
  verify: (providerId: string) => Promise<VerifyResult>
  /** the proxy pool's view: 登录出口 / 账号出口 (null: no pool routes, nothing shown) */
  egress?: EgressData | null
}>(), {
  provider: null,
  reauthEmail: null,
  egress: null,
})
const open = defineModel<boolean>({ default: false })
const emit = defineEmits<{ done: [name: string | null]; egress: []; imported: [] }>()
const { on: masked } = useMask()
const now = useNow()

type Step = 'pick' | 'risk' | 'auth' | 'verify' | 'done' | 'fail'
const step = ref<Step>('pick')
const chosen = shallowRef<ProviderInfo | null>(null)
const accepted = ref(false)
const session = shallowRef<OAuthStartResult | null>(null)
const starting = ref(false)
const expiresAt = ref<number | null>(null)
const callbackUrl = ref('')
const submitting = ref(false)
/** the pasted callback was accepted; the gateway exchanges the code on its own time, so polling carries on */
const callbackSent = ref(false)
const failText = ref('')
/** CPA's own words behind a reworded session error (server/oauthErrors.ts), shown collapsed */
const failDetail = ref('')
/** the submitted callback came from the clipboard (button, or read on returning to the tab) */
const viaClipboard = ref(false)
const outcome = ref<{ text: string; tone: 'ok' | 'warn' } | null>(null)
/** 账号出口 picked during the sign-in ('' = 继承): written to the new account once it is listed */
const exitChoice = ref('')
let timer: ReturnType<typeof setTimeout> | null = null
let closeTimer: ReturnType<typeof setTimeout> | null = null
let pollErrors = 0
let generation = 0
/** the generation whose verify already ran: an in-flight poll and the callback path cannot both finalize */
let finalized = -1

const BROWSER_POLL_MS = 3000
const DEVICE_POLL_MS = 5000
const DEFAULT_TTL_S = 300

const rail = computed(() => {
  const list: Array<{ id: Step; label: string }> = [{ id: 'pick', label: '选择服务' }]
  if (chosen.value?.risk && !props.reauthEmail) list.push({ id: 'risk', label: '风险确认' })
  list.push({ id: 'auth', label: '授权' }, { id: 'verify', label: '服务端验证' }, { id: 'done', label: '就地出现' })
  const order = list.map((s) => s.id)
  const at = step.value === 'fail' ? order.indexOf('auth') : order.indexOf(step.value)
  return list.map((s, i) => ({ ...s, n: String(i + 1), state: i < at ? 'done' : i === at ? (step.value === 'fail' ? 'fail' : 'now') : 'todo' }))
})

const who = computed(() => (props.reauthEmail ? (masked.value ? maskEmail(props.reauthEmail) : props.reauthEmail) : ''))
const left = computed(() => (expiresAt.value ? Math.max(0, expiresAt.value - now.value) : null))
const userCode = computed(() => String(session.value?.user_code ?? '').trim())
const codeChars = computed(() => {
  const raw = userCode.value.replace(/[\s-]+/g, '')
  const half = raw.length >= 8 ? raw.length / 2 : 0
  return half ? [raw.slice(0, half), raw.slice(half)] : [raw]
})
const authHost = computed(() => {
  try {
    return session.value?.url ? new URL(session.value.url).hostname : ''
  } catch {
    return ''
  }
})
const isDevice = computed(() => chosen.value?.flow === 'device' || Boolean(userCode.value))
const pastePlaceholder = computed(() => (chosen.value?.pastePlaceholder ? `${chosen.value.pastePlaceholder} · 或只填授权码` : '回调地址或授权码'))

const waitingPaste = computed(() => step.value === 'auth' && Boolean(session.value) && !isDevice.value && Boolean(chosen.value?.paste) && !callbackSent.value)
const { note: clipNote, pasteNow } = useClipboardCallback({
  active: waitingPaste,
  expect: () => (session.value && chosen.value ? { state: session.value.state, authUrl: session.value.url, placeholder: chosen.value.pastePlaceholder } : null),
  submit: (value) => {
    callbackUrl.value = value
    void submitCallback(true)
  },
})

function stopPolling() {
  if (timer) clearTimeout(timer)
  timer = null
}

function cancelSession() {
  const state = session.value?.state
  stopPolling()
  session.value = null
  expiresAt.value = null
  if (state) void api.cancelOAuth(state).catch(() => undefined)
}

function reset() {
  generation += 1
  cancelSession()
  if (closeTimer) clearTimeout(closeTimer)
  closeTimer = null
  accepted.value = false
  callbackUrl.value = ''
  submitting.value = false
  callbackSent.value = false
  starting.value = false
  failText.value = ''
  failDetail.value = ''
  viaClipboard.value = false
  outcome.value = null
  exitChoice.value = ''
  pollErrors = 0
}

/** The picked 账号出口, through the pool (the same credential writer; linked by entry id, previous value kept). */
async function applyExit(name: string): Promise<{ text: string; ok: boolean }> {
  const choice = exitChoice.value
  if (!choice || !props.egress?.accountProxy.supported) return { text: '', ok: true }
  const ref = cpaRef(name)
  try {
    const result = await api.proxies.assign(choice, [ref])
    const failed = result.results.find((item) => item.status === 'failed')
    if (failed) return { text: ` · ◇ 出口没设上：${failed.error ?? '稍后在账号详情里再选'}`, ok: false }
    emit('egress')
    return { text: ` · 出口 ${choiceName(props.egress, ref, choice)}`, ok: true }
  } catch (cause) {
    return { text: ` · ◇ 出口没设上：${errorReason(cause)}`, ok: false }
  }
}

function choose(p: ProviderInfo) {
  reset()
  chosen.value = p
  step.value = p.risk && !props.reauthEmail ? 'risk' : 'auth'
}

watch(open, (value) => {
  if (value) {
    reset()
    const p = providerById(props.provider)
    chosen.value = p
    step.value = p ? (p.risk && !props.reauthEmail ? 'risk' : 'auth') : 'pick'
    if (!p) void nextTick(() => listEl.value?.querySelector<HTMLButtonElement>('button')?.focus())
  } else {
    reset()
  }
}, { immediate: true }) // ?add=<provider> opens the sheet before it mounts
onBeforeUnmount(reset)

function fail(text: string, detail = '') {
  stopPolling()
  failText.value = text
  failDetail.value = detail
  step.value = 'fail'
}

async function start() {
  const p = chosen.value
  if (!p || starting.value) return
  starting.value = true
  const mine = ++generation
  try {
    const res = await api.startOAuth(p.id)
    if (mine !== generation) {
      // closed or switched while the start was in flight: nothing holds this session, release it now
      void api.cancelOAuth(res.state).catch(() => undefined)
      return
    }
    session.value = res
    const ttl = Number(res.expires_in) > 0 ? Number(res.expires_in) : DEFAULT_TTL_S
    expiresAt.value = Date.now() + ttl * 1000
    pollErrors = 0
    schedule(mine)
  } catch (error) {
    if (mine === generation) fail(`没能开始授权 · ${errorReason(error)}`)
  } finally {
    if (mine === generation) starting.value = false
  }
}

function schedule(mine: number) {
  stopPolling()
  timer = setTimeout(() => void poll(mine), isDevice.value ? DEVICE_POLL_MS : BROWSER_POLL_MS)
}

async function poll(mine: number) {
  const state = session.value?.state
  if (!state || mine !== generation || step.value !== 'auth') return
  if (expiresAt.value && Date.now() > expiresAt.value) {
    cancelSession()
    fail(callbackSent.value ? '回调已提交，但网关在有效期内没完成授权 · 请重试' : '授权链接已过期 · 没有收到回调')
    return
  }
  try {
    const res = await api.getOAuthStatus(state)
    if (mine !== generation || step.value !== 'auth') return
    pollErrors = 0
    if (res.status === 'ok') {
      stopPolling()
      void confirmServerSide(mine)
      return
    }
    if (res.status === 'error') {
      fail(`授权没完成 · ${res.error || '上游返回失败'}`, String((res as { detail?: string }).detail ?? ''))
      return
    }
  } catch (error) {
    if (mine !== generation) return
    pollErrors += 1
    if (pollErrors >= 3) {
      fail(`连续 3 次查不到授权状态 · ${errorReason(error)}`)
      return
    }
  }
  schedule(mine)
}

async function submitCallback(fromClipboard = false) {
  const p = chosen.value
  const url = callbackUrl.value.trim()
  if (!p || !url || submitting.value) return
  submitting.value = true
  const mine = generation
  try {
    await api.submitOAuthCallback(p.id, url, session.value?.state)
    if (mine !== generation) return
    // the POST only hands the code to the gateway (CPA exchanges it asynchronously): keep polling the session,
    // which moves on to 服务端验证 on `ok` and shows the upstream error on `error`
    failText.value = ''
    viaClipboard.value = fromClipboard
    callbackSent.value = true
    pollErrors = 0
    schedule(mine)
  } catch (error) {
    if (mine === generation) failText.value = `回调没被接受 · ${errorReason(error)}`
  } finally {
    if (mine === generation) submitting.value = false
  }
}

async function confirmServerSide(mine: number) {
  const p = chosen.value
  if (!p) return
  if (finalized === mine) return
  finalized = mine
  session.value = null
  expiresAt.value = null
  step.value = 'verify'
  let found: VerifyResult = null
  // the gateway may need a moment to register the new credential file
  for (let attempt = 0; attempt < 3 && !found; attempt += 1) {
    if (attempt) await new Promise((r) => setTimeout(r, 1500))
    if (mine !== generation) return
    found = await props.verify(p.id).catch(() => null)
  }
  if (mine !== generation) return
  step.value = 'done'
  if (found && 'name' in found) {
    const exit = await applyExit(found.name)
    if (mine !== generation) return
    outcome.value = { text: `✓ 已加入 ${p.name} · ${masked.value ? maskEmail(found.email) : found.email}${exit.text}`, tone: exit.ok ? 'ok' : 'warn' }
    emit('done', found.name)
    if (exit.ok) closeTimer = setTimeout(() => (open.value = false), 1200)
  } else if (found) {
    outcome.value = { text: `✓ 已续期 · ${p.name} 账号重新授权完成`, tone: 'ok' }
    emit('done', null)
    closeTimer = setTimeout(() => (open.value = false), 1200)
  } else {
    outcome.value = { text: '◇ 授权已完成，但列表里还没看到新账号 · 稍后刷新再看', tone: 'warn' }
    emit('done', null)
  }
}

function retry() {
  const p = chosen.value
  reset()
  chosen.value = p
  step.value = 'auth'
}
function another() {
  reset()
  chosen.value = null
  step.value = 'pick'
  void nextTick(() => listEl.value?.querySelector<HTMLButtonElement>('button')?.focus())
}

/* arrow keys move through the service list; Enter / Space are the buttons' own */
const listEl = useTemplateRef<HTMLElement>('list')
function onListKey(event: KeyboardEvent) {
  if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
  const items = [...(listEl.value?.querySelectorAll<HTMLButtonElement>('button') ?? [])]
  const i = items.indexOf(document.activeElement as HTMLButtonElement)
  const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : event.key === 'ArrowDown' ? Math.min(items.length - 1, i + 1) : Math.max(0, i - 1)
  items[next]?.focus()
  event.preventDefault()
}

/* 导入凭据文件: CPA auth files (one JSON, or a ZIP of them) go straight to the gateway; same-name files are skipped */
const fileInput = useTemplateRef<HTMLInputElement>('file')
const importing = ref(false)
const imported = ref<{ text: string; tone: 'ok' | 'warn' | 'bad'; failures: string[] } | null>(null)
async function onFile(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (!file || importing.value) return
  importing.value = true
  imported.value = null
  try {
    const result = await api.uploadCredentials(file)
    const parts = [`${result.total} 个文件`, `新增 ${result.uploaded}`, result.skipped ? `已存在 ${result.skipped}` : '', result.failed ? `失败 ${result.failed}` : ''].filter(Boolean)
    imported.value = {
      text: parts.join(' · '),
      tone: result.failed ? (result.uploaded ? 'warn' : 'bad') : 'ok',
      failures: result.items.filter((item) => !item.ok).slice(0, 3).map((item) => `${item.name} · ${item.message ?? item.code ?? '失败'}`),
    }
    if (result.uploaded) emit('imported')
  } catch (error) {
    imported.value = { text: errorReason(error) || '导入失败', tone: 'bad', failures: [] }
  } finally {
    importing.value = false
  }
}

const riskText = computed(() => {
  const vendor = chosen.value?.vendor.split(' · ')[0] ?? '供应商'
  return `通过网关共享订阅账号可能违反 ${vendor} 的条款，账号有被风控或封禁的风险 · 控制台读额度按账号缓存限频，但转发多少请求取决于各 Key 的用量`
})
</script>

<template>
  <Sheet v-model="open" title="添加账号" height="92vh">
    <template v-if="reauthEmail" #head-extra><span class="acc-add__re num">重新授权 · {{ who }}</span></template>
    <ol class="acc-steps" aria-label="步骤">
      <li v-for="s in rail" :key="s.id" :class="`is-${s.state}`" :aria-current="s.state === 'now' ? 'step' : undefined">
        <span class="acc-steps__n num">{{ s.state === 'done' ? '✓' : s.n }}</span><span class="acc-steps__l">{{ s.label }}</span>
      </li>
    </ol>

    <!-- 01 选择服务 -->
    <div v-if="step === 'pick'" ref="list" class="acc-add__list" role="list" @keydown="onListKey">
      <div v-for="p in PROVIDERS" :key="p.id" role="listitem">
        <TxButton class="acc-add__svc" variant="ghost" block @click="choose(p)">
          <ProviderMark :provider="p.mark" :size="22" />
          <span class="acc-add__svc-n">{{ p.name }}</span>
          <span class="acc-add__svc-v">{{ p.vendor }}</span>
          <TxTag v-if="p.risk" size="sm" variant="outline" label="需风险确认" />
          <span class="acc-add__svc-f">{{ p.flow === 'device' ? '设备码' : '浏览器登录' }}</span>
          <Icon name="arrow" :size="14" />
        </TxButton>
      </div>
      <div v-if="!reauthEmail" role="listitem">
        <TxButton class="acc-add__svc" variant="ghost" block :disabled="importing" @click="fileInput?.click()">
          <Icon name="plus" :size="22" />
          <span class="acc-add__svc-n">导入凭据文件</span>
          <span class="acc-add__svc-v">CPA 凭据 JSON · 多个打包成 ZIP</span>
          <span class="acc-add__svc-f">{{ importing ? '导入中···' : '本地文件' }}</span>
          <Icon name="arrow" :size="14" />
        </TxButton>
        <input ref="file" class="acc-add__file" type="file" accept=".json,.zip,application/json,application/zip" @change="onFile">
      </div>
      <div v-if="imported" class="acc-add__imported" :role="imported.tone === 'ok' ? 'status' : 'alert'">
        <p :class="{ sig: imported.tone !== 'ok' }">{{ imported.tone === 'ok' ? '' : '◆ ' }}{{ imported.text }}</p>
        <p v-for="line in imported.failures" :key="line" class="acc-add__hint">{{ line }}</p>
      </div>
    </div>

    <template v-else-if="chosen">
      <div class="acc-add__who">
        <ProviderMark :provider="chosen.mark" :size="22" />
        <b>{{ chosen.name }}</b><span class="dim">{{ chosen.vendor }}</span>
        <span class="dim acc-add__flow">{{ flowLabel(chosen) }}</span>
      </div>

      <!-- 02 风险确认 -->
      <div v-if="step === 'risk'" class="acc-add__body">
        <p class="acc-add__risk"><span class="sig" aria-hidden="true">◆ </span>{{ riskText }}</p>
        <TxCheckbox v-model="accepted" class="acc-add__check" label="我了解风险，继续" />
        <div class="acc-add__btns">
          <TxButton variant="secondary" @click="another">返回</TxButton>
          <TxButton variant="primary" :disabled="!accepted" @click="step = 'auth'">继续</TxButton>
        </div>
      </div>

      <!-- 03 授权 -->
      <div v-else-if="step === 'auth'" class="acc-add__body">
        <template v-if="!session">
          <p class="acc-add__p">
            <template v-if="chosen.flow === 'device'">拿到设备码后到 {{ chosen.vendor.split(' · ')[1] ?? chosen.name }} 确认 · 网关每 5s 查一次结果</template>
            <template v-else>在浏览器里登录 {{ chosen.name }} · 网关收到回调后自动完成<template v-if="chosen.paste"> · 网关不在本机时把跳转后的地址粘回这里</template></template>
          </p>
          <div class="acc-add__btns">
            <TxButton variant="secondary" @click="another">换一个服务</TxButton>
            <TxButton variant="primary" :disabled="starting" @click="start">{{ starting ? '生成中···' : '开始授权' }}</TxButton>
          </div>
        </template>
        <template v-else>
          <div v-if="isDevice && userCode" class="acc-add__code" aria-label="设备码">
            <span v-for="(part, i) in codeChars" :key="i" class="acc-add__code-p"><template v-if="i">—</template><u v-for="(ch, j) in part" :key="j">{{ ch }}</u></span>
          </div>
          <div class="acc-add__btns acc-add__btns--start">
            <a class="ui-btn ui-btn--primary" :href="session.url" target="_blank" rel="noopener noreferrer">
              {{ isDevice ? `打开 ${authHost || '授权页'}` : '打开授权页' }} <Icon name="external" :size="14" />
            </a>
            <TxButton v-if="isDevice && userCode" variant="secondary" @click="copyText(userCode, '设备码')"><Icon name="copy" :size="14" />复制代码</TxButton>
            <TxButton v-else variant="secondary" @click="copyText(session.url, '授权链接')"><Icon name="copy" :size="14" />复制链接</TxButton>
          </div>
          <p v-if="isDevice && !userCode" class="acc-add__p dim">设备码已带在授权链接里 · 打开后确认即可</p>
          <p class="acc-add__wait" role="status">
            <StatusMark state="busy" :label="callbackSent ? `${viaClipboard ? '已从剪贴板提交' : '回调已提交'} · 等网关换取令牌` : isDevice ? '等待确认' : '等待回调'" />
            <span class="num">· {{ isDevice ? `每 ${DEVICE_POLL_MS / 1000}s 轮询 · ` : '' }}剩 {{ left === null ? '—' : fmtCountdownClock(left) }}</span>
          </p>
          <form v-if="chosen.paste" class="acc-add__paste" novalidate @submit.prevent="submitCallback()">
            <label for="acc-cb" class="acc-add__lbl">粘贴回调地址或授权码</label>
            <div class="acc-add__row">
              <input id="acc-cb" v-model="callbackUrl" class="ui-input mono" type="text" inputmode="url" autocomplete="off" spellcheck="false" :placeholder="pastePlaceholder" aria-describedby="acc-cb-hint">
              <TxButton variant="secondary" native-type="submit" :disabled="!callbackUrl.trim() || submitting">{{ submitting ? '提交中···' : '提交' }}</TxButton>
            </div>
            <p id="acc-cb-hint" class="acc-add__hint">浏览器跳到 localhost 打不开是正常的 · 复制地址栏的完整地址，或只复制 code= 后面的授权码</p>
            <div class="acc-add__btns acc-add__btns--start">
              <TxButton variant="secondary" :disabled="submitting || callbackSent" @click="pasteNow"><Icon name="copy" :size="14" />从剪贴板粘贴并提交</TxButton>
            </div>
            <p v-if="clipNote" class="acc-add__hint" role="status">{{ clipNote }}</p>
            <p v-if="failText" class="acc-add__err" role="alert">◆ {{ failText }}</p>
          </form>
          <div class="acc-add__btns">
            <TxButton variant="ghost" @click="another">取消</TxButton>
          </div>
        </template>
        <SigninEgress v-if="!reauthEmail" v-model="exitChoice" :egress="egress" :service="serviceOf(chosen.id)" />
      </div>

      <!-- 04 服务端验证 -->
      <div v-else-if="step === 'verify'" class="acc-add__body" role="status">
        <p class="acc-add__verify">验证中<span class="acc-dots" aria-hidden="true"><i>·</i><i>·</i><i>·</i></span></p>
        <p class="acc-add__hint">网关已收到授权 · 正在确认账号出现在账号池里</p>
      </div>

      <!-- 05 / 失败 -->
      <div v-else-if="step === 'done'" class="acc-add__body" role="status">
        <p class="acc-add__done" :class="{ sig: outcome?.tone === 'warn' }">{{ outcome?.text }}</p>
        <div v-if="outcome?.tone === 'warn'" class="acc-add__btns"><TxButton variant="secondary" @click="open = false">关闭</TxButton></div>
      </div>
      <div v-else-if="step === 'fail'" class="acc-add__body" role="alert">
        <p class="acc-add__err">◆ {{ failText }}</p>
        <details v-if="failDetail" class="acc-add__raw">
          <summary>原始错误</summary>
          <p class="mono">{{ failDetail }}</p>
        </details>
        <div class="acc-add__btns">
          <TxButton variant="secondary" @click="another">换一种方式</TxButton>
          <TxButton variant="primary" @click="retry">重试</TxButton>
        </div>
      </div>
    </template>

    <p class="acc-add__note">授权完成后由服务端核对再出现在列表 · 同一账号重复授权记为续期</p>
  </Sheet>
</template>

<style>
.acc-add__re { font-size: var(--fs-xs); color: var(--ink-2); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; }
.acc-steps { list-style: none; margin: 0 0 14px; padding: 0; display: flex; flex-wrap: wrap; gap: 6px 18px; font-size: var(--fs-xs); }
.acc-steps li { display: inline-flex; align-items: center; gap: 5px; color: var(--ink-3); white-space: nowrap; }
.acc-steps__n { font-family: var(--font-mono); }
.acc-steps li.is-now { color: var(--ink); font-weight: 600; }
.acc-steps li.is-now .acc-steps__l { box-shadow: inset 0 -2px 0 var(--signal); padding-bottom: 1px; }
.acc-steps li.is-done { color: var(--ink-2); }
.acc-steps li.is-fail { color: var(--signal-ink); font-weight: 600; }
.acc-add__list { display: grid; }
/* service rows: a ghost TxButton stretched into a 48px list row, text left-aligned, hairline between rows */
html:root .acc-add__svc.tx-button {
  height: auto; min-height: 48px; padding: 0 6px; justify-content: flex-start; text-align: left; color: var(--ink); font-weight: 400;
  border-radius: 0; border-width: 0 0 1px; border-color: var(--rule);
}
html:root .acc-add__svc .tx-button__inner { flex: 1 1 auto; min-width: 0; justify-content: flex-start; gap: 10px; }
html:root .acc-add__svc.tx-button:focus-visible { outline: 2px solid var(--signal); outline-offset: -2px; }
.acc-add__svc-n { font-weight: 600; font-size: var(--fs-row); white-space: nowrap; }
.acc-add__svc-v { font-size: var(--fs-xs); color: var(--ink-3); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; flex: 1 1 auto; }
.acc-add__svc-f { font-size: var(--fs-xs); color: var(--ink-2); white-space: nowrap; }
.acc-add__svc .ui-ico { color: var(--ink-3); }
.acc-add__who { display: flex; align-items: center; gap: 10px; min-height: 40px; flex-wrap: wrap; font-size: var(--fs-sm); }
.acc-add__who .dim { font-size: var(--fs-xs); }
.acc-add__flow { margin-left: auto; }
.acc-add__body { display: grid; gap: 14px; padding-top: 10px; }
.acc-add__p { margin: 0; font-size: var(--fs-sm); color: var(--ink-2); line-height: 1.6; }
.acc-add__risk { margin: 0; font-size: var(--fs-sm); color: var(--ink-2); line-height: 1.7; }
.acc-add__check { justify-self: start; min-height: 32px; }
.acc-add__btns { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 8px; }
.acc-add__btns--start { justify-content: flex-start; }
.acc-add__btns a.ui-btn { text-decoration: none; }
.acc-add__code { display: flex; align-items: center; gap: 4px; font-family: var(--font-mono); font-size: 34px; line-height: 46px; letter-spacing: .02em; color: var(--ink); }
.acc-add__code-p { display: inline-flex; gap: 6px; }
.acc-add__code u { text-decoration: none; border-bottom: 2px solid var(--ink); min-width: .7em; text-align: center; }
.acc-add__wait { margin: 0; display: flex; align-items: center; gap: 6px; font-size: var(--fs-xs); color: var(--ink-3); }
.acc-add__paste { display: grid; gap: 6px; padding-top: 6px; }
.acc-add__lbl { font-size: var(--fs-xs); color: var(--ink-2); font-weight: 600; }
.acc-add__row { display: flex; gap: 8px; min-width: 0; }
/* the one native field left (RR-8 pins `<input id="acc-cb">`): drawn like TxInput — no fill, one ctl hairline */
.acc-add__row .ui-input { flex: 1 1 auto; min-width: 0; font-size: var(--fs-xs); background: transparent; }
.acc-add__hint { margin: 0; font-size: var(--fs-xs); color: var(--ink-3); }
.acc-add__err { margin: 0; font-size: var(--fs-sm); color: var(--signal-ink); }
.acc-add__raw { font-size: var(--fs-xs); color: var(--ink-3); }
.acc-add__raw summary { cursor: pointer; width: max-content; }
.acc-add__raw p { margin: 6px 0 0; color: var(--ink-2); overflow-wrap: anywhere; max-height: 12em; overflow: auto; }
.acc-add__verify { margin: 0; font-family: var(--font-mono); font-size: var(--fs-md); color: var(--ink); }
.acc-add__done { margin: 0; font-size: var(--fs-md); color: var(--ink); }
.acc-dots i { font-style: normal; animation: acc-dot 1.2s steps(1) infinite; opacity: .2; }
.acc-dots i:nth-child(2) { animation-delay: .4s; }
.acc-dots i:nth-child(3) { animation-delay: .8s; }
@keyframes acc-dot { 0%, 66% { opacity: 1; } 67%, 100% { opacity: .2; } }
:root[data-motion="reduce"] .acc-dots i { animation: none; opacity: 1; }
.acc-add__note { margin: 24px 0 0; font-size: var(--fs-xs); color: var(--ink-3); }
.acc-add__file { display: none; }
.acc-add__imported { display: grid; gap: 4px; padding: 10px 6px 0; }
.acc-add__imported p { margin: 0; font-size: var(--fs-sm); color: var(--ink); }
@media (max-width: 599px) {
  .acc-add__svc-v { display: none; }
  .acc-add__svc { min-height: var(--tap); }
  .acc-add__svc-n { flex: 1 1 auto; }
  .acc-add__code { font-size: 28px; }
  .acc-add__row { flex-direction: column; }
  .acc-add__flow { margin-left: 0; flex-basis: 100%; }
}
</style>

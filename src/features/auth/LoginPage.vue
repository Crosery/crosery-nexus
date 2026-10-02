<script setup lang="ts">
import { computed, nextTick, onMounted, reactive, ref, useTemplateRef, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import LoginGlobe from '../../ui/login/LoginGlobe.vue'
import LoginPlate from '../../ui/login/LoginPlate.vue'
import { api } from '../../api'
import { announceAuthChange, loadSession, roleHome, safeNext, takeLoginNotice } from '../../app/session'
import { requestScan } from '../../lib/motion'
import { useCountdown } from '../../ui/composables/useNow'
import type { SessionRole } from '../../types'
import type { LoginMode } from '../../ui/types'
import { describeLoginError, lockError, lockSeconds, mainField, precheck, type FieldError, type LoginField, type LoginPayload } from './loginModel'

/**
 * /login (DESIGN §6.1, §3.4): the glyph globe and the plate. One endpoint, two credentials — admin
 * `{username,password}` or `{apiKey}` — and the role in the answer decides where the console opens.
 * - Errors stay inline under the field and clear as soon as the field is edited.
 * - 429: the server keeps one limiter per mode (key login by IP, admin by IP + username), so each mode has its own
 *   lock; the active one shows a live `00:42`, disables 登录, and is announced once.
 * - Success: `await globe.exit()` (the stage clears), replace to `next` or the role's home, then one scanline so the
 *   console prints onto the empty sheet.
 */
const router = useRouter()
const route = useRoute()
const page = useTemplateRef<HTMLElement>('page')
const globe = useTemplateRef<InstanceType<typeof LoginGlobe>>('globe')

const mode = ref<LoginMode>()
const busy = ref(false)
const error = ref<FieldError | null>(null)
const notice = ref<string | null>(takeLoginNotice())

type Lock = { until: number }
const locks = reactive<Record<LoginMode, Lock | null>>({ key: null, admin: null })
const lock = computed(() => (mode.value ? locks[mode.value] : null))
const countdown = useCountdown(() => lock.value?.until ?? null)
const locked = computed(() => lock.value !== null && countdown.msLeft.value > 0)
/** seconds left when the lock came into view: the announcement says it once, the visible clock keeps ticking */
const lockSpoken = ref(0)
const remember = () => (lockSpoken.value = Math.ceil(countdown.msLeft.value / 1000))
watch(countdown.done, (done) => {
  if (done && mode.value) locks[mode.value] = null
})
watch(mode, () => {
  error.value = null
  remember()
})

const plateError = computed<FieldError | null>(() =>
  locked.value && mode.value ? lockError(mode.value, countdown.msLeft.value, lockSpoken.value) : error.value,
)

/** typing into the flagged field is the fix; the lock is the server's and stays */
function onEdit() {
  if (error.value) error.value = null
}

const FIELD_SELECTOR: Record<LoginField, string> = { key: '.ui-lp__key input', username: '#ui-lp-user', password: '.ui-lp__pw input' }
function focusField(field: LoginField) {
  page.value?.querySelector<HTMLInputElement>(FIELD_SELECTOR[field])?.focus()
}

/** `next` only when this role may open it; otherwise the role's home. */
function destination(role: SessionRole): string {
  const next = safeNext(route.query.next)
  if (next) {
    const resolved = router.resolve(next)
    const needs = resolved.meta.role
    if (resolved.matched.length && !resolved.meta.home && !resolved.meta.public && (!needs || needs === role)) return resolved.fullPath
  }
  return roleHome(role)
}

/** fetch the destination's lazy route chunks while the globe exits, so the cleared sheet is not left empty */
function warm(path: string) {
  for (const record of router.resolve(path).matched) {
    for (const component of Object.values(record.components ?? {})) {
      // lazy loaders only (vue-router's own test): functional components carry props/displayName/__vccOpts
      if (typeof component !== 'function' || 'props' in component || 'displayName' in component || '__vccOpts' in component) continue
      try {
        const loading = (component as () => unknown)()
        if (loading instanceof Promise) loading.catch(() => undefined)
      } catch {
        /* the navigation itself reports a failed chunk */
      }
    }
  }
}

async function submit(payload: LoginPayload) {
  if (busy.value || locked.value) return
  const invalid = precheck(payload)
  if (invalid) {
    // Enter in the account field with no password yet: move on to the password instead of flagging it
    if (invalid.field === 'password' && document.activeElement?.id === 'ui-lp-user') return focusField('password')
    error.value = invalid
    return
  }
  busy.value = true
  error.value = null
  try {
    const result = payload.mode === 'key' ? await api.loginWithKey(payload.key ?? '') : await api.login(payload.username ?? '', payload.password ?? '')
    const current = await loadSession(true)
    if (!current.authenticated) {
      error.value = { field: mainField(payload.mode), text: '◆ 登录成功但会话没建立 · 检查浏览器 Cookie 后重试' }
      return
    }
    notice.value = null
    announceAuthChange()
    const target = destination(current.role ?? result.role)
    warm(target)
    await globe.value?.exit()
    try {
      await router.replace(target)
    } catch {
      // the stage has already cleared: a failed chunk load must not strand an empty sheet — the cookie is set
      window.location.assign(target)
      return
    }
    await nextTick()
    requestScan()
  } catch (err) {
    const sec = lockSeconds(err)
    if (sec !== null) {
      locks[payload.mode] = { until: Date.now() + sec * 1000 }
      lockSpoken.value = sec
    }
    else error.value = describeLoginError(err, payload.mode, payload.key)
  } finally {
    busy.value = false
  }
}

/* desktop: the cursor is already in the field that starts the job (the key; the password when admin is prefilled).
   Touch keeps the globe in view until the person taps a field. */
onMounted(() => {
  if (!window.matchMedia('(pointer: fine)').matches) return
  void nextTick(() => focusField(mode.value === 'admin' ? 'password' : 'key'))
})
</script>

<template>
  <main id="main" ref="page" class="login-page" aria-label="登录" @input="onEdit">
    <LoginGlobe ref="globe">
      <LoginPlate v-model:mode="mode" :busy="busy" :locked="locked" :error="plateError" :notice="notice" @submit="submit" />
    </LoginGlobe>
  </main>
</template>

<style scoped>
.login-page { display: block; }
</style>

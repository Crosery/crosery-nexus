import { onBeforeUnmount, ref, watch, type Ref } from 'vue'
import { readCallback, type CallbackExpect } from './pasteCallback'

/**
 * 「从剪贴板粘贴并提交」 and, while the sheet waits, two quiet paths: a paste anywhere on the page, and a look at the
 * clipboard on returning to the tab. The button submits this session's callback URL or a bare code; the quiet paths
 * submit only this session's URL (a bare code pasted into the box stays there for Enter). The look on return runs
 * only once the browser already lets the page read the clipboard (granted after the first button use), so coming
 * back never pops a permission prompt.
 */
export function useClipboardCallback(options: {
  /** waiting for the callback: a browser session with a paste box, nothing submitted yet */
  active: Readonly<Ref<boolean>>
  expect: () => CallbackExpect | null
  submit: (value: string) => void
}) {
  /** the button's answer when it found nothing to submit */
  const note = ref('')
  /** a callback already handed over is not read in again on the next return */
  let tried = ''

  async function granted(): Promise<boolean> {
    if (!navigator.clipboard?.readText || !navigator.permissions?.query) return false
    try {
      return (await navigator.permissions.query({ name: 'clipboard-read' as PermissionName })).state === 'granted'
    } catch {
      return false
    }
  }

  async function read(auto: boolean) {
    const before = options.expect()
    if (!options.active.value || !before) return
    if (auto && !(await granted())) return
    let text = ''
    try {
      text = await navigator.clipboard.readText()
    } catch {
      if (!auto) note.value = '浏览器没允许读取剪贴板 · 粘贴到输入框后按回车也可以'
      return
    }
    if (!options.active.value || options.expect()?.state !== before.state) return
    const found = readCallback(text, before)
    if (auto) {
      if (found?.kind !== 'url' || found.value === tried) return
    } else if (!found || found.kind === 'stale') {
      note.value = found ? '剪贴板里是另一次授权的回调 · 用这次打开的授权页登录后再复制' : '剪贴板里没有回调地址或授权码'
      return
    }
    tried = found.value
    note.value = ''
    options.submit(found.value)
  }

  function onReturn() {
    if (document.visibilityState === 'visible') void read(true)
  }

  function onPaste(event: ClipboardEvent) {
    if (!options.active.value) return
    const found = readCallback(event.clipboardData?.getData('text/plain') ?? '', options.expect())
    if (found?.kind !== 'url') return
    event.preventDefault()
    tried = found.value
    note.value = ''
    options.submit(found.value)
  }

  function listen(on: boolean) {
    if (on) {
      window.addEventListener('focus', onReturn)
      document.addEventListener('visibilitychange', onReturn)
      document.addEventListener('paste', onPaste)
    } else {
      window.removeEventListener('focus', onReturn)
      document.removeEventListener('visibilitychange', onReturn)
      document.removeEventListener('paste', onPaste)
    }
  }

  watch(options.active, (on, was) => {
    if (on === Boolean(was)) return
    note.value = ''
    listen(on)
  }, { immediate: true })
  onBeforeUnmount(() => listen(false))

  return { note, pasteNow: () => read(false) }
}

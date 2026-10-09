/**
 * What the add-account sheet's paste box can take from the clipboard (tested in server/pasteCallback.test.ts).
 * The gateway accepts the full localhost callback URL or the bare authorization code (POST /api/cpa/oauth/callback
 * fills in the session's state). Only this session's URL may be submitted without a click; a bare code or a
 * `code=…` fragment goes in through the button, and another session's callback is never sent.
 */

export type CallbackExpect = {
  /** the running session's state */
  state: string
  /** the authorize URL CPA handed out; its redirect_uri carries the port the browser lands on */
  authUrl?: string | null
  /** the provider's paste placeholder, a fallback for the port */
  placeholder?: string | null
}

/**
 * - `url`: this session's localhost callback (submitted on its own when read on returning to the tab)
 * - `code`: a bare authorization code or a `code=…` fragment (submitted only from the button)
 * - `stale`: a callback that belongs to another session or port
 */
export type ClipboardCallback = { kind: 'url' | 'code'; value: string } | { kind: 'stale' } | null

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]'])

function loopbackPort(raw: string | null | undefined): string {
  try {
    const url = new URL(String(raw ?? ''))
    return url.protocol === 'http:' && LOOPBACK.has(url.hostname) ? url.port : ''
  } catch {
    return ''
  }
}

/** The port this session's redirect lands on: redirect_uri in the authorize URL, else the placeholder's; '' = any. */
export function callbackPort(expect: CallbackExpect): string {
  let redirect = ''
  try {
    redirect = new URL(String(expect.authUrl ?? '')).searchParams.get('redirect_uri') ?? ''
  } catch {
    redirect = ''
  }
  return loopbackPort(redirect) || loopbackPort(expect.placeholder)
}

/** Bare codes: OpenAI `ac_…`, Google `4/0A…`, Claude `code#state`; one token of URL-safe characters. */
const BARE_CODE = /^[A-Za-z0-9._~+/=%#-]{10,2048}$/
/** an API key left on the clipboard is not sent to a token endpoint as a code */
const API_KEY = /^(sk-|sk_|xai-|AIza|ghp_|github_pat_)/

export function readCallback(text: unknown, expect: CallbackExpect | null | undefined): ClipboardCallback {
  if (typeof text !== 'string' || !expect?.state) return null
  const raw = text.trim()
  if (!raw || raw.length > 4096 || /\s/.test(raw)) return null
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) {
    let url: URL
    try {
      url = new URL(raw)
    } catch {
      return null
    }
    const fragment = new URLSearchParams(url.hash.replace(/^#/, ''))
    const code = url.searchParams.get('code') || fragment.get('code')
    if (url.protocol !== 'http:' || !LOOPBACK.has(url.hostname) || !code) return null
    const state = url.searchParams.get('state') ?? fragment.get('state')
    const port = callbackPort(expect)
    if (!url.port || (port && url.port !== port) || state !== expect.state) return { kind: 'stale' }
    return { kind: 'url', value: raw }
  }
  if (/(^|[?#&])code=/.test(raw)) {
    const params = new URLSearchParams(raw.replace(/^[?#]/, ''))
    const state = params.get('state')
    if (!params.get('code')) return null
    return state && state !== expect.state ? { kind: 'stale' } : { kind: 'code', value: raw }
  }
  return BARE_CODE.test(raw) && !API_KEY.test(raw) ? { kind: 'code', value: raw } : null
}

/**
 * Per-account exit as its owner knows it, shared by the expanded row, the mobile detail sheet and the Magpie exit
 * sheet. Filled by the authoritative read (GET /api/proxies/egress/account: CPA's copy of the credential, reduced
 * to a masked value and a pool entry id server-side — the URL never reaches the browser) when a detail opens, and
 * again after each write; a newer read always wins over an older one still in flight. Every settled value is a new
 * object, so a picker watching `proxyRead(ref)` re-syncs to the server on each answer (also after a failed write).
 */
import { reactive } from 'vue'
import { proxyApi } from '../../api/proxy'
import type { EgressRead } from '../../types'
import type { ProxyRead } from './model'

type Entry = { read: ProxyRead; seq: number }

const entries = reactive<Record<string, Entry>>({})
const LOADING: ProxyRead = { state: 'loading' }
let counter = 0

/** a CPA credential name (the CPA page's key) or a pool account ref (`cpa:…`, `magpie:<agent>:<user>`) */
const refOf = (key: string) => (key.startsWith('cpa:') || key.startsWith('magpie:') ? key : `cpa:${key}`)

export function proxyRead(key: string): ProxyRead {
  return entries[refOf(key)]?.read ?? LOADING
}

/** Re-read the value; the last known value stays on screen while the read is in flight. */
export async function readProxy(key: string, provider?: string): Promise<void> {
  const ref = refOf(key)
  const mine = ++counter
  entries[ref] = { read: entries[ref]?.read ?? LOADING, seq: mine }
  let read: ProxyRead
  try {
    read = { state: 'ready', value: await proxyApi.egressAccount(ref, provider) }
  } catch {
    read = { state: 'error' }
  }
  if (entries[ref]?.seq === mine) entries[ref] = { read, seq: mine }
}

/** The value read right after a write; drops any older read still in flight. */
export function knowProxy(key: string, value: EgressRead): void {
  entries[refOf(key)] = { read: { state: 'ready', value }, seq: ++counter }
}

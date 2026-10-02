/**
 * Live facts for the admin chrome (statusline, ticker, header live edge, mobile sync chip, palette sync
 * actions). Each source keeps its own cadence and pauses while the tab is hidden (useLive):
 * - /api/pulse     2s   header trace + 网关 rpm · p95 · 成功率 (the trace redraws once per sample)
 * - /api/sync/status 30s sync squares, backoff text, 立即同步 cooldowns
 * - /api/rtk/global  60s `RTK 开/关`
 * - /api/version     5m  `magpie 3fe2ff9`
 * None of these reach an upstream: they read console state only.
 */
import { computed, inject, provide, ref, watch, type InjectionKey } from 'vue'
import { api } from '../api'
import { errorStatus } from '../lib/errors'
import { useLive } from '../ui/composables/useLive'
import type { PulseData, RtkGlobalStatus, SyncJob, SyncStatus, VersionsData } from '../types'
import type { ShellStatus, TraceSample } from '../ui/types'
import { chipDetail, chipState, kernelWord, syncWords } from './statusModel'

export const PULSE_MS = 2_000
const SYNC_MS = 30_000
const RTK_MS = 60_000
const VERSION_MS = 5 * 60_000

/** The shell's sources, handed to pages (概览, 设置) so they read the same polls instead of starting their own. */
export type AdminLive = {
  pulse: ReturnType<typeof useLive<PulseData>>
  sync: ReturnType<typeof useLive<SyncStatus>>
  rtk: ReturnType<typeof useLive<RtkGlobalStatus>>
  versions: ReturnType<typeof useLive<VersionsData>>
}
export const ADMIN_LIVE: InjectionKey<AdminLive> = Symbol('admin-live')
/** Inside AdminShell: the shared sources (a page write → `refresh()` also updates the statusline); else null. */
export function useSharedAdminLive(): AdminLive | null {
  return inject(ADMIN_LIVE, null)
}

export function useAdminStatus() {
  /** false once the server answered 404 (older server without the pulse route): stop asking. */
  const pulseAvailable = ref(true)
  const pulse = useLive<PulseData>((signal) => api.pulse(signal), { intervalMs: PULSE_MS, enabled: () => pulseAvailable.value })
  const sync = useLive<SyncStatus>((signal) => api.sync.status(signal), { intervalMs: SYNC_MS })
  const rtk = useLive<RtkGlobalStatus>((signal) => api.rtkGlobal.get(signal), { intervalMs: RTK_MS })
  const versions = useLive<VersionsData>(() => api.version(), { intervalMs: VERSION_MS })
  provide(ADMIN_LIVE, { pulse, sync, rtk, versions })

  watch(pulse.error, (err) => {
    if (err && errorStatus(err) === 404) pulseAvailable.value = false
  })
  const pulseMissing = computed(() => !pulseAvailable.value)

  const samples = computed<TraceSample[]>(() =>
    pulseMissing.value ? [] : (pulse.data.value?.samples ?? []).map((s) => ({ t: s.t, rps: s.rps, err: s.err })),
  )
  const traceStale = computed(() => pulse.state.value === 'stale' || pulse.state.value === 'error')

  const jobs = computed<SyncJob[]>(() => sync.data.value?.jobs ?? [])

  const status = computed<ShellStatus>(() => {
    const now = Date.now()
    const p = pulse.data.value
    return {
      gateway: pulseMissing.value || !p ? null : { rpm: p.rpm, p95Ms: p.p95Ms, successRate: p.successRate, stale: traceStale.value },
      sync: jobs.value.length ? jobs.value.map((job) => ({ id: job.id, label: job.label, state: chipState(job), detail: chipDetail(job, now) })) : null,
      syncText: syncWords(jobs.value, now),
      kernel: kernelWord(versions.data.value),
      rtk: rtk.data.value ? rtk.data.value.on : null,
    }
  })

  /** jobs in backoff or failing: the 更多 / 设置 badge */
  const syncAttention = computed(() => jobs.value.filter((job) => ['backoff', 'failed'].includes(chipState(job))).length)

  return { status, samples, traceStale, jobs, syncAttention, refreshSync: sync.refresh, refreshRtk: rtk.refresh }
}

/**
 * Pure mapping from server state to the chrome's words and marks (statusline, ticker, sync chip).
 * Structural input types and `.js` specifiers keep it importable by `server/appShell.test.ts`.
 */
import { fmtTime } from '../ui/fmt.js'

export type ChipState = 'ok' | 'running' | 'backoff' | 'failed' | 'idle'

/** The subset of a C3 sync job these helpers read. */
export type JobLike = {
  label: string
  state: string
  lastResult: string | null
  nextRunAt: string | null
  backoffUntil: string | null
  summary: string | null
  lastError: string | null
}

export type VersionsLike = { cpa?: { engine?: string; version?: string; commit?: string } | null } | null | undefined

export function chipState(job: JobLike): ChipState {
  if (job.state === 'running') return 'running'
  if (job.state === 'backoff') return 'backoff'
  if (job.state === 'error' || job.lastResult === 'error') return 'failed'
  if (job.state === 'disabled' || job.state === 'unknown' || job.lastResult === null) return 'idle'
  return 'ok'
}

const STATE_WORD: Record<ChipState, string> = { ok: '正常', running: '同步中', backoff: '退避', failed: '失败', idle: '空闲' }

export function chipDetail(job: JobLike, now: number): string {
  const parts: string[] = []
  if (job.state === 'backoff' && job.backoffUntil) parts.push(`退避至 ${fmtTime(job.backoffUntil, now)}`)
  else if (job.nextRunAt) parts.push(`下次 ${fmtTime(job.nextRunAt, now)}`)
  if (job.summary) parts.push(job.summary)
  if (job.lastError) parts.push(`上次错误 ${job.lastError}`)
  return parts.join(' · ')
}

/** Only jobs that need a look get words in the statusline (`价格元数据 退避 → 16:00`); healthy is silent. */
export function syncWords(jobs: JobLike[], now: number): string | null {
  const words = jobs
    .map((job) => ({ job, state: chipState(job) }))
    .filter(({ state }) => state === 'backoff' || state === 'running' || state === 'failed')
    .map(({ job, state }) => (state === 'backoff' && job.backoffUntil ? `${job.label} 退避 → ${fmtTime(job.backoffUntil, now)}` : `${job.label} ${STATE_WORD[state]}`))
  return words.length ? words.join(' · ') : null
}

export function kernelWord(versions: VersionsLike): string | null {
  const cpa = versions?.cpa
  if (!cpa) return null
  const engine = cpa.engine === 'magpie' ? 'magpie' : 'cpa'
  if (cpa.version === 'offline') return `${engine} 离线`
  const ref = cpa.commit && cpa.commit !== 'unknown' ? cpa.commit.slice(0, 7) : cpa.version
  return ref ? `${engine} ${ref}` : engine
}

/**
 * Account reset outcomes → toast copy (DESIGN.md §6.5 "Outcome toasts"). Pure so it is unit-tested
 * (server/uiKitModel.test.ts); `showResetOutcome` is the one-liner pages call after the reset request.
 */
import { fmtCountdownClock } from '../composables/useNow.js'
import { fmtTime } from '../fmt.js'

export type ResetOutcome =
  | 'ok'
  | 'partial'
  | 'no_window'
  | 'no_credit'
  | 'redeemed'
  | 'cooldown'
  | 'unsupported'
  | 'unavailable'
  | 'unknown'

export type ResetOutcomeContext = {
  /** credits left after this reset */
  remaining?: number | null
  /** partial: when the gateway cooldown lifts by itself */
  recoverAt?: string | number | Date | null
  /** cooldown: ms until another reset may be tried */
  retryInMs?: number | null
}

/** Same values as toast.ts NoticeTone (kept local so this module stays importable from node tests). */
export type ResetTone = 'ok' | 'note' | 'warn' | 'bad'

export function describeResetOutcome(outcome: ResetOutcome, ctx: ResetOutcomeContext = {}): { title: string; tone: ResetTone } {
  switch (outcome) {
    case 'ok':
      return { title: `✓ 已重置${ctx.remaining != null ? ` · 剩 ${ctx.remaining} 次` : ''}`, tone: 'ok' }
    case 'partial':
      return { title: `◇ 额度已重置，但网关冷却未清除${ctx.recoverAt ? ` · 约 ${fmtTime(ctx.recoverAt)} 后自动恢复` : ''}`, tone: 'warn' }
    case 'no_window':
      return { title: '— 当前没有可重置的窗口', tone: 'note' }
    case 'no_credit':
      return { title: '— 没有可用的重置次数', tone: 'note' }
    case 'redeemed':
      return { title: '— 这次重置已被使用', tone: 'note' }
    case 'cooldown':
      return { title: `◇ 重置冷却中${ctx.retryInMs != null ? ` · ${fmtCountdownClock(ctx.retryInMs)} 后可再试` : ''}`, tone: 'warn' }
    case 'unsupported':
      return { title: '— 该服务不支持重置', tone: 'note' }
    case 'unavailable':
      return { title: '◆ 重置接口不可用 · 稍后再试', tone: 'bad' }
    default:
      return { title: '◇ 结果未知 · 不会自动重试 · 3 分钟后刷新额度确认', tone: 'warn' }
  }
}

/* ── confirm sheet content (DESIGN.md §6.5 "Reset confirm") ─────────────────────────────────────── */

export type ResetConfirmInput = {
  /** account email as shown (pass it pre-masked when the privacy mask is on) */
  account: string
  /** "Codex · Pro" */
  service: string
  /** 1-based index of the credit that will be used (earliest expiry) */
  creditIndex: number
  creditExpiresAt?: string | number | Date | null
  /** credits before this reset */
  creditsBefore: number
  /** affected windows, e.g. ["5h"] */
  windows?: string[]
  /** the reset also tries to clear the gateway cooldown */
  clearsCooldown?: boolean
}

export type ResetConfirmContent = {
  title: string
  facts: Array<{ k: string; v: string }>
  consequence: string
  confirmText: string
  cancelText: string
}

/** Truncate the domain first: `zhang.wei.ops+codex-team@…`. */
function shortAccount(email: string): string {
  const at = email.indexOf('@')
  return at > 0 ? `${email.slice(0, at)}@…` : email
}

export function buildResetConfirm(input: ResetConfirmInput): ResetConfirmContent {
  const effects = [
    ...(input.windows?.length ? [`${input.windows.join(' / ')} 窗口归零`] : ['窗口归零']),
    ...(input.clearsCooldown === false ? [] : ['会尝试清除网关冷却']),
  ]
  const expiry = input.creditExpiresAt ? ` · ${fmtTime(input.creditExpiresAt, 0)} 过期` : ''
  return {
    title: '用 1 次重置？',
    facts: [
      { k: '账号', v: shortAccount(input.account) },
      { k: '服务', v: input.service },
      { k: '将使用', v: `第 ${input.creditIndex} 次${expiry}` },
      { k: '剩余', v: `${input.creditsBefore} → ${Math.max(0, input.creditsBefore - 1)} 次` },
      { k: '影响', v: effects.join(' · ') },
    ],
    consequence: '不可撤销',
    confirmText: '使用 1 次重置',
    cancelText: '取消',
  }
}

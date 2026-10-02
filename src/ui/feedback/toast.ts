/**
 * Toast helpers over tuffex's toast store (styled by styles/tx/toast.css, motion recipe 10).
 * Tone decides the variant and the lifetime: ok / note 2.6s, warn 5.2s (signal edge), bad stays until
 * dismissed (signal edge). Titles carry their own mark (✓ ◇ ◆ —) so meaning never rides on colour alone.
 */
import { toast } from '@talex-touch/tuffex/utils'
import { describeResetOutcome, type ResetOutcome, type ResetOutcomeContext } from './resetOutcome'

export type NoticeTone = 'ok' | 'note' | 'warn' | 'bad'

const VARIANT = { ok: 'default', note: 'default', warn: 'warning', bad: 'danger' } as const
const DURATION: Record<NoticeTone, number> = { ok: 2600, note: 2600, warn: 5200, bad: 0 }

export type NoticeOptions = {
  tone?: NoticeTone
  description?: string
  /** override the tone's lifetime (ms); 0 = stays until dismissed */
  duration?: number
  action?: { label: string; onClick?: (id: string) => void; dismiss?: boolean }
  /** replaces an existing toast with the same id instead of stacking */
  id?: string
}

export function notify(title: string, options: NoticeOptions = {}): string {
  const tone = options.tone ?? 'ok'
  return toast({
    id: options.id,
    title,
    description: options.description,
    variant: VARIANT[tone],
    duration: options.duration ?? DURATION[tone],
    action: options.action,
  })
}

function legacyCopy(text: string): boolean {
  if (typeof document === 'undefined') return false
  const area = document.createElement('textarea')
  area.value = text
  area.setAttribute('readonly', '')
  area.style.position = 'fixed'
  area.style.opacity = '0'
  document.body.appendChild(area)
  area.select()
  let ok = false
  try {
    ok = document.execCommand('copy')
  } catch {
    ok = false
  }
  area.remove()
  return ok
}

/** Copy to the clipboard and confirm with `已复制` (+ what, when given). Never echoes secrets: pass `what`. */
export async function copyText(text: string, what?: string): Promise<boolean> {
  let ok = false
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard && globalThis.isSecureContext !== false) {
      await navigator.clipboard.writeText(text)
      ok = true
    }
  } catch {
    ok = false
  }
  if (!ok) ok = legacyCopy(text)
  notify(ok ? `已复制${what ? ` ${what}` : ''}` : '◆ 复制失败 · 请手动选择复制', { tone: ok ? 'ok' : 'warn', id: 'cx-copy' })
  return ok
}

/** Account reset result → the DESIGN §6.5 toast for that outcome. */
export function showResetOutcome(outcome: ResetOutcome, ctx: ResetOutcomeContext = {}): string {
  const { title, tone } = describeResetOutcome(outcome, ctx)
  return notify(title, { tone, id: 'cx-reset' })
}

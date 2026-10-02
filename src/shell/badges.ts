/**
 * Attention counts on the rail (`账号³`), the tab bar badges and the 更多 sheet. Pages that already hold the
 * data publish the count; the shell never polls an endpoint just to draw a badge (e.g. /api/monitor would
 * trigger upstream quota reads).
 */
import { reactive } from 'vue'

const counts = reactive<Record<string, number>>({})

export const navCounts: Readonly<Record<string, number>> = counts

/** `id` = nav id (`accounts`, `channels`, `settings` …); 0 or null hides the count. */
export function setNavCount(id: string, value: number | null | undefined) {
  if (!value || value < 0) delete counts[id]
  else counts[id] = Math.round(value)
}

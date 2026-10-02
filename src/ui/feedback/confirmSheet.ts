/**
 * ConfirmSheet API (DESIGN.md §5.2 feedback/ConfirmSheet) on top of the existing `lib/confirm.ts` store:
 * the same single global host (`src/ui/feedback/ConfirmHost.vue`), the same `await → boolean` contract,
 * plus a facts table and a one-line consequence. Plain `confirm()` calls keep working and render the same.
 */
import { confirm, type ConfirmOptions } from '../../lib/confirm'

export type ConfirmFact = { k: string; v: string }

export type ConfirmSheetOptions = ConfirmOptions & {
  /** label / value rows, e.g. { k: '剩余', v: '2 → 1 次' } */
  facts?: ConfirmFact[]
  /** irreversible consequence, shown with a signal ◆, e.g. '不可撤销' */
  consequence?: string
}

export function confirmSheet(options: ConfirmSheetOptions): Promise<boolean> {
  const payload: ConfirmOptions = options
  return confirm(payload)
}

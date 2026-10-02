/**
 * ResetConfirm (DESIGN.md §5.2 feedback/ResetConfirm): the reset ConfirmSheet as one call.
 *   if (await confirmReset({...})) showResetOutcome(await api.reset(id), ctx)
 * Confirm is ink primary (not danger): resetting is the intended action, orange is not a button colour.
 */
import { confirmSheet } from './confirmSheet'
import { buildResetConfirm, type ResetConfirmInput } from './resetOutcome'

export function confirmReset(input: ResetConfirmInput): Promise<boolean> {
  return confirmSheet({ ...buildResetConfirm(input), danger: false })
}

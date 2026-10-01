/**
 * 危险操作前的确认。
 *
 * 对照参考实现 `geek_main/app/console/src/lib/confirm.ts:1-27`：全局只有一个确认框
 * （`src/components/ConfirmHost.vue`，挂在 App.vue），调用方 `await confirm({...})` 拿布尔结果，
 * 页面里不再各写一份 `showXxxConfirm` + TxModal。
 */
import { reactive } from 'vue'

export type ConfirmOptions = {
  title: string
  /** 一句话说清后果（建议写「删掉之后会怎样」）。 */
  body?: string
  confirmText?: string
  cancelText?: string
  /** 破坏性操作置 true：确认按钮变红，初始焦点落在「取消」。 */
  danger?: boolean
}

export const confirmState = reactive({
  open: false,
  options: { title: '' } as ConfirmOptions,
  resolve: null as ((ok: boolean) => void) | null,
})

export function confirm(options: ConfirmOptions): Promise<boolean> {
  // 上一个还没答复就被新的替换时，按「取消」结束它，不让调用方永远挂起。
  confirmState.resolve?.(false)
  return new Promise<boolean>((resolve) => {
    confirmState.options = options
    confirmState.resolve = resolve
    confirmState.open = true
  })
}

export function settleConfirm(ok: boolean) {
  const resolve = confirmState.resolve
  confirmState.resolve = null
  confirmState.open = false
  resolve?.(ok)
}

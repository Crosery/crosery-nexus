/**
 * 弹窗打开后的焦点落点。
 *
 * 背景：Tuffex 的 `TxModal`（`node_modules/@talex-touch/tuffex/dist/es/modal/src/TxModal2.vue.js:39-58`）
 * 在挂载后的 `nextTick` 里把焦点放在遮罩（`tabindex="-1"`）上做焦点陷阱。于是「打开弹窗后立刻
 * `nextTick` 再 focus 输入框」会被遮罩后发制人地抢走（本项目实测：活动元素始终是
 * `DIV.tx-modal__overlay`，键盘用户要 Tab 穿过遮罩才能进表单）。
 *
 * 这里等两轮 `nextTick` 越过遮罩的自动 focus，再补两次确认，确保焦点真的落在内容区。
 */
import { nextTick } from 'vue'

type FocusTarget = HTMLElement | { focus?: () => void } | null | undefined

const activeElement = (): HTMLElement | null =>
  typeof document === 'undefined' ? null : (document.activeElement as HTMLElement | null)

/** 焦点是否还停在遮罩上（或跑到了 body）。 */
export function isModalOverlayFocused(): boolean {
  const el = activeElement()
  if (!el || el === document.body) return true
  return el.classList.contains('tx-modal__overlay')
}

function applyFocus(target: FocusTarget, selector?: string): boolean {
  const direct = target && typeof target === 'object' && 'focus' in target ? (target as { focus?: () => void }) : undefined
  if (direct?.focus) {
    direct.focus()
    if (!isModalOverlayFocused()) return true
  }
  if (selector) {
    const el = document.querySelector<HTMLElement>(selector)
    if (el?.focus) {
      el.focus()
      if (!isModalOverlayFocused()) return true
    }
  }
  return false
}

/**
 * 把焦点送进刚打开的弹窗。
 * @param target 组件实例（暴露 `focus()`）或 DOM 元素
 * @param selector 兜底选择器，例如 `.tx-modal__overlay input`
 */
export async function focusInModal(target: FocusTarget, selector?: string): Promise<boolean> {
  await nextTick()
  await nextTick()
  if (applyFocus(target, selector)) return true
  for (const delay of [120, 260]) {
    await new Promise((resolve) => setTimeout(resolve, delay))
    if (!isModalOverlayFocused()) return true
    if (applyFocus(target, selector)) return true
  }
  return false
}

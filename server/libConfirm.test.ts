import assert from 'node:assert/strict'
import test from 'node:test'
import { clearConfirmTrigger, confirm, confirmState, getConfirmTrigger, settleConfirm } from '../src/lib/confirm.js'

/**
 * `confirm()` 是全局唯一确认框的调用约定（`src/components/ConfirmHost.vue` 渲染它）。
 * 这里测的是**行为**：调用方永远不会挂起。
 *
 * 不需要 DOM：`confirm()` 里的 `document.activeElement` 有 `typeof document !== 'undefined'` 保护。
 */

test('settleConfirm 只 resolve 一次，重复 settle 不会再触发', async () => {
  const first = confirm({ title: '删除渠道', danger: true })
  assert.equal(confirmState.open, true)
  assert.equal(confirmState.options.title, '删除渠道')

  settleConfirm(true)
  assert.equal(confirmState.open, false, 'settle 后应关闭')
  assert.equal(confirmState.resolve, null, 'resolve 槽必须清空，避免悬挂的调用方被二次唤醒')
  assert.equal(await first, true)

  // 再 settle 一次：没有悬挂的 resolve，也不能抛错
  settleConfirm(false)
  assert.equal(confirmState.open, false)
  assert.equal(await first, true, '第二次 settle 不得改变已结算的结果')
})

test('新的 confirm 到达时，把上一个按「取消」结束（调用方不会永远挂起）', async () => {
  const first = confirm({ title: '第一个确认' })
  const second = confirm({ title: '第二个确认' })

  assert.equal(await first, false, '被替换的确认必须按 false 结束')
  assert.equal(confirmState.options.title, '第二个确认')
  assert.equal(confirmState.open, true)

  settleConfirm(true)
  assert.equal(await second, true)
  assert.equal(confirmState.open, false)
})

test('confirm 返回的 Promise 只在 settle 之后结算（不提前 resolve）', async () => {
  let settled = false
  const pending = confirm({ title: '等答复' }).then((value) => {
    settled = true
    return value
  })

  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.equal(settled, false, '没有人点按钮时不能提前结算')

  settleConfirm(false)
  assert.equal(await pending, false)
})

test('触发元素在 confirm 调用点被记录，并可被清空（ConfirmHost 归还焦点用）', async () => {
  // 无 DOM 环境：应当记成 null 而不是抛错
  const promise = confirm({ title: '无 DOM 环境' })
  assert.equal(getConfirmTrigger(), null)
  clearConfirmTrigger()
  assert.equal(getConfirmTrigger(), null)
  settleConfirm(false)
  assert.equal(await promise, false)
})

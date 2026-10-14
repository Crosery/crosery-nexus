import { onBeforeUnmount, watch, type Ref } from 'vue'

/**
 * 弹层打开时锁住页面滚动：TxModal / TxDrawer 自己不锁，页面一长（正式环境的供应商页），
 * 在弹层上滚轮 / 滑动就会带着后面的整页一起动。多个弹层叠着时按计数：最后一个关了才放开。
 * 滚动条消失会让页面变宽，用右侧 padding 补回去，避免抖一下。
 */
let locks = 0
let saved: { overflow: string; paddingRight: string } | null = null

function lock() {
  if (locks++ > 0) return
  const root = document.documentElement
  saved = { overflow: root.style.overflow, paddingRight: root.style.paddingRight }
  const gap = window.innerWidth - root.clientWidth
  if (gap > 0) root.style.paddingRight = `${gap}px`
  root.style.overflow = 'hidden'
}

function unlock() {
  if (locks === 0 || --locks > 0) return
  const root = document.documentElement
  root.style.overflow = saved?.overflow ?? ''
  root.style.paddingRight = saved?.paddingRight ?? ''
  saved = null
}

export function useBodyScrollLock(open: Ref<boolean>) {
  let held = false
  const sync = (value: boolean) => {
    if (value && !held) { lock(); held = true } else if (!value && held) { unlock(); held = false }
  }
  watch(open, sync, { immediate: true })
  onBeforeUnmount(() => sync(false))
}

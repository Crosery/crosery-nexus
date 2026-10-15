import { onScopeDispose, ref } from 'vue'
import { api } from '../../api'
import type { RestartTarget } from '../../api/plugins'
import { errorMessage } from '../../lib/errors'
import { confirmSheet } from '../../ui/feedback/confirmSheet'
import { notify } from '../../ui/feedback/toast'

const COPY: Record<RestartTarget, { label: string; body: string }> = {
  cpa: { label: 'CPA 网关', body: '正在进行的请求会被中断，几秒后恢复；已安装的插件会在重启后加载。' },
  console: { label: '控制台', body: '页面会断开几秒，之后刷新即可；API 请求不受影响。' },
}
const GIVE_UP_MS = 90_000

/** 确认 → 提交重启请求 → 轮询执行器写回的结果。控制台自己重启时轮询会短暂失败，照常继续等。 */
export function useServiceRestart(target: RestartTarget, onDone?: () => void) {
  const restarting = ref(false)
  let timer: ReturnType<typeof setTimeout> | undefined
  const { label, body } = COPY[target]
  onScopeDispose(() => clearTimeout(timer))

  function poll(since: number) {
    timer = setTimeout(async () => {
      try {
        const state = (await api.restart.status())[target]
        if (state && !state.pending && state.finishedAt && Date.parse(state.finishedAt) >= since - 5000) {
          restarting.value = false
          if (state.result === 'ok') { notify(`✓ ${label}已重启`); onDone?.() }
          else notify(`◆ ${label}重启失败 · ${state.message || '未知原因'}`, { tone: 'bad' })
          return
        }
      } catch { /* 暂时连不上 */ }
      if (Date.now() - since < GIVE_UP_MS) poll(since)
      else { restarting.value = false; notify(`◆ 90 秒内没有收到${label}的重启结果，请到服务器上确认`, { tone: 'warn' }) }
    }, 2500)
  }

  async function restart() {
    if (restarting.value) return
    const ok = await confirmSheet({ title: `重启${label}？`, body, confirmText: '重启', danger: true })
    if (!ok) return
    restarting.value = true
    try {
      await api.restart.restart(target)
      poll(Date.now())
    } catch (error) {
      restarting.value = false
      notify(`◆ 重启失败 · ${errorMessage(error) || '请求失败'}`, { tone: 'bad' })
    }
  }
  return { restarting, restart }
}

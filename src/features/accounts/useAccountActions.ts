/**
 * Row writes, shared by the desktop row, the expanded band and the mobile detail sheet. All of them go through
 * the existing endpoints (PATCH/DELETE /api/credentials/:name, …/proxy, POST /api/accounts/:i/reset-*-quota);
 * an exit picked from the proxy pool goes through POST /api/proxies/assign (same credential writer underneath,
 * plus the previous value for undo and the link by entry id, so editing the entry later re-applies). Every one
 * asks before it changes routing in a way that cannot be taken back or that empties a provider.
 */
import { reactive } from 'vue'
import { api } from '../../api'
import { ApiError } from '../../api/http'
import { describeError } from '../../lib/errors'
import { maskEmail, useMask } from '../../lib/privacy'
import { confirmSheet } from '../../ui/feedback/confirmSheet'
import { confirmReset } from '../../ui/feedback/resetConfirm'
import { notify, showResetOutcome } from '../../ui/feedback/toast'
import type { EgressData, ProxyPreset } from '../../types'
import { classifyResetError, classifyResetSuccess, shortEmail, type AccountView, type ProviderGroup } from './model'
import { choiceName, cpaRef, egressWarning, egressWrite, readLabel, serviceOf } from './egressModel'
import { knowProxy, readProxy } from './proxyStore'

/** The page's pool view and presets, for the exit picker's writes (null data: the pool routes are not there). */
export type EgressContext = () => { data: EgressData | null; presets: ProxyPreset[]; reload: () => void }

export function useAccountActions(refresh: () => Promise<void> | void, egress?: EgressContext) {
  const busy = reactive<Record<string, string>>({})
  const { on: masked } = useMask()
  const who = (row: AccountView) => (masked.value ? maskEmail(row.email) : shortEmail(row.email))
  const service = (row: AccountView) => [row.provider?.name ?? row.type, row.plan].filter(Boolean).join(' · ')

  function fail(title: string, error: unknown) {
    const view = describeError(error)
    notify(`◆ ${title} · ${view.title}`, { tone: 'bad', description: view.trace, id: 'cx-acc-fail' })
  }

  async function run(row: AccountView, kind: string, work: () => Promise<void>) {
    if (busy[row.key]) return
    busy[row.key] = kind
    try {
      await work()
    } finally {
      delete busy[row.key]
    }
  }

  async function setRouting(row: AccountView, on: boolean, group: ProviderGroup | null) {
    if (!on && row.routable && group && group.routable <= 1) {
      const ok = await confirmSheet({
        title: '暂停最后一个可用账号？',
        facts: [{ k: '账号', v: who(row) }, { k: '服务', v: service(row) }],
        consequence: `暂停后 ${row.provider?.name ?? row.type} 没有可用账号 · 这类请求会失败`,
        confirmText: '暂停',
        danger: true,
      })
      if (!ok) return
    }
    await run(row, 'routing', async () => {
      try {
        await api.setCredentialEnabled(row.name, on)
        notify(on ? '✓ 已恢复 · 参与路由' : '✓ 已暂停 · 网关不再用它', { id: 'cx-acc-routing' })
        await refresh()
      } catch (error) {
        fail(on ? '恢复失败' : '暂停失败', error)
      }
    })
  }

  async function reset(row: AccountView) {
    const credits = row.credits
    if (!row.authIndex || !credits || credits.count <= 0) {
      showResetOutcome('no_credit')
      return
    }
    // Magpie: a reset on an account whose windows are all unused restarts nothing and burns the credit
    if (row.quotaState === 'ok' && row.windows.every((w) => w.used <= 0)) {
      showResetOutcome('no_window')
      return
    }
    const first = credits.entries[0]
    const ok = await confirmReset({
      account: masked.value ? maskEmail(row.email) : row.email,
      service: service(row),
      creditIndex: 1,
      creditExpiresAt: first?.expiresAt ?? null,
      creditsBefore: credits.count,
      windows: row.windows.filter((w) => !w.scoped).map((w) => w.short),
      clearsCooldown: true,
    })
    if (!ok) return
    await run(row, 'reset', async () => {
      try {
        const call = row.type === 'claude' || row.type === 'anthropic' ? api.resetClaudeQuota : api.resetCodexQuota
        const body = (await call(row.authIndex!)) as unknown as Record<string, unknown>
        const result = classifyResetSuccess(body, { creditsBefore: credits.count, coolUntil: row.coolUntil })
        showResetOutcome(result.outcome, { remaining: result.remaining, recoverAt: result.recoverAt })
      } catch (error) {
        const status = error instanceof ApiError ? error.status : null
        const body = error instanceof ApiError ? error.body : null
        const result = classifyResetError(status, body)
        showResetOutcome(result.outcome, { retryInMs: result.retryInMs })
      }
      await refresh()
    })
  }

  /** `choice`: '' 继承 · 'direct' · a pool entry id · `preset:N`; anything else is a typed address. */
  async function setProxy(row: AccountView, choice: string) {
    const context = egress?.() ?? { data: null, presets: [], reload: () => undefined }
    const write = egressWrite(choice, context.presets) ?? { via: 'url' as const, url: choice }
    const ref = cpaRef(row.name)
    // the exit's last check could not reach this account's vendor: say so once before the account moves
    const warning = write.via === 'assign' ? egressWarning(context.data, write.target, serviceOf(row.type)) : null
    if (warning) {
      const ok = await confirmSheet({
        title: '这个出口最近一次检测不通，仍然使用？',
        facts: [{ k: '账号', v: who(row) }, { k: '出口', v: choiceName(context.data, ref, choice, context.presets) }, { k: '检测', v: warning }],
        consequence: '可随时改回 · 原出口已记下',
        confirmText: '仍然使用',
      })
      if (!ok) {
        void readProxy(row.name)
        return
      }
    }
    await run(row, 'proxy', async () => {
      try {
        if (write.via === 'assign') {
          const result = await api.proxies.assign(write.target, [ref])
          const failed = result.results.find((item) => item.status === 'failed')
          if (failed) throw new Error(failed.error || '出口没改成')
        } else {
          await api.setCredentialProxy(row.name, write.url)
        }
        // what the server holds now (masked, with its pool entry): that is what the picker shows
        const saved = await api.proxies.egressAccount(ref, row.type)
        knowProxy(row.name, saved)
        notify(`✓ 出口已改为 ${readLabel(saved)}`, { id: 'cx-acc-proxy' })
        await refresh()
        context.reload()
      } catch (error) {
        fail('代理没改成', error)
        // the write may or may not have landed: show what the server has, not what was picked
        void readProxy(row.name)
      }
    })
  }

  async function remove(row: AccountView, group: ProviderGroup | null): Promise<boolean> {
    const last = row.routable && group && group.routable <= 1
    const ok = await confirmSheet({
      title: '移除这个账号？',
      facts: [
        { k: '账号', v: who(row) },
        { k: '服务', v: service(row) },
        { k: '影响', v: last ? `${row.provider?.name ?? row.type} 将没有可用账号` : '网关不再使用它 · 凭据文件删除' },
      ],
      consequence: '不可撤销 · 要用需重新授权',
      confirmText: '移除',
      danger: true,
    })
    if (!ok) return false
    let done = false
    await run(row, 'remove', async () => {
      try {
        await api.deleteCredential(row.name)
        notify('✓ 已移除', { id: 'cx-acc-remove' })
        done = true
        await refresh()
      } catch (error) {
        fail('移除失败', error)
      }
    })
    return done
  }

  return { busy, setRouting, reset, setProxy, remove }
}

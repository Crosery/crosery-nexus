import type { ConsoleGroup } from './groups.js'
import type { KeyAccessRow } from './keyModelAccess.js'

/**
 * 网关有两道彼此独立的闸：`api-key-model-access`（模型）和 `api-key-channel-access`
 * （渠道），渠道闸在挑选凭据之前执行。控制台过去只写模型那一份，于是出现过这样的事故：
 * 面板上把 Codex 组开给某把 Key，模型白名单也确实同步到了网关，但网关渠道闸里没有
 * `codex`，请求一律 503 `auth_not_found` —— 面板显示「已开放」，实际一个都用不了，
 * 而且报错里没有任何线索指向渠道闸。这里把同一份分组翻译成渠道白名单，让两份名单对齐。
 */

/**
 * 以分组为真相源重建渠道白名单。
 *
 * **每一把启用中的 Key 都要写**，不能只接管「网关里已经有条目」的 Key：网关的
 * `SanitizeAPIKeyChannelAccess` 会删掉不在 `api-keys` 里的条目，而额度超限停用
 * （quotaEnforcer 把 Key 从 api-keys 摘掉）或人工停用都会触发这一步。若只接管已有条目，
 * 这把 Key 恢复启用后条目再也回不来，就退化成「无条目 = 不限渠道」——
 * 2026-09-07 非雨被额度停用又恢复后，gpt-6-astra 有 460 次绕过 codex 打到了
 * priority 更高的 mox-aigw 上，就是这么来的。**失效方向必须是拒绝，不能是放开。**
 *
 * 两条边界仍然保留：
 * 1. **只写网关已配置的启用 Key**。停用的 Key 不在 `api-keys` 里，带进 PUT 会让网关以
 *    "api key is not configured" 400 掉整份请求，把其他 Key 的同步一起拖死。
 * 2. **受管 Key 仅接受明确授权**。旧名单不是授权来源；渠道停用后即使不在当前目录中，
 *    也不能作为「未知渠道」保留下来，否则只开 Codex 的 Key 仍会选中 Mox。
 *
 * 空池使用保留的拒绝标记，不能写空数组：旧网关会把空数组归一化成不限渠道。
 * 渠道闸必须独立拒绝，不能依赖另一个可能降级或写入失败的模型权限接口。
 */
/**
 * 默认对所有 Key 开放的渠道（2026-09-17 用户要求）。
 *
 * claude 渠道在这里只为「默认开放模型」（见 keyModelAccess.ts 的 DEFAULT_OPEN_MODELS，
 * 目前是 claude haiku）开路：它不会把该渠道的其它模型带进 Key 的模型白名单，
 * 那些模型仍然要 Key 显式勾选 claude 组才会开放。
 *
 * codex 渠道同理，只为 gpt-image 全系（DEFAULT_OPEN_MODEL_PREFIXES，2026-09-26）开路。
 * 这里刻意写死而不是按「哪些渠道有 gpt-image」推导：渠道闸不分模型，若日后 mox-aigw
 * 之类中转也挂上 gpt-image，推导会把中转对所有 Key 放开，gpt-6 等模型随之被路由过去。
 * 反过来要留意：某渠道若与 codex 提供同名非图片模型，勾了该渠道的 Key 也会被路由到 codex。
 */
export const DEFAULT_OPEN_CHANNELS = ['claude', 'codex'] as const

export function buildKeyChannelAccessPlan(
  groups: ConsoleGroup[],
  rows: KeyAccessRow[],
  _current: Record<string, string[]>,
  configuredKeys: ReadonlySet<string>,
): Record<string, string[]> {
  const knownGroups = new Set(groups.map((group) => group.id))
  const plan: Record<string, string[]> = {}

  for (const row of rows) {
    if (!row.enabled || !configuredKeys.has(row.keyValue)) continue
    const selected = [...new Set([...row.groups.filter((group) => knownGroups.has(group)), ...DEFAULT_OPEN_CHANNELS])].sort()
    plan[row.keyValue] = selected.length ? selected : ['__console_no_channels_allowed__']
  }

  return plan
}

/**
 * PUT 是整份替换，所以未被接管的 Key 必须原样带上，否则一次同步就会把它们的限制抹掉。
 */
export const mergeChannelAccess = (
  current: Record<string, string[]>,
  plan: Record<string, string[]>,
): Record<string, string[]> => ({ ...current, ...plan })

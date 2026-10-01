export type KeyPolicy = {
  enabled: boolean
  groups: string[]
  totalConcurrency: number
  groupConcurrency: Record<string, number>
}

/**
 * 并发规则的**唯一真源文案**（R7-B）。
 * `server/index.ts` 的请求解析与这里必须报同一句话，否则用户会在表单旁看到一份说法、
 * 在接口 400 里看到另一份说法。测试 `server/policyCopy.test.ts` 会断言：
 *   1. `validatePolicy` 抛出的消息 === 本常量；
 *   2. 全仓库 `server/**` 只出现一次这段字面量（防止再复制一份）。
 */
export const TOTAL_CONCURRENCY_RULE = '总并发必须是 0 到 500 的整数，0 表示不限速'

export function validatePolicy(policy: KeyPolicy) {
  if (!Number.isInteger(policy.totalConcurrency) || policy.totalConcurrency < 0 || policy.totalConcurrency > 500) {
    throw new Error(TOTAL_CONCURRENCY_RULE)
  }
  if (!Array.isArray(policy.groups) || policy.groups.length === 0) throw new Error('至少选择一个渠道分组')
  if (policy.totalConcurrency === 0) return policy
  for (const group of policy.groups) {
    const limit = policy.groupConcurrency[group]
    if (!Number.isInteger(limit) || limit < 1 || limit > policy.totalConcurrency) {
      throw new Error(`${group} 分组并发必须在 1 到总并发之间`)
    }
  }
  return policy
}

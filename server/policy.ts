export type KeyPolicy = {
  enabled: boolean
  groups: string[]
  totalConcurrency: number
  groupConcurrency: Record<string, number>
}

export function validatePolicy(policy: KeyPolicy) {
  if (!Number.isInteger(policy.totalConcurrency) || policy.totalConcurrency < 1 || policy.totalConcurrency > 500) {
    throw new Error('总并发必须是 1 到 500 的整数')
  }
  if (!Array.isArray(policy.groups) || policy.groups.length === 0) throw new Error('至少选择一个渠道分组')
  for (const group of policy.groups) {
    const limit = policy.groupConcurrency[group]
    if (!Number.isInteger(limit) || limit < 1 || limit > policy.totalConcurrency) {
      throw new Error(`${group} 分组并发必须在 1 到总并发之间`)
    }
  }
  return policy
}

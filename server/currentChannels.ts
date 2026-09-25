import type { ConsoleGroup } from './groups.js'

/**
 * 当前渠道集合只来自 CPA 实时配置：groups 已排除了停用、残留快照和无活跃账号的 OAuth provider。
 * usage_events 里的 provider 是历史事实，不得反过来创造当前渠道。
 */
export function activeProviderValues(groups: ConsoleGroup[]): string[] {
  const values = new Set<string>()
  for (const group of groups) {
    const id = String(group.id || '').trim().toLowerCase()
    if (!id) continue
    values.add(id)
    // CPA 的 usage provider 在不同版本中曾使用完整 openai-compatible-* 名称，
    // 而管理配置使用短渠道名；这两个值只在该渠道当前仍存在时互为别名。
    if (group.kind === 'compat' && id.startsWith('openai-compatible-')) values.add(id.slice('openai-compatible-'.length))
    else if (group.kind === 'compat') values.add(`openai-compatible-${id}`)
  }
  return [...values].sort()
}

/** 生成可绑定参数的 provider 白名单；空集合 fail-closed。 */
export function activeProviderPredicate(groups: ConsoleGroup[], column = 'provider') {
  const values = activeProviderValues(groups)
  if (!values.length) return { sql: '0 = 1', params: [] as string[] }
  return { sql: `lower(trim(${column})) IN (${values.map(() => '?').join(', ')})`, params: values }
}

/** 将 provider 的兼容写法归一到当前分组 ID，避免同一渠道拆成两条统计。 */
export function activeProviderExpression(groups: ConsoleGroup[], column = 'provider') {
  if (!groups.length) return { sql: "'unknown'", params: [] as string[] }
  const cases: string[] = []
  const params: string[] = []
  for (const group of groups) {
    const id = group.id.toLowerCase()
    const aliases = group.kind === 'compat' && id.startsWith('openai-compatible-')
      ? [id, id.slice('openai-compatible-'.length)]
      : group.kind === 'compat' ? [id, `openai-compatible-${id}`] : [id]
    cases.push(`WHEN lower(trim(${column})) IN (${aliases.map(() => '?').join(', ')}) THEN ?`)
    params.push(...aliases, group.id)
  }
  return { sql: `(CASE ${cases.join(' ')} ELSE lower(trim(${column})) END)`, params }
}

export function isActiveProvider(provider: string, groups: ConsoleGroup[]): boolean {
  const value = String(provider || '').trim().toLowerCase()
  return value !== '' && activeProviderValues(groups).includes(value)
}

/** 把 CPA usage 中可能出现的完整 provider 名折叠回当前渠道/分组 ID。 */
export function activeProviderId(provider: string, groups: ConsoleGroup[]): string {
  const value = String(provider || '').trim().toLowerCase()
  const direct = groups.find((group) => group.id.toLowerCase() === value)
  if (direct) return direct.id
  const prefixed = groups.find((group) => `openai-compatible-${group.id}`.toLowerCase() === value)
  return prefixed?.id || value || 'unknown'
}

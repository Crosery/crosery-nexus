export type RelayRouteRow = { prefix: string; weight: number; round_robin: number }

/**
 * 一次请求的尝试顺序：按权重分档，档内按已发布的先后；该模型开了「同档轮询」时，每个档内按 `turn` 轮换起点。
 * 失败后依次换下一个，所以返回的是全部来源，不只是第一个。
 */
export function planAttempts(model: string, rows: RelayRouteRow[], turn: number): string[] {
  const tiers = new Map<number, RelayRouteRow[]>()
  for (const row of rows) {
    const tier = tiers.get(row.weight)
    if (tier) tier.push(row)
    else tiers.set(row.weight, [row])
  }
  const rotate = rows.some((row) => row.round_robin === 1)
  const out: string[] = []
  for (const weight of [...tiers.keys()].sort((a, b) => a - b)) {
    const tier = tiers.get(weight)!
    const shift = rotate ? turn % tier.length : 0
    for (const row of [...tier.slice(shift), ...tier.slice(0, shift)]) out.push(`${row.prefix}/${model}`)
  }
  return out
}

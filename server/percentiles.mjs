/**
 * Exact nearest-rank P50 / P95 for the 性能 report, partitioned four ways (all · model · channel · bucket).
 *
 * Shared by the read worker (`reduce: { percentiles }`, rows streamed with `iterate()`) and perfReports' in-process
 * fallback for readers that return raw rows. It replaces four `ROW_NUMBER() OVER (PARTITION BY …)` sorts, which cost
 * ~16 s and several hundred MB of temp B-tree on a 90-day production-sized window, with two linear passes:
 *   1. per partition, a slot histogram (slot = value at display precision) locates the slot holding each target
 *      rank and the rank inside that slot;
 *   2. only the values falling in those target slots are collected and sorted to pick the exact value.
 * Ranks are SQL's integers: ⌈n/2⌉ = ⌊(n + 1) / 2⌋ and ⌈0.95n⌉ = ⌊(95n + 99) / 100⌋.
 */

const DIMS = ['a', 'm', 'p', 'b']

/** Slot of a positive value: 1 ms below 1 s, then 10 / 100 / 1000 / 10000 ms per slot; the last slot is open. */
function slotOf(v) {
  if (v < 1_000) return Math.floor(v)
  if (v < 10_000) return 1_000 + Math.floor((v - 1_000) / 10)
  if (v < 100_000) return 1_900 + Math.floor((v - 10_000) / 100)
  if (v < 1_000_000) return 2_800 + Math.floor((v - 100_000) / 1_000)
  return Math.min(4_599, 3_700 + Math.floor((v - 1_000_000) / 10_000))
}
const SLOTS = 4_600

function growable(Type) {
  let data = new Type(1 << 14)
  let length = 0
  return {
    push(value) {
      if (length === data.length) {
        const next = new Type(data.length * 2)
        next.set(data)
        data = next
      }
      data[length++] = value
    },
    get: (index) => data[index],
    get length() { return length },
  }
}

/**
 * @param {Iterable<Record<string, unknown> | unknown[]>} rows objects with `b`, `m`, `p` and every name in `fields`,
 *   or arrays in that column order (`[b, m, p, ...fields]`, what the worker streams with `setReturnArrays`)
 * @param {string[]} fields metric columns; a value ≤ 0 or null is "not reported" and skipped for that metric
 * @returns {Record<string, Array<{ dim: 'a' | 'm' | 'p' | 'b'; k: string | number; n: number; p50: number; p95: number }>>}
 */
export function percentileSummary(rows, fields) {
  // partition ids: one shared space across the four dims; id 0 is 'a'
  const keys = [['a', '']]
  const maps = [new Map(), new Map(), new Map()]
  const idOf = (d, key) => {
    let id = maps[d].get(key)
    if (id === undefined) {
      id = keys.length
      maps[d].set(key, id)
      keys.push([DIMS[d + 1], key])
    }
    return id
  }
  const rowParts = [growable(Uint32Array), growable(Uint32Array), growable(Uint32Array)]
  const values = fields.map(() => growable(Float64Array))
  const histograms = fields.map(() => [])
  const counts = fields.map(() => [])
  const parts = [0, 0, 0, 0]

  for (const row of rows) {
    const array = Array.isArray(row)
    parts[1] = idOf(0, (array ? row[1] : row.m) ?? '')
    parts[2] = idOf(1, (array ? row[2] : row.p) ?? '')
    parts[3] = idOf(2, (array ? row[0] : row.b) ?? '')
    rowParts[0].push(parts[1])
    rowParts[1].push(parts[2])
    rowParts[2].push(parts[3])
    for (let f = 0; f < fields.length; f += 1) {
      const raw = Number(array ? row[3 + f] : row[fields[f]])
      const v = Number.isFinite(raw) && raw > 0 ? raw : NaN
      values[f].push(v)
      if (Number.isNaN(v)) continue
      const slot = slotOf(v)
      for (let d = 0; d < 4; d += 1) {
        const id = parts[d]
        const histogram = histograms[f][id] ??= new Uint32Array(SLOTS)
        histogram[slot] += 1
        counts[f][id] = (counts[f][id] ?? 0) + 1
      }
    }
  }

  const result = {}
  for (let f = 0; f < fields.length; f += 1) {
    // pass 1 → per partition: the slot of each target rank and the rank inside it
    const targets = []
    for (let id = 0; id < keys.length; id += 1) {
      const n = counts[f][id]
      if (!n) continue
      const histogram = histograms[f][id]
      const found = [Math.floor((n + 1) / 2), Math.floor((95 * n + 99) / 100)].map((rank) => {
        let seen = 0
        for (let slot = 0; slot < SLOTS; slot += 1) {
          if (seen + histogram[slot] >= rank) return { slot, within: rank - seen, picked: [] }
          seen += histogram[slot]
        }
        return null
      })
      targets[id] = { n, found }
    }
    // pass 2 → collect only the values in a target slot, then pick the exact one
    const collect = (id, slot, v) => {
      const [p50, p95] = targets[id].found
      if (p50?.slot === slot) p50.picked.push(v)
      if (p95?.slot === slot) p95.picked.push(v)
    }
    for (let index = 0; index < values[f].length; index += 1) {
      const v = values[f].get(index)
      if (Number.isNaN(v)) continue
      const slot = slotOf(v)
      collect(0, slot, v)
      collect(rowParts[0].get(index), slot, v)
      collect(rowParts[1].get(index), slot, v)
      collect(rowParts[2].get(index), slot, v)
    }
    const out = []
    targets.forEach(({ n, found }, id) => {
      const [p50, p95] = found.map((target) => {
        if (!target) return null
        target.picked.sort((x, y) => x - y)
        return target.picked[target.within - 1] ?? null
      })
      const [dim, key] = keys[id]
      out.push({ dim, k: key, n, p50, p95 })
    })
    out.sort((x, y) => DIMS.indexOf(x.dim) - DIMS.indexOf(y.dim))
    result[fields[f]] = out
  }
  return result
}

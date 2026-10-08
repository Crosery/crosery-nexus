// 控制台的数字与时间写法（src/ui/fmt.ts、src/features/keys/keysModel.ts、src/features/accounts/model.ts）：
// 详情与用量页要和网页逐字一致时用这里；控制台改了写法，这里跟着改。时间按本机时区。

export const NONE = '—'
const DAY_MS = 86_400_000
const WEEKDAY = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']

const finite = value => typeof value === 'number' && Number.isFinite(value)
const two = n => String(n).padStart(2, '0')
const fixed = (value, digits) => value.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits })

export const fmtInt = value => (finite(value) ? Math.round(value).toLocaleString('en-US') : NONE)

export const fmtNum = (value, digits = 2) => (finite(value) ? value.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: digits }) : NONE)

const trim = text => text.replace(/\.0+$/, '').replace(/(\.\d*[1-9])0+$/, '$1')

/** 9,412 · 35.4k · 248.6M · 10.95B（≥10,000 才缩写） */
export function fmtCompact(value) {
  if (!finite(value)) return NONE
  const abs = Math.abs(value)
  const sign = value < 0 ? '-' : ''
  if (abs < 10_000) return fmtInt(value)
  if (abs < 1e6) return `${sign}${trim((abs / 1e3).toFixed(1))}k`
  if (abs < 1e9) return `${sign}${trim((abs / 1e6).toFixed(1))}M`
  return `${sign}${trim((abs / 1e9).toFixed(2))}B`
}

/** $1,284.30 · <$0.01 · approx 时前缀 ≈ */
export function fmtUsd(value, { approx = false, digits } = {}) {
  if (!finite(value)) return NONE
  const prefix = approx ? '≈ ' : ''
  const abs = Math.abs(value)
  const sign = value < 0 ? '-' : ''
  if (abs > 0 && abs < 0.01 && digits === undefined) return `${prefix}${sign}<$0.01`
  return `${prefix}${sign}$${fixed(abs, digits ?? 2)}`
}

/** 每行的花费：未知或为 0 都是 —。 */
export const fmtSpend = value => (finite(value) && value !== 0 ? fmtUsd(value) : NONE)

/** 额度金额：整数或 ≥1000 不带小数。 */
export const capMoney = value => fmtUsd(value, { digits: value >= 1000 || Number.isInteger(value) ? 0 : 2 })

export const fmtPct = (ratio, digits = 1) => (finite(ratio) ? `${(ratio * 100).toFixed(digits)}%` : NONE)

/** ▲ 12.0% · ▼ 0.30pp · ▲ 2 */
export function fmtDelta(value, unit = 'pct', digits = 1) {
  if (!finite(value)) return NONE
  const arrow = value > 0 ? '▲' : value < 0 ? '▼' : '·'
  const abs = Math.abs(value)
  if (unit === 'pct') return `${arrow} ${(abs * 100).toFixed(digits)}%`
  if (unit === 'pp') return `${arrow} ${(abs * 100).toFixed(digits)}pp`
  return `${arrow} ${fmtNum(abs, digits)}`
}

const instant = value => {
  if (value === null || value === undefined || value === '') return null
  const date = new Date(typeof value === 'number' ? value : String(value))
  return Number.isNaN(date.getTime()) ? null : date
}
const hm = date => `${two(date.getHours())}:${two(date.getMinutes())}`

/** 2026-10-09 周五 */
export function fmtDate(value) {
  const date = instant(value)
  return date ? `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())} ${WEEKDAY[date.getDay()]}` : NONE
}

/** Key 额度窗口的重置：一天内 `↻ 00:00`，更远 `↻ 周一 00:00`（keysModel.ts resetLabel）。 */
export function keyReset(value, now = Date.now()) {
  const date = instant(value)
  if (!date) return ''
  return date.getTime() - now <= DAY_MS ? `↻ ${hm(date)}` : `↻ ${WEEKDAY[date.getDay()]} ${hm(date)}`
}

/** 账号额度窗口的重置：今天 `15:10` · 明天 `明天 09:00` · 一周内 `周四 09:00` · 更远 `10/04 22:30`（accounts/model.ts fmtReset）。 */
export function accountReset(value, now = Date.now()) {
  const date = instant(value)
  if (!date) return NONE
  const today = new Date(now)
  const days = Math.round((new Date(date.getFullYear(), date.getMonth(), date.getDate()) - new Date(today.getFullYear(), today.getMonth(), today.getDate())) / DAY_MS)
  if (days === 0) return hm(date)
  if (days === 1) return `明天 ${hm(date)}`
  if (days > 1 && days < 7) return `${WEEKDAY[date.getDay()]} ${hm(date)}`
  return `${two(date.getMonth() + 1)}/${two(date.getDate())} ${hm(date)}`
}

/**
 * 时间与数字格式的唯一出口。
 *
 * 对照参考实现 `geek_main/app/console/src/lib/format.ts:1-36`：控制台一律按北京时间（Asia/Shanghai）
 * 24 小时制显示，不跟浏览器时区走——同一份用量数据在运维和用户两侧读出来必须是同一个时刻。
 * 金额/百分比/大数/延迟同样收敛到这里，页面里不再散落 toLocaleString / toFixed / 手写除法。
 */
import { compact, ms } from '../chartTheme'

export const TIME_ZONE = 'Asia/Shanghai'

type Instant = string | number | Date | null | undefined

const toDate = (value: Instant): Date | null =>
  value === null || value === undefined || value === '' ? null : value instanceof Date ? value : new Date(value)

const isBad = (date: Date | null): boolean => !date || Number.isNaN(date.getTime())

/** 完整时刻：2026/10/01 08:30（北京时间，24 小时制）。 */
export function fmtDate(value: Instant): string {
  const date = toDate(value)
  if (isBad(date)) return '—'
  return (date as Date).toLocaleString('zh-CN', {
    timeZone: TIME_ZONE,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}

/** 只到天：2026/10/01。 */
export function fmtDay(value: Instant): string {
  const date = toDate(value)
  if (isBad(date)) return '—'
  return (date as Date).toLocaleDateString('zh-CN', { timeZone: TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit' })
}

/** 带秒的短时刻：10/01 08:30:05，用于请求流水这类密集列表。 */
export function fmtClock(value: Instant): string {
  const date = toDate(value)
  if (isBad(date)) return '—'
  return (date as Date).toLocaleString('zh-CN', {
    timeZone: TIME_ZONE,
    hour12: false,
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
}

/** 相对时间：刚刚 / 12 分钟前 / 3 天前；超过 30 天退回日期。 */
export function fmtRelative(value: Instant, now = Date.now()): string {
  const date = toDate(value)
  if (isBad(date)) return '—'
  const diff = now - (date as Date).getTime()
  const suffix = diff >= 0 ? '前' : '后'
  const seconds = Math.round(Math.abs(diff) / 1000)
  if (seconds < 60) return diff >= 0 ? '刚刚' : '马上'
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes} 分钟${suffix}`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours} 小时${suffix}`
  const days = Math.round(hours / 24)
  if (days < 30) return `${days} 天${suffix}`
  return fmtDay(date as Date)
}

/** 倒计时：把「还有多久重置」写成 2 小时 5 分 / 3 天 4 小时。 */
export function fmtCountdown(msLeft: number): string {
  if (!Number.isFinite(msLeft) || msLeft <= 0) return '即将重置'
  const minutes = Math.floor(msLeft / 60000)
  if (minutes < 60) return `${Math.max(1, minutes)} 分钟`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} 小时 ${minutes % 60} 分`
  return `${Math.floor(hours / 24)} 天 ${hours % 24} 小时`
}

/** 金额：$1.23；小于 1 分显示 $0.001 精度，避免小额被抹成 $0.00。 */
export function fmtUsd(value: number | null | undefined, digits?: number): string {
  const amount = Number(value ?? 0)
  if (!Number.isFinite(amount)) return '$0.00'
  const fixed = digits ?? (Math.abs(amount) > 0 && Math.abs(amount) < 0.01 ? 3 : 2)
  return `$${amount.toFixed(fixed)}`
}

/** 百分比：0.0523 → 5.2%。 */
export function fmtPercent(value: number | null | undefined, digits = 1): string {
  const ratio = Number(value ?? 0)
  if (!Number.isFinite(ratio)) return '0%'
  return `${(ratio * 100).toFixed(digits)}%`
}

/** 大数：12345 → 1.2万（与图表刻度同一套 compact 规则，避免图表与表格对不上）。 */
export function fmtCompact(value: number | null | undefined): string {
  return compact(Number(value ?? 0))
}

/** 整数千分位：1234567 → 1,234,567。 */
export function fmtInt(value: number | null | undefined): string {
  return new Intl.NumberFormat('zh-CN').format(Number(value ?? 0))
}

/** 延迟：850 → 850ms；1500 → 1.5s。 */
export function fmtLatency(value: number | null | undefined): string {
  return ms(Number(value ?? 0))
}

/** 字节：2048 → 2.0 KB。 */
export function fmtBytes(value: number | null | undefined): string {
  const size = Number(value ?? 0)
  if (!Number.isFinite(size) || size <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const index = Math.min(units.length - 1, Math.floor(Math.log(size) / Math.log(1024)))
  const scaled = size / 1024 ** index
  return `${index === 0 ? scaled : scaled.toFixed(1)} ${units[index]}`
}

/**
 * 图表色板。取自已验证的分类色板，并针对本项目面板底色 #f0eee8 跑过校验：
 *   node scripts/validate_palette.js "#2a78d6,#eb6834,#1baf7a,#eda100,#e87ba4" --mode light --surface "#f0eee8"
 *   → 亮度带 / 色度下限 / CVD 分离 / 常视觉下限 全部 PASS
 * 项目原来的 --blue #6f8fae、--purple #9484a3 色度只有 0.059/0.049，低于下限会读成灰色，故不用于数据标记。
 * 对比度检查为 WARN：所有图表都必须配图例或直接标签，不能只靠颜色区分。
 */
export const CATEGORICAL = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#4a3aa7', '#e34948'] as const

/** 单系列图一律用 slot 1，避免把「大小」二次编码成色相。 */
export const PRIMARY = CATEGORICAL[0]

/** 状态色专用于成功/失败语义，绝不复用为第 N 个系列。 */
export const STATUS = { good: '#1baf7a', danger: '#c0392f', warn: '#eda100' } as const

export const AXIS = { tick: '#8a837b', grid: 'rgba(120,113,104,.14)' } as const

/**
 * 颜色跟随实体：同一渠道在任何图表里都是同一个槽位，
 * 过滤掉某些系列时幸存者不会被重新上色。
 */
export function colorForEntity(id: string, order: string[]): string {
  const index = order.indexOf(id)
  if (index >= 0 && index < CATEGORICAL.length) return CATEGORICAL[index]
  // 超出槽位数不再生成新色相，统一归入中性灰（对应 “Other”）
  return '#9a938a'
}

export const tooltipStyle = {
  background: '#ffffff',
  border: '1px solid #e3e1db',
  borderRadius: 10,
  boxShadow: '0 8px 24px rgba(0,0,0,.10)',
  fontSize: 12,
  color: '#2d2a26',
  padding: '8px 10px',
} as const

export const compact = (value: number) =>
  new Intl.NumberFormat('zh-CN', { notation: 'compact', maximumFractionDigits: 1 }).format(value || 0)

export const ms = (value: number) => (value >= 1000 ? `${(value / 1000).toFixed(1)}s` : `${Math.round(value)}ms`)

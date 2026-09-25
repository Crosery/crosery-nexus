/**
 * 网关管理面能力的运行时事实。
 *
 * CPA v7.2.140 把 /v0/management/api-key-model-access 从上游删除后，网关侧不再有
 * Key 级模型隔离。控制台仍然保留分组配置（换网关或上游恢复该能力时可直接生效），
 * 但必须如实告诉使用者「当前这层限制没有在网关生效」，否则分组 UI 就是个假承诺。
 *
 * 这里只存事实，不做判断：由真正调用网关的一方（对账循环）写入，读的一方（bootstrap、
 * 按需取用。
 */

export type ManagementCapability = 'unknown' | 'available' | 'unavailable'

let keyModelAccess: ManagementCapability = 'unknown'

/** 尚未与网关对账过时是 'unknown'，不预设网关支持。 */
export const getKeyModelAccessState = (): ManagementCapability => keyModelAccess

/** 仅在状态翻转时打印，避免每 15 秒一轮的对账把日志刷爆。 */
export function markKeyModelAccess(state: Exclude<ManagementCapability, 'unknown'>) {
  if (keyModelAccess === state) return
  keyModelAccess = state
  console.warn(JSON.stringify({
    category: state === 'available' ? '[AUDIT]' : '[WARN]',
    event: 'management.key_model_access',
    stage: 'reconcile',
    outcome: state === 'available' ? 'ok' : 'degraded',
    detail: state === 'available'
      ? '网关支持 api-key-model-access，Key 级模型白名单已生效'
      : '网关缺少 api-key-model-access（CPA v7.2.140 起已从上游移除），Key 级模型白名单不在网关生效',
  }))
}

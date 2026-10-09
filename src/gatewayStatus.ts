export type GatewayState = 'checking' | 'online' | 'unavailable'
export type DashboardState = 'loading' | 'ready' | 'unavailable'

export const gatewayStatusCopy = (state: GatewayState) => {
  if (state === 'online') return { title: '网关运行正常', detail: 'CPA 控制面可访问', short: '在线' }
  if (state === 'unavailable') return { title: '网关状态不可用', detail: '无法读取 CPA 控制面', short: '状态不可用' }
  return { title: '正在检查网关', detail: '正在读取 CPA 控制面', short: '检查中' }
}

export const analyticsScopeKey = (days: number, keyId: string): string => JSON.stringify([days, keyId])

export const dataForScope = <T>(value: T | null, loadedScope: string, currentScope: string): T | null =>
  loadedScope === currentScope ? value : null

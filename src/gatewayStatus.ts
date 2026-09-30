export type GatewayState = 'checking' | 'online' | 'unavailable'
export type DashboardState = 'loading' | 'ready' | 'unavailable'

export const gatewayStatusCopy = (state: GatewayState, engine: 'cpa' | 'magpie' = 'cpa') => {
  if (engine === 'magpie') {
    if (state === 'online') return { title: '网关运行正常', detail: 'Magpie 内核可访问', short: '在线' }
    if (state === 'unavailable') return { title: '网关状态不可用', detail: '无法访问 Magpie 内核', short: '状态不可用' }
    return { title: '正在检查网关', detail: '正在检查 Magpie 内核', short: '检查中' }
  }
  if (state === 'online') return { title: '网关运行正常', detail: 'CPA 控制面可访问', short: '在线' }
  if (state === 'unavailable') return { title: '网关状态不可用', detail: '无法读取 CPA 控制面', short: '状态不可用' }
  return { title: '正在检查网关', detail: '正在读取 CPA 控制面', short: '检查中' }
}

export const emptyKeyListCopy = (state: GatewayState, keyCount: number): string | null => {
  if (keyCount > 0) return null
  if (state === 'online') return '还没有 API Key'
  if (state === 'unavailable') return '密钥数据暂时不可用'
  return '正在读取密钥数据'
}

export const analyticsScopeKey = (days: number, keyId: string): string => JSON.stringify([days, keyId])

export const dataForScope = <T>(value: T | null, loadedScope: string, currentScope: string): T | null =>
  loadedScope === currentScope ? value : null

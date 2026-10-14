import type { ChannelItem, EgressData, ProxyPreset } from '../../types'
import { egressOptions, egressWrite, EGRESS_CUSTOM } from '../accounts/egressModel'
import type { PickItem } from '../accounts/egressModel'

/**
 * 渠道出口的选择，和账号一样是一个下拉：继承全局 / 直连 / 代理池里的出口 / 网关预设 / 自定义地址。
 * 列表里渠道的地址 userinfo 已打码；「当前是哪个出口」由服务端按地址比对后给出（proxyEntryId / proxyPreset），
 * 浏览器拿不到也不回显带账号密码的地址。写入：池出口只传条目 id（地址由服务端解析），其余传地址。
 */
export const CHANNEL_CUSTOM = EGRESS_CUSTOM
export const channelRef = (name: string) => `cpa:channel:${name}`
export const PROXY_URL_RE = /^(https?|socks5h?):\/\/[^\s]+$/i

export function channelChoice(channel: Pick<ChannelItem, 'proxyUrl' | 'proxyEntryId' | 'proxyPreset'>, egress: EgressData | null): string {
  const value = (channel.proxyUrl ?? '').trim()
  if (!value) return ''
  if (value.toLowerCase() === 'direct') return 'direct'
  if (channel.proxyEntryId && egress?.entries.some((entry) => entry.id === channel.proxyEntryId)) return channel.proxyEntryId
  if (channel.proxyPreset !== undefined && !egress?.presets[channel.proxyPreset]?.entryId) return `preset:${channel.proxyPreset}`
  return CHANNEL_CUSTOM
}

export function channelOptions(channel: Pick<ChannelItem, 'name' | 'proxyUrl' | 'proxyEntryId' | 'proxyPreset'>, egress: EgressData | null, presets: ProxyPreset[]): PickItem[] {
  const items = egressOptions(egress, channelRef(channel.name), null, { presets, custom: true })
  const custom = items.find((item) => item.value === CHANNEL_CUSTOM)
  if (custom && channelChoice(channel, egress) === CHANNEL_CUSTOM && channel.proxyUrl) custom.label = `自定义 · ${channel.proxyUrl}`
  return items
}

export type ChannelProxyWrite = { proxyUrl: string } | { target: string }

/** 选项要写什么；自定义地址要等输入框点保存，这里返回 null。 */
export function channelWrite(choice: string, presets: ProxyPreset[]): ChannelProxyWrite | null {
  const write = egressWrite(choice, presets)
  if (!write) return null
  if (write.via === 'url') return { proxyUrl: write.url }
  if (write.target === 'inherit') return { proxyUrl: '' }
  if (write.target === 'direct') return { proxyUrl: 'direct' }
  return { target: write.target }
}

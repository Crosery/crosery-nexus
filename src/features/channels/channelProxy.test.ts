import assert from 'node:assert/strict'
import test from 'node:test'
import type { EgressData } from '../../types.js'
import { channelChoice, channelOptions, channelWrite, CHANNEL_CUSTOM } from './channelProxy.js'

const presets = [{ label: '香港', url: 'socks5://hk.example.test:1080' }, { label: '东京', url: 'http://jp.example.test:8080' }]
const egress = {
  entries: [{ id: 'px_abcdefghij', name: 'node-1 · US', country: 'US', assignable: true, checks: {}, exitState: null }],
  presets: [{ entryId: null }, { entryId: 'px_abcdefghij' }],
  default: { mode: 'direct', entryId: null },
} as unknown as EgressData

test('channelChoice：空=继承，direct，池条目，预设，其余自定义', () => {
  assert.equal(channelChoice({}, egress), '')
  assert.equal(channelChoice({ proxyUrl: 'direct' }, egress), 'direct')
  assert.equal(channelChoice({ proxyUrl: 'socks5://***@x:1', proxyEntryId: 'px_abcdefghij' }, egress), 'px_abcdefghij')
  assert.equal(channelChoice({ proxyUrl: 'socks5://hk.example.test:1080', proxyPreset: 0 }, egress), 'preset:0')
  assert.equal(channelChoice({ proxyUrl: 'http://jp.example.test:8080', proxyPreset: 1 }, egress), CHANNEL_CUSTOM, '这个预设已经在池里，选项里没有它，回到自定义')
  assert.equal(channelChoice({ proxyUrl: 'socks5://other.example.test:1' }, egress), CHANNEL_CUSTOM)
})

test('channelOptions：继承、直连、池出口、不在池里的预设、自定义；自定义带当前打码地址', () => {
  const options = channelOptions({ name: 'relay', proxyUrl: 'socks5://other.example.test:1' }, egress, presets)
  assert.deepEqual(options.map((item) => item.value), ['', 'direct', 'px_abcdefghij', 'preset:0', CHANNEL_CUSTOM])
  assert.equal(options.at(-1)?.label, '自定义 · socks5://other.example.test:1')
})

test('channelWrite：池出口只传条目 id，其余传地址，自定义等保存', () => {
  assert.deepEqual(channelWrite('', presets), { proxyUrl: '' })
  assert.deepEqual(channelWrite('direct', presets), { proxyUrl: 'direct' })
  assert.deepEqual(channelWrite('px_abcdefghij', presets), { target: 'px_abcdefghij' })
  assert.deepEqual(channelWrite('preset:0', presets), { proxyUrl: presets[0].url })
  assert.equal(channelWrite(CHANNEL_CUSTOM, presets), null)
})

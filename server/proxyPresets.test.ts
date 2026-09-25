import assert from 'node:assert/strict'
import test from 'node:test'

import { PROXY_DIRECT, PROXY_INHERIT, normalizeProxyUrl, parseProxyPresets } from './proxyPresets.js'

test('normalizes the three proxy_url modes CPA understands', () => {
  assert.equal(normalizeProxyUrl(''), PROXY_INHERIT)
  assert.equal(normalizeProxyUrl('   '), PROXY_INHERIT)
  assert.equal(normalizeProxyUrl('direct'), PROXY_DIRECT)
  assert.equal(normalizeProxyUrl('DIRECT'), PROXY_DIRECT)
  assert.equal(normalizeProxyUrl('none'), PROXY_DIRECT)
  assert.equal(normalizeProxyUrl(' http://42.192.60.90:26720 '), 'http://42.192.60.90:26720')
  assert.equal(normalizeProxyUrl('socks5://127.0.0.1:1080'), 'socks5://127.0.0.1:1080')
})

test('rejects proxy values CPA cannot build a transport from', () => {
  assert.equal(normalizeProxyUrl('42.192.60.90:26720'), null)
  assert.equal(normalizeProxyUrl('ftp://host:21'), null)
  assert.equal(normalizeProxyUrl('http://'), null)
})

test('parses labelled and bare preset entries', () => {
  const presets = parseProxyPresets('北京中转=http://42.192.60.90:26720\nhttp://127.0.0.1:17897')
  assert.deepEqual(presets, [
    { label: '北京中转', url: 'http://42.192.60.90:26720' },
    { label: 'http://127.0.0.1:17897', url: 'http://127.0.0.1:17897' },
  ])
})

test('drops malformed entries instead of the whole preset table', () => {
  const presets = parseProxyPresets('好的=http://1.2.3.4:8080; 坏的=not-a-proxy; # 注释; 直连=direct')
  assert.deepEqual(presets, [{ label: '好的', url: 'http://1.2.3.4:8080' }])
})

test('deduplicates repeated proxy addresses', () => {
  const presets = parseProxyPresets('A=http://1.2.3.4:8080,B=http://1.2.3.4:8080')
  assert.deepEqual(presets, [{ label: 'A', url: 'http://1.2.3.4:8080' }])
})

test('treats an unset variable as no presets', () => {
  assert.deepEqual(parseProxyPresets(undefined), [])
  assert.deepEqual(parseProxyPresets(''), [])
})

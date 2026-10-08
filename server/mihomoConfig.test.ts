import assert from 'node:assert/strict'
import test from 'node:test'
import {
  buildMihomoConfig, isPortFree, kernelPortRange, listenerProxyUrl, mapMihomoError, mihomoErrorMessages, nodeSecrets, renderMihomoConfig, scrubMihomoText,
  type MihomoNodeEntry,
} from './mihomoConfig.js'

const controller = { port: 50123, secret: 'controller-secret-0123456789' }
const auth = { username: 'lu-user', password: 'lp-secret-pass' }

const ss = (id: string, port: number, extra: Record<string, unknown> = {}): MihomoNodeEntry => ({
  id, port, node: { name: '🇺🇸 美国 label', type: 'ss', server: 'node.example.com', port: 8388, cipher: 'aes-128-gcm', password: `pw-${id}`, ...extra },
})

test('config: loopback-only listeners, no global inbounds, tun/dns off, MATCH,DIRECT, no labels', () => {
  const built = buildMihomoConfig({ entries: [ss('px_aaaaaaaaaa', 27890), ss('px_bbbbbbbbbb', 27891)], listenerAuth: auth, controller })
  const config = built.config
  for (const key of ['port', 'socks-port', 'mixed-port', 'redir-port', 'tproxy-port']) assert.equal(config[key], 0, key)
  assert.equal(config['allow-lan'], false)
  assert.equal(config['bind-address'], '127.0.0.1')
  assert.deepEqual(config.tun, { enable: false })
  assert.deepEqual(config.dns, { enable: false })
  assert.equal(config['geo-auto-update'], false)
  assert.deepEqual(config.rules, ['MATCH,DIRECT'])
  assert.equal(config['external-controller'], '127.0.0.1:50123')
  assert.equal(config.secret, controller.secret)
  const listeners = config.listeners as Array<Record<string, unknown>>
  assert.equal(listeners.length, 2)
  for (const listener of listeners) {
    assert.equal(listener.type, 'socks')
    assert.equal(listener.listen, '127.0.0.1')
    assert.equal(listener.udp, false)
    assert.deepEqual(listener.users, [auth])
    assert.match(String(listener.proxy), /^n-px_/)
  }
  const proxies = config.proxies as Array<Record<string, unknown>>
  assert.deepEqual(proxies.map(proxy => proxy.name), ['n-px_aaaaaaaaaa', 'n-px_bbbbbbbbbb'])
  const text = renderMihomoConfig(config)
  assert.ok(!text.includes('美国'), 'labels never reach the config')
  assert.deepEqual(JSON.parse(text), config)
})

test('config: dangerous keys and file paths are dropped; wireguard private-key stays', () => {
  const built = buildMihomoConfig({
    entries: [
      ss('px_a', 27890, { 'interface-name': 'en0', 'routing-mark': 6666, 'dialer-proxy': 'other', certificate: '/etc/passwd', 'plugin-opts': { mode: 'tls', host: 'bing.com', 'private-key': '/x' } }),
      { id: 'px_w', port: 27891, node: { type: 'wireguard', server: 'wg.example.com', port: 51820, ip: '192.0.2.2', 'private-key': 'WGKEY', 'public-key': 'PUB' } },
    ],
    listenerAuth: null,
    controller,
  })
  const [first, second] = built.config.proxies as Array<Record<string, unknown>>
  for (const key of ['interface-name', 'routing-mark', 'dialer-proxy', 'certificate']) assert.equal(key in first, false, key)
  assert.deepEqual(first['plugin-opts'], { mode: 'tls', host: 'bing.com' })
  assert.equal(second['private-key'], 'WGKEY')
  const listener = (built.config.listeners as Array<Record<string, unknown>>)[0]
  assert.equal('users' in listener, false, 'PROXY_LISTENER_AUTH=off → no users block')
})

test('config: structural rejects (bad id, type, port range, duplicate port, controller port)', () => {
  const range = { base: 27890, count: 10 }
  const built = buildMihomoConfig({
    entries: [
      ss('ok_1', 27890),
      ss('bad id!', 27891),
      { id: 'snell_1', port: 27892, node: { type: 'snell', server: 'x.example.com', port: 1 } },
      ss('far_1', 40000),
      ss('dup_1', 27890),
      ss('noserver', 27893, { server: '' }),
    ],
    listenerAuth: auth,
    controller: { port: 27894, secret: 'x'.repeat(20) },
    portRange: range,
  })
  assert.deepEqual(built.entries.map(entry => entry.id), ['ok_1'])
  assert.deepEqual(Object.fromEntries(built.rejected.map(item => [item.id, item.reason])), {
    'bad id!': '条目标识无效',
    snell_1: '不支持的类型 snell',
    far_1: '本机端口不在内核端口范围内',
    dup_1: '本机端口重复',
    noserver: '缺少服务器地址',
  })
  const conflict = buildMihomoConfig({ entries: [ss('c_1', 27894)], listenerAuth: null, controller: { port: 27894, secret: 'x'.repeat(20) } })
  assert.equal(conflict.rejected[0].reason, '本机端口与内核控制端口冲突')
})

test('config: PROXY_KERNEL_DNS turns on a non-listening resolver only', () => {
  const built = buildMihomoConfig({ entries: [ss('px_a', 27890)], listenerAuth: null, controller, kernelDns: true })
  const dns = built.config.dns as Record<string, unknown>
  assert.equal(dns.enable, true)
  assert.equal(dns.listen, '')
  assert.equal(dns['enhanced-mode'], 'normal')
})

test('port range: defaults, env override, garbage falls back', () => {
  assert.deepEqual(kernelPortRange({}), { base: 27890, count: 1000 })
  assert.deepEqual(kernelPortRange({ PROXY_PORT_BASE: '30000', PROXY_PORT_COUNT: '20' }), { base: 30000, count: 20 })
  assert.deepEqual(kernelPortRange({ PROXY_PORT_BASE: '80', PROXY_PORT_COUNT: 'x' }), { base: 27890, count: 1000 })
})

test('listener URL percent-encodes credentials', () => {
  assert.equal(listenerProxyUrl(27890, { username: 'u', password: 'p@ss:/' }), 'socks5://u:p%40ss%3A%2F@127.0.0.1:27890')
  assert.equal(listenerProxyUrl(27890, null), 'socks5://127.0.0.1:27890')
})

test('isPortFree: a bound port is busy, a closed one is free', async () => {
  const net = await import('node:net')
  const server = net.createServer()
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as { port: number }).port
  assert.equal(await isPortFree(port), false)
  await new Promise<void>(resolve => server.close(() => resolve()))
  assert.equal(await isPortFree(port), true)
})

test('mihomo errors: extracts msg, maps proxy index to entry, scrubs hosts and secrets', () => {
  const output = [
    'time="x" level=info msg="Start initial configuration in progress"',
    'time="x" level=error msg="proxy 1: ss node.example.com:8388 cipher: bogus initialize error: unknown method: bogus pw-px_b"',
    'configuration file /data/proxy/mihomo/config.next.yaml test failed',
  ].join('\n')
  const [message] = mihomoErrorMessages(output)
  const entries = [ss('px_a', 27890), ss('px_b', 27891)]
  const mapped = mapMihomoError(message, entries)
  assert.equal(mapped.entryId, 'px_b')
  assert.equal(mapped.index, 1)
  assert.equal(mapped.reason, 'ss ***:8388 cipher: bogus initialize error: unknown method: bogus ***')
  const unmapped = mapMihomoError('yaml: line 1: did not find expected key', entries)
  assert.equal(unmapped.entryId, null)
  assert.equal(unmapped.reason, 'yaml: line 1: did not find expected key')
})

test('scrubMihomoText masks userinfo, uuids, IPs, domains, file paths and known secrets', () => {
  const text = scrubMihomoText('dial socks5://u:p@198.51.100.4:1080 uuid 0b5c5b9e-7d3f-4b8e-9c55-8f7e6b3a2d10 to [2001:db8::1]:443 via relay.example.net open /Users/x/data/proxy/mihomo/config.yaml TOKENVALUE', ['TOKENVALUE'])
  for (const leak of ['u:p', '198.51.100.4', '0b5c5b9e', '2001:db8', 'relay.example.net', '/Users/x', 'TOKENVALUE']) assert.ok(!text.includes(leak), leak)
  assert.deepEqual(nodeSecrets({ password: 'a', 'reality-opts': { 'public-key': 'b', 'short-id': 123 }, users: [{ uuid: 'c' }] }).sort(), ['123', 'a', 'b', 'c'])
  assert.deepEqual(nodeSecrets({ 'ws-opts': { headers: { Host: 'h.test', Cookie: 'ck' } }, 'http-opts': { headers: { 'X-Key': ['k1'] } } }).sort(), ['ck', 'k1'])
})

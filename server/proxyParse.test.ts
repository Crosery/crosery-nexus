import assert from 'node:assert/strict'
import test from 'node:test'
import { parseProxyInput, ProxyParseError } from './proxyParse.js'
import { maskNode, nodeDedupKey, nodeSecrets, parseProxyUrl, sanitizeClashProxy, urlDedupKey } from './proxyParseClash.js'
import { decodeBase64Text, isSubscriptionUrl, parseShareLink } from './proxyParseUri.js'

// every sample is synthetic: documentation IP ranges, example.test hosts, made-up keys
const b64 = (text: string) => Buffer.from(text, 'utf8').toString('base64')
const b64url = (text: string) => b64(text).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
const UUID = '00000000-0000-4000-8000-00000000abcd'

test('ss: SIP002 base64 userinfo, SIP002 plain 2022 cipher, legacy whole-body base64, obfs plugin', () => {
  const sip = parseShareLink(`ss://${b64url('aes-256-gcm:pa ss-1')}@203.0.113.10:8388#HK%2001`)
  assert.equal(sip.status, 'ok')
  assert.equal(sip.kind, 'mihomo')
  assert.deepEqual({ name: sip.name, ...sip.node }, { name: 'HK 01', server: '203.0.113.10', port: 8388, cipher: 'aes-256-gcm', password: 'pa ss-1', udp: true })

  const plain = parseShareLink('ss://2022-blake3-aes-128-gcm:YWJjZGVmZ2hpamtsbW5vcA%3D%3D@s.example.test:443#p')
  assert.equal(plain.node?.cipher, '2022-blake3-aes-128-gcm')
  assert.equal(plain.node?.password, 'YWJjZGVmZ2hpamtsbW5vcA==')

  const legacy = parseShareLink(`ss://${b64('aes-128-gcm:pw@198.51.100.2:443')}#legacy`)
  assert.equal(legacy.status, 'ok')
  assert.equal(legacy.node?.server, '198.51.100.2')
  assert.equal(legacy.node?.password, 'pw')

  const obfs = parseShareLink(`ss://${b64url('chacha20-ietf-poly1305:k')}@s.example.test:8443/?plugin=obfs-local%3Bobfs%3Dtls%3Bobfs-host%3Dcdn.example.test#o`)
  assert.equal(obfs.node?.plugin, 'obfs')
  assert.deepEqual(obfs.node?.['plugin-opts'], { mode: 'tls', host: 'cdn.example.test' })

  const v2ray = parseShareLink(`ss://${b64url('aes-128-gcm:k')}@s.example.test:443?plugin=v2ray-plugin%3Bmode%3Dwebsocket%3Btls%3Bhost%3Dw.example.test%3Bpath%3D%2Fws#v`)
  assert.deepEqual(v2ray.node?.['plugin-opts'], { mode: 'websocket', tls: true, host: 'w.example.test', path: '/ws' })

  assert.equal(parseShareLink(`ss://${b64url('aes-128-gcm:k')}@s.example.test:443?plugin=kcptun#k`).status, 'unsupported')
  assert.equal(parseShareLink(`ss://${b64url('bogus-cipher:k')}@s.example.test:443`).status, 'invalid')
})

test('ssr: fields split from the right, base64url params', () => {
  const body = `[2001:db8::5]:8443:auth_sha1_v4:chacha20-ietf:tls1.2_ticket_auth:${b64url('ssr-pass')}/?obfsparam=${b64url('cdn.example.test')}&protoparam=${b64url('1:abc')}&remarks=${b64url('台湾 ①')}`
  const ssr = parseShareLink(`ssr://${b64url(body)}`)
  assert.equal(ssr.status, 'ok', ssr.reason)
  assert.equal(ssr.name, '台湾 ①')
  assert.deepEqual(ssr.node, {
    server: '2001:db8::5', port: 8443, cipher: 'chacha20-ietf', password: 'ssr-pass', obfs: 'tls1.2_ticket_auth',
    protocol: 'auth_sha1_v4', 'obfs-param': 'cdn.example.test', 'protocol-param': '1:abc', udp: true,
  })
})

test('vmess: base64 JSON (ws+tls, ports as string or number), h2, http header, kcp unsupported, URL style', () => {
  const json = (extra: Record<string, unknown>) => `vmess://${b64(JSON.stringify({ v: '2', ps: '美国 🇺🇸', add: 'v.example.test', port: '443', id: UUID, aid: 0, scy: 'auto', net: 'ws', type: 'none', host: 'cdn.example.test', path: '/ray', tls: 'tls', sni: 'sni.example.test', ...extra }))}`
  const ws = parseShareLink(json({}))
  assert.equal(ws.status, 'ok', ws.reason)
  assert.equal(ws.name, '美国 🇺🇸')
  assert.equal(ws.node?.network, 'ws')
  assert.deepEqual(ws.node?.['ws-opts'], { path: '/ray', headers: { Host: 'cdn.example.test' } })
  assert.equal(ws.node?.tls, true)
  assert.equal(ws.node?.servername, 'sni.example.test')
  assert.equal(ws.node?.alterId, 0)
  assert.equal(parseShareLink(json({ port: 443 })).node?.port, 443)
  assert.equal(parseShareLink(json({ net: 'h2' })).node?.network, 'h2')
  const httpHeader = parseShareLink(json({ net: 'tcp', type: 'http', tls: '' }))
  assert.equal(httpHeader.node?.network, 'http')
  const kcp = parseShareLink(json({ net: 'kcp' }))
  assert.equal(kcp.status, 'unsupported')
  assert.equal(kcp.reason, 'vmess kcp 暂不支持')
  const urlStyle = parseShareLink(`vmess://${UUID}@v.example.test:8443?type=grpc&serviceName=svc&security=tls&sni=g.example.test#g`)
  assert.equal(urlStyle.status, 'ok', urlStyle.reason)
  assert.equal(urlStyle.node?.network, 'grpc')
  assert.deepEqual(urlStyle.node?.['grpc-opts'], { 'grpc-service-name': 'svc' })
})

test('vless: reality + vision, ws + tls, xhttp; trojan: ws, sni from peer', () => {
  const reality = parseShareLink(`vless://${UUID}@r.example.test:443?encryption=none&security=reality&sni=www.example.test&fp=chrome&pbk=AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_AbCd&sid=0a1b&type=tcp&flow=xtls-rprx-vision#Reality`)
  assert.equal(reality.status, 'ok', reality.reason)
  assert.equal(reality.node?.flow, 'xtls-rprx-vision')
  assert.deepEqual(reality.node?.['reality-opts'], { 'public-key': 'AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_AbCd', 'short-id': '0a1b' })
  assert.equal(reality.node?.['client-fingerprint'], 'chrome')
  assert.equal(reality.node?.servername, 'www.example.test')

  const ws = parseShareLink(`vless://${UUID}@w.example.test:443?security=tls&type=ws&host=h.example.test&path=%2Fv%3Fed%3D2048&sni=w.example.test&allowInsecure=1#ws`)
  assert.deepEqual(ws.node?.['ws-opts'], { path: '/v?ed=2048', headers: { Host: 'h.example.test' } })
  assert.equal(ws.node?.['skip-cert-verify'], true)

  const xhttp = parseShareLink(`vless://${UUID}@x.example.test:443?security=tls&type=xhttp&path=%2Fx&mode=auto&alpn=h2#x`)
  assert.equal(xhttp.node?.network, 'xhttp')
  assert.deepEqual(xhttp.node?.alpn, ['h2'])

  const trojan = parseShareLink('trojan://p%40ss%3Aword@t.example.test:443?type=ws&path=%2Ft&host=t.example.test&peer=peer.example.test#T')
  assert.equal(trojan.status, 'ok', trojan.reason)
  assert.equal(trojan.node?.password, 'p@ss:word')
  assert.equal(trojan.node?.sni, 'peer.example.test')
  assert.equal(trojan.node?.network, 'ws')
})

test('hysteria2 / hy2, tuic v5 and v4, wireguard', () => {
  const hy2 = parseShareLink('hy2://user:pw@h.example.test:443/?sni=h.example.test&insecure=1&obfs=salamander&obfs-password=ob&mport=20000-30000&pinSHA256=AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99#hy')
  assert.equal(hy2.status, 'ok', hy2.reason)
  assert.equal(hy2.node?.password, 'user:pw')
  assert.equal(hy2.node?.ports, '20000-30000')
  assert.equal(hy2.node?.obfs, 'salamander')
  assert.equal(hy2.node?.fingerprint, 'aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899')
  assert.equal(parseShareLink('hysteria2://pw@h.example.test:443#a').protocol, 'hysteria2')

  const tuic = parseShareLink(`tuic://${UUID}:tpw@u.example.test:443?congestion_control=bbr&udp_relay_mode=native&alpn=h3&sni=u.example.test&allow_insecure=1#t`)
  assert.equal(tuic.status, 'ok', tuic.reason)
  assert.equal(tuic.node?.uuid, UUID)
  assert.equal(tuic.node?.password, 'tpw')
  assert.equal(tuic.node?.['congestion-controller'], 'bbr')
  const tuicV4 = parseShareLink('tuic://sometoken@u.example.test:443#v4')
  assert.equal(tuicV4.node?.token, 'sometoken')

  const wg = parseShareLink('wireguard://cHJpdmF0ZWtleQ%3D%3D@w.example.test:51820?publickey=cHVibGljLWtleQ%3D%3D&address=192.0.2.2%2F32%2Cfd00%3A%3A2%2F128&reserved=1%2C2%2C3&mtu=1280#wg')
  assert.equal(wg.status, 'ok', wg.reason)
  assert.equal(wg.node?.['private-key'], 'cHJpdmF0ZWtleQ==')
  assert.equal(wg.node?.ip, '192.0.2.2')
  assert.equal(wg.node?.ipv6, 'fd00::2')
  assert.deepEqual(wg.node?.reserved, [1, 2, 3])
  assert.equal(parseShareLink('wg://k@w.example.test:51820?publickey=p&address=192.0.2.3').protocol, 'wireguard')
})

test('http/https/socks links are url entries; v2rayN socks base64 userinfo; loopback is external', () => {
  const socks = parseShareLink(`socks://${b64('alice:s3cret')}@198.51.100.7:1080#res`)
  assert.equal(socks.kind, 'url')
  assert.equal(socks.url, 'socks5://alice:s3cret@198.51.100.7:1080')
  const http = parseShareLink('http://u%40x:p%3Aw@proxy.example.test:3128')
  assert.equal(http.url, 'http://u%40x:p%3Aw@proxy.example.test:3128')
  assert.equal(parseShareLink('socks5h://127.0.0.1:7890').external, true)
  assert.equal(parseShareLink('https://proxy.example.test').serverPort, 443)
  assert.equal(parseShareLink('snell://x@y.test:1').status, 'unsupported')
  assert.equal(parseShareLink('not a link').status, 'invalid')
})

test('detection order: subscription URL vs proxy URL vs userinfo URL', () => {
  const sub = parseProxyInput('https://sub.example.test/api/v1/client/subscribe?token=SUB-TOKEN-123')
  assert.equal(sub.format, 'subscription')
  assert.equal(sub.providers.length, 1)
  assert.equal(sub.candidates.length, 0)
  assert.equal(parseProxyInput('http://203.0.113.9:8080').candidates[0].kind, 'url')
  assert.equal(parseProxyInput('http://203.0.113.9:8080/').candidates[0].kind, 'url')
  assert.equal(parseProxyInput('https://u:p@203.0.113.9:443/x').candidates[0].kind, 'url')
  assert.equal(isSubscriptionUrl('https://u:p@x.test/a'), false)
})

test('base64 blobs: standard padded, url-safe unpadded, wrapped lines, Clash YAML inside', () => {
  const lines = [`trojan://pw@t.example.test:443#a`, `ss://${b64url('aes-128-gcm:x')}@s.example.test:1#b`].join('\n')
  const standard = parseProxyInput(b64(lines))
  assert.equal(standard.format, 'base64')
  assert.equal(standard.candidates.length, 2)
  const urlsafe = parseProxyInput(b64url(lines))
  assert.equal(urlsafe.candidates.length, 2)
  const wrapped = parseProxyInput(b64(lines).replace(/(.{20})/g, '$1\n'))
  assert.equal(wrapped.candidates.length, 2)
  const yaml = parseProxyInput(b64('proxies:\n  - {name: y, type: ss, server: s.test, port: 2, cipher: aes-128-gcm, password: z}\n'))
  assert.equal(yaml.format, 'clash')
  assert.equal(decodeBase64Text('!!notbase64'), null)
})

test('Clash: providers (http fetched later, file unsupported, inline parsed), unsupported types, banner rows, ignored sections', () => {
  const doc = [
    'proxies:',
    '  - {name: "剩余流量：12.3 GB", type: ss, server: 127.0.0.1, port: 1, cipher: aes-128-gcm, password: x}',
    '  - {name: "到期：2026-12-01", type: trojan, server: t.example.test, port: 443, password: y}',
    '  - {name: snell-node, type: snell, server: s.test, port: 1, psk: z}',
    '  - {name: bad, type: vmess, server: v.test, port: 99999, uuid: u}',
    '  - {name: plain-socks, type: socks5, server: 198.51.100.3, port: 1080, username: u, password: p}',
    '  - {name: tls-socks, type: socks5, server: 198.51.100.3, port: 1081, tls: true}',
    '  - {name: dialer, type: ss, server: d.test, port: 2, cipher: aes-128-gcm, password: q, dialer-proxy: other, interface-name: en0, routing-mark: 5}',
    'proxy-providers:',
    '  airport:',
    '    type: http',
    '    url: "https://sub.example.test/link?token=TOK"',
    '    interval: 86400',
    '    override: {additional-prefix: "[A] "}',
    '  local:',
    '    type: file',
    '    path: ./x.yaml',
    '  inline:',
    '    type: inline',
    '    payload:',
    '      - {name: in1, type: ss, server: i.test, port: 3, cipher: aes-128-gcm, password: r}',
    'proxy-groups:',
    '  - {name: G, type: select, proxies: [bad]}',
    'rules:',
    '  - MATCH,G',
  ].join('\n')
  const parsed = parseProxyInput(doc)
  assert.equal(parsed.format, 'clash')
  const byName = Object.fromEntries(parsed.candidates.map(item => [item.name, item]))
  assert.equal(byName['剩余流量：12.3 GB'].status, 'info')
  assert.equal(byName['到期：2026-12-01'].status, 'info')
  assert.equal(byName['snell-node'].status, 'unsupported')
  assert.equal(byName['snell-node'].reason, '不支持的类型 snell')
  assert.equal(byName.bad.status, 'invalid')
  assert.equal(byName['plain-socks'].kind, 'url')
  assert.equal(byName['plain-socks'].url, 'socks5://u:p@198.51.100.3:1080')
  assert.equal(byName['tls-socks'].kind, 'mihomo')
  assert.deepEqual(Object.keys(byName.dialer.node ?? {}).sort(), ['cipher', 'password', 'port', 'server'])
  assert.equal(byName.local.status, 'unsupported')
  assert.equal(byName.local.reason, 'provider type file：不读取本地文件')
  assert.equal(byName.in1.status, 'ok')
  assert.equal(parsed.providers.length, 1)
  assert.equal(parsed.providers[0].prefix, '[A] ')
  assert.equal(parsed.providers[0].intervalH, 24)
  assert.ok(parsed.ignoredSections.includes('rules'))
  assert.ok(parsed.ignoredSections.includes('proxy-groups'))
})

test('subscription bodies never yield nested providers to fetch', () => {
  const parsed = parseProxyInput('proxy-providers:\n  p:\n    type: http\n    url: https://x.test/s?t=1\n', { fromSubscription: true })
  assert.equal(parsed.providers.length, 0)
})

test('sing-box / Surge / QX inputs get the ?flag=clash hint', () => {
  for (const sample of ['{"outbounds": [{"type": "vmess"}]}', '[Proxy]\nHK = ss, 198.51.100.4, 443, encrypt-method=aes-128-gcm, password=x', 'shadowsocks=198.51.100.4:443, method=aes-128-gcm, password=x, tag=a']) {
    assert.throws(() => parseProxyInput(sample), (error: unknown) => error instanceof ProxyParseError && error.code === 'unsupported_format' && Boolean(error.hint?.includes('flag=clash')))
  }
})

test('export JSON: masked entries cannot be imported, unmasked ones can; assignments parsed', () => {
  const masked = parseProxyInput(JSON.stringify({ format: 'crosery-proxy-pool', version: 1, entries: [{ ref: 'e1', name: 'm', kind: 'url', protocol: 'socks5', url: 'socks5://***@198.51.100.1:1080' }] }))
  assert.equal(masked.candidates[0].status, 'invalid')
  assert.equal(masked.candidates[0].reason, '脱敏导出不含密码，无法导入')
  const full = parseProxyInput(JSON.stringify({
    format: 'crosery-proxy-pool', version: 1,
    entries: [
      { ref: 'e1', name: 'u', kind: 'url', protocol: 'socks5', url: 'socks5://a:b@198.51.100.1:1080', tags: ['res'] },
      { ref: 'e2', name: 'n', kind: 'mihomo', protocol: 'trojan', node: { server: 't.test', port: 443, password: 'pw' } },
    ],
    assignments: [{ entryRef: 'e1', account: { backend: 'cpa', provider: 'claude', identity: 'claude-a@example.test.json' } }],
  }))
  assert.equal(full.format, 'export')
  assert.equal(full.candidates[0].status, 'ok')
  assert.deepEqual(full.candidates[0].tags, ['res'])
  assert.equal(full.candidates[1].node?.password, 'pw')
  assert.equal(full.assignments.length, 1)
})

test('dedup keys: socks5 = socks5h, host case, default ports, credential matters, transport does not', () => {
  const key = (url: string) => urlDedupKey(parseProxyUrl(url) as NonNullable<ReturnType<typeof parseProxyUrl>>)
  assert.equal(key('socks5://u:p@Proxy.Example.TEST:1080'), key('socks5h://u:p@proxy.example.test'))
  assert.equal(key('http://u:p@h.test'), key('http://u:p@h.test:80'))
  assert.notEqual(key('http://u:p@h.test'), key('https://u:p@h.test'))
  assert.notEqual(key('socks5://user-country-us:p@g.test:1'), key('socks5://user-country-jp:p@g.test:1'))
  const a = sanitizeClashProxy({ name: 'a', type: 'vmess', server: 'V.test', port: 443, uuid: UUID.toUpperCase(), network: 'ws', 'ws-opts': { path: '/a' } })
  const b = sanitizeClashProxy({ name: 'b', type: 'vmess', server: 'v.test', port: '443', uuid: UUID, network: 'grpc' })
  assert.equal(a.dedupKey, b.dedupKey)
  assert.notEqual(nodeDedupKey('ss', { server: 's', port: 1, cipher: 'aes-128-gcm', password: 'x' }), nodeDedupKey('ss', { server: 's', port: 1, cipher: 'aes-256-gcm', password: 'x' }))
})

test('names: control characters stripped, capped at 64; masked nodes hide every secret field', () => {
  const candidate = sanitizeClashProxy({ name: `a\u0000b\u202e${'x'.repeat(100)}`, type: 'trojan', server: 't.test', port: 1, password: 'secret-pw' })
  assert.ok(!candidate.name.includes('\u0000') && !candidate.name.includes('\u202e'))
  assert.equal(Array.from(candidate.name).length, 64)
  const masked = maskNode({ server: 's', port: 1, password: 'p', uuid: UUID, 'plugin-opts': { password: 'inner' }, 'private-key': 'k' })
  assert.equal(JSON.stringify(masked).includes('inner'), false)
  assert.equal(masked.password, '***')
  assert.equal(masked.uuid, '***')
})

test('masked nodes hide transport header values (any name) and uuid-shaped text; nodeSecrets lists them', () => {
  const COOKIE = 'session=synthetic-cookie-value'
  const KEY = 'synthetic-header-api-key'
  const candidate = sanitizeClashProxy({
    name: 'ws', type: 'trojan', server: 't.test', port: 443, password: 'secret-pw', network: 'ws',
    'ws-opts': { path: `/${UUID}?ed=2048`, headers: { Host: 'cdn.t.test', Cookie: COOKIE, 'X-Api-Key': KEY } },
  })
  assert.equal(candidate.status, 'ok')
  const masked = maskNode(candidate.node as Record<string, unknown>)
  const text = JSON.stringify(masked)
  for (const secret of [COOKIE, KEY, UUID, 'secret-pw']) assert.equal(text.includes(secret), false, secret)
  assert.equal(text.includes('cdn.t.test'), true, 'Host is not a credential')
  const secrets = nodeSecrets(candidate.node as Record<string, unknown>)
  for (const secret of [COOKIE, KEY]) assert.ok(secrets.includes(secret), secret)
  assert.equal(secrets.includes('cdn.t.test'), false)
})

test('a subscription address pasted many times is one provider and does not use up the cap', () => {
  const a = 'https://sub-a.example.test/api/v1/client/subscribe?token=A1'
  const b = 'https://sub-b.example.test/api/v1/client/subscribe?token=B2'
  const parsed = parseProxyInput([...Array.from({ length: 12 }, () => a), b, a].join('\n'))
  assert.deepEqual(parsed.providers.map(provider => provider.url), [a, b])
  assert.ok(parsed.notes.includes('重复的订阅链接已合并'))
  const clash = parseProxyInput(`proxy-providers:\n  p1:\n    type: http\n    url: ${a}\n  p2:\n    type: http\n    url: ${a}\nproxies: []\n`)
  assert.deepEqual(clash.providers.map(provider => provider.url), [a])
})

test('garbage never throws anything but ProxyParseError', () => {
  const samples = ['', ' ', '{', '[]', 'vmess://!!!', 'ss://@:', 'ssr://', `vmess://${b64('{"add": 1')}`, 'trojan://@:0', 'hy2://', 'tuic://:@x:1', 'wg://', 'http://', 'proxies: [', '- {', '\u0000\u0001', 'a'.repeat(5000)]
  for (const sample of samples) {
    try { parseProxyInput(sample) } catch (error) { assert.ok(error instanceof ProxyParseError, `${JSON.stringify(sample.slice(0, 40))} threw ${String(error)}`) }
  }
  const alphabet = 'abc:/@?#&=%-_.[]{}\n vmesstrojan'
  for (let round = 0; round < 400; round++) {
    let text = ['ss://', 'vmess://', 'vless://', 'trojan://', 'hy2://', 'tuic://', 'ssr://', ''][round % 8]
    for (let index = 0; index < 30; index++) text += alphabet[Math.floor(Math.random() * alphabet.length)]
    try { parseProxyInput(text) } catch (error) { assert.ok(error instanceof ProxyParseError, `${JSON.stringify(text)} threw ${String(error)}`) }
  }
})

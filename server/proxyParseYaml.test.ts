import assert from 'node:assert/strict'
import test from 'node:test'
import { CLASH_SKIP_SECTIONS, parseYamlSubset, YamlSubsetError } from './proxyParseYaml.js'

const clashOptions = { skipKeys: CLASH_SKIP_SECTIONS, requiredKeys: new Set(['proxies', 'proxy-providers']) }

test('block style proxies: quoted CJK/emoji names, numeric-looking secrets stay strings, nested opts', () => {
  const doc = [
    '# 订阅：示例',
    'mixed-port: 7890',
    'proxies:',
    '  - name: "🇭🇰 香港 01 | 专线"',
    '    type: vmess',
    '    server: hk.example.test',
    '    port: "443"',
    '    uuid: 00000000-0000-4000-8000-000000000001',
    '    alterId: 0',
    '    cipher: auto',
    '    tls: true',
    '    network: ws',
    '    ws-opts:',
    '      path: /ws?ed=2048   # comment after value',
    '      headers:',
    '        Host: cdn.example.test',
    "  - name: '日本 02 ''特价'''",
    '    type: ss',
    '    server: 203.0.113.5',
    '    port: 8388',
    '    cipher: aes-256-gcm',
    '    password: 123456',
    '  - name: vless-reality',
    '    type: vless',
    '    server: v.example.test',
    '    port: 443',
    '    uuid: 00000000-0000-4000-8000-000000000002',
    '    reality-opts:',
    '      public-key: AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_AbCd',
    '      short-id: 0123',
    '    alpn:',
    '      - h2',
    '      - http/1.1',
  ].join('\n')
  const { value } = parseYamlSubset(doc, clashOptions)
  const proxies = (value as Record<string, unknown>).proxies as Array<Record<string, any>>
  assert.equal(proxies.length, 3)
  assert.equal(proxies[0].name, '🇭🇰 香港 01 | 专线')
  assert.equal(proxies[0].port, '443')
  assert.equal(proxies[0]['ws-opts'].path, '/ws?ed=2048')
  assert.equal(proxies[0]['ws-opts'].headers.Host, 'cdn.example.test')
  assert.equal(proxies[1].name, "日本 02 '特价'")
  assert.equal(proxies[1].password, '123456')
  assert.equal(typeof proxies[1].password, 'string')
  assert.equal(proxies[2]['reality-opts']['short-id'], '0123')
  assert.deepEqual(proxies[2].alpn, ['h2', 'http/1.1'])
})

test('flow style: maps and lists inline, multi-line flow, quoted keys, empty values', () => {
  const doc = [
    'proxies:',
    '  - {name: "a, b", type: trojan, server: t.example.test, port: 443, password: "p:w#1", sni: x.test, alpn: [h2, "http/1.1"], ws-opts: {path: /t, headers: {Host: h.test}}}',
    '  - { "name": q, "type": ss, "server": s.test, "port": 1,',
    '      "cipher": aes-128-gcm, password: , udp: true }',
  ].join('\n')
  const proxies = (parseYamlSubset(doc, clashOptions).value as any).proxies
  assert.equal(proxies[0].name, 'a, b')
  assert.equal(proxies[0].password, 'p:w#1')
  assert.deepEqual(proxies[0].alpn, ['h2', 'http/1.1'])
  assert.equal(proxies[0]['ws-opts'].headers.Host, 'h.test')
  assert.equal(proxies[1].cipher, 'aes-128-gcm')
  assert.equal(proxies[1].password, null)
  assert.equal(proxies[1].udp, 'true')
})

test('compact sequences at the key indent, anchors, aliases and merge keys (explicit keys win)', () => {
  const doc = [
    'defaults: &d',
    '  udp: true',
    '  skip-cert-verify: false',
    '  cipher: chacha20-ietf-poly1305',
    'proxies:',
    '- name: one',
    '  type: ss',
    '  <<: *d',
    '  cipher: aes-256-gcm',
    '- &two {name: two, type: ss}',
    '- *two',
  ].join('\n')
  const proxies = (parseYamlSubset(doc, clashOptions).value as any).proxies
  assert.equal(proxies[0].udp, 'true')
  assert.equal(proxies[0].cipher, 'aes-256-gcm')
  assert.equal(proxies[1].name, 'two')
  assert.equal(proxies[2].name, 'two')
})

test('heavy sections are skipped unparsed; unreadable non-proxy sections do not reject the profile', () => {
  const rules = Array.from({ length: 30_000 }, (_, index) => `  - DOMAIN-SUFFIX,site${index}.test,PROXY`).join('\n')
  const doc = `proxies:\n  - {name: a, type: ss, server: s.test, port: 1, cipher: aes-128-gcm, password: x}\nrules:\n${rules}\nweird: !custom tag here\nproxy-groups:\n  - {name: G, type: select, proxies: [a]}\n`
  const result = parseYamlSubset(doc, clashOptions)
  assert.equal((result.value as any).proxies.length, 1)
  assert.ok(result.skipped.includes('rules'))
  assert.ok(result.skipped.includes('proxy-groups'))
  assert.ok(result.skipped.includes('weird'))
})

test('block scalars, multi-line quoted and plain scalars, BOM and CRLF', () => {
  const doc = '\uFEFFa: |\r\n  line1\r\n  line2\r\nb: >-\r\n  folded\r\n  text\r\nc: "multi\r\n  line"\r\nd: plain\r\n  continued\r\n'
  const value = parseYamlSubset(doc).value as any
  assert.equal(value.a, 'line1\nline2\n')
  assert.equal(value.b, 'folded text')
  assert.equal(value.c, 'multi line')
  assert.equal(value.d, 'plain continued')
})

test('double-quoted escapes', () => {
  const value = parseYamlSubset('a: "tab\\there \\u4e2d \\x41 \\"q\\""').value as any
  assert.equal(value.a, 'tab\there 中 A "q"')
})

test('limits: alias bomb, depth, size; rejected: multi-document, tags, tabs', () => {
  const bomb = ['a: &a [x,x,x,x,x,x,x,x,x,x]', 'b: &b [*a,*a,*a,*a,*a,*a,*a,*a,*a,*a]', 'c: &c [*b,*b,*b,*b,*b,*b,*b,*b,*b,*b]',
    'd: &d [*c,*c,*c,*c,*c,*c,*c,*c,*c,*c]', 'e: [*d,*d,*d,*d,*d,*d,*d,*d,*d,*d]'].join('\n')
  assert.throws(() => parseYamlSubset(bomb), /节点数超过上限/)
  assert.throws(() => parseYamlSubset(`a: ${'['.repeat(40)}${']'.repeat(40)}`), /嵌套超过 32 层/)
  let nested = 'a:\n'
  for (let depth = 1; depth < 40; depth++) nested += `${'  '.repeat(depth)}k${depth}:\n`
  assert.throws(() => parseYamlSubset(nested), /嵌套超过/)
  assert.throws(() => parseYamlSubset('a: 1\n---\nb: 2'), /多文档/)
  assert.throws(() => parseYamlSubset('a: !!str 1'), /标签/)
  assert.throws(() => parseYamlSubset('a:\n\tb: 1'), /制表符/)
  assert.throws(() => parseYamlSubset('a: x'.padEnd(64, ' '), { maxBytes: 16 }), /超过/)
  assert.throws(() => parseYamlSubset('a: *missing'), /未定义的锚点/)
})

test('a leading document marker and directives are fine', () => {
  assert.deepEqual(JSON.parse(JSON.stringify(parseYamlSubset('%YAML 1.2\n---\na: 1\n...\n').value)), { a: '1' })
})

test('__proto__ keys cannot pollute prototypes', () => {
  const value = parseYamlSubset('__proto__: {polluted: yes}\nconstructor: x\nok: 1').value as any
  assert.equal(({} as any).polluted, undefined)
  assert.equal(Object.keys(value).join(','), 'ok')
})

test('garbage never throws anything but YamlSubsetError', () => {
  const samples = ['{', '[a, b', 'a: "unterminated', '- - - -', ':', 'a:\n  - b\n c: d', '"\\q"', 'a: |9\nx', '? complex\n: v', 'a: [b: ]', '{a: b} c']
  for (const sample of samples) {
    try { parseYamlSubset(sample) } catch (error) { assert.ok(error instanceof YamlSubsetError, `${JSON.stringify(sample)} threw ${String(error)}`) }
  }
  for (let round = 0; round < 300; round++) {
    const alphabet = 'ab:-[]{}&*!|>"\'# \n,'
    let text = ''
    for (let index = 0; index < 40; index++) text += alphabet[Math.floor(Math.random() * alphabet.length)]
    try { parseYamlSubset(text) } catch (error) { assert.ok(error instanceof YamlSubsetError, `${JSON.stringify(text)} threw ${String(error)}`) }
  }
})

import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import { callbackPort, readCallback } from '../src/features/accounts/pasteCallback.js'

/** The add-account sheet's paste box and clipboard button (src/features/accounts/pasteCallback.ts). */

const expect = {
  state: 'web-s1',
  authUrl: 'https://auth.example.test/oauth/authorize?client_id=app_x&redirect_uri=http%3A%2F%2Flocalhost%3A1455%2Fauth%2Fcallback&state=web-s1',
  placeholder: 'http://localhost:1455/auth/callback?code=…&state=…',
}

test('this session\'s localhost callback URL: the one thing that may be submitted without a click', () => {
  const url = 'http://localhost:1455/auth/callback?code=ac_abc123&scope=openid&state=web-s1'
  assert.deepEqual(readCallback(url, expect), { kind: 'url', value: url })
  assert.deepEqual(readCallback(`  ${url}\n`, expect), { kind: 'url', value: url }, 'the trailing newline of a copied address bar')
  assert.deepEqual(readCallback('http://127.0.0.1:1455/auth/callback?code=c&state=web-s1', expect)?.kind, 'url')
  assert.deepEqual(readCallback('http://[::1]:1455/auth/callback?code=c&state=web-s1', expect)?.kind, 'url')
  assert.deepEqual(readCallback('http://localhost:1455/auth/callback#code=c&state=web-s1', expect)?.kind, 'url', 'state in the fragment')
})

test('another session\'s or another port\'s callback is stale and never sent', () => {
  for (const text of [
    'http://localhost:1455/auth/callback?code=c&state=old-s0',
    'http://localhost:1455/auth/callback?code=c',
    'http://localhost:54545/callback?code=c&state=web-s1',
    'http://localhost/auth/callback?code=c&state=web-s1',
    'code=c&state=old-s0',
  ]) assert.deepEqual(readCallback(text, expect), { kind: 'stale' }, text)
})

test('a bare code or a code= fragment: the button submits it, the quiet read does not (kind code)', () => {
  assert.deepEqual(readCallback('ac_Q1w2E3r4T5y6U7i8O9p0', expect), { kind: 'code', value: 'ac_Q1w2E3r4T5y6U7i8O9p0' })
  assert.deepEqual(readCallback('4/0AeanS0abc-def_ghi', expect), { kind: 'code', value: '4/0AeanS0abc-def_ghi' })
  assert.deepEqual(readCallback('code=ac_abc123&state=web-s1', expect), { kind: 'code', value: 'code=ac_abc123&state=web-s1' })
  assert.deepEqual(readCallback('?code=ac_abc123', expect), { kind: 'code', value: '?code=ac_abc123' })
})

test('nothing usable: prose, short words, other links, an API key, no session', () => {
  for (const text of [
    '', 'hello world', 'short', 'see http://localhost:1455/auth/callback?code=c&state=web-s1',
    'https://auth.example.test/oauth/authorize?state=web-s1', 'https://localhost:1455/auth/callback?code=c&state=web-s1',
    'http://callback.example.test:1455/auth/callback?code=c&state=web-s1', 'http://localhost:1455/auth/callback?state=web-s1',
    'sk-proj-abcdefghijklmnop', 'person@example.test', 'code=&state=web-s1',
  ]) assert.equal(readCallback(text, expect), null, text)
  assert.equal(readCallback(42, expect), null)
  assert.equal(readCallback('ac_Q1w2E3r4T5y6U7i8O9p0', null), null)
  assert.equal(readCallback('ac_Q1w2E3r4T5y6U7i8O9p0', { state: '' }), null)
})

test('the session port comes from redirect_uri, then the placeholder; without either any loopback port with the state counts', () => {
  assert.equal(callbackPort(expect), '1455')
  assert.equal(callbackPort({ state: 's', authUrl: 'https://auth.example.test/a?redirect_uri=http%3A%2F%2Flocalhost%3A51121%2Foauth-callback', placeholder: 'http://localhost:1455/x' }), '51121')
  assert.equal(callbackPort({ state: 's', authUrl: 'https://auth.example.test/a', placeholder: 'http://localhost:54545/callback?code=…&state=…' }), '54545')
  const anyPort = { state: 's-9', authUrl: 'https://auth.example.test/a', placeholder: 'http://localhost:…/callback?code=…' }
  assert.equal(callbackPort(anyPort), '')
  assert.equal(readCallback('http://localhost:56121/callback?code=c&state=s-9', anyPort)?.kind, 'url')
  assert.deepEqual(readCallback('http://localhost:56121/callback?code=c&state=s-8', anyPort), { kind: 'stale' })
})

test('sheet: the paste box says URL or code, Enter submits, the button reads the clipboard, the quiet read takes URLs only', () => {
  const sheet = fs.readFileSync(new URL('../src/features/accounts/AddAccountSheet.vue', import.meta.url), 'utf8')
  assert.match(sheet, /<label for="acc-cb" class="acc-add__lbl">粘贴回调地址或授权码<\/label>/)
  assert.match(sheet, /浏览器跳到 localhost 打不开是正常的 · 复制地址栏的完整地址，或只复制 code= 后面的授权码/)
  assert.match(sheet, /@submit\.prevent="submitCallback\(\)"[\s\S]{0,700}native-type="submit"/, 'Enter in the field submits the form')
  assert.match(sheet, /@click="pasteNow">[\s\S]{0,60}从剪贴板粘贴并提交/)
  assert.match(sheet, /<details v-if="failDetail" class="acc-add__raw">/)
  const clipboard = fs.readFileSync(new URL('../src/features/accounts/useClipboardCallback.ts', import.meta.url), 'utf8')
  assert.match(clipboard, /if \(found\?\.kind !== 'url' \|\| found\.value === tried\) return/, 'a bare code is never submitted on its own')
  assert.match(clipboard, /\.state === 'granted'/, 'returning to the tab never pops a permission prompt')
})

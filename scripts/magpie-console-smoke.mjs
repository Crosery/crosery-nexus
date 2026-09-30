import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import assert from 'node:assert/strict'

if (!process.argv.includes('--live')) throw new Error('Pass --live to opt into four tiny real upstream calls')
const runtime = process.env.MAGPIE_CONSOLE_RUNTIME || path.join(os.homedir(), '.agents/crosery/magpie-console')
const manifest = JSON.parse(await fs.readFile(path.join(runtime, 'console-manifest.json'), 'utf8'))
const consoleBase = `http://127.0.0.1:${manifest.consolePort}`
const gateway = `http://127.0.0.1:${manifest.gatewayPort}`
const password = (await fs.readFile(manifest.consolePasswordFile, 'utf8')).trim()
const login = await fetch(`${consoleBase}/api/login`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'admin', password }),
})
assert.equal(login.status, 200, 'Console login failed')
const cookie = login.headers.get('set-cookie')?.split(';')[0]
assert.ok(cookie)
const management = async (route, options = {}) => {
  const response = await fetch(consoleBase + route, {
    ...options, headers: { 'content-type': 'application/json', cookie }, signal: AbortSignal.timeout(30_000),
  })
  const value = await response.json()
  assert.ok(response.ok, `Local Console HTTP ${response.status}`)
  return value
}
const source = await management('/api/channels')
assert.equal(source.channels.filter(channel => channel.enabled).length, 2)
assert.equal(source.channels.filter(channel => !channel.enabled).length, 2)
const created = await management('/api/keys', {
  method: 'POST', body: JSON.stringify({ name: 'Magpie local verification', slug: 'magpie-local-verification',
    groups: ['openrouter'], totalConcurrency: 1, groupConcurrency: { openrouter: 1 } }),
})
const key = created.key
const keyId = created.item.id
assert.ok(key && keyId, 'Local key creation failed')
try {
  const headers = { authorization: `Bearer ${key}`, 'content-type': 'application/json' }
  const modelsResponse = await fetch(`${gateway}/v1/models`, { headers })
  const models = await modelsResponse.json()
  assert.equal(modelsResponse.status, 200)
  assert.equal(models.data.length, 20)
  assert.ok(!models.data.some(model => model.id === 'deepseek-v4.1-flash'), 'Channel ACL leaked another channel')
  const model = 'openrouter/free'
  const cases = [
    ['/v1/chat/completions', { model, stream: true, max_tokens: 16, messages: [{ role: 'user', content: 'Reply with just OK.' }] }],
    ['/v1/responses', { model, max_output_tokens: 16, input: 'Reply with just OK.' }],
    ['/v1/messages', { model, max_tokens: 16, messages: [{ role: 'user', content: 'Reply with just OK.' }] }],
    [`/v1beta/models/${model}:generateContent`, { contents: [{ role: 'user', parts: [{ text: 'Reply with just OK.' }] }], generationConfig: { maxOutputTokens: 16 } }],
  ]
  for (const [route, body] of cases) {
    const response = await fetch(gateway + route, { method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(120_000) })
    const text = await response.text()
    assert.equal(response.status, 200, `Live ${route} HTTP ${response.status}`)
    assert.equal(response.headers.get('x-crosery-engine'), 'magpie')
    assert.ok(text.length > 0)
    console.log(JSON.stringify({ route, status: response.status, engine: 'magpie', bytes: Buffer.byteLength(text) }))
  }
  const denied = await fetch(`${gateway}/v1/chat/completions`, {
    method: 'POST', headers, body: JSON.stringify({ model: 'deepseek-v4.1-flash', messages: [{ role: 'user', content: 'OK' }] }),
  })
  assert.equal(denied.status, 403)
  await denied.text()
  const usage = await management(`/api/usage-page?days=1&keyId=${encodeURIComponent(keyId)}`)
  console.log(JSON.stringify({ console: 'Crosery', channelAcl: 'passed', usageReportAvailable: Boolean(usage), note: 'Temporary local key will be removed; no source-management writes were made.' }))
} finally {
  await management(`/api/keys/${encodeURIComponent(keyId)}`, { method: 'DELETE' })
}

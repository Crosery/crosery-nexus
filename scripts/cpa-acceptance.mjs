#!/usr/bin/env node
/**
 * External acceptance of a CPA gateway through its public API (the same checks as `release.mjs accept`):
 * /v1/models, then per model a JSON completion, an SSE stream (content deltas and [DONE]) and a tool round trip
 * (call → tool result → the final answer contains the tool result).
 *
 *   CPA_ACCEPT_KEY=… node scripts/cpa-acceptance.mjs --base-url https://api.example.com --models a,b [--expect-version V]
 *
 * Prints { version: 1, ok, ranAt, baseUrl, models, cpaVersion, checks: [{ name, ok, detail }], summary } and exits 0 only
 * when every check passed. The key is read from the environment only (argv shows in `ps`) and never printed.
 */
import { realpathSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const TOOL_RESULT = '4217'
const TOOLS = [{ type: 'function', function: { name: 'get_build_number', description: 'Returns the current build number.', parameters: { type: 'object', properties: {} } } }]

class CheckError extends Error {}
const expect = (condition, message) => { if (!condition) throw new CheckError(message) }
const parse = text => { try { return JSON.parse(text) } catch { return null } }
const clip = (text, max = 160) => String(text ?? '').replace(/\s+/g, ' ').slice(0, max)

/** `https://host/v1/` and `https://host` both mean the gateway root. */
export function gatewayRoot(value) {
  const url = new URL(String(value))
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error(`base URL must be http(s): ${url.protocol}`)
  return `${url.origin}${url.pathname.replace(/\/+$/, '').replace(/\/v1$/, '')}`
}

export function checkModelsList({ status, text }) {
  expect(status === 200, `HTTP ${status} ${clip(text, 120)}`)
  const count = parse(text)?.data?.length ?? 0
  expect(count > 0, '模型列表为空')
  return `${count} 个模型`
}

export function checkJsonReply({ status, text }) {
  expect(status === 200, `HTTP ${status} ${clip(text)}`)
  const content = parse(text)?.choices?.[0]?.message?.content
  expect(typeof content === 'string' && content.trim(), '没有回复内容')
  return JSON.stringify(content.trim().slice(0, 30))
}

/** SSE body: at least one `data:` chunk carrying a non-empty content delta, and the closing `data: [DONE]`. */
export function checkStream({ status, text }) {
  expect(status === 200, `HTTP ${status} ${clip(text)}`)
  const events = String(text).split('\n').map(line => line.trim()).filter(line => line.startsWith('data:')).map(line => line.slice(5).trim())
  expect(events.includes('[DONE]'), '流没有 [DONE]')
  const deltas = events.filter(event => {
    const delta = parse(event)?.choices?.[0]?.delta?.content
    return typeof delta === 'string' && delta.length > 0
  }).length
  expect(deltas > 0, '流里没有内容增量')
  return `${events.length} 个事件 · ${deltas} 个内容增量`
}

/** First leg of the tool round trip: the model must call get_build_number. Returns the assistant message to replay. */
export function checkToolCall({ status, text }) {
  expect(status === 200, `HTTP ${status} ${clip(text)}`)
  const message = parse(text)?.choices?.[0]?.message
  const call = message?.tool_calls?.[0]
  expect(call?.function?.name === 'get_build_number' && typeof call.id === 'string', `模型没有调用工具：${clip(JSON.stringify(message ?? null))}`)
  return { role: 'assistant', content: message.content ?? null, tool_calls: message.tool_calls }
}

export function checkToolAnswer({ status, text }) {
  expect(status === 200, `HTTP ${status} ${clip(text)}`)
  const answer = parse(text)?.choices?.[0]?.message?.content ?? ''
  expect(typeof answer === 'string' && answer.includes(TOOL_RESULT), `回复里没有工具结果：${clip(answer, 80)}`)
  return 'tool result returned'
}

/** A running gateway that says another version than the one under test fails; one that does not say is noted only. */
export function checkVersionHeader(header, expected) {
  if (!expected) return header ? `版本 ${header}` : ''
  if (!header) return `没有 x-cpa-version 头（按状态文件认定在跑 ${expected}）`
  expect(header === expected, `在跑 ${header}，不是 ${expected}`)
  return `版本 ${header}`
}

/** Error text must never carry the key, whatever the upstream echoed back. */
export function redact(text, key) {
  let out = String(text ?? '')
  if (key) out = out.split(key).join('***')
  return out.replace(/\b(sk|rk|pk)-[A-Za-z0-9_-]{8,}/g, '$1-***').replace(/(bearer\s+)[^\s"',}]+/gi, '$1***')
}

export async function runAcceptance({ baseUrl, key, models, expectVersion = null, fetchImpl = fetch, timeoutMs = 120_000, now = Date.now }) {
  if (!key) throw new Error('CPA_ACCEPT_KEY is not set')
  const list = [...new Set((Array.isArray(models) ? models : String(models ?? '').split(',')).map(model => String(model).trim()).filter(Boolean))]
  if (!list.length) throw new Error('no models to accept (--models)')
  const root = gatewayRoot(baseUrl)
  const headers = { authorization: `Bearer ${key}`, 'content-type': 'application/json', 'cache-control': 'no-cache' }
  const call = async (route, body) => {
    const response = await fetchImpl(`${root}/v1${route}`, { method: body ? 'POST' : 'GET', headers, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(timeoutMs) })
    return { status: response.status, headers: response.headers, text: await response.text() }
  }
  const checks = []
  const check = async (name, fn) => {
    try {
      checks.push({ name, ok: true, detail: redact(await fn(), key).slice(0, 300) })
    } catch (error) {
      checks.push({ name, ok: false, detail: redact(error instanceof CheckError ? error.message : `${error?.name ?? 'Error'}: ${error?.message ?? error}`, key).slice(0, 300) })
    }
  }
  const ranAt = new Date(now()).toISOString()
  let cpaVersion = null
  await check('网关 /v1/models', async () => {
    const response = await call('/models')
    cpaVersion = response.headers?.get?.('x-cpa-version') || null
    const listed = checkModelsList(response)
    const version = checkVersionHeader(cpaVersion, expectVersion)
    return [listed, version].filter(Boolean).join(' · ')
  })
  for (const model of list) {
    await check(`${model} JSON`, async () => checkJsonReply(await call('/chat/completions', { model, messages: [{ role: 'user', content: 'Reply with the single word: pong' }], max_tokens: 64 })))
    await check(`${model} SSE`, async () => checkStream(await call('/chat/completions', { model, stream: true, messages: [{ role: 'user', content: 'Count from 1 to 5.' }], max_tokens: 64 })))
    await check(`${model} 工具往返`, async () => {
      const messages = [{ role: 'user', content: 'Call get_build_number, then reply with only the number it returned.' }]
      const assistant = checkToolCall(await call('/chat/completions', { model, messages, tools: TOOLS, max_tokens: 256 }))
      messages.push(assistant, { role: 'tool', tool_call_id: assistant.tool_calls[0].id, content: TOOL_RESULT })
      return checkToolAnswer(await call('/chat/completions', { model, messages, tools: TOOLS, max_tokens: 256 }))
    })
  }
  const failed = checks.filter(item => !item.ok)
  return {
    version: 1, ok: failed.length === 0, ranAt, baseUrl: root, models: list, cpaVersion, checks,
    summary: failed.length ? `${failed.length}/${checks.length} 项没过：${failed.slice(0, 3).map(item => item.name).join('、')}` : `${checks.length} 项全部通过`,
  }
}

async function main() {
  const arg = name => { const at = process.argv.indexOf(name); return at < 0 ? undefined : process.argv[at + 1] }
  const baseUrl = arg('--base-url') ?? process.env.CPA_ACCEPT_BASE_URL
  if (!baseUrl) throw new Error('--base-url (or CPA_ACCEPT_BASE_URL) is required')
  const timeout = Number(arg('--timeout-ms') ?? 120_000)
  const result = await runAcceptance({
    baseUrl, key: process.env.CPA_ACCEPT_KEY, models: arg('--models') ?? process.env.CPA_ACCEPT_MODELS,
    expectVersion: arg('--expect-version') ?? null, timeoutMs: Number.isFinite(timeout) && timeout > 0 ? timeout : 120_000,
  })
  console.log(JSON.stringify(result, null, 2))
  if (!result.ok) process.exitCode = 1
}

if (process.argv[1] && realpathSync(path.resolve(process.argv[1])) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(redact(error.message, process.env.CPA_ACCEPT_KEY)); process.exitCode = 2 })
}

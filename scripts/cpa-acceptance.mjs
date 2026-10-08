#!/usr/bin/env node
/**
 * External acceptance of a CPA gateway through its public API (the same checks as `release.mjs accept`):
 * /v1/models, then per model a JSON completion, an SSE stream (content deltas and [DONE]) and a tool round trip
 * (call → tool result → the final answer contains the tool result).
 *
 *   CPA_ACCEPT_KEY=… node scripts/cpa-acceptance.mjs --base-url https://api.example.com --models a,b [--expect-version V]
 *
 * Prints { version: 1, verdict, ok, ranAt, baseUrl, models, cpaVersion, checks: [{ name, ok, verdict, detail }], summary }.
 * verdict:
 *   passed        every check passed;
 *   failed        the trial binary answered and behaved wrongly (wrong JSON shape, no SSE deltas or [DONE], broken tool
 *                 round trip, 4xx on a listed model, an empty model list …);
 *   inconclusive  we could not tell: DNS, refused or reset connection, TLS, a timeout before any HTTP response, HTTP
 *                 502/503/504, a non-JSON /v1/models, an x-cpa-version that is not the expected one (not the trial
 *                 binary), 4xx on a model /v1/models does not list. Never grounds to reject a candidate.
 * Exit code: 0 passed · 1 failed · 3 inconclusive · 2 usage. The key is read from the environment only (argv shows in
 * `ps`) and never printed.
 */
import { realpathSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const TOOL_RESULT = '4217'
const TOOLS = [{ type: 'function', function: { name: 'get_build_number', description: 'Returns the current build number.', parameters: { type: 'object', properties: {} } } }]

class CheckError extends Error {}
/** Thrown when the answer says nothing about the trial binary: the network, a proxy, or another binary answered. */
class Inconclusive extends Error {}
const expect = (condition, message) => { if (!condition) throw new CheckError(message) }
const UNAVAILABLE = new Set([502, 503, 504])
const RESET = /ECONNRESET|EPIPE|UND_ERR_SOCKET|terminated|other side closed/i

/** `fetch failed` hides the reason in `cause`: ENOTFOUND, ECONNREFUSED, a TLS code … */
export function describeNetworkError(error) {
  const parts = []
  for (let item = error, depth = 0; item && depth < 4; item = item.cause, depth += 1) {
    const text = [item.code, item.name !== 'Error' && item.name !== 'TypeError' ? item.name : null, item.message].filter(Boolean).join(' ')
    if (text && !parts.includes(text)) parts.push(text)
  }
  return clip(parts.join(' · ') || String(error), 200)
}
const parse = text => { try { return JSON.parse(text) } catch { return null } }
const clip = (text, max = 160) => String(text ?? '').replace(/\s+/g, ' ').slice(0, max)

/** `https://host/v1/` and `https://host` both mean the gateway root. */
export function gatewayRoot(value) {
  const url = new URL(String(value))
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error(`base URL must be http(s): ${url.protocol}`)
  return `${url.origin}${url.pathname.replace(/\/+$/, '').replace(/\/v1$/, '')}`
}

/** /v1/models: a proxy page or an empty body is not the gateway talking; a JSON answer is. */
export function checkModelsList({ status, text }) {
  const body = parse(text)
  if (body === null || typeof body !== 'object') throw new Inconclusive(`HTTP ${status}，返回的不是 JSON（不是网关在应答）：${clip(text, 80)}`)
  expect(status === 200, `HTTP ${status} ${clip(text, 120)}`)
  const count = body?.data?.length ?? 0
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

/** Another version answering means this is not the trial binary (inconclusive); no header at all is noted only. */
export function checkVersionHeader(header, expected) {
  if (!expected) return header ? `版本 ${header}` : ''
  if (!header) return `没有 x-cpa-version 头（按状态文件认定在跑 ${expected}）`
  if (header !== expected) throw new Inconclusive(`应答的是 ${header}，不是试运行的 ${expected}`)
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
  // what /v1/models listed: a 4xx on a model it does not list says nothing about the binary
  let listed = null
  const call = async (route, body, model = null) => {
    let response
    try {
      response = await fetchImpl(`${root}/v1${route}`, { method: body ? 'POST' : 'GET', headers, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(timeoutMs) })
    } catch (error) {
      // nothing came back at all: DNS, refused, reset, TLS, or the timeout before the response
      throw new Inconclusive(`连不上网关：${describeNetworkError(error)}`)
    }
    let text
    try {
      text = await response.text()
    } catch (error) {
      // the connection dropped under the body: the network; the gateway stalling mid-answer is its own behaviour
      if (RESET.test(describeNetworkError(error))) throw new Inconclusive(`应答中途断开：${describeNetworkError(error)}`)
      throw new CheckError(`应答没读完：${describeNetworkError(error)}`)
    }
    if (UNAVAILABLE.has(response.status)) throw new Inconclusive(`HTTP ${response.status}（网关前的代理或上游不可用）：${clip(text, 80)}`)
    if (model && listed && !listed.has(model) && response.status >= 400 && response.status < 500) {
      throw new Inconclusive(`${model} 不在 /v1/models 里，HTTP ${response.status} 不能算到二进制头上`)
    }
    return { status: response.status, headers: response.headers, text }
  }
  const checks = []
  const check = async (name, fn) => {
    try {
      checks.push({ name, ok: true, verdict: 'passed', detail: redact(await fn(), key).slice(0, 300) })
    } catch (error) {
      const verdict = error instanceof Inconclusive ? 'inconclusive' : 'failed'
      const detail = error instanceof CheckError || error instanceof Inconclusive ? error.message : `${error?.name ?? 'Error'}: ${error?.message ?? error}`
      checks.push({ name, ok: false, verdict, detail: redact(detail, key).slice(0, 300) })
    }
  }
  const ranAt = new Date(now()).toISOString()
  let cpaVersion = null
  await check('网关 /v1/models', async () => {
    const response = await call('/models')
    cpaVersion = response.headers?.get?.('x-cpa-version') || null
    // first: is this the trial binary at all
    const version = checkVersionHeader(cpaVersion, expectVersion)
    const count = checkModelsList(response)
    listed = new Set((parse(response.text)?.data ?? []).map(item => item?.id).filter(id => typeof id === 'string'))
    return [count, version].filter(Boolean).join(' · ')
  })
  // the trial binary was not reached: the completions would only repeat that
  if (checks[0].verdict !== 'inconclusive') {
    for (const model of list) {
      const complete = body => call('/chat/completions', { model, ...body }, model)
      await check(`${model} JSON`, async () => checkJsonReply(await complete({ messages: [{ role: 'user', content: 'Reply with the single word: pong' }], max_tokens: 64 })))
      await check(`${model} SSE`, async () => checkStream(await complete({ stream: true, messages: [{ role: 'user', content: 'Count from 1 to 5.' }], max_tokens: 64 })))
      await check(`${model} 工具往返`, async () => {
        const messages = [{ role: 'user', content: 'Call get_build_number, then reply with only the number it returned.' }]
        const assistant = checkToolCall(await complete({ messages, tools: TOOLS, max_tokens: 256 }))
        messages.push(assistant, { role: 'tool', tool_call_id: assistant.tool_calls[0].id, content: TOOL_RESULT })
        return checkToolAnswer(await complete({ messages, tools: TOOLS, max_tokens: 256 }))
      })
    }
  }
  const failed = checks.filter(item => item.verdict === 'failed')
  const unsure = checks.filter(item => item.verdict === 'inconclusive')
  // a wrong answer from the binary decides; anything we could not judge only postpones
  const verdict = failed.length ? 'failed' : unsure.length ? 'inconclusive' : 'passed'
  const names = items => items.slice(0, 3).map(item => item.name).join('、')
  return {
    version: 1, verdict, ok: verdict === 'passed', ranAt, baseUrl: root, models: list, cpaVersion, checks,
    summary: verdict === 'failed' ? `${failed.length}/${checks.length} 项没过：${names(failed)}`
      : verdict === 'inconclusive' ? `没有结论：${unsure[0].detail.slice(0, 120)}（${names(unsure)}）`
        : `${checks.length} 项全部通过`,
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
  process.exitCode = result.verdict === 'passed' ? 0 : result.verdict === 'failed' ? 1 : 3
}

if (process.argv[1] && realpathSync(path.resolve(process.argv[1])) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(redact(error.message, process.env.CPA_ACCEPT_KEY)); process.exitCode = 2 })
}

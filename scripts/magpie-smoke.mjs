import assert from 'node:assert/strict'

// Explicit live opt-in: never run paid/upstream requests as part of npm test.
if (process.argv[2] !== '--live') throw new Error('Usage: node scripts/magpie-smoke.mjs --live [model]')
const model = process.argv[3] || 'crosery/gpt-5.6-luna'
const gateway = process.env.MAGPIE_SMOKE_URL || 'http://127.0.0.1:3465'
const prompt = 'Reply with just OK.'
const cases = [
  { name: 'chat-sse', path: '/v1/chat/completions', body: {
    model, messages: [{ role: 'user', content: prompt }], max_tokens: 256, reasoning_effort: 'low', stream: true,
  }, check(text, response) {
    assert.match(response.headers.get('content-type') || '', /text\/event-stream/)
    assert.match(text, /data:/)
    assert.match(text, /\[DONE\]/)
    return { sseComplete: true }
  } },
  { name: 'responses', path: '/v1/responses', body: {
    model, input: prompt, max_output_tokens: 256, reasoning: { effort: 'low' },
  }, check(text) {
    const json = JSON.parse(text)
    assert.equal(json.object, 'response')
    assert.ok(Array.isArray(json.output))
    assert.ok(json.output.some(item => item.content?.some(content => content.type === 'output_text' && content.text)))
    return { status: json.status, outputItems: json.output.length }
  } },
  { name: 'messages', path: '/v1/messages', body: {
    model, max_tokens: 256, messages: [{ role: 'user', content: prompt }],
  }, check(text) {
    const json = JSON.parse(text)
    assert.equal(json.type, 'message')
    assert.ok(json.content.some(item => item.type === 'text' && item.text))
    return { stopReason: json.stop_reason }
  } },
  { name: 'gemini-translation', path: `/v1beta/models/${model}:generateContent`, body: {
    contents: [{ role: 'user', parts: [{ text: prompt }] }], generationConfig: { maxOutputTokens: 256 },
  }, check(text) {
    const json = JSON.parse(text)
    assert.ok(json.candidates?.some(item => item.content?.parts?.some(part => part.text)))
    return { candidates: json.candidates.length }
  } },
  { name: 'messages-count', path: '/v1/messages/count_tokens', body: {
    model, messages: [{ role: 'user', content: prompt }],
  }, check(text) {
    const json = JSON.parse(text)
    assert.ok(Number.isFinite(json.input_tokens) && json.input_tokens > 0)
    return { tokens: json.input_tokens, note: 'May be an estimate, not an authoritative upstream tokenizer' }
  } },
  { name: 'gemini-count', path: `/v1beta/models/${model}:countTokens`, body: {
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
  }, check(text) {
    const json = JSON.parse(text)
    assert.ok(Number.isFinite(json.totalTokens) && json.totalTokens > 0)
    return { tokens: json.totalTokens, note: 'Local conversion estimate' }
  } },
]
let failed = 0
for (const entry of cases) {
  const start = Date.now()
  try {
    const response = await fetch(gateway + entry.path, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer magpie',
        'anthropic-version': '2023-06-01', 'user-agent': 'crosery-magpie-smoke' },
      body: JSON.stringify(entry.body), signal: AbortSignal.timeout(90_000),
    })
    const text = await response.text()
    assert.equal(response.status, 200, `HTTP ${response.status}; response body deliberately not logged`)
    console.log(JSON.stringify({ case: entry.name, ok: true, ms: Date.now() - start, ...entry.check(text, response) }))
  } catch (error) {
    failed++
    console.log(JSON.stringify({ case: entry.name, ok: false, ms: Date.now() - start,
      error: error.message.slice(0, 180) }))
  }
}
process.exitCode = failed ? 1 : 0

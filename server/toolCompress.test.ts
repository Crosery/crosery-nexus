import assert from 'node:assert/strict'
import test from 'node:test'
import { compressRequestToolOutputs, compressToolText, MIN_COMPRESS_BYTES } from './toolCompress.js'

const repeated = Array(100).fill('stdout: identical diagnostic detail, retained with its occurrence count').join('\n')
const unique = Array.from({ length: 360 }, (_, index) => `source ${index}: const value${index} = "unique semantic content ${index}";`).join('\n')

function assertInvariants(raw: string): string {
  const result = compressToolText(raw)
  const difference = Buffer.byteLength(raw, 'utf8') - Buffer.byteLength(result.text, 'utf8')
  assert.equal(result.saved, difference)
  assert.ok(Number.isInteger(result.saved) && result.saved >= 0)
  assert.ok(Math.floor(result.saved / 4) >= 0)
  assert.ok(Math.floor(result.saved / 4) * 4 <= result.saved)
  assert.deepEqual(compressToolText(result.text), { text: result.text, saved: 0 })
  assert.deepEqual(compressToolText(raw), result)
  return result.text
}

test('small outputs pass through byte-for-byte, including colors, carriage returns and repetitions', () => {
  for (const raw of ['', 'Checking error: missing file', '10%\r20%\r100%\r\n', '\x1b[31merror\x1b[0m', 'same\nsame\nsame', '界'.repeat(600), 'x'.repeat(MIN_COMPRESS_BYTES - 1)]) {
    assert.ok(Buffer.byteLength(raw, 'utf8') < MIN_COMPRESS_BYTES)
    assert.deepEqual(compressToolText(raw), { text: raw, saved: 0 })
    assertInvariants(raw)
  }
})

test('large unique output, source lines and unique middle errors are never truncated', () => {
  const lines = unique.split('\n')
  lines.splice(180, 0, 'ERROR unique-middle: connection refused at /src/critical.ts:901')
  const raw = lines.join('\n')
  assert.deepEqual(compressToolText(raw), { text: raw, saved: 0 })
  assertInvariants(raw)
})

test('diagnostic prefixes, separators, blank lines and non-progress labels are not noise', () => {
  const diagnostic = [
    'Checking error: filesystem access denied',
    'Compiling ERROR TS2322: incompatible type',
    'Loading warning: certificate expired',
    'Building failed: linker symbol missing',
    'Fetching error: authentication rejected',
    'Downloading warning: truncated response',
    'Progress: 10%',
    '101%',
    '999%',
    '50% ERROR: operation aborted',
    '--- distinct separator ---',
    '====',
    '',
    '    const source = "Checking error";',
  ].join('\n')
  const raw = `${repeated}\n${diagnostic}\n${unique}`
  const text = assertInvariants(raw)
  assert.ok(text.includes(diagnostic))
  assert.ok(text.includes(unique))
  assert.ok(compressToolText(raw).saved > 0)
})

test('identical adjacent lines collapse with a stable visible count and retain the original line', () => {
  const line = 'ERROR repeated: a detailed error that must survive'
  const raw = `${unique}\n${Array(90).fill(line).join('\n')}\n${unique}`
  const text = assertInvariants(raw)
  assert.equal(text, `${unique}\n${line}\n[RTK identical line: 90 times]\n${unique}`)
  assert.ok(Buffer.byteLength(text, 'utf8') >= MIN_COMPRESS_BYTES, 'idempotence is exercised above the threshold')
  const nonAdjacent = `${unique}\n${line}\nunique intervening detail\n${line}`
  assert.deepEqual(compressToolText(nonAdjacent), { text: nonAdjacent, saved: 0 })
})

test('only standalone numeric percentage progress collapses, with the final value and update count', () => {
  const progress = Array.from({ length: 500 }, (_, index) => `${index % 101}%`).join('\n')
  const raw = `${unique}\n${progress}\nChecking error: keep this final failure`
  const text = assertInvariants(raw)
  assert.equal(text, `${unique}\n95%\n[RTK numeric progress: 500 updates]\nChecking error: keep this final failure`)
  const bracketed = Array.from({ length: 300 }, (_, index) => `[ ${index % 100}% ]`).join('\n')
  assert.equal(assertInvariants(`${unique}\n${bracketed}`), `${unique}\n[ 99% ]\n[RTK numeric progress: 300 updates]`)
})

test('CRLF is a line boundary, while numeric CR overwrite frames are counted together', () => {
  const crlfUnique = unique.replaceAll('\n', '\r\n')
  assert.deepEqual(compressToolText(crlfUnique), { text: crlfUnique, saved: 0 })
  const crlfRepeated = Array(70).fill('Loading error: unique error text repeated intentionally').join('\r\n') + '\r\n'
  assert.equal(assertInvariants(crlfRepeated), 'Loading error: unique error text repeated intentionally\r\n[RTK identical line: 70 times]\r\n')
  const frames = Array.from({ length: 500 }, (_, index) => `${index % 101}%`).join('\r')
  assert.equal(assertInvariants(`${unique}\n${frames}\n${unique}`), `${unique}\n95%\n[RTK numeric progress: 500 updates]\n${unique}`)
  assert.equal(assertInvariants(`${unique}\n${frames}\r\n${unique}`), `${unique}\n95%\r\n[RTK numeric progress: 500 updates]\r\n${unique}`)
  const mixedBoundaries = `${unique}\n10%\n20%\n${frames}\n${unique}`
  assert.equal(assertInvariants(mixedBoundaries), `${unique}\n95%\n[RTK numeric progress: 502 updates]\n${unique}`)
})

test('CR overwrite never erases unique diagnostics, even next to numeric progress', () => {
  const diagnostics = [
    'Checking error: initial failure\rChecking error: second failure',
    'Compiling warning: unsupported flag\rLoading error: final failure',
    '10%\rERROR: download failed\r100%',
    'source: a = 1\rsource: a = 2',
  ].join('\n')
  const raw = `${unique}\n${diagnostics}`
  assert.deepEqual(compressToolText(raw), { text: raw, saved: 0 })
  assertInvariants(raw)
})

test('SGR colors are removed without swallowing OSC payloads, unknown controls or malformed escapes', () => {
  const colored = unique.split('\n').map(line => `\x1b[31m${line}\x1b[0m`).join('\n')
  assert.equal(assertInvariants(colored), unique)
  const rgb = `\x1b[38;2;255;80;0m${unique}\x1b[0m`
  assert.equal(assertInvariants(rgb), unique)
  for (const escape of [
    '\x1b]8;;https://example.test/private\x1b\\source link\x1b]8;;\x1b\\',
    '\x1b]0;unterminated title\nERROR: title payload must survive',
    '\x1b[2KERROR: cursor/erase sequence is not a color',
    '\x1b[\x1b[31m0mERROR: nested malformed escape',
  ]) {
    const raw = `${colored}\n${escape}`
    assert.deepEqual(compressToolText(raw), { text: raw, saved: 0 })
    assertInvariants(raw)
  }
})

test('markers and long histories remain byte-stable rather than being collapsed again', () => {
  const markers = [
    '[RTK identical line: 100 times]',
    '[RTK numeric progress: 400 updates]',
    '[RTK original application message]',
    '[RTK original application message]',
    '[RTK original application message]',
    '[… 中转站 RTK 已省略 200 行噪音输出 …]',
    'source [x7 重复行]',
  ].join('\n')
  const raw = `${unique}\n${markers}\n${repeated}\n${unique}`
  const text = assertInvariants(raw)
  assert.ok(text.includes(markers))
  assert.ok(Buffer.byteLength(text, 'utf8') >= MIN_COMPRESS_BYTES)
})

test('UTF-8 savings are actual nonnegative bytes and summaries never enlarge a run', () => {
  for (const raw of [
    Array(100).fill('界面警告：重复内容且必须保留次数').join('\n'),
    `${unique}\na\na\na`,
    `${unique}\n\n\n\n`,
    `${unique}\n1%\n2%\n3%`,
    `${unique}\n${'\x1b[0m'.repeat(100)}`,
    `${unique}\n${repeated}`,
  ]) assertInvariants(raw)
  assert.deepEqual(compressToolText(`${unique}\na\na\na`), { text: `${unique}\na\na\na`, saved: 0 })
  assert.deepEqual(compressToolText(`${unique}\n1%\n2%\n3%`), { text: `${unique}\n1%\n2%\n3%`, saved: 0 })
})

test('Anthropic tool-result strings and text parts change in place, with metadata and non-text isolated', () => {
  const cache = { type: 'ephemeral', ttl: '1h' }
  const text = { type: 'text', text: repeated, cache_control: cache, citations: [{ source: 'keep' }] }
  const nonText = [
    { type: 'image', text: repeated, source: { type: 'base64', data: 'keep' }, cache_control: cache },
    { type: 'document', text: repeated, cache_control: cache },
    { type: 'input_text', text: repeated, cache_control: cache },
    { text: repeated, cache_control: cache },
    { type: 'json', text: repeated, data: { output: repeated } },
    null,
    repeated,
  ]
  const carrier = [text, ...nonText]
  const part = { type: 'tool_result', tool_use_id: 'call-1', is_error: true, content: carrier, cache_control: cache }
  const messages = [{ role: 'user', content: [part, { type: 'text', text: repeated, cache_control: cache }] }]
  const body = { system: [{ type: 'text', text: repeated, cache_control: cache }], messages, tools: [{ name: 'run', description: repeated }] }
  const before = structuredClone(body)
  const result = compressRequestToolOutputs(body)
  const expected = compressToolText(repeated)
  const expectedPart = before.messages[0]!.content[0] as typeof part
  const expectedText = expectedPart.content[0] as typeof text
  expectedText.text = expected.text
  assert.equal(result.body, body)
  assert.equal(result.saved, expected.saved)
  assert.equal(text.text, expected.text)
  assert.equal(part.content, carrier)
  assert.equal(carrier[0], text)
  assert.equal(text.cache_control, cache)
  assert.equal(part.cache_control, cache)
  assert.deepEqual(carrier.slice(1), nonText)
  assert.deepEqual(body, before)
  const stringBody = { messages: [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call-2', content: repeated, cache_control: cache }] }] }
  assert.equal(compressRequestToolOutputs(stringBody).saved, expected.saved)
  assert.equal(stringBody.messages[0]!.content[0]!.content, expected.text)
  assert.equal(stringBody.messages[0]!.content[0]!.cache_control, cache)
})

test('Chat tool/function strings and text parts change, while assistant, user and system content do not', () => {
  const cache = { type: 'ephemeral' }
  const part = { type: 'text', text: repeated, cache_control: cache }
  const nonText = { type: 'image_url', text: repeated, image_url: { url: 'keep' } }
  const arbitrary = { text: repeated }
  const content = [part, nonText, arbitrary, { type: 'input_text', text: repeated }]
  const messages = [
    { role: 'tool', tool_call_id: 'call-1', content },
    { role: 'function', name: 'run', content: repeated },
    { role: 'system', content: repeated },
    { role: 'assistant', content: repeated, tool_calls: [{ function: { arguments: repeated } }] },
    { role: 'user', content: repeated },
    { role: 'tool' },
  ]
  const body = { messages, tools: [{ type: 'function', function: { description: repeated } }] }
  const before = structuredClone(body)
  const result = compressRequestToolOutputs(body)
  const expected = compressToolText(repeated)
  const expectedContent = before.messages[0]!.content as typeof content
  const expectedPart = expectedContent[0] as typeof part
  expectedPart.text = expected.text
  before.messages[1]!.content = expected.text
  assert.equal(result.body, body)
  assert.equal(result.saved, expected.saved * 2)
  assert.equal(messages[0]!.content, content)
  assert.equal(content[0], part)
  assert.equal(part.cache_control, cache)
  assert.equal(part.text, expected.text)
  assert.equal(messages[1]!.content, expected.text)
  assert.deepEqual(body, before)
  assert.equal(Object.hasOwn(messages[5]!, 'content'), false)
})

test('Responses function_call_output changes only strings and input_text parts', () => {
  const cache = { type: 'ephemeral' }
  const text = { type: 'input_text', text: repeated, cache_control: cache }
  const nonText = [
    { type: 'input_image', text: repeated, image_url: 'keep' },
    { type: 'input_file', text: repeated, file_id: 'keep' },
    { type: 'output_text', text: repeated, annotations: [] },
    { type: 'text', text: repeated },
    { text: repeated },
  ]
  const output = [text, ...nonText]
  const input = [
    { type: 'function_call_output', call_id: 'call-1', output },
    { type: 'function_call_output', call_id: 'call-2', output: repeated },
    { type: 'function_call', arguments: repeated },
    { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: repeated }] },
    { type: 'function_call_output', call_id: 'call-3', output: { text: repeated } },
  ]
  const body = { instructions: repeated, input, tools: [{ description: repeated }] }
  const before = structuredClone(body)
  const result = compressRequestToolOutputs(body)
  const expected = compressToolText(repeated)
  const expectedOutput = before.input[0]!.output as typeof output
  const expectedText = expectedOutput[0] as typeof text
  expectedText.text = expected.text
  before.input[1]!.output = expected.text
  assert.equal(result.body, body)
  assert.equal(result.saved, expected.saved * 2)
  assert.equal(input[0]!.output, output)
  assert.equal(output[0], text)
  assert.equal(text.cache_control, cache)
  assert.equal(text.text, expected.text)
  assert.deepEqual(output.slice(1), nonText)
  assert.deepEqual(body, before)
})

test('structured Gemini results, other message roles and arbitrary objects are untouched', () => {
  const body = {
    contents: [{ role: 'user', parts: [{ functionResponse: { name: 'run', response: { text: repeated, result: repeated } } }] }],
    messages: [
      { role: 'assistant', content: [{ type: 'tool_result', content: repeated }] },
      { role: 'system', content: [{ type: 'tool_result', content: repeated }] },
      { role: 'user', content: [{ type: 'text', text: repeated }, { text: repeated }] },
      { role: 'tool', content: { type: 'text', text: repeated } },
      null,
    ],
    input: [{ type: 'function_call_output', output: { response: repeated } }, null],
    tools: [{ description: repeated }],
  }
  const before = structuredClone(body)
  assert.deepEqual(compressRequestToolOutputs(body), { body, saved: 0 })
  assert.deepEqual(body, before)
})

test('repeated complete request histories produce identical serialized bytes and exact aggregate savings', () => {
  const history = {
    system: 'unchanged system prompt',
    messages: [
      { role: 'user', content: 'unchanged user prompt' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'call-1', input: { command: repeated } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call-1', content: `${unique}\n${repeated}`, cache_control: { type: 'ephemeral' } }] },
      { role: 'tool', tool_call_id: 'call-2', content: repeated },
    ],
    input: [{ type: 'function_call_output', call_id: 'call-3', output: repeated }],
  }
  const expectedSaved = compressToolText(`${unique}\n${repeated}`).saved + 2 * compressToolText(repeated).saved
  const first = structuredClone(history)
  const result = compressRequestToolOutputs(first)
  const serialized = JSON.stringify(first)
  assert.equal(result.saved, expectedSaved)
  assert.ok(result.saved > 0)
  assert.ok(Math.floor(result.saved / 4) >= 0)
  assert.equal(result.body, first)
  for (let round = 0; round < 4; round++) {
    const resend = structuredClone(history)
    assert.equal(compressRequestToolOutputs(resend).saved, expectedSaved)
    assert.equal(JSON.stringify(resend), serialized)
    assert.equal(compressRequestToolOutputs(first).saved, 0)
    assert.equal(JSON.stringify(first), serialized)
  }
})

import assert from 'node:assert/strict'
import test from 'node:test'
import {
  AUTH_HEADER,
  CRAPI_INSTALL,
  DEFAULT_BASE,
  DEFAULT_EXAMPLES,
  EXPORT_COPY,
  anthropicBaseOf,
  clientSnippets,
  crapiCommands,
  faqItems,
  inlineParts,
  modelsCheck,
  pickExamples,
  vendorOf,
  vendorShares,
} from '../src/features/help/helpContent.js'

/*
 * /help content (src/features/help/helpContent.ts) — the pure part of the page: snippets, example-model picking,
 * vendor grouping and the FAQ. Rendering is covered by the build + visual QA.
 */

const BASE = 'https://gateway.example.test/v1'
const CATALOG = [
  '~anthropic/claude-sonnet-latest',
  'anthropic/claude-sonnet-5.5',
  'anthropic/claude-sonnet-5.5:batch',
  'claude-haiku-4-5-20251001',
  'claude-sonnet-4-6',
  'claude-sonnet-5',
  'claude-sonnet-5-5',
  'gpt-5.5',
  'gpt-5.6-sol',
  'gpt-6-sol',
  'gpt-6.1-sol',
  'openai/gpt-5-image',
  'openai/gpt-oss-120b',
  'qwen/qwen3-max',
  'gemini-3.8-flash',
]

test('help: every snippet reads the key from CROSERY_API_KEY and never carries a key fragment', () => {
  const variants = [...clientSnippets(BASE, anthropicBaseOf(BASE), DEFAULT_EXAMPLES), modelsCheck(BASE), ...CRAPI_INSTALL, crapiCommands(DEFAULT_EXAMPLES)]
  for (const v of variants) {
    const text = `${v.code}\n${v.copyValue ?? ''}`
    assert.doesNotMatch(text, /sk-[A-Za-z0-9]/, `${v.id} must not contain a key`)
    assert.doesNotMatch(text, /<YOUR_API_KEY>|<KEY>/, `${v.id} uses the unified placeholder`)
  }
  for (const v of clientSnippets(BASE, anthropicBaseOf(BASE), DEFAULT_EXAMPLES)) {
    assert.match(v.code, /CROSERY_API_KEY/, `${v.id} reads the key from the environment`)
    assert.ok(v.facts.length > 0 && v.facts.length <= 3, `${v.id} has 1–3 facts`)
  }
  assert.match(modelsCheck(BASE).code, /\$CROSERY_API_KEY/)
  assert.equal(AUTH_HEADER, 'Authorization: Bearer $CROSERY_API_KEY')
  assert.equal(EXPORT_COPY, "export CROSERY_API_KEY=''")
})

test('help: snippets use the given base; Anthropic clients get the base without /v1', () => {
  const byId = Object.fromEntries(clientSnippets(BASE, 'https://gateway.example.test', DEFAULT_EXAMPLES).map((v) => [v.id, v]))
  assert.ok(byId.curl.code.startsWith(`curl ${BASE}/chat/completions`))
  assert.ok(byId.responses.code.includes(`${BASE}/responses`))
  assert.ok(byId.image.code.includes(`${BASE}/images/generations`))
  assert.ok(byId.codex.code.includes(`base_url = "${BASE}"`) && byId.codex.code.includes('env_key = "CROSERY_API_KEY"'))
  assert.ok(byId['claude-code'].code.includes('ANTHROPIC_BASE_URL="https://gateway.example.test"'))
  assert.ok(byId.anthropic.code.includes('base_url="https://gateway.example.test"'))
  assert.equal(byId.anthropic.model, DEFAULT_EXAMPLES.claude)
  assert.equal(byId.image.model, DEFAULT_EXAMPLES.image)
  assert.ok(modelsCheck(BASE).code.startsWith(`curl ${BASE}/models`))
  assert.deepEqual([...Object.keys(byId)], ['curl', 'openai', 'anthropic', 'responses', 'codex', 'claude-code', 'image'])
})

test('help: anthropic base is only derived from a /v1 base (never guessed)', () => {
  assert.equal(anthropicBaseOf(DEFAULT_BASE), 'https://ai.crosery.com')
  assert.equal(anthropicBaseOf('https://x.test/v2'), null)
})

test('help: example models come from the in-use catalog (plain ids first, newest), else the documented default', () => {
  assert.deepEqual(pickExamples(CATALOG), { claude: 'claude-sonnet-5-5', gpt: 'gpt-6.1-sol', image: DEFAULT_EXAMPLES.image })
  assert.deepEqual(pickExamples([]), DEFAULT_EXAMPLES)
  // only vendor-prefixed ids → use them as-is; batch variants and ~aliases are never examples
  assert.deepEqual(pickExamples(['anthropic/claude-sonnet-5.5', 'anthropic/claude-sonnet-5.5:batch', '~anthropic/claude-sonnet-latest', 'openai/gpt-image-2']), {
    claude: 'anthropic/claude-sonnet-5.5',
    gpt: DEFAULT_EXAMPLES.gpt,
    image: 'openai/gpt-image-2',
  })
  // non-chat gpt ids are not chat examples
  assert.equal(pickExamples(['gpt-image-2', 'gpt-oss-120b', 'gpt-5.1-codex']).gpt, DEFAULT_EXAMPLES.gpt)
})

test('help: vendor grouping folds the tail into 其余 and keeps the total', () => {
  assert.equal(vendorOf('openai/gpt-5'), 'openai')
  assert.equal(vendorOf('~anthropic/claude-opus-latest'), 'anthropic')
  assert.equal(vendorOf('claude-sonnet-5-5'), 'anthropic')
  assert.equal(vendorOf('gpt-6.1-sol'), 'openai')
  assert.equal(vendorOf('gemini-3.8-flash'), 'google')
  assert.equal(vendorOf('cline-deepseek-v4.1-flash'), 'cline')
  const shares = vendorShares(CATALOG, 2)
  assert.deepEqual(shares.map((s) => s.key), ['anthropic', 'openai', '__rest'])
  assert.equal(shares.reduce((sum, s) => sum + s.value, 0), CATALOG.length)
  assert.equal(shares.at(-1)?.tone, 'rest')
  assert.deepEqual(vendorShares([]), [])
})

test('help: FAQ links never point at the retired /rtk page; inline code spans split on backticks', () => {
  const faq = faqItems(BASE, 'https://console.example.test/v1/usage')
  assert.ok(faq.length >= 6)
  assert.equal(new Set(faq.map((f) => f.id)).size, faq.length)
  for (const f of faq) {
    assert.ok(!f.link || !/^\/rtk(\b|$)/.test(f.link.to), `${f.id} links to /rtk`)
    assert.ok(f.a.split('`').length % 2 === 1, `${f.id} has balanced backticks`)
    assert.doesNotMatch(`${f.q} ${f.a}`, /您|请(?!求)/, `${f.id}: no polite filler`)
  }
  assert.equal(faq.find((f) => f.id === 'rtk')?.link?.to, '/settings#rtk')
  assert.ok(faq.find((f) => f.id === 'apps')?.a.includes(BASE))
  assert.deepEqual(inlineParts('a `b` c'), [
    { t: 'a ', code: false },
    { t: 'b', code: true },
    { t: ' c', code: false },
  ])
})

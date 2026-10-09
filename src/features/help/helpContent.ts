/**
 * /help content (DESIGN §6.9): pure builders, no Vue, no fetch — unit-tested in server/helpContent.test.ts.
 *
 * Invariants (tested): every snippet reads the key from `CROSERY_API_KEY` and never carries a key fragment;
 * example models come from the gateway's in-use catalog when it has a match, else a documented default;
 * no link points at the retired `/rtk` page.
 */

export type Snippet = { id: string; label: string; code: string; copyValue?: string }
/** inline text with `code` spans marked by backticks */
export type Fact = { k: string; v: string }
/** `model` = the example model id this snippet calls */
export type ClientSnippet = Snippet & { facts: Fact[]; model: string }
export type FaqItem = { id: string; tag?: string; q: string; a: string; link?: { label: string; to: string } }
export type Examples = { claude: string; gpt: string; image: string }

/** Shown only when the console cannot read its gateway config (it is the production address in the docs). */
export const DEFAULT_BASE = 'https://ai.crosery.com/v1'
export const KEY_ENV = 'CROSERY_API_KEY'
export const AUTH_HEADER = `Authorization: Bearer $${KEY_ENV}`
export const EXPORT_SHOWN = `export ${KEY_ENV}='…'`
export const EXPORT_COPY = `export ${KEY_ENV}=''`
export const DEFAULT_EXAMPLES: Examples = { claude: 'claude-sonnet-4-6', gpt: 'gpt-5.6-luna', image: 'gpt-image-2' }

export function anthropicBaseOf(base: string): string | null {
  return /\/v1$/.test(base) ? base.slice(0, -3) : null
}

const collator = new Intl.Collator('en', { numeric: true })
const NOT_CHAT = /image|audio|realtime|embed|tts|whisper|transcribe|search|moderation|oss|codex/i

/** Latest id matching `pattern`: plain gateway ids first (`claude-sonnet-5-5`), vendor-prefixed ones only as a fallback. */
function latest(ids: readonly string[], pattern: RegExp, exclude?: RegExp): string | null {
  const usable = ids.filter((id) => !id.startsWith('~') && !id.includes(':') && pattern.test(id) && !(exclude && exclude.test(id)))
  const plain = usable.filter((id) => !id.includes('/'))
  const pool = plain.length ? plain : usable
  if (!pool.length) return null
  return [...pool].sort(collator.compare).at(-1) ?? null
}

/** Example models for the snippets, taken from the gateway's in-use ids. */
export function pickExamples(ids: readonly string[]): Examples {
  return {
    claude: latest(ids, /(^|\/)claude-sonnet-\d/) ?? latest(ids, /(^|\/)claude-/) ?? DEFAULT_EXAMPLES.claude,
    gpt: latest(ids, /(^|\/)gpt-\d/, NOT_CHAT) ?? DEFAULT_EXAMPLES.gpt,
    image: latest(ids, /(^|\/)gpt-image/) ?? DEFAULT_EXAMPLES.image,
  }
}

const BARE_VENDOR: Array<[RegExp, string]> = [
  [/^claude/, 'anthropic'],
  [/^(gpt|o\d|chatgpt|dall-e|text-embedding)/, 'openai'],
  [/^(gemini|gemma|imagen|veo)/, 'google'],
  [/^deepseek/, 'deepseek'],
  [/^(qwen|qwq|qcn-qwen)/, 'qwen'],
  [/^glm/, 'z-ai'],
  [/^kimi/, 'moonshotai'],
  [/^grok/, 'x-ai'],
  [/^minimax/, 'minimax'],
  [/^(mistral|codestral|devstral|ministral)/, 'mistralai'],
  [/^llama/, 'meta-llama'],
]

/** `openai/gpt-5` → openai; plain ids are mapped by family (`claude-…` → anthropic); unknown → first token. */
export function vendorOf(id: string): string {
  const clean = id.replace(/^~/, '').toLowerCase()
  const slash = clean.indexOf('/')
  if (slash > 0) return clean.slice(0, slash)
  for (const [pattern, vendor] of BARE_VENDOR) if (pattern.test(clean)) return vendor
  return clean.split(/[-_.:\d]/)[0] || 'other'
}

/** Model count per vendor, largest first; the tail beyond `top` folds into one `rest` segment. */
export function vendorShares(ids: readonly string[], top = 5): Array<{ key: string; label: string; value: number; tone?: 'rest' }> {
  const counts = new Map<string, number>()
  for (const id of ids) {
    const vendor = vendorOf(id)
    counts.set(vendor, (counts.get(vendor) ?? 0) + 1)
  }
  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
  const named = sorted.slice(0, top).map(([key, value]) => ({ key, label: key, value }))
  const rest = sorted.slice(top).reduce((sum, [, value]) => sum + value, 0)
  return rest > 0 ? [...named, { key: '__rest', label: '其余', value: rest, tone: 'rest' as const }] : named
}

const curlJson = (url: string, headers: string[], body: string) =>
  [`curl ${url} \\`, ...headers.map((h) => `  -H "${h}" \\`), `  -H "Content-Type: application/json" \\`, `  -d '${body}'`].join('\n')

/** 02 调用示例: one variant per client / protocol, each with up to three terse facts. */
export function clientSnippets(base: string, anthropicBase: string | null, m: Examples): ClientSnippet[] {
  const a = anthropicBase ?? base.replace(/\/v\d+$/, '')
  const bearer = `Authorization: Bearer $${KEY_ENV}`
  return [
    {
      id: 'curl',
      model: m.gpt,
      label: 'curl',
      code: curlJson(`${base}/chat/completions`, [bearer], `{\n    "model": "${m.gpt}",\n    "messages": [{"role": "user", "content": "你好"}]\n  }`),
      facts: [
        { k: '端点', v: '`POST /v1/chat/completions`' },
        { k: '结果', v: '`choices[0].message.content`' },
        { k: '流式', v: '请求体加 `"stream": true`' },
      ],
    },
    {
      id: 'openai',
      model: m.gpt,
      label: 'OpenAI',
      code: [
        '# pip install openai',
        'import os',
        'from openai import OpenAI',
        '',
        'client = OpenAI(',
        `    base_url="${base}",`,
        `    api_key=os.environ["${KEY_ENV}"],`,
        ')',
        'reply = client.chat.completions.create(',
        `    model="${m.gpt}",`,
        '    messages=[{"role": "user", "content": "你好"}],',
        ')',
        'print(reply.choices[0].message.content)',
      ].join('\n'),
      facts: [
        { k: '端点', v: '`POST /v1/chat/completions`' },
        { k: 'Node', v: '`new OpenAI({ baseURL, apiKey })`' },
        { k: '兼容', v: 'Claude 模型也能走这个接口' },
      ],
    },
    {
      id: 'anthropic',
      model: m.claude,
      label: 'Anthropic',
      code: [
        '# pip install anthropic',
        'import os',
        'import anthropic',
        '',
        'client = anthropic.Anthropic(',
        `    base_url="${a}",`,
        `    api_key=os.environ["${KEY_ENV}"],`,
        ')',
        'reply = client.messages.create(',
        `    model="${m.claude}",`,
        '    max_tokens=1024,',
        '    messages=[{"role": "user", "content": "你好"}],',
        ')',
        'print(reply.content[0].text)',
      ].join('\n'),
      facts: [
        { k: 'Base URL', v: '不带 `/v1`，SDK 自己补' },
        { k: '端点', v: '`POST /v1/messages`' },
        { k: '鉴权', v: '`x-api-key` 或 `Authorization: Bearer`' },
      ],
    },
    {
      id: 'responses',
      model: m.gpt,
      label: 'Responses',
      code: curlJson(`${base}/responses`, [bearer], `{\n    "model": "${m.gpt}",\n    "input": "你好"\n  }`),
      facts: [
        { k: '端点', v: '`POST /v1/responses`' },
        { k: '输入', v: '用 `input`，不是 `messages`' },
        { k: '结果', v: '`output` 数组 · SDK 读 `output_text`' },
      ],
    },
    {
      id: 'codex',
      model: m.gpt,
      label: 'Codex',
      code: [
        '# ~/.codex/config.toml',
        `model = "${m.gpt}"`,
        'model_provider = "crosery"',
        '',
        '[model_providers.crosery]',
        'name = "Crosery"',
        `base_url = "${base}"`,
        `env_key = "${KEY_ENV}"`,
        'wire_api = "responses"',
      ].join('\n'),
      facts: [
        { k: '文件', v: '`~/.codex/config.toml`' },
        { k: '协议', v: '`wire_api = "responses"`' },
        { k: 'Key', v: '从环境变量读，不写进文件' },
      ],
    },
    {
      id: 'claude-code',
      model: m.claude,
      label: 'Claude Code',
      code: [
        `export ANTHROPIC_BASE_URL="${a}"`,
        `export ANTHROPIC_AUTH_TOKEN="$${KEY_ENV}"`,
        `export ANTHROPIC_MODEL="${m.claude}"`,
        'claude',
      ].join('\n'),
      facts: [
        { k: 'Base URL', v: '不带 `/v1`' },
        { k: '鉴权', v: '`ANTHROPIC_AUTH_TOKEN` 走 Bearer' },
        { k: '默认模型', v: '`ANTHROPIC_MODEL` 可省' },
      ],
    },
    {
      id: 'image',
      model: m.image,
      label: '图片',
      code: curlJson(
        `${base}/images/generations`,
        [bearer],
        `{\n    "model": "${m.image}",\n    "prompt": "屋顶上的橘猫，水彩",\n    "size": "1024x1024"\n  }`,
      ),
      facts: [
        { k: '端点', v: '`POST /v1/images/generations`' },
        { k: '结果', v: '`data[0].b64_json` · 没有 `url`' },
        { k: '超时', v: '客户端设到 120s 以上' },
      ],
    },
  ]
}

/** 03 检查模型: the one request that proves base URL + key + model access in one go. */
export function modelsCheck(base: string): Snippet {
  return { id: 'models', label: 'GET /v1/models', code: `curl ${base}/models \\\n  -H "${AUTH_HEADER}"` }
}

export const CRAPI_INSTALL: Snippet[] = [
  { id: 'unix', label: 'macOS / Linux', code: 'curl -fsSL https://cdn.jsdelivr.net/gh/crosery/crapi/install.sh | sh' },
  { id: 'windows', label: 'Windows', code: 'irm https://cdn.jsdelivr.net/gh/crosery/crapi/install.ps1 | iex' },
]

export function crapiCommands(m: Examples): Snippet {
  return {
    id: 'crapi',
    label: 'crapi 常用命令',
    code: [
      '# 识别本机客户端，写好 Base URL 与 Key',
      'crapi setup',
      '# 切换所有客户端的默认模型',
      `crapi use ${m.claude}`,
      '# 从网关拉最新模型',
      'crapi update',
    ].join('\n'),
  }
}

/** 05 常见问题 — answers are one or two terse lines; facts come from the gateway behaviour the docs page states. */
export function faqItems(base: string, usageUrl: string): FaqItem[] {
  return [
    { id: '401', tag: '401', q: 'Key 无效或已停用', a: '请求头写成 `Authorization: Bearer <Key>`（Anthropic 协议也可用 `x-api-key`）· Key 不放进 URL 或请求体 · 人工停用的 Key 一律 401' },
    { id: '403', tag: '403', q: '模型没有授权', a: '这把 Key 无权调用该模型（`model_not_allowed`）· 先 `GET /v1/models`，只用返回的 id', link: { label: 'Key 页 →', to: '/keys' } },
    { id: '429', tag: '429', q: '请求被限流', a: '上游限流或 Key 并发到上限 · 稍后重试或降低并发' },
    { id: 'quota', q: '额度什么时候恢复', a: '日额度每天 00:00、周额度每周一 00:00 恢复（Asia/Shanghai）· 总额度不自动恢复 · 超额期间新调用被拒，查用量不受影响' },
    { id: 'self', q: '别人怎么看自己的用量', a: `登录页选「API Key」，粘贴自己的 Key · 只看得到这把 Key 的额度、用量和可用模型 · 不登录也能查 \`GET ${usageUrl}\`，同样 Bearer 鉴权` },
    { id: 'apps', q: 'Cursor / Cline / Cherry Studio 怎么填', a: `服务商选「OpenAI 兼容」· Base URL 填 \`${base}\` · 模型名用 \`/v1/models\` 返回的 id` },
    { id: 'stream', q: '流式输出', a: '请求体加 `"stream": true`，按 SSE 逐段读 `data:` 行 · chat/completions 与 responses 都支持' },
    { id: 'image', q: '生图超时', a: '客户端超时设到 120 秒以上 · 超时后先查用量再决定重试，避免重复生成' },
    { id: 'rtk', q: '怎么省 token', a: 'RTK 先压缩命令输出再交给模型 · 全局开关与节省统计在设置页', link: { label: '设置 · RTK 中转 →', to: '/settings#rtk-relay' } },
  ]
}

/** `a \`b\` c` → [{t:'a ',code:false},{t:'b',code:true},{t:' c',code:false}] */
export function inlineParts(text: string): Array<{ t: string; code: boolean }> {
  return text.split('`').map((t, i) => ({ t, code: i % 2 === 1 })).filter((p) => p.t !== '')
}

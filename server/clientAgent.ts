/**
 * 调用方识别。
 *
 * CPA 的 usage-queue 一直在下发 `user_agent` / `client_ip` / `x_forwarded_for`，
 * 但早期落库时没接这三个字段，因此面板只能看到「哪个 Key、哪个模型」，
 * 看不到「是谁在打」——Pi、Claude Code、Codex CLI 还是某个 SDK 脚本。
 *
 * 这里只做一件事：把原始 UA 归一化成稳定的客户端标识，供明细展示与分布统计使用。
 * 归一化必须保守：宁可落到 other 并保留原始 UA，也不要猜错归属，
 * 否则统计会把两个不同客户端合并成一个，比没有统计更有害。
 */

export type ClientType =
  | 'omp'
  | 'pi'
  | 'claude-code'
  | 'deepseek-harness'
  | 'deepseek-honeypot'
  | 'agent-honeypot'
  | 'codex-cli'
  | 'codex-desktop'
  | 'codex-vscode'
  | 'antigravity-cli'
  | 'gemini-cli'
  | 'cursor'
  | 'cc-switch'
  | 'ibuki'
  | 'openai-sdk'
  | 'anthropic-sdk'
  | 'vercel-ai-sdk'
  | 'langchain'
  | 'cpa-internal'
  | 'script'
  | 'browser'
  | 'other'
  | 'unknown'
  | 'legacy-unknown'

/** 展示名固定在服务端，避免前端各处各写一份中英混排的映射。 */
export const CLIENT_LABELS: Record<ClientType, string> = {
  omp: 'OMP',
  pi: 'Pi',
  'claude-code': 'Claude Code',
  'deepseek-harness': 'DSH',
  'deepseek-honeypot': 'DeepSeek Honeypot',
  'agent-honeypot': 'Agent Honeypot',
  'codex-cli': 'Codex CLI',
  'codex-desktop': 'Codex Desktop',
  'codex-vscode': 'Codex VS Code',
  'antigravity-cli': 'AntiGravity CLI',
  'gemini-cli': 'Gemini CLI',
  cursor: 'Cursor',
  'cc-switch': 'CC Switch',
  ibuki: 'Ibuki',
  'openai-sdk': 'OpenAI SDK',
  'anthropic-sdk': 'Anthropic SDK',
  'vercel-ai-sdk': 'Vercel AI SDK',
  langchain: 'LangChain',
  'cpa-internal': 'CPA 中转（下游网关）',
  script: '脚本/HTTP 库',
  browser: '浏览器',
  other: '其他',
  unknown: '未上报',
  'legacy-unknown': '历史未识别',
}

/**
 * 顺序即优先级：更具体的产品特征必须排在通用 SDK / HTTP 库之前。
 * Claude Code 和 Codex 内部就是用官方 SDK 发请求的，UA 里可能同时出现
 * `claude-cli` 与 `anthropic-sdk`，先匹配产品才不会被 SDK 规则吃掉。
 *
 * 正则均根据生产 nginx 日志里的真实 UA 写成，不是猜的，例如：
 *   claude-cli/2.1.250 (external, cli)                 -> claude-code
 *   pi (darwin 24.6.0; arm64)                          -> pi（注意：无斜杠版本号）
 *   deepseek-harness/0.1.1-rc.2 (+https://github.com/) -> deepseek-harness（DSH）
 *   codex-tui/0.149.1 (Mac OS ...) Orca/1.4.143        -> codex-cli（主要形态，非 `codex/`）
 *   codex_exec / codex_cli_rs / codex_vscode           -> codex-cli / codex-vscode
 *   Codex Desktop/0.150.0-alpha.8 (Mac OS ...)         -> codex-desktop
 *   cc-switch/1.0                                      -> cc-switch
 *   cli-proxy-openai-compat                            -> cpa-internal（下游 CLIProxyAPI 中转）
 *   undici / Python-urllib / curl / axios              -> script
 */
const RULES: Array<{ type: ClientType; test: RegExp }> = [
  // Real OMP UA: omp/18.1.14 and omp/18.1.15. Pi remains a separate client.
  { type: 'omp', test: /^omp\/[0-9]/i },
  // `pi (darwin ...)` 没有 `/版本`，不能只靠斜杠形式匹配；
  // 同时用边界限定，避免误伤 `openai-python` 里的 pi 字符串。
  { type: 'pi', test: /^pi[\s/]|\bpi-(coding-agent|agent|cli)\b/i },
  { type: 'claude-code', test: /claude-cli|claude[-_ ]?code/i },
  { type: 'deepseek-harness', test: /deepseek[-_ ]?harness/i },
  // Honeypot 是独立客户端身份；没有对应 UA 时不主动把 DSH/Ibuki 猜成 Honeypot。
  { type: 'deepseek-honeypot', test: /deepseek[-_ ]?honeypot/i },
  { type: 'agent-honeypot', test: /agent[-_ ]?honeypot/i },
  // Codex 内嵌客户端会把宿主程序（Orca / ghostty / VS Code）拼在 UA 尾部，
  // 必须先匹配更具体的 desktop / vscode，否则会被通用 codex 规则吃掉。
  { type: 'codex-desktop', test: /codex[-_ ]?desktop/i },
  { type: 'codex-vscode', test: /codex[-_ ]?vscode/i },
  // 生产主要形态是 `codex-tui`，不是 `codex/`；只写 `^codex\/\d` 会漏掉绝大多数请求。
  { type: 'codex-cli', test: /^codex[-_](tui|cli|exec|cli_rs)|\bcodex[-_ ]?(cli|exec)\b|^codex\/\d/i },
  { type: 'gemini-cli', test: /gemini[-_ ]?cli|antigravity/i },
  { type: 'cc-switch', test: /cc-switch/i },
  { type: 'ibuki', test: /^ibuki\//i },
  { type: 'cursor', test: /\bcursor\b/i },
  { type: 'langchain', test: /langchain|langgraph|llamaindex/i },
  { type: 'vercel-ai-sdk', test: /\bai-sdk\b|^ai\/\d/i },
  // 官方 JS SDK 的 UA 是 `OpenAI/JS 6.40.0`（空格分隔、JS 不是版本号），
  // 只写 `openai\/\d` 会把它漏掉——实测占总请求量 13.8%。
  { type: 'openai-sdk', test: /openai-python|openai-node|openai[-_ ]?sdk|\bopenai\/(js|python|node|\d)/i },
  { type: 'anthropic-sdk', test: /anthropic-sdk|anthropic-python|anthropic-ai|\banthropic\/(js|python|node|\d)/i },
  // `cli-proxy-openai-compat` 是另一个 CLIProxyAPI 实例（下游网关）转发过来的请求，
  // 不是本网关内部回流；单独成类以免与真实终端客户端混在一起。类型 ID 保持不变以兼容历史数据。
  { type: 'cpa-internal', test: /^cli-proxy|cliproxyapi/i },
  { type: 'script', test: /^curl\/|\bwget\b|python-requests|python-urllib|python-httpx|\bhttpx\b|\baiohttp\b|node-fetch|axios|undici|go-http-client|grpc-go|^node$|okhttp|libredtail|^java\/|^ruby\b/i },
  { type: 'browser', test: /mozilla\/|chrome\/|safari\/|firefox\/|edge\//i },
]

/**
 * 空 UA 与无法归类的 UA 必须分开：前者是没上报，后者是没认出来。
 * nginx 对缺失 UA 会写字面量 `-`，不能当成真实客户端。
 */
export function classifyClient(userAgent: string, context: { provider?: string } = {}): ClientType {
  const ua = (userAgent || '').trim()
  if (!ua || ua === '-') return 'unknown'
  if (String(context.provider || '').trim().toLowerCase() === 'antigravity' && /^google-genai-sdk\//i.test(ua)) {
    return 'antigravity-cli'
  }
  for (const rule of RULES) {
    if (rule.test.test(ua)) return rule.type
  }
  return 'other'
}

/** Recover historical OMP/AGY identities at read time without rewriting production data. */
export function clientTypeSql(alias = ''): string {
  const prefix = alias ? `${alias}.` : ''
  return `(CASE
    WHEN lower(trim(${prefix}user_agent)) LIKE 'omp/%'
      AND substr(trim(${prefix}user_agent), 5, 1) BETWEEN '0' AND '9'
      THEN 'omp'
    WHEN lower(trim(${prefix}provider)) = 'antigravity'
      AND lower(trim(${prefix}user_agent)) LIKE 'google-genai-sdk/%'
      THEN 'antigravity-cli'
    WHEN ${prefix}client_type = '' THEN 'legacy-unknown'
    ELSE ${prefix}client_type
  END)`
}

export const clientLabel = (type: string): string =>
  CLIENT_LABELS[type as ClientType] || CLIENT_LABELS.other

/**
 * UA 里常带版本号（`claude-cli/2.1.250 (external, cli)`）。
 * 版本对排查有用，但作为分组维度会把同一客户端炸成几十个值，因此单独抽出来。
 */
export function clientVersion(userAgent: string): string {
  const match = /\/(\d+(?:\.\d+)*)/.exec(userAgent || '')
  return match?.[1] || ''
}

/**
 * 真实来源 IP。请求经 nginx 转发后 client_ip 恒为回环地址，
 * 此时必须取 XFF 最左值；但 XFF 完全由客户端可伪造，只作展示不作安全判断。
 */
export function resolveClientIp(clientIp: string, forwardedFor: string): string {
  const forwarded = (forwardedFor || '').split(',')[0]?.trim()
  const direct = (clientIp || '').trim()
  const loopback = !direct || direct === '127.0.0.1' || direct === '::1'
  return (loopback && forwarded) ? forwarded : direct
}

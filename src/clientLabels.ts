/**
 * 调用方展示名。与 server/clientAgent.ts 的 CLIENT_LABELS 一一对应。
 *
 * 前端不重新做 UA 解析：分类结果由服务端在落库或历史读取时确定并随接口返回，
 * 这里只负责把稳定的类型标识翻译成中文展示名。两边同时改才不会分裂。
 */
export const CLIENT_LABELS: Record<string, string> = {
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

export const clientLabel = (type: string): string => CLIENT_LABELS[type] || CLIENT_LABELS.other

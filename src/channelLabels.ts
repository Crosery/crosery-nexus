const CHANNEL_LABELS: Record<string, string> = {
  claude: 'Claude',
  codex: 'Codex',
  antigravity: 'Antigravity',
  xai: 'Grok',
  minimax: 'MiniMax',
  'openai-compatible-minimax': 'MiniMax',
  'mox-aigw': 'Mox 中转',
  'openai-compatible-mox-aigw': 'Mox 中转',
}

export function channelLabel(provider: string): string {
  const id = String(provider || '').trim()
  return CHANNEL_LABELS[id] || (id ? id : '未知渠道')
}

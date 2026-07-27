import path from 'node:path'

export const config = {
  port: Number(process.env.PORT || 8787),
  host: process.env.HOST || '127.0.0.1',
  dataDir: process.env.DATA_DIR || path.resolve('data'),
  cpaBaseUrl: (process.env.CPA_BASE_URL || 'http://127.0.0.1:8317').replace(/\/$/, ''),
  cpaManagementKey: process.env.CPA_MANAGEMENT_KEY || '',
  consoleUsername: process.env.CONSOLE_USERNAME || 'admin',
  consolePassword: process.env.CONSOLE_PASSWORD || '',
  sessionSecret: process.env.SESSION_SECRET || '',
  cookieSecure: process.env.COOKIE_SECURE !== 'false',
  usageRetentionDays: Number(process.env.USAGE_RETENTION_DAYS || 90),
  syncIntervalMs: Number(process.env.SYNC_INTERVAL_MS || 15000),
  groups: [
    { id: 'qijichuangtan', name: '奇迹创谈', color: '#ef6c57', match: ['qiji/'] },
    { id: 'claude', name: 'Claude', color: '#d97757', match: ['claude'] },
    { id: 'codex', name: 'Codex', color: '#6ee7b7', match: ['gpt-', 'codex'] },
    { id: 'kimi', name: 'Kimi', color: '#60a5fa', match: ['kimi', 'moonshot'] },
    { id: 'grok', name: 'Grok', color: '#c084fc', match: ['grok', 'xai'] },
    { id: 'image', name: '图像', color: '#fbbf24', match: ['image', 'dall-e', 'gpt-image'] },
  ],
}

export type ConsoleGroup = (typeof config.groups)[number]

import { OAUTH_PROVIDER_ENDPOINTS } from './cpa.js'

/**
 * The CPA backend's providers, server-side (the page's PROVIDERS list mirrors it). Every id is an
 * OAUTH_PROVIDER_ENDPOINTS key, so this list cannot offer a provider the CPA routes would refuse.
 */
export const CPA_CATALOG = [
  { agent: 'codex', name: 'Codex', vendor: 'OpenAI · ChatGPT 订阅', flow: 'browser', pasteCallback: true, risk: false },
  { agent: 'claude', name: 'Claude', vendor: 'Anthropic · Claude 订阅', flow: 'browser', pasteCallback: true, risk: true },
  { agent: 'antigravity', name: 'Antigravity', vendor: 'Google · 按模型家族计额', flow: 'browser', pasteCallback: true, risk: true },
  { agent: 'kimi', name: 'Kimi', vendor: 'Moonshot · kimi.com 国内站', flow: 'device', pasteCallback: false, risk: false },
  { agent: 'kimi-ai', name: 'Kimi 国际站', vendor: 'Moonshot · kimi.ai', flow: 'device', pasteCallback: false, risk: false },
  { agent: 'xai', name: 'Grok', vendor: 'xAI · SuperGrok', flow: 'browser', pasteCallback: true, risk: false },
  { agent: 'devin', name: 'Devin', vendor: 'Cognition', flow: 'browser', pasteCallback: true, risk: false },
  { agent: 'meta', name: 'Meta AI', vendor: 'Meta · Muse', flow: 'device', pasteCallback: false, risk: false },
].filter(entry => Object.prototype.hasOwnProperty.call(OAUTH_PROVIDER_ENDPOINTS, entry.agent))

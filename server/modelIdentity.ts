/**
 * 模型与渠道是两个独立维度。
 *
 * CPA 的日志里可能出现：
 *   claude-opus-5                         （原生 Claude）
 *   gpt-5.6-luna                         （Codex 官方）
 *   gpt-5.6-luna                         （Mox 中转）
 *
 * DSH（DeepSeek Harness）不在这里：它是客户端 UA（deepseek-harness/...），
 * 与 Pi、Codex、Claude Code 同一层，只进入 client_type 统计。
 *
 * 统计的模型维度必须去掉渠道前缀并合并；渠道维度则必须使用 provider 分开。
 */
import { normalizeModelForPricing } from './pricing.js'

export function canonicalModelId(model: string): string {
  return normalizeModelForPricing(String(model || '').trim()) || 'unknown'
}

/** SQL 版本必须和 canonicalModelId 保持相同语义。 */
export function canonicalModelSql(alias = ''): string {
  const p = alias ? `${alias}.` : ''
  return `CASE WHEN instr(${p}model,'/')>0 THEN substr(${p}model, instr(${p}model,'/')+1) ELSE ${p}model END`
}

/**
 * provider 是真实上游，不是模型组，也不是 API Key 的授权组。
 * 已删除的历史 provider 不在这里提供特殊展示名；当前统计会在查询层按实时 CPA 渠道白名单过滤。
 */
export function channelLabel(provider: string): string {
  const id = String(provider || '').trim()
  if (!id || id === 'unknown') return '未知渠道'
  if (id === 'claude') return 'Claude'
  if (id === 'codex') return 'Codex'
  if (id === 'antigravity') return 'Antigravity'
  if (id === 'xai') return 'Grok'
  if (id === 'mox-aigw' || id === 'openai-compatible-mox-aigw') return 'Mox 中转'
  if (id === 'minimax' || id === 'openai-compatible-minimax') return 'MiniMax'
  return id
}

/**
 * 「新输入 token」的 SQL 表达式。
 *
 * 两家上游对 cached_tokens 的口径相反：
 * - 原生 Anthropic：input 与 cached 并列，input 本身就是新输入。
 * - OpenAI/兼容协议：cached 内含于 input，必须扣减才是新输入。
 *
 * 判定必须优先看实际 provider/model_group，不能只看模型名前缀：
 * DSH 的 `qiji/claude-*` 也是 Claude 模型名，但它走 OpenAI 兼容口径；
 * 只有实际 provider 为 claude（或 model_group 为 claude）才按 Anthropic 处理。
 */
export const NEW_INPUT_SQL = (alias = '') => {
  const p = alias ? `${alias}.` : ''
  // provider/model_group 是 CPA 记录里的真实协议来源；没有字段时才回退到模型名。
  // provider 可能是 `claude` / `claude-api-key`，兼容渠道如 `qijichuangtan`
  // 即便 model 是 qiji/claude-opus-5，也必须走 OpenAI 口径。
  const provider = `${p}provider`
  const group = `${p}model_group`
  const bare = `CASE WHEN instr(${p}model,'/')>0 THEN substr(${p}model, instr(${p}model,'/')+1) ELSE ${p}model END`
  // provider 一旦存在就是权威来源：DSH 的 model_group 可能也叫 claude，
  // 但它仍是兼容协议，不能被 group 名误判成原生 Anthropic。
  const anthropic = `((lower(COALESCE(${provider},'')) IN ('claude','claude-api-key','anthropic','anthropic-api-key')) OR (COALESCE(${provider},'') = '' AND (lower(COALESCE(${group},'')) = 'claude' OR lower(${bare}) LIKE 'claude%')))`
  return `CASE WHEN ${anthropic} THEN ${p}input_tokens ELSE MAX(${p}input_tokens - ${p}cached_tokens, 0) END`
}

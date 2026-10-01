/**
 * 字段级校验（D25）。
 *
 * 背景：原来两个表单都是「点提交 → 顺序 if → 写一个底部错误」，字段本身没有错误态，
 * 用户要自己往上找是哪个字段错了。Tuffex 的 `TxForm` 只暴露整表 `validate()`（没有单字段 API，
 * 也没有 blur 触发），所以这里提供一个**纯函数**校验器：
 * - 规则与文案分离，文案一律写「怎么改」；
 * - 失焦时只校验当前字段（`fieldError`），提交时整表校验并给出**首个出错字段**（`validateAll`）；
 * - 纯函数 → 行为级测试直接跑（见 `server/libValidation.test.ts`）。
 */

export type FieldRule = {
  /** 必填：空值直接给 message。 */
  required?: boolean
  /** 出错的提示文案，写「怎么改」。 */
  message: string
  /** 额外判定；返回 false 表示不通过。所有规则都通过时字段合法。 */
  test?: (value: string) => boolean
}

export type FieldRules = Record<string, FieldRule[]>

const isEmpty = (value: unknown): boolean => value === null || value === undefined || String(value).trim() === ''

/** 取字段值并统一成字符串（表单控件多数给 string，数字框可能给 number）。 */
export function fieldText(model: Record<string, unknown>, name: string): string {
  const value = model[name]
  return value === null || value === undefined ? '' : String(value)
}

/** 单个字段的第一条错误；null 表示通过。 */
export function fieldError(rules: FieldRules, model: Record<string, unknown>, name: string): string | null {
  const list = rules[name]
  if (!list?.length) return null
  const raw = model[name]
  const text = fieldText(model, name)
  for (const rule of list) {
    if (rule.required && isEmpty(raw)) return rule.message
    if (!rule.required && isEmpty(raw) && !rule.test) continue
    if (rule.test && !rule.test(text)) return rule.message
  }
  return null
}

export type ValidationOutcome = {
  valid: boolean
  /** 名称 → 错误文案（只含出错的字段） */
  errors: Record<string, string>
  /** 第一个出错字段的**声明顺序**（用于提交时定位焦点），全部通过时为 null */
  firstInvalid: string | null
}

/** 整表校验：按 rules 的键顺序返回首个出错字段，便于「提交时定位到第一个错误」。 */
export function validateAll(rules: FieldRules, model: Record<string, unknown>): ValidationOutcome {
  const errors: Record<string, string> = {}
  let firstInvalid: string | null = null
  for (const name of Object.keys(rules)) {
    const message = fieldError(rules, model, name)
    if (message) {
      errors[name] = message
      if (!firstInvalid) firstInvalid = name
    }
  }
  return { valid: !firstInvalid, errors, firstInvalid }
}

/** 常用规则构造器（保持文案可读、可复用）。 */
export const rules = {
  required(message: string): FieldRule {
    return { required: true, message }
  },
  maxLength(length: number, message: string): FieldRule {
    return { message, test: (value) => value.length <= length }
  },
  /** 允许留空的数字范围（例如额度上限留空 = 不限制）。 */
  numberInRange(min: number, max: number, message: string): FieldRule {
    return {
      message,
      test: (value) => {
        if (value.trim() === '') return true
        if (!/^\d+(\.\d+)?$/.test(value.trim())) return false
        const parsed = Number(value)
        return parsed >= min && parsed <= max
      },
    }
  },
  /** 整数范围（并发数这类）。 */
  integerInRange(min: number, max: number, message: string): FieldRule {
    return {
      message,
      test: (value) => {
        if (value.trim() === '') return true
        if (!/^\d+$/.test(value.trim())) return false
        const parsed = Number(value)
        return parsed >= min && parsed <= max
      },
    }
  },
  /** 自定义判定。 */
  custom(message: string, test: (value: string) => boolean): FieldRule {
    return { message, test }
  },
}

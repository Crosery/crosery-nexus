import assert from 'node:assert/strict'
import test from 'node:test'
import { fieldError, rules, validateAll, type FieldRules } from '../src/lib/validation.js'

/** D25 的字段级校验器：行为级测试（纯函数，不需要 DOM）。 */

const editorRules: FieldRules = {
  name: [
    rules.required('请填写显示名称（1–40 个字符）'),
    rules.maxLength(40, '显示名称最多 40 个字符，请缩短后再保存'),
  ],
  note: [rules.maxLength(100, '备注最多 100 个字符，请精简后再保存')],
  groups: [rules.required('至少选择一个渠道分组，否则这把密钥无法调用任何模型')],
  totalConcurrency: [rules.integerInRange(1, 1000, '并发数请填 1–1000 的整数；不限速请打开「不限速」开关')],
}

const base = { name: '测试密钥', note: '', groups: ['g1'], totalConcurrency: '4' }

test('合法输入：整表通过，无错误、无首个出错字段', () => {
  const outcome = validateAll(editorRules, base)
  assert.equal(outcome.valid, true)
  assert.deepEqual(outcome.errors, {})
  assert.equal(outcome.firstInvalid, null)
})

test('必填缺失：错误文案说明怎么改，且定位到该字段', () => {
  const outcome = validateAll(editorRules, { ...base, name: '   ' })
  assert.equal(outcome.valid, false)
  assert.equal(outcome.firstInvalid, 'name')
  assert.match(outcome.errors.name, /请填写显示名称/)
  // 文案是「怎么改」，不是「错了」
  assert.doesNotMatch(outcome.errors.name, /^错误|invalid$/i)
})

test('长度超限与数值越界都能拦下，并给出范围', () => {
  assert.match(fieldError(editorRules, { ...base, name: 'x'.repeat(41) }, 'name') ?? '', /最多 40 个字符/)
  assert.equal(fieldError(editorRules, { ...base, name: 'x'.repeat(40) }, 'name'), null, '边界值 40 字符合法')
  assert.match(fieldError(editorRules, { ...base, totalConcurrency: '0' }, 'totalConcurrency') ?? '', /1–1000 的整数/)
  assert.match(fieldError(editorRules, { ...base, totalConcurrency: '1.5' }, 'totalConcurrency') ?? '', /整数/)
  assert.equal(fieldError(editorRules, { ...base, totalConcurrency: '1000' }, 'totalConcurrency'), null)
})

test('留空的可选数字字段不算错（留空 = 不限制）', () => {
  const quotaRules: FieldRules = { daily: [rules.numberInRange(0, 1_000_000, '单日额度请填 0–1000000 的数字，留空表示不限制')] }
  assert.equal(validateAll(quotaRules, { daily: '' }).valid, true)
  assert.equal(validateAll(quotaRules, { daily: '0' }).valid, true)
  assert.equal(validateAll(quotaRules, { daily: '12.5' }).valid, true)
  assert.equal(validateAll(quotaRules, { daily: '-1' }).valid, false)
  assert.equal(validateAll(quotaRules, { daily: 'abc' }).valid, false)
  assert.equal(validateAll(quotaRules, { daily: '1000001' }).valid, false)
})

test('多个字段同时出错：errors 全都有，firstInvalid 是声明顺序里的第一个', () => {
  const outcome = validateAll(editorRules, { name: '', note: 'x'.repeat(101), groups: [], totalConcurrency: '99999' })
  assert.equal(outcome.valid, false)
  assert.deepEqual(Object.keys(outcome.errors), ['name', 'note', 'groups', 'totalConcurrency'])
  assert.equal(outcome.firstInvalid, 'name', '按 rules 的键顺序取第一个，而不是对象遍历顺序')
})

test('修正后错误消失（同一套规则复跑）', () => {
  const bad = validateAll(editorRules, { ...base, name: '' })
  assert.equal(bad.valid, false)
  const fixed = validateAll(editorRules, { ...base, name: '新名字' })
  assert.equal(fixed.valid, true)
  assert.equal(fixed.errors.name, undefined)
})

test('自定义规则（例如重名检查）可用，且能读到值本身', () => {
  const taken = new Set(['已存在的密钥'])
  const custom: FieldRules = {
    name: [rules.custom('已有同名密钥，请换一个名称', (value) => !taken.has(value.trim()))],
  }
  assert.equal(validateAll(custom, { name: '可用的名字' }).valid, true)
  const dup = validateAll(custom, { name: '已存在的密钥' })
  assert.equal(dup.valid, false)
  assert.match(dup.errors.name, /请换一个名称/)
})

test('未声明规则的字段永远通过（不做无依据的拦截）', () => {
  assert.equal(fieldError(editorRules, { ...base, 未声明字段: '随便' }, '未声明字段'), null)
  assert.equal(validateAll({}, { anything: '' }).valid, true)
})

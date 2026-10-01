import assert from 'node:assert/strict'
import test from 'node:test'
import { CONCURRENCY_LIMITS, rules } from '../src/lib/validation.js'
import { validatePolicy, type KeyPolicy } from './policy.js'

/**
 * R6-C：客户端宣告的并发区间必须等于**服务端真正接受的区间**。
 *
 * 第五轮客户端写的是 1–1000，而 `server/policy.ts:9-11` 对 >500 一律拒绝（红队直接调纯函数验证
 * 501/600/1000 全 REJECTED）→ 用户填 501–1000 时表单判合法、提交被 400 拒，两侧文案互相矛盾。
 *
 * 这条测试不看文案、也不比对字符串常量，而是**用服务端校验函数实测接受区间**，再与客户端常量对齐——
 * 任一侧漂移（客户端放宽 / 服务端收紧）都会红。
 */

/** 用服务端权威校验函数实测某个并发值是否被接受（0 表示不限速，单独处理）。 */
function serverAccepts(totalConcurrency: number): boolean {
  const policy: KeyPolicy = {
    enabled: true,
    groups: ['g1'],
    totalConcurrency,
    groupConcurrency: totalConcurrency === 0 ? {} : { g1: 1 },
  }
  try {
    validatePolicy(policy)
    return true
  } catch {
    return false
  }
}

test('服务端接受区间可以被实测出来（守卫自身前提）', () => {
  assert.equal(serverAccepts(1), true)
  assert.equal(serverAccepts(500), true)
  assert.equal(serverAccepts(501), false, '服务端应当拒绝 501（这是 R6-C 的事实依据）')
  assert.equal(serverAccepts(1000), false)
  assert.equal(serverAccepts(0), true, '0 = 不限速，服务端接受')
})

test('客户端区间上界 == 服务端接受上界', () => {
  // 实测服务端能接受的最大值（在 1..2000 内二分即可，这里直接线性扫描边界附近，读起来更直白）
  let serverMax = 0
  for (let value = 1; value <= 2000; value += 1) if (serverAccepts(value)) serverMax = value
  assert.equal(serverMax, 500, '服务端接受上界变了，请同步客户端 CONCURRENCY_LIMITS 与文案')
  assert.equal(
    CONCURRENCY_LIMITS.max,
    serverMax,
    `客户端声称 1–${CONCURRENCY_LIMITS.max}，服务端实际只接受到 ${serverMax}：两侧漂移，用户会填进必然被 400 拒的值`,
  )
})

test('客户端下界 == 服务端可用的最小正数下界（0 由「不限速」开关表达）', () => {
  assert.equal(CONCURRENCY_LIMITS.min, 1)
  assert.equal(serverAccepts(CONCURRENCY_LIMITS.min), true, '客户端的下界必须被服务端接受')
  assert.equal(serverAccepts(CONCURRENCY_LIMITS.min - 1), true, '0 在服务端是合法的「不限速」，由开关表达')
})

test('客户端规则与服务端在边界上逐点一致', () => {
  const rule = rules.integerInRange(CONCURRENCY_LIMITS.min, CONCURRENCY_LIMITS.max, '边界', { allowEmpty: false })
  for (const value of [0, 1, 2, 499, 500, 501, 600, 1000, 2000]) {
    if (value === 0) continue // 0 由「不限速」开关表达，输入框不接受
    const clientAccepts = rule.test?.(String(value)) ?? false
    assert.equal(
      clientAccepts,
      serverAccepts(value),
      `并发 ${value}：客户端=${clientAccepts ? '接受' : '拒绝'}，服务端=${serverAccepts(value) ? '接受' : '拒绝'}`,
    )
  }
})

test('R6-B：并发留空在客户端就被拦下（不再让 "" 到达服务端被静默改成 4）', () => {
  const rule = rules.integerInRange(CONCURRENCY_LIMITS.min, CONCURRENCY_LIMITS.max, '必填', { allowEmpty: false })
  assert.equal(rule.test?.(''), false, '留空必须报错：服务端会把空串静默变成 4')
  assert.equal(rule.test?.('   '), false)
  const quotaLike = rules.integerInRange(0, 100, '可留空', { allowEmpty: true })
  assert.equal(quotaLike.test?.(''), true, '额度这类「留空 = 不限制」的字段仍应允许留空')
})

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { TOTAL_CONCURRENCY_RULE, validatePolicy } from './policy.js'

/**
 * R7-B：并发规则文案必须**只有一个真源**。
 *
 * 第七轮红队发现：`policy.ts` 内联一份字面量、`index.ts` 又抄了一份 `TOTAL_CONCURRENCY_RULE`，
 * 数值区间已被 `server/concurrencyContract.test.ts` 锁住，但**文案没有**——
 * 两份副本可以各自漂移，用户会在表单旁看到一份说法、在接口 400 里看到另一份说法。
 *
 * 本测试从两个角度锁：
 * 1. 运行时：`validatePolicy` 实际抛出的消息 === 从 `policy.ts` 导出的常量（语义，不是文本）；
 * 2. 仓库级：整段字面量在 `server/**` 里**只出现一次**（真源以外不得再抄一份副本）。
 */

const SERVER_DIR = new URL('./', import.meta.url)

function serverSources(): string[] {
  return fs
    .readdirSync(SERVER_DIR)
    .filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts'))
    .map((name) => path.join(new URL('./', import.meta.url).pathname, name))
}

test('validatePolicy 抛出的消息就是导出的那份唯一真源', () => {
  let message = ''
  try {
    validatePolicy({ enabled: true, groups: ['g1'], totalConcurrency: 501, groupConcurrency: { g1: 1 } })
  } catch (error) {
    message = error instanceof Error ? error.message : String(error)
  }
  assert.equal(message, TOTAL_CONCURRENCY_RULE, '校验文案必须直接引用常量，而不是再内联一份字面量')
  assert.match(TOTAL_CONCURRENCY_RULE, /0 到 500 的整数/)
})

test('并发规则字面量在 server/** 里只有一处（真源在 policy.ts）', () => {
  const hits: string[] = []
  for (const file of serverSources()) {
    const source = fs.readFileSync(file, 'utf8')
    const count = source.split(TOTAL_CONCURRENCY_RULE).length - 1
    if (count > 0) hits.push(`${path.basename(file)} ×${count}`)
  }
  assert.deepEqual(
    hits,
    ['policy.ts ×1'],
    `并发规则文案出现多处，说明又抄了一份副本（真源只应在 policy.ts）：${hits.join('、')}`,
  )
})

test('自检：把字面量再抄一份进别的文件会被抓出来（合成样本，不依赖生产文件）', () => {
  const scan = (sources: Record<string, string>) =>
    Object.entries(sources)
      .filter(([, source]) => source.includes(TOTAL_CONCURRENCY_RULE))
      .map(([name, source]) => `${name} ×${source.split(TOTAL_CONCURRENCY_RULE).length - 1}`)
  assert.deepEqual(scan({ 'policy.ts': `export const R = '${TOTAL_CONCURRENCY_RULE}'` }), ['policy.ts ×1'])
  assert.deepEqual(
    scan({ 'policy.ts': `export const R = '${TOTAL_CONCURRENCY_RULE}'`, 'index.ts': `const R = '${TOTAL_CONCURRENCY_RULE}'` }),
    ['policy.ts ×1', 'index.ts ×1'],
    '第二份副本必须被扫出来',
  )
})

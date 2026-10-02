import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

// runtime 目录在模块加载时确定：先指到临时目录再导入，绝不碰真实 ~/.agents/crosery/magpie-upstream。
const runtime = await fs.mkdtemp(path.join(os.tmpdir(), 'magpie-upstream-backoff-'))
process.env.MAGPIE_UPSTREAM_RUNTIME = runtime
const upstream = await import(`./magpie-upstream.mjs?backoff=${Date.now()}`)
const baseline = JSON.parse(await fs.readFile(upstream.baselinePath, 'utf8'))
const originalFetch = globalThis.fetch
const originalPath = process.env.PATH
after(async () => {
  globalThis.fetch = originalFetch
  process.env.PATH = originalPath
  await fs.rm(runtime, { recursive: true, force: true })
})

const statusFile = path.join(runtime, 'status.json')
const writeStatus = value => fs.writeFile(statusFile, JSON.stringify(value), { mode: 0o600 })
const readStatus = async () => JSON.parse(await fs.readFile(statusFile, 'utf8'))
const SHA = 'b'.repeat(40)

function githubFake(handler) {
  const calls = []
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), ifNoneMatch: new Headers(init.headers).get('if-none-match') })
    return handler(String(url), calls.length)
  }
  return calls
}

test('退避期内不发任何请求，状态文件原样保留', async () => {
  const previous = { version: 1, status: 'error', checkedAt: new Date().toISOString(), failures: 3, nextAttemptAt: new Date(Date.now() + 60 * 60_000).toISOString() }
  await writeStatus(previous)
  const calls = githubFake(() => { throw new Error('must not fetch') })
  const result = await upstream.checkUpstream()
  assert.equal(result.skipped, true)
  assert.equal(calls.length, 0)
  assert.deepEqual(await readStatus(), previous)
})

test('上游 main 未变：沿用上次候选（不 git fetch、不 go run），条件请求带 ETag', async () => {
  const extractor = await upstream.extractorFingerprint()
  await writeStatus({
    version: 1, status: 'review_required', checkedAt: '2026-10-01T00:00:00.000Z', baselineRevision: baseline.revision,
    candidateRevision: SHA, latestRelease: 'v0.1.1', rtkRelease: 'v0.50.0', diff: { addedRoutes: [], addedSettings: [] }, artifact: 'candidates/x', extractor, failures: 0,
  })
  process.env.PATH = path.join(runtime, 'no-bin') // 万一走到 checkout 也只会本地失败，不会联网
  try {
    const first = githubFake((url) => new Response(JSON.stringify(url.includes('/commits/') ? { sha: SHA } : { tag_name: url.includes('rtk') ? 'v0.51.0' : 'v0.1.2' }), {
      status: 200, headers: { etag: `"${url.length}"` },
    }))
    const status = await upstream.checkUpstream()
    assert.equal(status.reused, true)
    assert.equal(status.status, 'review_required')
    assert.equal(status.rtkRelease, 'v0.51.0')
    assert.equal(first.length, 3)
    assert.ok(first.every(call => call.ifNoneMatch === null))

    const second = githubFake(() => new Response(null, { status: 304 }))
    const again = await upstream.checkUpstream()
    assert.equal(again.reused, true)
    assert.equal(again.latestRelease, 'v0.1.2', '304 时沿用缓存的响应体')
    assert.ok(second.every(call => call.ifNoneMatch), '第二轮全部是条件请求')
  } finally {
    process.env.PATH = originalPath
  }
})

test('上次的状态没有设置对比（发布前写的）：不沿用，重新检出候选一次', async () => {
  const extractor = await upstream.extractorFingerprint()
  await writeStatus({
    version: 1, status: 'review_required', checkedAt: '2026-10-01T00:00:00.000Z', baselineRevision: baseline.revision,
    candidateRevision: SHA, diff: { addedRoutes: [] }, artifact: 'candidates/x', extractor, failures: 0,
  })
  process.env.PATH = path.join(runtime, 'no-bin') // checkout 只会本地失败，不会联网
  try {
    githubFake((url) => new Response(JSON.stringify(url.includes('/commits/') ? { sha: SHA } : { tag_name: 'v0.1.2' }), { status: 200 }))
    await assert.rejects(upstream.checkUpstream(), /failed at source-checkout/)
    assert.equal((await readStatus()).errorStage, 'source-checkout')
  } finally {
    process.env.PATH = originalPath
    await writeStatus({ version: 1, status: 'unchanged', checkedAt: '2026-10-01T00:00:00.000Z' })
  }
})

test('GitHub 限流：按 x-ratelimit-reset 退避，下一轮直接跳过', async () => {
  await writeStatus({ version: 1, status: 'unchanged', checkedAt: '2026-10-01T00:00:00.000Z', candidateRevision: SHA, baselineRevision: baseline.revision })
  const reset = Math.floor(Date.now() / 1000) + 3 * 60 * 60
  githubFake(() => new Response('rate limited', { status: 403, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(reset) } }))
  await assert.rejects(upstream.checkUpstream(), /public-metadata/)
  const status = await readStatus()
  assert.equal(status.status, 'error')
  assert.equal(status.candidateRevision, SHA, '失败保留上次候选')
  assert.ok(Date.parse(status.nextAttemptAt) >= reset * 1000 - 1000)
  const calls = githubFake(() => { throw new Error('must not fetch') })
  assert.equal((await upstream.checkUpstream()).skipped, true)
  assert.equal(calls.length, 0)
})

test('连续失败的退避节奏：第一次不额外等待，之后 30 分钟起翻倍封顶 6 小时', () => {
  assert.equal(upstream.nextAttemptDelay(1), 0)
  assert.equal(upstream.nextAttemptDelay(2), 30 * 60_000)
  assert.equal(upstream.nextAttemptDelay(3), 60 * 60_000)
  assert.equal(upstream.nextAttemptDelay(20), 6 * 60 * 60_000)
  assert.equal(upstream.nextAttemptDelay(1, 90 * 60_000), 90 * 60_000)
  assert.equal(upstream.rateLimitDelay(new Headers({ 'retry-after': '120' })), 120_000)
  assert.equal(upstream.rateLimitDelay(new Headers({ 'x-ratelimit-remaining': '5', 'x-ratelimit-reset': '1' })), null)
})

/* ────────────────────────── review-sync-balance ────────────────────────── */

test('SB-17 Retry-After 的 HTTP 日期格式也被识别', () => {
  const now = Date.parse('2026-10-02T00:00:00Z')
  assert.equal(upstream.rateLimitDelay(new Headers({ 'retry-after': new Date(now + 90_000).toUTCString() }), now), 90_000)
})

test('SB-17 可选端点（release / rtk）被限流：主检查照常完成，但 GitHub 给的等待时间被记下并严格遵守', async () => {
  const extractor = await upstream.extractorFingerprint()
  await writeStatus({
    version: 1, status: 'unchanged', checkedAt: '2026-10-01T00:00:00.000Z', baselineRevision: baseline.revision,
    candidateRevision: SHA, diff: { addedRoutes: [], addedSettings: [] }, artifact: 'candidates/x', extractor, failures: 0,
  })
  await fs.rm(path.join(runtime, 'http-cache.json'), { force: true })
  process.env.PATH = path.join(runtime, 'no-bin')
  const deadline = Date.now() + 2 * 60 * 60_000
  try {
    githubFake((url) => {
      if (url.includes('/commits/')) return new Response(JSON.stringify({ sha: SHA }), { status: 200 })
      if (url.includes('rtk-ai')) return new Response('limited', { status: 429, headers: { 'retry-after': new Date(deadline).toUTCString() } })
      return new Response('limited', { status: 403, headers: { 'retry-after': '600' } })
    })
    const status = await upstream.checkUpstream()
    assert.equal(status.reused, true)
    assert.equal(status.failures, 0)
    assert.ok(Math.abs(Date.parse(status.retryNotBefore) - deadline) < 2_000, '取三个请求里最晚的等待时间')
  } finally {
    process.env.PATH = originalPath
  }
  const calls = githubFake(() => { throw new Error('must not fetch') })
  assert.equal((await upstream.checkUpstream()).skipped, true)
  assert.equal(calls.length, 0)
})

test('SB-17 容差只放宽本地指数退避，不放宽 GitHub 给的等待时间', async () => {
  const soon = new Date(Date.now() + 60_000).toISOString()
  await writeStatus({ version: 1, status: 'error', checkedAt: new Date().toISOString(), failures: 2, retryNotBefore: soon })
  const calls = githubFake(() => { throw new Error('must not fetch') })
  assert.equal((await upstream.checkUpstream()).skipped, true, '离上游给的时间还差 1 分钟：不提前')
  assert.equal(calls.length, 0)

  await writeStatus({ version: 1, status: 'error', checkedAt: new Date().toISOString(), failures: 2, nextAttemptAt: soon, candidateRevision: SHA, baselineRevision: baseline.revision })
  githubFake(() => new Response('down', { status: 502 }))
  await assert.rejects(upstream.checkUpstream(), /public-metadata/, '本地退避差 1 分钟：launchd 节拍误差内照常检查')
})

test('SB-17 主请求失败时也采用可选端点给出的更晚等待时间', async () => {
  await writeStatus({ version: 1, status: 'unchanged', checkedAt: '2026-10-01T00:00:00.000Z', candidateRevision: SHA, baselineRevision: baseline.revision })
  await fs.rm(path.join(runtime, 'http-cache.json'), { force: true })
  githubFake((url) => (url.includes('/commits/')
    ? new Response('limited', { status: 429, headers: { 'retry-after': '60' } })
    : new Response('limited', { status: 429, headers: { 'retry-after': '5400' } })))
  const before = Date.now()
  await assert.rejects(upstream.checkUpstream(), /public-metadata/)
  const status = await readStatus()
  assert.ok(Date.parse(status.retryNotBefore) >= before + 5_400_000 - 1_000)
  assert.ok(Date.parse(status.nextAttemptAt) >= before + 5_400_000 - 1_000)
})

test('SB-17 可选端点的等待时间在后续阶段失败时不丢；截止时间按收到响应的时刻算', async () => {
  const extractor = await upstream.extractorFingerprint()
  await writeStatus({
    version: 1, status: 'unchanged', checkedAt: '2026-10-01T00:00:00.000Z', baselineRevision: baseline.revision,
    candidateRevision: SHA, diff: { addedRoutes: [], addedSettings: [] }, artifact: 'candidates/x', extractor, failures: 0,
  })
  await fs.rm(path.join(runtime, 'http-cache.json'), { force: true })
  process.env.PATH = path.join(runtime, 'no-bin') // 上游 main 变了 → 要 checkout，没有 git：本地失败，不联网
  let respondedAt = 0
  try {
    githubFake(async (url) => {
      if (url.includes('/commits/')) return new Response(JSON.stringify({ sha: 'c'.repeat(40) }), { status: 200 })
      await new Promise(resolve => setTimeout(resolve, 30)) // 响应比本轮开始晚到
      respondedAt = Date.now()
      return new Response('limited', { status: 429, headers: { 'retry-after': '5400' } })
    })
    await assert.rejects(upstream.checkUpstream(), /source-checkout/)
  } finally {
    process.env.PATH = originalPath
  }
  const status = await readStatus()
  assert.equal(status.errorStage, 'source-checkout')
  assert.ok(Date.parse(status.retryNotBefore) >= respondedAt + 5_400_000, 'GitHub 给的等待时间带到失败状态里，并从响应时刻起算')
  assert.ok(Date.parse(status.nextAttemptAt) >= Date.parse(status.retryNotBefore) - 1_000)
  const calls = githubFake(() => { throw new Error('must not fetch') })
  assert.equal((await upstream.checkUpstream()).skipped, true)
  assert.equal(calls.length, 0)
})

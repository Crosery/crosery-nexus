import './testDataDir.js'

import assert from 'node:assert/strict'
import test from 'node:test'
import { extractAntigravityProjectId, fetchAntigravityAccountQuota } from './antigravityQuota.js'
import { AccountQuotaUpstreamError } from './accountQuota.js'

test('AntiGravity project id is resolved from every credential shape CPA currently accepts', () => {
  assert.equal(extractAntigravityProjectId({ project_id: 'direct-project' }), 'direct-project')
  assert.equal(extractAntigravityProjectId({ attributes: { gemini_virtual_project: 'attribute-project' } }), 'attribute-project')
  assert.equal(extractAntigravityProjectId({ installed: { project_id: 'installed-project' } }), 'installed-project')
  assert.equal(extractAntigravityProjectId({ web: { projectId: 'web-project' } }), 'web-project')
})

test('AntiGravity monitor downloads the credential only when the auth-file summary lacks project id', async () => {
  const calls: Array<Record<string, unknown>> = []
  const quota = await fetchAntigravityAccountQuota(
    { name: 'ag.json', auth_index: 'ag-1', type: 'antigravity' },
    {
      downloadAuthFile: async () => ({ installed: { project_id: 'downloaded-project' } }),
      apiCall: async (_authIndex, url, options) => {
        calls.push({ url, ...options })
        if (url.includes('loadCodeAssist')) {
          return { status_code: 200, body: { paidTier: { id: 'g1-pro-tier', name: 'Google AI Pro' } } }
        }
        return {
          status_code: 200,
          body: { groups: [{ displayName: 'Gemini Models', buckets: [{ bucketId: 'weekly', remainingFraction: 0.5, resetTime: '2026-09-03T07:28:21Z' }] }] },
        }
      },
    },
  )

  assert.equal(quota.subscription?.plan, 'pro')
  assert.equal(quota.groups.length, 1)
  const quotaCall = calls.find((call) => String(call.url).includes('retrieveUserQuotaSummary'))
  assert.deepEqual(JSON.parse(String(quotaCall?.data)), { project: 'downloaded-project' })
})

test('AntiGravity quota falls back across Google control-plane hosts', async () => {
  const hosts: string[] = []
  let quotaCalls = 0
  const quota = await fetchAntigravityAccountQuota(
    { name: 'ag.json', auth_index: 'ag-1', type: 'antigravity', project_id: 'direct-project' },
    {
      downloadAuthFile: async () => { throw new Error('不应下载') },
      apiCall: async (_authIndex, url) => {
        hosts.push(new URL(url).hostname)
        if (url.includes('loadCodeAssist')) return { status_code: 404, body: {} }
        quotaCalls += 1
        if (quotaCalls === 1) return { status_code: 404, body: {} }
        return { status_code: 200, body: { groups: [{ displayName: 'Gemini Models', buckets: [{ remainingFraction: 1 }] }] } }
      },
    },
  )

  assert.equal(quota.groups.length, 1)
  assert.ok(hosts.includes('daily-cloudcode-pa.sandbox.googleapis.com'))
})

test('AntiGravity quota also falls back after a transport exception', async () => {
  let quotaCalls = 0
  const quota = await fetchAntigravityAccountQuota(
    { name: 'ag.json', auth_index: 'ag-1', type: 'antigravity', project_id: 'direct-project' },
    {
      downloadAuthFile: async () => { throw new Error('不应下载') },
      apiCall: async (_authIndex, url) => {
        if (url.includes('loadCodeAssist')) return { status_code: 200, body: {} }
        quotaCalls += 1
        if (quotaCalls === 1) throw new Error('TLS timeout')
        return { status_code: 200, body: { groups: [{ displayName: 'Gemini Models', buckets: [{ remainingFraction: 0.8 }] }] } }
      },
    },
  )
  assert.equal(quota.groups.length, 1)
  assert.equal(quotaCalls, 2)
})

test('AntiGravity 遇到 429/401/403 立刻停手：不换域名重打同一账号，也不再查订阅', async () => {
  const urls: string[] = []
  await assert.rejects(
    fetchAntigravityAccountQuota(
      { name: 'ag.json', auth_index: 'ag-1', type: 'antigravity', project_id: 'direct-project' },
      {
        downloadAuthFile: async () => { throw new Error('不应下载') },
        apiCall: async (_authIndex, url) => {
          urls.push(url)
          return { status_code: 429, body: {} }
        },
      },
    ),
    (error: unknown) => {
      assert.ok(error instanceof AccountQuotaUpstreamError)
      assert.equal(error.status, 429)
      return true
    },
  )
  assert.equal(urls.length, 1)
  assert.ok(!urls.some(url => url.includes('loadCodeAssist')))
})

const claudeGroup = { displayName: 'Claude and GPT models', buckets: [{ bucketId: '3p-5h', window: '5h', remainingFraction: 0.99, resetTime: '2026-10-17T18:57:37Z' }] }
const geminiInfo = (fraction: number, resetTime?: string) => ({ quotaInfo: { remainingFraction: fraction, ...(resetTime ? { resetTime } : {}) } })

test('AntiGravity 汇总里没有 Gemini 分组：从 fetchAvailableModels 补一个 5 小时窗口（取剩余最少的 Gemini 模型）', async () => {
  const urls: string[] = []
  const quota = await fetchAntigravityAccountQuota(
    { name: 'ag.json', auth_index: 'ag-1', type: 'antigravity', project_id: 'direct-project' },
    {
      downloadAuthFile: async () => { throw new Error('不应下载') },
      apiCall: async (_authIndex, url, options) => {
        urls.push(url)
        if (url.includes('loadCodeAssist')) return { status_code: 200, body: {} }
        if (url.endsWith(':fetchAvailableModels')) {
          assert.deepEqual(JSON.parse(String(options?.data)), { project: 'direct-project' })
          return { status_code: 200, body: { models: {
            'gemini-3-flash': geminiInfo(0.9, '2026-10-17T14:52:56Z'),
            'gemini-2.5-pro': geminiInfo(0.87, '2026-10-17T14:52:56Z'),
            'claude-sonnet-4-6': geminiInfo(0.5, '2026-10-17T18:57:37Z'),
            tab_flash_lite_preview: { quotaInfo: { remainingFraction: 1 } },
          } } }
        }
        return { status_code: 200, body: { groups: [claudeGroup] } }
      },
    },
  )
  assert.deepEqual(quota.groups.map((group) => group.displayName), ['Gemini models', 'Claude and GPT models'])
  assert.deepEqual(quota.groups[0].buckets, [{ bucketId: 'gemini-5h', displayName: 'Five Hour Limit Remaining', window: '5h', remainingFraction: 0.87, resetTime: '2026-10-17T14:52:56Z' }])
  assert.equal(urls.filter((url) => url.endsWith(':fetchAvailableModels')).length, 1)
  assert.equal(new URL(urls.find((url) => url.endsWith(':fetchAvailableModels'))!).hostname, 'daily-cloudcode-pa.googleapis.com', '沿用汇总接口成功的那个域名')
})

test('AntiGravity 汇总里已有 Gemini 分组：不再多打 fetchAvailableModels', async () => {
  const urls: string[] = []
  const quota = await fetchAntigravityAccountQuota(
    { name: 'ag.json', auth_index: 'ag-1', type: 'antigravity', project_id: 'direct-project' },
    {
      downloadAuthFile: async () => { throw new Error('不应下载') },
      apiCall: async (_authIndex, url) => {
        urls.push(url)
        if (url.includes('loadCodeAssist')) return { status_code: 200, body: {} }
        return { status_code: 200, body: { groups: [{ displayName: 'Gemini Models', buckets: [{ remainingFraction: 0.5 }] }, claudeGroup] } }
      },
    },
  )
  assert.equal(quota.groups.length, 2)
  assert.ok(!urls.some((url) => url.endsWith(':fetchAvailableModels')))
})

test('AntiGravity 补 Gemini 额度失败（HTTP 错误 / 抛异常 / 没有 Gemini 模型）：不影响其余额度', async () => {
  for (const behave of ['http500', 'throws', 'noGemini'] as const) {
    const quota = await fetchAntigravityAccountQuota(
      { name: 'ag.json', auth_index: 'ag-1', type: 'antigravity', project_id: 'direct-project' },
      {
        downloadAuthFile: async () => { throw new Error('不应下载') },
        apiCall: async (_authIndex, url) => {
          if (url.includes('loadCodeAssist')) return { status_code: 200, body: {} }
          if (url.endsWith(':fetchAvailableModels')) {
            if (behave === 'throws') throw new Error('TLS timeout')
            if (behave === 'http500') return { status_code: 500, body: {} }
            return { status_code: 200, body: { models: { 'claude-sonnet-4-6': geminiInfo(0.5, '2026-10-17T18:57:37Z') } } }
          }
          return { status_code: 200, body: { groups: [claudeGroup] } }
        },
      },
    )
    assert.deepEqual(quota.groups.map((group) => group.displayName), ['Claude and GPT models'], behave)
  }
})

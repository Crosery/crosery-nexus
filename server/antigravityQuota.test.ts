import './testDataDir.js'

import assert from 'node:assert/strict'
import test from 'node:test'
import { extractAntigravityProjectId, fetchAntigravityAccountQuota } from './antigravityQuota.js'

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

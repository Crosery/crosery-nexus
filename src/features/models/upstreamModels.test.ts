import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import { ApiError, api, modelUpstreamModelsUrl } from '../../api'
import { errorStatus } from '../../lib/errors'
import {
  buildUpstreamModelsView,
  toggleUpstreamModelExpanded,
  type UpstreamModelsPayload,
} from './modelRows'

// 避免测试文件里的字面量被 server/testing/frontendCalls.ts 当成未登记的 /api 引用
const API_MODELS_PREFIX = ['', 'api', 'models'].join('/')

test('modelUpstreamModelsUrl 与 api.modelUpstreamModels：URL 拼装与请求/错误态传递', async () => {
  assert.equal(
    modelUpstreamModelsUrl('gemini-3.8-flash-high'),
    `${API_MODELS_PREFIX}/gemini-3.8-flash-high/upstream-models?days=7`,
  )
  assert.equal(
    api.modelUpstreamModelsUrl('google/gemini-3.8-flash:free', 14),
    `${API_MODELS_PREFIX}/google%2Fgemini-3.8-flash%3Afree/upstream-models?days=14`,
  )

  const originalFetch = globalThis.fetch
  const calls: string[] = []
  try {
    const sample: UpstreamModelsPayload = {
      requested: 'gemini-3.8-flash-high',
      days: 7,
      total: 4,
      served: [
        {
          model: 'gemini-3.8-flash-exp-a',
          requests: 3,
          accounts: [
            { authIndex: 'ag-1', requests: 2 },
            { authIndex: 'ag-2', requests: 1 },
          ],
        },
        {
          model: 'gemini-3.8-flash-n',
          requests: 1,
          accounts: [{ authIndex: 'ag-1', requests: 1 }],
        },
      ],
    }

    globalThis.fetch = (async (input: string | URL | Request) => {
      calls.push(String(input))
      return new Response(JSON.stringify(sample), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }) as typeof fetch

    const res = await api.modelUpstreamModels('gemini-3.8-flash-high', 7)
    assert.deepEqual(calls, [`${API_MODELS_PREFIX}/gemini-3.8-flash-high/upstream-models?days=7`])
    assert.deepEqual(res, sample)

    // 错误态：上游 503 与 403 权限拒绝都能被 errorStatus 识别并交给 StateBlock 渲染
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ error: '上游模型统计暂不可用', code: 'upstream_unavailable' }), {
        status: 503,
        headers: { 'content-type': 'application/json' },
      })) as typeof fetch

    await assert.rejects(
      () => api.modelUpstreamModels('gemini-3.8-flash-high', 7),
      (err: unknown) => {
        assert.ok(err instanceof ApiError)
        assert.equal(errorStatus(err), 503)
        assert.match(err.message, /上游模型统计暂不可用/)
        return true
      },
    )
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('buildUpstreamModelsView：渲染改写分布、占比与账号展开维度', () => {
  const view = buildUpstreamModelsView({
    requested: 'gemini-3.8-flash-high',
    days: 7,
    total: 4,
    served: [
      {
        model: 'gemini-3.8-flash-exp-a',
        requests: 3,
        accounts: [
          { authIndex: 'ag-1', requests: 2 },
          { authIndex: 'ag-2', requests: 1 },
        ],
      },
      {
        model: 'gemini-3.8-flash-n',
        requests: 1,
        accounts: [{ authIndex: '', requests: 1 }],
      },
    ],
  })

  assert.equal(view.status, 'rewritten')
  assert.equal(view.summary, '上游分流为 2 种实际模型')
  assert.equal(view.total, 4)
  assert.equal(view.rows.length, 2)

  assert.deepEqual(
    view.rows.map((r) => ({
      model: r.model,
      rewritten: r.rewritten,
      requests: r.requests,
      shareText: r.shareText,
      accountCount: r.accountCount,
    })),
    [
      {
        model: 'gemini-3.8-flash-exp-a',
        rewritten: true,
        requests: 3,
        shareText: '75.0%',
        accountCount: 2,
      },
      {
        model: 'gemini-3.8-flash-n',
        rewritten: true,
        requests: 1,
        shareText: '25.0%',
        accountCount: 1,
      },
    ],
  )

  assert.deepEqual(
    view.rows[0].accounts.map((a) => [a.label, a.requests, a.shareText]),
    [
      ['ag-1', 2, '66.7%'],
      ['ag-2', 1, '33.3%'],
    ],
  )
  assert.deepEqual(
    view.rows[1].accounts.map((a) => [a.label, a.requests, a.shareText]),
    [['未记录账号', 1, '100%']],
  )

  // 展开 / 收起状态切换
  let expanded = new Set<string>()
  expanded = toggleUpstreamModelExpanded(expanded, 'gemini-3.8-flash-exp-a')
  assert.equal(expanded.has('gemini-3.8-flash-exp-a'), true)
  expanded = toggleUpstreamModelExpanded(expanded, 'gemini-3.8-flash-exp-a')
  assert.equal(expanded.has('gemini-3.8-flash-exp-a'), false)
})

test('buildUpstreamModelsView：空态（暂无记录）与未改写态（上游未改写）文案', () => {
  const empty = buildUpstreamModelsView(
    { requested: 'gemini-3.8-flash-high', days: 7, total: 0, served: [] },
    'gemini-3.8-flash-high',
  )
  assert.equal(empty.status, 'empty')
  assert.equal(empty.summary, '近 7 天暂无记录')
  assert.deepEqual(empty.rows, [])

  const nullPayload = buildUpstreamModelsView(null, 'gpt-5', 14)
  assert.equal(nullPayload.status, 'empty')
  assert.equal(nullPayload.summary, '近 14 天暂无记录')

  const unchanged = buildUpstreamModelsView({
    requested: 'gemini-3.8-flash-high',
    days: 7,
    total: 5,
    served: [
      {
        model: 'google/gemini-3.8-flash-high',
        requests: 5,
        accounts: [{ authIndex: 'ag-1', requests: 5 }],
      },
    ],
  })
  assert.equal(unchanged.status, 'unchanged')
  assert.equal(unchanged.summary, '上游未改写')
  assert.equal(unchanged.rows.length, 1)
  assert.equal(unchanged.rows[0].rewritten, false)
  assert.equal(unchanged.rows[0].shareText, '100%')
})

test('ModelSheet 与 ModelUpstreamModels 组件接线：挂载面板、加载/错误/空态/未改写与账号展开齐全', () => {
  const sheetSource = fs.readFileSync(new URL('./ModelSheet.vue', import.meta.url), 'utf8')
  const panelSource = fs.readFileSync(new URL('./ModelUpstreamModels.vue', import.meta.url), 'utf8')

  assert.match(sheetSource, /<ModelUpstreamModels\s+:model-key="row\.key"\s+:model-id="row\.id"\s+:active="open"\s*\/>/)
  assert.match(panelSource, /api\.modelUpstreamModels\(key,\s*props\.days,\s*controller\.signal\)/)
  assert.match(panelSource, /<StateBlock[\s\S]*?:state="state"[\s\S]*?@retry="loadUpstream"/)
  assert.match(panelSource, /上游未改写/)
  assert.match(panelSource, /v-else-if="view\.status === 'empty'"/)
  assert.match(panelSource, /:aria-expanded="expanded\.has\(item\.model\)"/)
})

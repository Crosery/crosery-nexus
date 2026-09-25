import { createPortal } from 'react-dom'
import { CLIENT_LABELS } from '../clientLabels'
import { channelLabel } from '../channelLabels'
import type { RequestDetailItem } from '../types'

type RequestItem = RequestDetailItem

export function RequestDetail({ request, onClose }: { request: RequestItem; onClose: () => void }) {
  return createPortal(
    <div className="request-detail-backdrop" role="presentation">
      <aside className="request-detail" role="dialog" aria-label="请求详情">
        <header><div><p className="eyebrow">REQUEST DETAIL</p><h2>{request.model}</h2></div><button type="button" className="icon-button" onClick={onClose}>×</button></header>
        <dl>
          <div><dt>请求时间</dt><dd>{new Date(request.timestamp).toLocaleString('zh-CN')}</dd></div>
          <div><dt>客户端 Key</dt><dd>{request.keyName || '未知'}</dd></div>
          <div><dt>调用客户端</dt><dd>{CLIENT_LABELS[request.clientType || 'unknown'] || '未知'}{request.userAgent ? <small className="detail-inline-note"> · CLI/Agent</small> : ''}</dd></div>
          <div><dt>来源 IP</dt><dd><code>{request.clientIp || '未记录'}</code></dd></div>
          <div><dt>渠道</dt><dd>{request.provider ? channelLabel(request.provider) : '未记录'}{request.provider && channelLabel(request.provider) !== request.provider ? <small className="detail-inline-note"> · {request.provider}</small> : ''}</dd></div>
          <div><dt>模型分组</dt><dd>{request.modelGroup || '未记录'}</dd></div>
          <div><dt>入口</dt><dd>{request.endpoint || '未记录'}</dd></div>
          <div><dt>请求 ID</dt><dd><code>{request.requestId}</code></dd></div>
          <div><dt>上游请求 ID</dt><dd><code>{request.upstreamRequestId || '未提供'}</code></dd></div>
          <div><dt>HTTP 状态</dt><dd>{request.statusCode ?? '未记录'}</dd></div>
          <div><dt>总耗时</dt><dd>{request.latencyMs} ms</dd></div>
          <div><dt>首 Token</dt><dd>{request.ttftMs || 0} ms</dd></div>
          <div><dt>思考等级</dt><dd>{request.reasoningEffort || '未记录'}</dd></div>
          {/* 缓存读与缓存写必须分开展示：写入按 1.25x 输入价计费，合并会掩盖真实花销 */}
          <div><dt>Token</dt><dd>原始输入 {request.inputTokens ?? 0} · 输出 {request.outputTokens ?? 0} · 推理 {request.reasoningTokens ?? 0} · 缓存读 {request.cachedTokens ?? request.cacheReadTokens ?? 0} · 缓存写 {request.cacheWriteTokens || 0}</dd></div>
          <div><dt>缓存归一化</dt><dd>新输入 {request.freshInputTokens ?? '未计算'} · 完整提示 {request.promptTokens ?? '未计算'} · 命中率 {request.hitRate === null || request.hitRate === undefined ? '未计算' : `${(request.hitRate * 100).toFixed(1)}%`} · 成本 {request.costUsd === null || request.costUsd === undefined ? '未定价' : `$${request.costUsd.toFixed(5)}`}</dd></div>
          <div className="detail-wide"><dt>User-Agent</dt><dd><code>{request.userAgent || '未上报'}</code></dd></div>
          <div className="detail-wide"><dt>请求/响应正文</dt><dd className="detail-note">CPA usage_queue 只提供用量与错误正文，不提供原始请求体或完整响应体；此处不会伪造缺失内容。</dd></div>
          <div className="detail-wide"><dt>错误正文</dt><dd className={request.errorDetail ? 'error-body' : ''}>{request.errorDetail || '无'}</dd></div>
        </dl>
      </aside>
    </div>,
    document.body,
  )
}

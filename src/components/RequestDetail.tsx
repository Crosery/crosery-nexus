import { createPortal } from 'react-dom'
import type { AnalyticsData } from '../types'

type RequestItem = AnalyticsData['requests'][number]

export function RequestDetail({ request, onClose }: { request: RequestItem; onClose: () => void }) {
  return createPortal(
    <div className="request-detail-backdrop" role="presentation" onMouseDown={onClose}>
      <aside className="request-detail" role="dialog" aria-label="请求详情" onMouseDown={(event) => event.stopPropagation()}>
        <header><div><p className="eyebrow">REQUEST DETAIL</p><h2>{request.model}</h2></div><button className="icon-button" onClick={onClose}>×</button></header>
        <dl>
          <div><dt>请求时间</dt><dd>{new Date(request.timestamp).toLocaleString('zh-CN')}</dd></div>
          <div><dt>客户端 Key</dt><dd>{request.keyName || '未知'}</dd></div>
          <div><dt>渠道</dt><dd>{request.provider}</dd></div>
          <div><dt>入口</dt><dd>{request.endpoint || '未记录'}</dd></div>
          <div><dt>请求 ID</dt><dd><code>{request.requestId}</code></dd></div>
          <div><dt>上游请求 ID</dt><dd><code>{request.upstreamRequestId || '未提供'}</code></dd></div>
          <div><dt>HTTP 状态</dt><dd>{request.statusCode}</dd></div>
          <div><dt>总耗时</dt><dd>{request.latencyMs} ms</dd></div>
          <div><dt>首 Token</dt><dd>{request.ttftMs || 0} ms</dd></div>
          <div><dt>思考等级</dt><dd>{request.reasoningEffort || '未记录'}</dd></div>
          <div><dt>Token</dt><dd>输入 {request.inputTokens} · 输出 {request.outputTokens} · 推理 {request.reasoningTokens} · 缓存 {request.cachedTokens}</dd></div>
          <div className="detail-wide"><dt>错误正文</dt><dd className={request.errorDetail ? 'error-body' : ''}>{request.errorDetail || '无'}</dd></div>
        </dl>
      </aside>
    </div>,
    document.body,
  )
}

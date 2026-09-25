import { Area, AreaChart, Bar, BarChart, CartesianGrid, Cell, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { useMemo } from 'react'
import { Select } from '../components/Select'
import { AXIS, colorForEntity, compact, ms, PRIMARY, STATUS, tooltipStyle } from '../chartTheme'
import type { ApiKeyItem, ChartsData, Group } from '../types'

const hour = (bucket: unknown) => String(bucket ?? '').slice(5, 13).replace('T', ' ')
const num = (value: unknown) => Number(value ?? 0)
const fmtCompact = (value: unknown) => compact(num(value))
const fmtMs = (value: unknown) => ms(num(value))
const errorCategoryLabel: Record<string, string> = {
  upstream_eof: '上游连接中断',
  client_cancelled: '客户端取消',
  context_too_large: '超出上下文',
  rate_limited: '限流',
  quota_exhausted: '额度耗尽',
  auth_failed: '凭据失效',
  wrong_endpoint: '端点不匹配',
  upstream_5xx: '上游 5xx',
  other: '其他',
}

export function ChartsPage({ analytics, latencyState, keys, groups, days, setDays, keyId, setKeyId }: { analytics: ChartsData | null; latencyState: 'idle' | 'loading' | 'ready' | 'error'; keys: ApiKeyItem[]; groups: Group[]; days: number; setDays: (days: number) => void; keyId: string; setKeyId: (id: string) => void }) {
  // 渠道顺序固定，保证同一渠道在任何图表里都是同一个颜色
  const groupOrder = useMemo(() => (analytics?.groups || []).map((item) => item.name), [analytics])
  const groupName = (id: string) => groups.find((group) => group.id === id)?.name || id

  const trend = analytics?.trend || []
  const channelData = (analytics?.groups || []).map((item) => ({ ...item, label: groupName(item.name) }))
  const modelData = (analytics?.models || []).slice(0, 6)
  const latencyData = (analytics?.latency || []).slice(0, 6)
  const statusData = analytics?.statusCodes || []
  const errorData = (analytics?.errorCategories || []).map((item) => ({ ...item, label: errorCategoryLabel[item.category] || item.category }))

  return <div className="page-stack">
    <section className="page-heading">
      <div><p className="eyebrow">ANALYTICS</p><h1>图表分析</h1><p>调用趋势、渠道与模型构成、延迟画像与失败分布。</p></div>
      <div className="heading-filters">
        <Select ariaLabel="选择 API Key" value={keyId} onChange={setKeyId} options={[{ value: '', label: '全部 API Key' }, ...keys.map((key) => ({ value: key.id, label: key.name }))]} />
        <Select ariaLabel="选择统计周期" value={String(days)} onChange={(value) => setDays(Number(value))} options={[{ value: '1', label: '最近 24 小时' }, { value: '7', label: '最近 7 天' }, { value: '30', label: '最近 30 天' }, { value: '90', label: '最近 90 天' }]} />
      </div>
    </section>

    <section className="charts-grid fill">
      <article className="panel chart-panel">
        <div className="panel-title"><div><h2>请求与错误趋势</h2><p>每小时请求量与失败数</p></div></div>
        <div className="chart-wrap">
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={trend} margin={{ top: 6, right: 10, bottom: 0, left: 2 }}>
              <defs>
                <linearGradient id="reqFill2" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={PRIMARY} stopOpacity=".26" />
                  <stop offset="100%" stopColor={PRIMARY} stopOpacity="0" />
                </linearGradient>
              </defs>
              <CartesianGrid stroke={AXIS.grid} vertical={false} />
              <XAxis dataKey="bucket" tickFormatter={hour} stroke={AXIS.tick} tickLine={false} axisLine={false} fontSize={11} minTickGap={30} />
              <YAxis stroke={AXIS.tick} tickLine={false} axisLine={false} fontSize={11} tickFormatter={fmtCompact} width={52} />
              <Tooltip contentStyle={tooltipStyle} labelFormatter={hour as never} formatter={((value: unknown, name: unknown) => [compact(num(value)), name === 'requests' ? '请求' : '失败']) as never} cursor={{ stroke: AXIS.tick, strokeWidth: 1 }} />
              <Legend verticalAlign="top" align="right" height={24} iconType="plainline" iconSize={14} formatter={(value) => <span className="legend-text">{value === 'requests' ? '请求' : '失败'}</span>} />
              <Area dataKey="requests" stroke={PRIMARY} strokeWidth={2} fill="url(#reqFill2)" dot={false} activeDot={{ r: 4, strokeWidth: 2, stroke: '#fff' }} isAnimationActive={false} />
              <Area dataKey="errors" stroke={STATUS.danger} strokeWidth={2} fill="transparent" dot={false} activeDot={{ r: 4, strokeWidth: 2, stroke: '#fff' }} isAnimationActive={false} />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      </article>

      <article className="panel chart-panel">
        <div className="panel-title"><div><h2>Token 消耗</h2><p>每小时 Token 总量</p></div></div>
        <div className="chart-wrap">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={trend} margin={{ top: 6, right: 10, bottom: 0, left: 2 }}>
              <CartesianGrid stroke={AXIS.grid} vertical={false} />
              <XAxis dataKey="bucket" tickFormatter={hour} stroke={AXIS.tick} tickLine={false} axisLine={false} fontSize={11} minTickGap={30} />
              <YAxis stroke={AXIS.tick} tickLine={false} axisLine={false} fontSize={11} tickFormatter={fmtCompact} width={52} />
              <Tooltip contentStyle={tooltipStyle} labelFormatter={hour as never} formatter={((value: unknown) => [compact(num(value)), 'Token']) as never} cursor={{ stroke: AXIS.tick, strokeWidth: 1 }} />
              <Line dataKey="tokens" stroke={PRIMARY} strokeWidth={2} dot={false} activeDot={{ r: 4, strokeWidth: 2, stroke: '#fff' }} isAnimationActive={false} />
            </LineChart>
          </ResponsiveContainer>
        </div>
      </article>

      <article className="panel chart-panel">
        <div className="panel-title"><div><h2>渠道分布</h2><p>按请求量</p></div></div>
        <div className="chart-wrap">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={channelData} layout="vertical" margin={{ top: 4, right: 46, bottom: 4, left: 4 }} barCategoryGap={7}>
              <XAxis type="number" hide />
              <YAxis type="category" dataKey="label" width={78} stroke={AXIS.tick} tickLine={false} axisLine={false} fontSize={11} />
              <Tooltip contentStyle={tooltipStyle} formatter={((value: unknown) => [compact(num(value)), '请求']) as never} cursor={{ fill: 'rgba(120,113,104,.06)' }} />
              <Bar dataKey="requests" radius={[0, 4, 4, 0]} barSize={14} label={{ position: 'right', formatter: fmtCompact, fontSize: 10, fill: AXIS.tick } as never} isAnimationActive={false}>
                {channelData.map((item) => <Cell key={item.name} fill={colorForEntity(item.name, groupOrder)} />)}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
      </article>

      <article className="panel chart-panel">
        <div className="panel-title"><div><h2>模型调用 Top</h2><p>按请求量</p></div></div>
        <div className="chart-wrap">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={modelData} layout="vertical" margin={{ top: 4, right: 46, bottom: 4, left: 4 }} barCategoryGap={7}>
              <XAxis type="number" hide />
              <YAxis type="category" dataKey="name" width={132} stroke={AXIS.tick} tickLine={false} axisLine={false} fontSize={11} />
              <Tooltip contentStyle={tooltipStyle} formatter={((value: unknown) => [compact(num(value)), '请求']) as never} cursor={{ fill: 'rgba(120,113,104,.06)' }} />
              <Bar dataKey="requests" fill={PRIMARY} radius={[0, 4, 4, 0]} barSize={13} label={{ position: 'right', formatter: fmtCompact, fontSize: 10, fill: AXIS.tick } as never} isAnimationActive={false} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </article>

      <article className="panel chart-panel">
        <div className="panel-title"><div><h2>响应延迟</h2><p>成功请求 · 均值与 p95</p></div></div>
        <div className="chart-wrap">
          {latencyData.length ? <ResponsiveContainer width="100%" height="100%">
            <BarChart data={latencyData} layout="vertical" margin={{ top: 4, right: 52, bottom: 4, left: 4 }} barCategoryGap={9}>
              <XAxis type="number" hide />
              <YAxis type="category" dataKey="name" width={132} stroke={AXIS.tick} tickLine={false} axisLine={false} fontSize={11} />
              <Tooltip contentStyle={tooltipStyle} formatter={((value: unknown, name: unknown) => [ms(num(value)), name === 'avgLatency' ? '均值' : 'p95']) as never} cursor={{ fill: 'rgba(120,113,104,.06)' }} />
              <Legend verticalAlign="top" align="right" height={22} iconSize={9} formatter={(value) => <span className="legend-text">{value === 'avgLatency' ? '均值' : 'p95'}</span>} />
              <Bar dataKey="avgLatency" fill={PRIMARY} radius={[0, 3, 3, 0]} barSize={9} isAnimationActive={false} />
              <Bar dataKey="p95" fill="#a8bdd8" radius={[0, 3, 3, 0]} barSize={9} label={{ position: 'right', formatter: fmtMs, fontSize: 10, fill: AXIS.tick } as never} isAnimationActive={false} />
            </BarChart>
          </ResponsiveContainer> : <div className="chart-empty">{latencyState === 'loading' ? '延迟分位正在加载' : latencyState === 'error' ? '延迟数据暂时不可用' : '暂无成功请求样本'}</div>}
        </div>
      </article>

      <article className="panel chart-panel">
        <div className="panel-title"><div><h2>失败构成</h2><p>按可操作原因归类，不再只看笼统的 HTTP 500</p></div></div>
        <div className="chart-wrap">
          {errorData.length ? <ResponsiveContainer width="100%" height="100%">
            <BarChart data={errorData} layout="vertical" margin={{ top: 4, right: 46, bottom: 4, left: 4 }} barCategoryGap={7}>
              <XAxis type="number" hide />
              <YAxis type="category" dataKey="label" width={92} stroke={AXIS.tick} tickLine={false} axisLine={false} fontSize={11} />
              <Tooltip contentStyle={tooltipStyle} formatter={((value: unknown) => [compact(num(value)), '次数']) as never} cursor={{ fill: 'rgba(120,113,104,.06)' }} />
              <Bar dataKey="count" fill={STATUS.danger} radius={[0, 4, 4, 0]} barSize={14} label={{ position: 'right', formatter: fmtCompact, fontSize: 10, fill: AXIS.tick } as never} isAnimationActive={false} />
            </BarChart>
          </ResponsiveContainer> : statusData.length ? <div className="chart-empty">历史失败尚未完成原因归类</div> : <div className="chart-empty ok">周期内没有失败请求</div>}
        </div>
      </article>
    </section>
  </div>
}

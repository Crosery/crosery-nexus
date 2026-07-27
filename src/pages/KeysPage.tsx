import { Check, Copy, KeyRound, MoreHorizontal, Plus, Search, Settings2, Trash2 } from 'lucide-react'
import { useMemo, useState } from 'react'
import { api } from '../api'
import { Modal } from '../components/Modal'
import type { ApiKeyItem, Group } from '../types'

const defaultConcurrency = (groups: Group[]) => Object.fromEntries(groups.map((group) => [group.id, 2]))

export function KeysPage({ keys, groups, onRefresh, onSelectKey }: { keys: ApiKeyItem[]; groups: Group[]; onRefresh: () => Promise<void>; onSelectKey: (key: ApiKeyItem) => void }) {
  const [query, setQuery] = useState('')
  const [editing, setEditing] = useState<ApiKeyItem | null>(null)
  const [creating, setCreating] = useState(false)
  const [revealed, setRevealed] = useState('')
  const [error, setError] = useState('')
  const filtered = useMemo(() => keys.filter((key) => `${key.name} ${key.note} ${key.maskedKey}`.toLowerCase().includes(query.toLowerCase())), [keys, query])
  return <div className="page-stack">
    <section className="page-heading"><div><p className="eyebrow">ACCESS CONTROL</p><h1>API Key 管理</h1><p>创建独立密钥，并为每个 Key 配置渠道分组与并发策略。</p></div><button className="primary-button" onClick={() => setCreating(true)}><Plus size={17}/>创建 API Key</button></section>
    <section className="panel table-panel">
      <div className="table-toolbar"><div className="search-box"><Search size={17}/><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索名称、备注或 Key" /></div><span className="result-count">{filtered.length} 个密钥</span></div>
      <div className="key-table"><div className="key-row table-head"><span>名称</span><span>渠道分组</span><span>并发</span><span>最近使用</span><span>状态</span><span /></div>
        {filtered.map((key) => <div className="key-row" key={key.id}>
          <button className="key-name-cell" onClick={() => onSelectKey(key)}><span className="key-icon"><KeyRound size={16}/></span><span><strong>{key.name}</strong><small>{key.maskedKey}</small></span></button>
          <div className="group-chips">{key.groups.length ? key.groups.slice(0, 3).map((id) => { const group = groups.find((item) => item.id === id); return <span key={id} style={{ '--chip': group?.color } as React.CSSProperties}>{group?.name || id}</span> }) : <span className="muted">未配置</span>}</div>
          <span><strong>{key.totalConcurrency}</strong><small className="cell-note"> 总并发</small></span>
          <span>{key.lastUsedAt ? new Date(key.lastUsedAt).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '从未使用'}</span>
          <span className={key.enabled ? 'status-chip success' : 'status-chip'}>{key.enabled ? '启用' : '停用'}</span>
          <div className="row-actions"><button className="icon-button" title="编辑" onClick={() => setEditing(key)}><Settings2 size={17}/></button><button className="icon-button" title="更多"><MoreHorizontal size={17}/></button></div>
        </div>)}
        {!filtered.length && <div className="empty-state"><KeyRound size={28}/><h3>没有找到 API Key</h3><p>创建一个密钥后即可开始分组授权和统计。</p></div>}
      </div>
    </section>
    {(creating || editing) && <KeyEditor key={editing?.id || 'new'} item={editing} groups={groups} onClose={() => { setCreating(false); setEditing(null); setError('') }} onSaved={async (newKey) => { if (newKey) setRevealed(newKey); setCreating(false); setEditing(null); await onRefresh() }} error={error} setError={setError} />}
    {revealed && <Modal title="API Key 创建成功" subtitle="完整密钥只在这里显示一次，请立即复制保存。" onClose={() => setRevealed('')}>
      <div className="reveal-key"><code>{revealed}</code><button className="icon-button" onClick={() => navigator.clipboard.writeText(revealed)}><Copy size={17}/></button></div><button className="primary-button full-button" onClick={() => { navigator.clipboard.writeText(revealed); setRevealed('') }}><Check size={17}/>复制并完成</button>
    </Modal>}
  </div>
}

function KeyEditor({ item, groups, onClose, onSaved, error, setError }: { item: ApiKeyItem | null; groups: Group[]; onClose: () => void; onSaved: (key?: string) => void; error: string; setError: (value: string) => void }) {
  const [name, setName] = useState(item?.name || '')
  const [note, setNote] = useState(item?.note || '')
  const [enabled, setEnabled] = useState(item?.enabled ?? true)
  const [selected, setSelected] = useState(item?.groups || groups.map((group) => group.id))
  const [total, setTotal] = useState(item?.totalConcurrency || 4)
  const [limits, setLimits] = useState(item?.groupConcurrency || defaultConcurrency(groups))
  const [saving, setSaving] = useState(false)
  const toggleGroup = (id: string) => setSelected((current) => current.includes(id) ? current.filter((value) => value !== id) : [...current, id])
  const save = async () => {
    setSaving(true); setError('')
    try {
      const body = { name, note, enabled, groups: selected, totalConcurrency: total, groupConcurrency: limits }
      if (item) { await api.updateKey(item.id, body); onSaved() } else { const result = await api.createKey<{ key: string }>(body); onSaved(result.key) }
    } catch (reason) { setError(reason instanceof Error ? reason.message : '保存失败') } finally { setSaving(false) }
  }
  const remove = async () => { if (!item || !confirm(`确定永久删除“${item.name}”吗？`)) return; await api.deleteKey(item.id); onSaved() }
  return <Modal wide title={item ? '编辑 API Key' : '创建 API Key'} subtitle="分组控制可用模型范围，并发策略用于保护网关资源。" onClose={onClose}>
    <div className="editor-grid"><div className="form-column">
      <label className="field-label">名称<input className="text-input" value={name} onChange={(event) => setName(event.target.value)} placeholder="例如：伊吹生产环境" /></label>
      <label className="field-label">备注<textarea className="text-input" value={note} onChange={(event) => setNote(event.target.value)} placeholder="记录使用方、用途或负责人" /></label>
      {item && <label className="toggle-row"><span><strong>启用密钥</strong><small>停用后将立即从 CPA 可用 Key 中移除</small></span><button type="button" className={enabled ? 'switch active' : 'switch'} onClick={() => setEnabled(!enabled)}><span /></button></label>}
      <div><span className="field-label standalone">允许使用的渠道分组</span><div className="group-selector">{groups.map((group) => <button type="button" className={selected.includes(group.id) ? 'group-choice active' : 'group-choice'} style={{ '--group': group.color } as React.CSSProperties} onClick={() => toggleGroup(group.id)} key={group.id}><span className="choice-dot"/><strong>{group.name}</strong>{selected.includes(group.id) && <Check size={15}/>}</button>)}</div></div>
    </div><div className="policy-column">
      <div className="policy-card"><div><h3>总并发限额</h3><p>该 Key 同时进行的全部请求数量。</p></div><div className="stepper"><button type="button" onClick={() => setTotal(Math.max(1, total - 1))}>−</button><input type="number" min="1" max="500" value={total} onChange={(event) => setTotal(Number(event.target.value))}/><button type="button" onClick={() => setTotal(Math.min(500, total + 1))}>+</button></div></div>
      <div className="policy-card vertical"><div><h3>分组并发限额</h3><p>每个分组独立限制，同时受总并发上限约束。</p></div><div className="limit-list">{groups.filter((group) => selected.includes(group.id)).map((group) => <label key={group.id}><span><i style={{ background: group.color }}/>{group.name}</span><input type="number" min="1" max={total} value={limits[group.id] || 1} onChange={(event) => setLimits({ ...limits, [group.id]: Number(event.target.value) })}/></label>)}</div></div>
    </div></div>
    {error && <p className="form-error modal-error">{error}</p>}
    <footer className="modal-footer">{item ? <button className="danger-button" onClick={remove}><Trash2 size={16}/>删除 Key</button> : <span/>}<div><button className="secondary-button" onClick={onClose}>取消</button><button className="primary-button" disabled={!name || !selected.length || saving} onClick={save}>{saving ? '保存中' : item ? '保存设置' : '创建密钥'}</button></div></footer>
  </Modal>
}

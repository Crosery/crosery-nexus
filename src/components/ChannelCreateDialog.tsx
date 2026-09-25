import { Check, LoaderCircle, Plus, Radar, Search } from 'lucide-react'
import { useMemo, useState } from 'react'
import { api } from '../api'
import type { DiscoveredModel } from '../types'
import { Modal } from './Modal'

type Protocol = 'openai' | 'claude'

export function ChannelCreateDialog({ onClose, onCreated }: { onClose: () => void; onCreated: (name: string) => Promise<void> }) {
  const [protocol, setProtocol] = useState<Protocol>('openai')
  const [name, setName] = useState('')
  const [baseUrl, setBaseUrl] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [models, setModels] = useState<DiscoveredModel[]>([])
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [query, setQuery] = useState('')
  const [endpoint, setEndpoint] = useState('')
  const [scanning, setScanning] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  const resetDiscovery = () => {
    setModels([])
    setSelected(new Set())
    setEndpoint('')
    setError('')
  }

  const scan = async () => {
    setScanning(true); setError('')
    try {
      const result = await api.discoverChannelModels({ protocol, baseUrl, apiKey })
      setModels(result.models)
      setSelected(new Set(result.models.map((model) => model.id)))
      setEndpoint(result.endpoint)
    } catch (reason) {
      setModels([]); setSelected(new Set())
      setError(reason instanceof Error ? reason.message : '扫描失败')
    } finally { setScanning(false) }
  }

  const save = async () => {
    setSaving(true); setError('')
    try {
      const chosen = models.filter((model) => selected.has(model.id))
      await api.createChannel({ name, protocol, baseUrl, apiKey, models: chosen })
      await onCreated(name.trim())
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '创建失败')
      setSaving(false)
    }
  }

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase()
    return needle ? models.filter((model) => `${model.id} ${model.alias}`.toLowerCase().includes(needle)) : models
  }, [models, query])

  const toggle = (id: string) => setSelected((current) => {
    const next = new Set(current)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    return next
  })

  const updateAlias = (id: string, alias: string) => setModels((current) => current.map((model) => model.id === id ? { ...model, alias } : model))

  return <Modal title="添加上游渠道" subtitle="填入上游地址和 API Key，先由小鸡云服务器扫描模型，再选择要公开的模型。" onClose={onClose} wide>
    <div className="channel-form-grid">
      <div className="protocol-picker">
        <button type="button" className={protocol === 'openai' ? 'protocol-option active' : 'protocol-option'} onClick={() => { setProtocol('openai'); resetDiscovery() }}>
          <strong>OpenAI 兼容</strong><small>使用 Bearer Key，扫描 /models 或 /v1/models</small>
        </button>
        <button type="button" className={protocol === 'claude' ? 'protocol-option active' : 'protocol-option'} onClick={() => { setProtocol('claude'); resetDiscovery() }}>
          <strong>Claude 兼容</strong><small>使用 x-api-key，扫描 /v1/models</small>
        </button>
      </div>
      <label className="field-label">渠道名
        <input className="text-input" value={name} onChange={(event) => setName(event.target.value)} placeholder="例如 minimax、kimi" />
      </label>
      <label className="field-label">Base URL
        <input className="text-input" value={baseUrl} onChange={(event) => { setBaseUrl(event.target.value); resetDiscovery() }} placeholder="https://api.example.com/v1" />
      </label>
      <label className="field-label">API Key
        <input className="text-input" type="password" value={apiKey} onChange={(event) => { setApiKey(event.target.value); resetDiscovery() }} placeholder="sk-..." autoComplete="off" />
      </label>
      <button className="secondary-button channel-scan-button" type="button" disabled={scanning || !baseUrl.trim() || !apiKey.trim()} onClick={() => void scan()}>
        {scanning ? <LoaderCircle className="spin" size={16} /> : <Radar size={16} />}{scanning ? '扫描中' : '扫描模型'}
      </button>
    </div>

    {error && <p className="form-error modal-error">{error}</p>}

    {models.length > 0 && <section className="discovery-results">
      <div className="discovery-head">
        <div><strong>扫描到 {models.length} 个模型</strong><small>{endpoint}</small></div>
        <div className="discovery-actions">
          <button className="text-button" type="button" onClick={() => setSelected(new Set(models.map((model) => model.id)))}>全选</button>
          <button className="text-button" type="button" onClick={() => setSelected(new Set())}>清空</button>
          <div className="search-box compact"><Search size={14} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="筛选模型" /></div>
        </div>
      </div>
      <div className="discovered-model-list scroll-area">
        {visible.map((model) => <div className={selected.has(model.id) ? 'discovered-model selected' : 'discovered-model'} key={model.id}>
          <button type="button" className="model-check" onClick={() => toggle(model.id)} aria-label={`选择 ${model.id}`}>
            {selected.has(model.id) && <Check size={13} />}
          </button>
          <div className="discovered-model-name"><strong>{model.id}</strong><small>上游模型名</small></div>
          <label>公开别名<input value={model.alias} disabled={!selected.has(model.id)} onChange={(event) => updateAlias(model.id, event.target.value)} /></label>
        </div>)}
      </div>
    </section>}

    <footer className="modal-footer"><span>{models.length ? `已选择 ${selected.size} 个模型` : '请先扫描模型'}</span><div>
      <button className="secondary-button" type="button" onClick={onClose}>取消</button>
      <button className="primary-button" type="button" disabled={saving || !name.trim() || selected.size === 0} onClick={() => void save()}>
        {saving ? <LoaderCircle className="spin" size={15} /> : <Plus size={15} />}{saving ? '创建中' : '创建渠道'}
      </button>
    </div></footer>
  </Modal>
}

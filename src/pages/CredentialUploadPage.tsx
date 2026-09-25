import { AlertTriangle, CheckCircle2, FileArchive, LoaderCircle, RefreshCw, ShieldCheck, UploadCloud, XCircle } from 'lucide-react'
import { useRef, useState } from 'react'
import { api } from '../api'

type UploadItem = { name: string; label: string; ok: boolean; skipped?: boolean; code?: string; message?: string }
type UploadResult = { traceId: string; total: number; uploaded: number; skipped: number; failed: number; items: UploadItem[] }

const formatBytes = (bytes: number) => {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

export function CredentialUploadPage({ limits, onUploaded, onNotify }: { limits: { maxBytes: number; maxEntries: number }; onUploaded: () => Promise<void>; onNotify: (message: string) => void }) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [file, setFile] = useState<File | null>(null)
  const [dragging, setDragging] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [error, setError] = useState('')
  const [result, setResult] = useState<UploadResult | null>(null)

  const selectFile = (next: File | null) => {
    setError('')
    setResult(null)
    if (!next) return setFile(null)
    if (!/\.(json|zip)$/i.test(next.name)) {
      setFile(null)
      setError('只允许上传 .json 或 .zip 文件')
      return
    }
    if (next.size > limits.maxBytes) {
      setFile(null)
      setError(`上传文件不能超过 ${formatBytes(limits.maxBytes)}`)
      return
    }
    setFile(next)
  }

  const upload = async () => {
    if (!file) return
    setUploading(true); setError(''); setResult(null)
    try {
      const response = await api.uploadCredentials<UploadResult>(file)
      setResult(response)
      await onUploaded()
      onNotify(response.failed ? `上传完成：${response.uploaded} 成功，${response.skipped} 跳过，${response.failed} 失败` : `已导入 ${response.uploaded} 个 Grok 凭据，跳过 ${response.skipped} 个已存在凭据`)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '上传失败')
    } finally {
      setUploading(false)
    }
  }

  return <div className="page-stack credential-upload-page">
    <section className="page-heading">
      <div><p className="eyebrow">CREDENTIAL INTAKE</p><h1>Grok 凭据上传</h1><p>在公网控制台直接导入 xAI/Grok CPA JSON 或 ZIP，凭据只在服务端校验并写入生产 CPA。</p></div>
      {result && <button className="secondary-button" onClick={() => { setFile(null); setResult(null); setError(''); if (inputRef.current) inputRef.current.value = '' }}><RefreshCw size={16} />上传下一批</button>}
    </section>

    <section className="upload-layout fill">
      <div className="panel upload-card">
        <div className="panel-title"><div><h2>选择凭据包</h2><p>单个 JSON 或包含多个 JSON 的 ZIP；每次最多 {limits.maxEntries} 个条目。</p></div><span className="soft-badge"><ShieldCheck size={12} />仅管理员</span></div>
        <input ref={inputRef} className="visually-hidden" type="file" accept=".json,.zip,application/json,application/zip" onChange={(event) => selectFile(event.target.files?.[0] || null)} />
        <button
          type="button"
          className={dragging ? 'upload-dropzone dragging' : 'upload-dropzone'}
          onClick={() => inputRef.current?.click()}
          onDragOver={(event) => { event.preventDefault(); setDragging(true) }}
          onDragLeave={() => setDragging(false)}
          onDrop={(event) => { event.preventDefault(); setDragging(false); selectFile(event.dataTransfer.files?.[0] || null) }}
        >
          <span className="upload-icon"><UploadCloud size={28} /></span>
          <strong>{file ? file.name : '拖入文件，或点击选择'}</strong>
          <small>{file ? `${formatBytes(file.size)} · ${file.type || '自动识别格式'}` : `支持 .json / .zip，上传体积上限 ${formatBytes(limits.maxBytes)}`}</small>
        </button>
        <div className="upload-safety-grid">
          <div><ShieldCheck size={16} /><span><strong>会话保护</strong><small>只有登录管理员可以访问</small></span></div>
          <div><FileArchive size={16} /><span><strong>安全解压</strong><small>拦截路径穿越、重名和超限压缩包</small></span></div>
          <div><AlertTriangle size={16} /><span><strong>限定 xAI</strong><small>拒绝非 Grok 凭据和缺少刷新令牌的文件</small></span></div>
        </div>
        {error && <div className="warning-strip upload-warning"><AlertTriangle size={16} />{error}</div>}
        <button className="primary-button upload-submit" disabled={!file || uploading} onClick={() => void upload()}>
          {uploading ? <LoaderCircle size={17} className="spin" /> : <UploadCloud size={17} />}{uploading ? '正在校验并写入 CPA' : '校验并上传到 CPA'}
        </button>
      </div>

      <div className="panel upload-result-panel">
        <div className="panel-title"><div><h2>上传结果</h2><p>只展示文件名、账号标识和状态，不返回 access token 或 refresh token。</p></div>{result && <span className={result.failed ? 'status-chip danger' : 'status-chip success'}>{result.failed ? '部分失败' : '全部成功'}</span>}</div>
        {!result && <div className="empty-compact upload-empty"><FileArchive size={30} /><p>完成上传后，这里会显示逐项结果和 trace ID。</p></div>}
        {result && <>
          <div className="upload-summary">
            <div><span>总数</span><strong>{result.total}</strong></div>
            <div className="success"><span>写入</span><strong>{result.uploaded}</strong></div>
            <div><span>跳过</span><strong>{result.skipped}</strong></div>
            <div className={result.failed ? 'danger' : ''}><span>失败</span><strong>{result.failed}</strong></div>
          </div>
          <div className="upload-trace"><span>Trace ID</span><code>{result.traceId}</code></div>
          <div className="upload-result-list scroll-area">
            {result.items.map((item) => <div className={item.ok ? 'upload-result-row' : 'upload-result-row failed'} key={item.name}>
              {item.ok ? <CheckCircle2 size={16} /> : <XCircle size={16} />}
              <span><strong>{item.label}</strong><small>{item.name}{item.message ? ` · ${item.message}` : ''}</small></span>
              <em>{item.skipped ? '已存在' : item.ok ? '已写入' : '失败'}</em>
            </div>)}
          </div>
        </>}
      </div>
    </section>
  </div>
}

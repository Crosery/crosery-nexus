import { CheckCircle2, XCircle } from 'lucide-react'

export function ResultDialog({ tone, title, description, detail, onClose }: {
  tone: 'success' | 'error'
  title: string
  description?: string
  detail?: string
  onClose: () => void
}) {
  return <div className="modal-backdrop stacked" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}>
    <section className="modal confirm-modal" role="alertdialog" aria-modal="true" aria-label={title}>
      <div className={`confirm-icon ${tone}`}>{tone === 'success' ? <CheckCircle2 size={21} /> : <XCircle size={21} />}</div>
      <h2>{title}</h2>
      {description && <p>{description}</p>}
      {detail && <span className="confirm-target">{detail}</span>}
      <footer className="confirm-actions single">
        <button type="button" className="primary-button" onClick={onClose} autoFocus>知道了</button>
      </footer>
    </section>
  </div>
}

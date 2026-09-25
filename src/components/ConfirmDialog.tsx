import { AlertTriangle } from 'lucide-react'
import type { ReactNode } from 'react'

export function ConfirmDialog({ title, description, target, confirmLabel, busyLabel, busy = false, error = '', onConfirm, onCancel }: {
  title: string
  description: ReactNode
  target?: string
  confirmLabel: string
  busyLabel?: string
  busy?: boolean
  error?: string
  onConfirm: () => void
  onCancel: () => void
}) {
  return <div className="modal-backdrop stacked" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) onCancel() }}>
    <section className="modal confirm-modal" role="alertdialog" aria-modal="true" aria-label={title}>
      <div className="confirm-icon"><AlertTriangle size={21} /></div>
      <h2>{title}</h2>
      <p>{description}</p>
      {target && <span className="confirm-target">{target}</span>}
      {error && <p className="form-error">{error}</p>}
      <footer className="confirm-actions">
        <button type="button" className="secondary-button" onClick={onCancel} disabled={busy}>取消</button>
        <button type="button" className="danger-solid-button" onClick={onConfirm} disabled={busy}>{busy ? (busyLabel || '处理中…') : confirmLabel}</button>
      </footer>
    </section>
  </div>
}

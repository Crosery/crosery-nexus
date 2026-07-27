import { Check, ChevronDown } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'

type Option = { value: string; label: string }

export function Select({ value, options, onChange, ariaLabel }: { value: string; options: Option[]; onChange: (value: string) => void; ariaLabel: string }) {
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  const selected = options.find((option) => option.value === value) || options[0]
  useEffect(() => {
    const close = (event: MouseEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false) }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [])
  return (
    <div className="select" ref={root}>
      <button className="select-trigger" type="button" aria-label={ariaLabel} aria-expanded={open} onClick={() => setOpen(!open)}>
        <span>{selected?.label}</span><ChevronDown size={16} />
      </button>
      {open && <div className="select-menu" role="listbox">
        {options.map((option) => <button key={option.value} type="button" className={option.value === value ? 'select-option active' : 'select-option'} onClick={() => { onChange(option.value); setOpen(false) }}>
          <span>{option.label}</span>{option.value === value && <Check size={15} />}
        </button>)}
      </div>}
    </div>
  )
}

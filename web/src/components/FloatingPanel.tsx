import { Minus, Plus, X } from 'lucide-react'
import { useState, type ReactNode } from 'react'

export function FloatingPanel({ side, width = 236, top = 12, bottom = 12, title, onClose, children }: {
  side: 'left' | 'right'; width?: number; top?: number; bottom?: number; title?: string; onClose?: () => void; children: ReactNode
}) {
  return (
    <aside
      className={`absolute z-10 flex flex-col overflow-hidden rounded-xl border border-line bg-panel shadow-lg ${side === 'left' ? 'left-3' : 'right-3'}`}
      style={{ width, top, bottom }}
    >
      {(title || onClose) && (
        <header className="flex flex-none items-center justify-between border-b border-line px-3 py-2 text-xs font-semibold text-text">
          <span>{title}</span>
          {onClose && (
            <button aria-label="Đóng panel" onClick={onClose} className="text-muted hover:text-text">
              <X size={14} />
            </button>
          )}
        </header>
      )}
      <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
    </aside>
  )
}

export function PanelSection({ title, defaultOpen = true, children }: { title: string; defaultOpen?: boolean; children: ReactNode }) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <section className="border-b border-line last:border-0">
      <button
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="flex w-full items-center justify-between px-3 py-2 text-xs font-semibold text-text"
      >
        {title}
        {open ? <Minus size={13} className="text-muted" /> : <Plus size={13} className="text-muted" />}
      </button>
      {open && <div className="px-3 pb-3">{children}</div>}
    </section>
  )
}

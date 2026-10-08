import { Minus, Plus, X, type LucideIcon } from 'lucide-react'
import { useState, type ReactNode } from 'react'

export function FloatingPanel({ side, width = 236, top = 12, bottom = 12, fit = false, title, stats, onClose, children }: {
  side: 'left' | 'right'; width?: number; top?: number; bottom?: number; title?: string; onClose?: () => void; children: ReactNode
  /** Vài con số chính hiện ngay dưới tiêu đề (thay cho chuỗi mô tả dài). */
  stats?: { icon: LucideIcon; value: ReactNode; label: string }[]
  /** Cao vừa nội dung (tối đa tới mép dưới) thay vì luôn kéo dài hết chiều cao. */
  fit?: boolean
}) {
  return (
    <aside
      className={`absolute z-10 flex flex-col overflow-hidden rounded-xl border border-line bg-panel shadow-lg ${side === 'left' ? 'left-3' : 'right-3'}`}
      style={fit ? { width, top, maxHeight: `calc(100% - ${top + bottom}px)` } : { width, top, bottom }}
    >
      {(title || onClose) && (
        <header className="flex-none border-b border-line px-3 py-2">
          <div className="flex items-center justify-between text-[13px] font-semibold text-text">
            <span>{title}</span>
            {onClose && (
              <button aria-label="Đóng panel" onClick={onClose} className="text-muted hover:text-text">
                <X size={14} />
              </button>
            )}
          </div>
          {stats && stats.length > 0 && (
            <div className="mt-1.5 flex flex-wrap gap-x-3.5 gap-y-1">
              {stats.map(({ icon: Icon, value, label }) => (
                <div key={label} className="flex items-center gap-1.5" title={label}>
                  <Icon size={13} className="text-faint" aria-hidden />
                  <span className="text-[12px] font-semibold tabular-nums text-text">{value}</span>
                  <span className="text-[11px] text-muted">{label}</span>
                </div>
              ))}
            </div>
          )}
        </header>
      )}
      <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
    </aside>
  )
}

export function PanelSection({ title, icon: Icon, meta, defaultOpen = true, children }: {
  title: string; defaultOpen?: boolean; children: ReactNode
  /** Biểu tượng nhỏ trước tiêu đề, để lướt bảng là nhận ra mục. */
  icon?: LucideIcon
  /** Một con số hay trạng thái ngắn ở mép phải tiêu đề (vd. 13/13, 3 xe), hiện cả khi mục đang thu gọn. */
  meta?: ReactNode
}) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <section className="border-b border-line last:border-0">
      <button
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="flex w-full items-center gap-2 px-3 py-2.5 text-xs font-semibold text-text hover:bg-panel-2"
      >
        {Icon && <Icon size={14} className="flex-none text-muted" aria-hidden />}
        <span className="flex-1 text-left">{title}</span>
        {meta !== undefined && meta !== null && <span className="text-[11px] font-medium tabular-nums text-muted">{meta}</span>}
        {open ? <Minus size={13} className="flex-none text-faint" /> : <Plus size={13} className="flex-none text-faint" />}
      </button>
      {open && <div className="px-3 pb-3">{children}</div>}
    </section>
  )
}

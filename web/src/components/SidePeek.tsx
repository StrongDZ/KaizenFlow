import { Maximize2, X } from 'lucide-react'
import { useEffect, type ReactNode } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { ActionButtons, SplitAction, type ActionItem } from './ActionMenu'
import { Loading, PageBody, PageHeader } from './ui'

/** Đối tượng đang mở trong khung chi tiết, lưu ở `?peek=` của URL: tải lại trang hay gửi link vẫn mở đúng chỗ, không chất thêm lịch sử. */
export function usePeekParam(): [string | null, (id: string | null) => void] {
  const [params, setParams] = useSearchParams()
  const set = (id: string | null) => setParams((p) => {
    const n = new URLSearchParams(p)
    if (id) n.set('peek', id); else n.delete('peek')
    return n
  }, { replace: true })
  return [params.get('peek'), set]
}

/**
 * Khung bao của trang danh sách: danh sách ở bên trái, chi tiết của dòng đang chọn ở bên phải (side peek), không rời trang danh sách.
 * Danh sách vẫn xem và bấm được khi khung mở; bấm dòng khác thì khung đổi sang dòng đó; Esc hoặc nút ✕ để đóng.
 */
export function PeekHost({ peek, onClose, children }: { peek: ReactNode; onClose: () => void; children: ReactNode }) {
  const open = peek !== null && peek !== false && peek !== undefined
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      // Esc đang đóng hộp thoại hay ô chọn thì không đóng luôn khung chi tiết.
      if (e.key !== 'Escape' || e.defaultPrevented || document.querySelector('[role=dialog], [role=listbox]')) return
      onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])
  return (
    <div className="flex min-h-full items-start">
      <div className="min-w-0 flex-1">{children}</div>
      {open && (
        <aside aria-label="Chi tiết" className="kf-peek-in sticky top-0 h-[calc(100vh-2.5rem)] w-[min(480px,46vw)] flex-none border-l border-line bg-panel print:hidden">
          {peek}
        </aside>
      )}
    </div>
  )
}

/**
 * Khung chi tiết bên phải. Thanh tiêu đề chỉ nói đây là màn gì ("Chi tiết scenario") cùng nút mở trang đầy đủ và nút đóng.
 * Phần thân mở đầu bằng một khối giới thiệu (hero): tên, nhãn và vài dòng thông tin chung của đối tượng, cùng nút thao tác
 * (nút chính và menu các thao tác còn lại) vì chúng là của đối tượng đó chứ không của khung.
 */
export function SidePeek({ title, heading, subtitle, summary, menu, fullPageTo, onClose, children }: {
  title: string; heading: ReactNode; subtitle?: ReactNode; summary?: ReactNode; menu?: ActionItem[]; fullPageTo?: string; onClose: () => void; children?: ReactNode
}) {
  const hasMenu = !!menu && menu.length > 0
  return (
    <section className="flex h-full flex-col">
      <header className="flex items-center gap-2 border-b border-line px-4 py-2.5">
        <h2 className="min-w-0 flex-1 truncate text-xs font-semibold text-muted">{title}</h2>
        {fullPageTo && (
          <Link to={fullPageTo} title="Mở trang đầy đủ" aria-label="Mở trang đầy đủ" className="flex-none rounded-md p-1.5 text-muted hover:bg-panel-2 hover:text-text"><Maximize2 size={14} /></Link>
        )}
        <button type="button" aria-label="Đóng chi tiết" title="Đóng (Esc)" onClick={onClose} className="flex-none rounded-md p-1.5 text-muted hover:bg-panel-2 hover:text-text"><X size={15} /></button>
      </header>
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4 text-xs">
        <div className="flex flex-wrap items-start gap-x-3 gap-y-3 rounded-xl border border-line bg-panel-2 p-4">
          <div className="min-w-0 flex-1 basis-44 space-y-1.5">
            <h3 className="break-words text-base font-semibold leading-snug text-text">{heading}</h3>
            {subtitle && <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted">{subtitle}</div>}
            {summary && <div className="space-y-0.5 pt-0.5 text-xs leading-relaxed text-text-2">{summary}</div>}
          </div>
          {hasMenu && <SplitAction items={menu} />}
        </div>
        {children}
      </div>
    </section>
  )
}

export type DetailVariant = 'page' | 'peek'

/**
 * Một màn chi tiết dùng được ở hai chỗ: trang riêng (`page`, có liên kết quay lại, thao tác là hàng nút) hoặc khung bên phải của
 * danh sách (`peek`, thao tác gom vào menu). Nội dung và danh sách thao tác viết một lần, chỉ khác khung bao.
 * `kind` là tên chung của màn ("Chi tiết scenario"); `title` là tên đối tượng.
 */
export function DetailShell({ variant, kind, title, subtitle, menu, fullPageTo, back, onClose, loading, children }: {
  variant: DetailVariant; kind: string; title: string; subtitle?: ReactNode; menu?: ActionItem[]; fullPageTo?: string
  back?: { to: string; label: string }; onClose?: () => void; loading?: boolean; children: ReactNode
}) {
  if (variant === 'peek') {
    return (
      <SidePeek title={kind} heading={title} subtitle={subtitle} menu={menu} fullPageTo={fullPageTo} onClose={onClose ?? (() => undefined)}>
        {loading ? <Loading /> : children}
      </SidePeek>
    )
  }
  return (
    <PageBody>
      {back && <Link className="text-xs text-muted hover:text-text" to={back.to}>‹ {back.label}</Link>}
      <PageHeader title={title} subtitle={subtitle} actions={menu ? <ActionButtons items={menu} /> : undefined} />
      {loading ? <Loading /> : children}
    </PageBody>
  )
}

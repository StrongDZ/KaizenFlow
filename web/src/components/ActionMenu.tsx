import * as Popover from '@radix-ui/react-popover'
import { ChevronDown, type LucideIcon } from 'lucide-react'
import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { Link } from 'react-router-dom'
import { btn, btnDangerOutline, btnPrimary } from './ui'

/**
 * Một thao tác lên đối tượng đang xem. Một danh sách duy nhất nuôi cả hai cách hiển thị: menu "Thao tác" trong khung chi tiết
 * (side peek) và hàng nút ở trang riêng, nên thêm hay bớt thao tác chỉ sửa một chỗ.
 */
export type ActionItem = {
  key: string
  label: string
  icon?: LucideIcon
  /** Thao tác chuyển trang. */
  to?: string
  /** Thao tác chạy ngay (hoặc mở hộp xác nhận). */
  onSelect?: () => void
  /** Khoá thao tác; `hint` là lý do, hiện ngay dưới tên để người dùng khỏi phải đoán. */
  disabled?: boolean
  hint?: string
  /** Thao tác chính của đối tượng (trang riêng vẽ thành nút nổi bật). */
  primary?: boolean
  /** Thao tác phá huỷ: màu đỏ, tách riêng ở cuối menu. */
  danger?: boolean
}

const itemCls = 'flex w-full cursor-pointer select-none flex-col gap-0.5 rounded-md px-2.5 py-1.5 text-left text-xs outline-none hover:bg-panel-2 focus-visible:bg-panel-2 disabled:cursor-not-allowed disabled:hover:bg-transparent'

function ItemBody({ it }: { it: ActionItem }) {
  const Icon = it.icon
  return (
    <>
      <span className={`flex items-center gap-2 font-medium ${it.danger ? 'text-bad-text' : 'text-text'} ${it.disabled ? 'opacity-50' : ''}`}>
        {Icon && <Icon size={13} aria-hidden className="flex-none" />}{it.label}
      </span>
      {it.disabled && it.hint && <span className="pl-[21px] text-[11px] font-normal leading-snug text-muted">{it.hint}</span>}
    </>
  )
}

const seg = 'inline-flex items-center gap-1.5 px-3 py-1.5 text-xs outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:cursor-not-allowed disabled:opacity-50'

/**
 * Nút tách đôi cho khung chi tiết: bên trái là thao tác chính của đối tượng, bên phải là mũi tên; rê chuột vào (hoặc bấm/Enter vào mũi tên)
 * thì mở menu các thao tác còn lại. Thao tác chính là mục `primary`, không có thì mục thường đầu tiên. Chỉ có một thao tác thì chỉ vẽ một nút,
 * không có menu. Thao tác phá huỷ luôn nằm trong menu (đỏ, tách ở cuối), trừ khi nó là thao tác duy nhất.
 */
export function SplitAction({ items }: { items: ActionItem[] }) {
  const [open, setOpen] = useState(false)
  const timer = useRef<number | undefined>(undefined)
  const viaHover = useRef(false)
  useEffect(() => () => window.clearTimeout(timer.current), [])
  if (items.length === 0) return null

  if (items.length === 1) return <ActionButtons items={items} />
  // Không có thao tác thường nào (toàn thao tác phá huỷ) thì không có nút chính: chỉ còn mũi tên "Thao tác" mở menu.
  const main = items.find((i) => i.primary && !i.danger) ?? items.find((i) => !i.danger)
  const rest = items.filter((i) => i !== main)
  const normal = rest.filter((i) => !i.danger)
  const danger = rest.filter((i) => i.danger)

  const enter = (e: { pointerType: string }) => {
    if (e.pointerType !== 'mouse') return
    window.clearTimeout(timer.current)
    if (!open) viaHover.current = true
    setOpen(true)
  }
  const leave = (e: { pointerType: string }) => {
    if (e.pointerType !== 'mouse') return
    window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => setOpen(false), 180)
  }

  const pick = (it: ActionItem) => { setOpen(false); it.onSelect?.() }
  const render = (it: ActionItem) => it.to && !it.disabled ? (
    <Link key={it.key} to={it.to} role="menuitem" className={itemCls} onClick={() => setOpen(false)}><ItemBody it={it} /></Link>
  ) : (
    <button key={it.key} type="button" role="menuitem" disabled={it.disabled} onClick={() => pick(it)} className={itemCls}><ItemBody it={it} /></button>
  )
  // Phím mũi tên đi giữa các mục như một menu thật.
  const onMenuKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
    const els = [...e.currentTarget.querySelectorAll<HTMLElement>('[role=menuitem]:not(:disabled)')]
    if (els.length === 0) return
    e.preventDefault()
    const at = els.indexOf(document.activeElement as HTMLElement)
    els[(at + (e.key === 'ArrowDown' ? 1 : -1) + els.length) % els.length].focus()
  }

  const filled = !!main?.primary
  const shell = filled ? 'bg-accent text-on-accent font-semibold' : 'border border-line-2 text-text-2 font-medium'
  const divider = filled ? 'border-l border-on-accent/25' : 'border-l border-line-2'
  const hover = filled ? 'hover:opacity-90' : 'hover:bg-panel hover:text-text'
  const Icon = main?.icon

  return (
    <div className={`inline-flex flex-none overflow-hidden rounded-lg ${shell}`} onPointerEnter={enter} onPointerLeave={leave}>
      {main && (main.to && !main.disabled ? (
        <Link to={main.to} className={`${seg} ${hover}`}>{Icon && <Icon size={12} aria-hidden />}{main.label}</Link>
      ) : (
        <button type="button" className={`${seg} ${hover}`} disabled={main.disabled} title={main.disabled ? main.hint : undefined} onClick={() => main.onSelect?.()}>
          {Icon && <Icon size={12} aria-hidden />}{main.label}
        </button>
      ))}
      <Popover.Root open={open} onOpenChange={(o) => { if (o) viaHover.current = false; setOpen(o) }}>
        <Popover.Trigger
          aria-label="Thao tác khác" aria-haspopup="menu"
          // Đang mở nhờ rê chuột thì bấm vào mũi tên không được đóng lại.
          onPointerDown={(e) => { if (open && e.pointerType === 'mouse') e.preventDefault() }}
          className={`${seg} px-2 ${main ? divider : ''} ${hover}`}
        >
          {!main && 'Thao tác'}<ChevronDown size={12} aria-hidden />
        </Popover.Trigger>
        <Popover.Portal>
          <Popover.Content
            role="menu" align="end" sideOffset={4}
            onPointerEnter={enter} onPointerLeave={leave} onKeyDown={onMenuKey}
            // Mở bằng rê chuột thì không giành con trỏ gõ phím của ô đang nhập, và đóng thì không kéo tiêu điểm đi đâu.
            onOpenAutoFocus={(e) => { if (viaHover.current) e.preventDefault() }}
            onCloseAutoFocus={(e) => { if (viaHover.current) e.preventDefault() }}
            className="z-50 min-w-48 max-w-72 rounded-lg border border-line-2 bg-raised p-1 shadow-xl outline-none"
          >
            {normal.map(render)}
            {normal.length > 0 && danger.length > 0 && <div role="separator" className="my-1 h-px bg-line" />}
            {danger.map(render)}
          </Popover.Content>
        </Popover.Portal>
      </Popover.Root>
    </div>
  )
}

/** Cùng danh sách thao tác, vẽ thành hàng nút cho trang riêng (còn chỗ, và thao tác chính nên nằm sẵn trước mắt). */
export function ActionButtons({ items }: { items: ActionItem[] }) {
  return (
    <>
      {items.map((it) => {
        const cls = it.danger ? btnDangerOutline : it.primary ? btnPrimary : btn
        const Icon = it.icon
        const body = <>{Icon && <Icon size={12} aria-hidden />}{it.label}</>
        if (it.to && !it.disabled) return <Link key={it.key} to={it.to} className={cls}>{body}</Link>
        return <button key={it.key} className={cls} disabled={it.disabled} title={it.disabled ? it.hint : undefined} onClick={() => it.onSelect?.()}>{body}</button>
      })}
    </>
  )
}

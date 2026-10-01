import * as Menu from '@radix-ui/react-dropdown-menu'
import { ChevronDown, type LucideIcon } from 'lucide-react'
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

const itemCls = 'flex w-full cursor-pointer select-none flex-col gap-0.5 rounded-md px-2.5 py-1.5 text-left text-xs outline-none data-[disabled]:cursor-not-allowed data-[highlighted]:bg-panel-2'

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

/** Menu "Thao tác ▾": thao tác thường ở trên, thao tác phá huỷ ở dưới sau một đường kẻ. Không có thao tác nào thì không vẽ gì. */
export function ActionMenu({ items, label = 'Thao tác' }: { items: ActionItem[]; label?: string }) {
  if (items.length === 0) return null
  const normal = items.filter((i) => !i.danger)
  const danger = items.filter((i) => i.danger)
  const render = (it: ActionItem) => it.to && !it.disabled ? (
    <Menu.Item key={it.key} asChild>
      <Link to={it.to} className={itemCls}><ItemBody it={it} /></Link>
    </Menu.Item>
  ) : (
    <Menu.Item key={it.key} disabled={it.disabled} onSelect={() => it.onSelect?.()} className={itemCls}><ItemBody it={it} /></Menu.Item>
  )
  return (
    <Menu.Root>
      <Menu.Trigger className={`${btn} gap-1`}>{label}<ChevronDown size={12} aria-hidden /></Menu.Trigger>
      <Menu.Portal>
        <Menu.Content align="end" sideOffset={6} className="z-50 min-w-48 max-w-72 rounded-lg border border-line-2 bg-raised p-1 shadow-xl">
          {normal.map(render)}
          {normal.length > 0 && danger.length > 0 && <Menu.Separator className="my-1 h-px bg-line" />}
          {danger.map(render)}
        </Menu.Content>
      </Menu.Portal>
    </Menu.Root>
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

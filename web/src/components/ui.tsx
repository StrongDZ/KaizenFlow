import { Inbox, Info, Search, TriangleAlert, type LucideIcon } from 'lucide-react'
import type { ReactNode } from 'react'
import { ApiError } from '../api/client'
import type { Issue, RunStatus } from '../api/types'
import { friendlyMessage } from '../lib/errors'
import { statusLabel } from '../lib/format'

/**
 * Hệ màu nút (spec 2026-10-01 §3.6): hai trục, tông và độ nổi. Mỗi vùng chỉ một nút đặc; nút lặp trong bảng và nút phá huỷ
 * dùng kiểu viền; đỏ đặc chỉ dành cho bước xác nhận trong hộp thoại. Màu không phải tín hiệu duy nhất: nút luôn có chữ.
 */
const base = 'inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs disabled:cursor-not-allowed disabled:opacity-50'
/** Trung tính, viền: Huỷ, Sửa, Nhân bản, Tạm dừng… */
export const btn = `${base} border border-line-2 font-medium text-text-2 hover:bg-panel hover:text-text`
/** Hành động chính của vùng: Lưu, Tạo, Áp dụng, Chạy. */
export const btnPrimary = `${base} bg-accent font-semibold text-on-accent hover:opacity-90`
/** Đưa vào dùng: Publish, Bắt đầu phát, Tiếp tục. */
export const btnOk = `${base} bg-ok-solid font-semibold text-on-ok hover:opacity-90`
/** Thao tác cố ý gây rối của demo (Bơm sự cố, Chặn làn), khác với phá huỷ thật. */
export const btnWarn = `${base} bg-warn font-semibold text-on-warn hover:opacity-90`
/** Đỏ đặc: chỉ nút xác nhận phá huỷ trong ConfirmDialog. */
export const btnDanger = `${base} bg-bad font-semibold text-bg hover:opacity-90`
/** Đỏ viền: nút phá huỷ ở chỗ kích hoạt (Xoá, Đặt lại, Xoá mọi ghép nối). */
export const btnDangerOutline = `${base} border border-bad/60 font-medium text-bad-text hover:bg-bad-bg`
/** Xanh dương viền: hành động chính lặp lại trong bảng (Chạy ở mỗi dòng). */
export const btnAccentOutline = `${base} border border-accent/60 font-medium text-accent hover:bg-panel`
/** Xanh lá viền: Publish ở mỗi dòng phiên bản. */
export const btnOkOutline = `${base} border border-ok-solid/60 font-medium text-ok-solid hover:bg-panel`
/** Nút biểu tượng không viền (đóng panel, đổi giao diện). */
export const btnGhost = 'inline-flex items-center justify-center rounded-md p-1.5 text-muted hover:bg-panel hover:text-text disabled:cursor-not-allowed disabled:opacity-50'
/** Liên kết chữ xanh nhỏ trong form ("Tạo vật tư RAW01 trong Thư viện"). */
export const btnLinkAccent = 'mt-1 block text-[11px] text-accent underline decoration-dotted hover:opacity-80'
/** Chữ đỏ nhỏ trong form, cho thao tác bỏ một dòng (không phải xoá dữ liệu). */
export const btnLinkDanger = 'text-xs text-bad-text underline decoration-dotted hover:opacity-80 disabled:opacity-50'
export const input =
  'rounded-lg border border-line-2 bg-panel-2 px-2.5 py-1.5 text-xs text-text placeholder:text-faint'

export function Loading() {
  return <div className="p-6 text-xs text-muted">Đang tải…</div>
}

export function issuesOf(e: unknown): Issue[] {
  return e instanceof ApiError ? e.issues : []
}

export function ErrorBox({ error }: { error: unknown }) {
  if (!error) return null
  const msg = friendlyMessage(error)
  const issues = issuesOf(error)
  return (
    <div role="alert" className="rounded-lg border border-bad/50 bg-bad-bg p-3 text-xs text-bad-text">
      <div className="font-medium">{msg}</div>
      {issues.length > 0 && (
        <ul className="mt-1 list-disc pl-5">
          {issues.map((i) => (
            <li key={i.key + i.message}>
              <b>{i.key}</b>: {i.message}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

const DOT: Record<RunStatus, string> = {
  QUEUED: 'bg-faint',
  RUNNING: 'bg-text animate-pulse',
  DONE: 'bg-ok',
  FAILED: 'bg-bad',
}

export function StatusChip({ status }: { status: RunStatus }) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-md border border-line-2 px-2 py-0.5 text-[11px] text-text-2">
      <i className={`h-1.5 w-1.5 rounded-full ${DOT[status]}`} />
      {statusLabel(status)}
    </span>
  )
}

export function Card({ title, icon: Icon, children, actions }: { title: string; icon?: LucideIcon; children: ReactNode; actions?: ReactNode }) {
  return (
    <section className="rounded-xl border border-line bg-panel">
      <header className="flex items-center justify-between gap-2 border-b border-line px-4 py-2.5">
        <h2 className="flex items-center gap-2 text-xs font-semibold text-text">{Icon && <Icon size={14} className="text-muted" aria-hidden />}{title}</h2>
        {actions}
      </header>
      <div className="p-4">{children}</div>
    </section>
  )
}

/** Trạng thái trống: một biểu tượng, một câu nói chuyện gì, và (trong children) bước tiếp theo. */
export function EmptyState({ title, icon: Icon = Inbox, children }: { title: string; icon?: LucideIcon; children?: ReactNode }) {
  return (
    <div className="flex h-full min-h-60 flex-col items-center justify-center gap-1.5 p-8 text-center">
      <span className="mb-1.5 flex h-11 w-11 items-center justify-center rounded-full border border-line-2 bg-panel-2 text-muted" aria-hidden><Icon size={20} strokeWidth={1.7} /></span>
      <div className="text-sm font-semibold text-text">{title}</div>
      {children && <div className="max-w-md text-xs text-muted">{children}</div>}
    </div>
  )
}

export function PageBody({ children, wide = false }: { children: ReactNode; wide?: boolean }) {
  return <div className={`mx-auto space-y-4 p-6 ${wide ? 'max-w-7xl' : 'max-w-6xl'}`}>{children}</div>
}

export function PageHeader({ title, icon: Icon, subtitle, actions }: { title: string; icon?: LucideIcon; subtitle?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-3">
      {Icon && <span className="flex h-9 w-9 flex-none items-center justify-center rounded-lg bg-accent/12 text-accent" aria-hidden><Icon size={18} strokeWidth={1.8} /></span>}
      <h1 className="text-lg font-semibold text-text">{title}</h1>
      {subtitle && <span className="text-xs text-muted">{subtitle}</span>}
      <div className="ml-auto flex items-center gap-2">{actions}</div>
    </div>
  )
}

export function FilterChip({ active, onClick, children }: { active: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      onClick={onClick}
      aria-pressed={active}
      className={`rounded-full border px-2.5 py-1 text-[11px] ${active ? 'border-text bg-text font-semibold text-bg' : 'border-line-2 text-muted hover:text-text'}`}
    >
      {children}
    </button>
  )
}

const TAG_TONE = {
  neutral: 'border-line-2 text-text-2',
  ok: 'border-ok/40 bg-ok/10 text-ok',
  warn: 'border-warn/40 bg-warn/10 text-warn',
  bad: 'border-bad/40 bg-bad/10 text-bad-text',
  accent: 'border-accent/40 bg-accent/10 text-accent',
} as const

/** Nhãn nhỏ. `tone` chỉ khi màu mang nghĩa (trạng thái); `color` là màu vai trò hay loại (vd. var(--color-role-storage)). */
export function Tag({ children, tone = 'neutral', icon: Icon, color }: { children: ReactNode; tone?: keyof typeof TAG_TONE; icon?: LucideIcon; color?: string }) {
  const style = color ? { color, borderColor: `color-mix(in srgb, ${color} 40%, transparent)`, background: `color-mix(in srgb, ${color} 10%, transparent)` } : undefined
  return (
    <span style={style} className={`inline-flex items-center gap-1 whitespace-nowrap rounded-[5px] border px-1.5 py-px text-[10.5px] ${color ? '' : TAG_TONE[tone]}`}>
      {Icon && <Icon size={11} aria-hidden />}{children}
    </span>
  )
}

/** Dải thông báo: `lock` cho object bị khoá, `info` cho chỉ dẫn trung tính. */
export function Notice({ tone = 'info', children }: { tone?: 'lock' | 'info'; children: ReactNode }) {
  const style = tone === 'lock' ? 'border-lock-line bg-lock-bg text-lock-text' : 'border-line-2 bg-panel-2 text-text-2'
  const Icon = tone === 'lock' ? TriangleAlert : Info
  return (
    <div role="note" className={`flex items-start gap-2 rounded-lg border px-3 py-2 text-xs ${style}`}>
      <Icon size={14} className="mt-px flex-none opacity-80" aria-hidden />
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  )
}

export function SearchBox({ value, onChange, placeholder = 'Tìm theo tên hoặc mã', className = 'w-56' }: { value: string; onChange: (v: string) => void; placeholder?: string; className?: string }) {
  return (
    <label className={`relative inline-block ${className}`}>
      <Search size={13} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-faint" aria-hidden />
      <input
        type="search"
        aria-label={placeholder}
        className={`${input} w-full pl-8`}
        placeholder={placeholder}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
    </label>
  )
}

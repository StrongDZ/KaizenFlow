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

export function Card({ title, children, actions }: { title: string; children: ReactNode; actions?: ReactNode }) {
  return (
    <section className="rounded-xl border border-line bg-panel">
      <header className="flex items-center justify-between border-b border-line px-4 py-2">
        <h2 className="text-xs font-semibold text-text">{title}</h2>
        {actions}
      </header>
      <div className="p-4">{children}</div>
    </section>
  )
}

export function EmptyState({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="flex h-full min-h-60 flex-col items-center justify-center gap-1 p-8 text-center">
      <div className="text-sm font-semibold text-text">{title}</div>
      {children && <div className="max-w-md text-xs text-muted">{children}</div>}
    </div>
  )
}

export function PageBody({ children, wide = false }: { children: ReactNode; wide?: boolean }) {
  return <div className={`mx-auto space-y-4 p-6 ${wide ? 'max-w-7xl' : 'max-w-6xl'}`}>{children}</div>
}

export function PageHeader({ title, subtitle, actions }: { title: string; subtitle?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-3">
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

export function Tag({ children }: { children: ReactNode }) {
  return <span className="whitespace-nowrap rounded-[5px] border border-line-2 px-1.5 py-px text-[10.5px] text-text-2">{children}</span>
}

/** Dải thông báo: `lock` cho object bị khoá, `info` cho chỉ dẫn trung tính. */
export function Notice({ tone = 'info', children }: { tone?: 'lock' | 'info'; children: ReactNode }) {
  const style = tone === 'lock' ? 'border-lock-line bg-lock-bg text-lock-text' : 'border-line-2 bg-panel-2 text-text-2'
  return <div role="note" className={`rounded-lg border px-3 py-2 text-xs ${style}`}>{children}</div>
}

export function SearchBox({ value, onChange, placeholder = 'Tìm theo tên hoặc mã' }: { value: string; onChange: (v: string) => void; placeholder?: string }) {
  return (
    <input
      type="search"
      aria-label={placeholder}
      className={`${input} w-56`}
      placeholder={placeholder}
      value={value}
      onChange={(e) => onChange(e.target.value)}
    />
  )
}

import * as Dialog from '@radix-ui/react-dialog'
import type { FormEvent, ReactNode } from 'react'
import { ErrorBox, btn, btnPrimary } from './ui'

/**
 * Hộp thoại nổi cho form ngắn (vài trường): tạo mô hình, tạo vật tư... Nổi trên một lớp phủ riêng, không chèn vào
 * nội dung trang. Enter gửi form, Esc hoặc bấm ra ngoài thì đóng.
 */
export function FormDialog({ open, title, description, submitLabel, pending, error, canSubmit = true, width = 460, onSubmit, onClose, children }: {
  open: boolean
  title: string
  description?: ReactNode
  submitLabel: string
  pending: boolean
  error?: unknown
  canSubmit?: boolean
  /** Bề rộng hộp (px); form có nhiều cột hoặc danh sách dài cần rộng hơn mặc định. */
  width?: number
  onSubmit: () => void
  onClose: () => void
  children: ReactNode
}) {
  // Portal vẫn nổi bọt sự kiện React lên phần tử cha trong cây React, nên chặn ở đây (giống ConfirmDialog).
  const stop = (e: { stopPropagation: () => void }) => e.stopPropagation()
  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (canSubmit && !pending) onSubmit()
  }
  return (
    <Dialog.Root open={open} onOpenChange={(o) => { if (!o) onClose() }}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/50" onClick={stop} />
        <Dialog.Content
          onClick={stop}
          onKeyDown={stop}
          style={{ width }}
          className="fixed left-1/2 top-1/2 z-50 max-h-[92vh] max-w-[92vw] -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-xl border border-line-2 bg-raised p-5 text-xs shadow-xl"
        >
          <Dialog.Title className="text-sm font-semibold text-text">{title}</Dialog.Title>
          {description && <Dialog.Description className="mt-1 text-text-2">{description}</Dialog.Description>}
          <form onSubmit={submit} className="mt-4 space-y-3">
            {children}
            <ErrorBox error={error} />
            <div className="flex justify-end gap-2 pt-1">
              <button type="button" className={btn} onClick={onClose}>Huỷ</button>
              <button type="submit" className={btnPrimary} disabled={!canSubmit || pending}>{submitLabel}</button>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

/** Một trường của form: nhãn phía trên, gợi ý hoặc lỗi kiểm tra ngay bên dưới. */
export function Field({ label, hint, problem, children }: { label: string; hint?: ReactNode; problem?: string | null; children: ReactNode }) {
  return (
    <label className="block space-y-1">
      <span className="block text-text-2">{label}</span>
      {children}
      {problem ? <span role="alert" className="block text-bad-text">{problem}</span> : hint ? <span className="block text-faint">{hint}</span> : null}
    </label>
  )
}

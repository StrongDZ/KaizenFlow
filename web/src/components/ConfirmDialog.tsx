import * as Dialog from '@radix-ui/react-dialog'
import type { ReactNode } from 'react'
import { ErrorBox, btn, btnDanger } from './ui'

export function ConfirmDialog({ open, title, description, error, confirmLabel, pending, onConfirm, onCancel }: {
  open: boolean
  title: string
  description: ReactNode
  error?: unknown
  confirmLabel: string
  pending: boolean
  onConfirm: () => void
  onCancel: () => void
}) {
  // Portal vẫn nổi bọt sự kiện React lên phần tử cha trong cây React (vd. <tr onClick>), nên chặn ở đây
  // để bấm hay gõ Enter trong hộp không mở dòng bảng phía sau.
  const stop = (e: { stopPropagation: () => void }) => e.stopPropagation()
  return (
    <Dialog.Root open={open} onOpenChange={(o) => { if (!o) onCancel() }}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/50" onClick={stop} />
        <Dialog.Content
          onClick={stop}
          onKeyDown={stop}
          className="fixed left-1/2 top-1/2 z-50 w-[440px] max-w-[92vw] -translate-x-1/2 -translate-y-1/2 space-y-3 rounded-xl border border-line-2 bg-raised p-5 text-xs shadow-xl"
        >
          <Dialog.Title className="text-sm font-semibold text-text">{title}</Dialog.Title>
          <Dialog.Description className="text-text-2">{description}</Dialog.Description>
          <ErrorBox error={error} />
          <div className="flex justify-end gap-2 pt-1">
            <button className={btn} onClick={onCancel}>Huỷ</button>
            <button className={btnDanger} disabled={pending} onClick={onConfirm}>{confirmLabel}</button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

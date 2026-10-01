import { useMutation } from '@tanstack/react-query'
import { Trash2 } from 'lucide-react'
import { useState } from 'react'
import { ApiError } from '../api/client'
import { impactText } from '../lib/impact'
import { ConfirmDialog } from './ConfirmDialog'
import { btnDangerOutline } from './ui'

/**
 * Hộp xác nhận xoá với giao thức hai bước của spec §6.3: hỏi trước; nếu server trả 409 kèm `impact`
 * thì liệt kê những gì sẽ mất và chỉ khi xác nhận mới gọi lại với cascade = true.
 * Tách khỏi nút để mở được từ mục menu (menu đóng lại thì hộp vẫn phải còn).
 */
export function DeleteDialog({ open, onClose, what, run, onDone }: {
  open: boolean
  onClose: () => void
  what: string
  run: (cascade: boolean) => Promise<unknown>
  onDone: () => void
}) {
  const [impact, setImpact] = useState<Record<string, number> | null>(null)
  const m = useMutation({
    mutationFn: (cascade: boolean) => run(cascade),
    onSuccess: () => { setImpact(null); onClose(); onDone() },
    onError: (e) => { if (e instanceof ApiError && e.status === 409 && e.impact) setImpact(e.impact) },
  })
  const cancel = () => { setImpact(null); m.reset(); onClose() }
  return (
    <ConfirmDialog
      open={open}
      title={impact ? `Xoá luôn dữ liệu đi kèm ${what}?` : `Xoá ${what}?`}
      description={impact ? `Xoá ${what} sẽ xoá luôn ${impactText(impact)}. Không hoàn tác được.` : 'Không hoàn tác được.'}
      error={m.error instanceof ApiError && m.error.impact ? null : m.error}
      confirmLabel={impact ? 'Xoá tất cả' : 'Xoá'}
      pending={m.isPending}
      onConfirm={() => m.mutate(impact !== null)}
      onCancel={cancel}
    />
  )
}

/** Nút xoá kèm hộp xác nhận, dùng trong các dòng bảng. */
export function DeleteAction({ what, run, onDone, disabled = false, label = 'Xoá' }: {
  what: string
  run: (cascade: boolean) => Promise<unknown>
  onDone: () => void
  disabled?: boolean
  label?: string
}) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <button className={btnDangerOutline} disabled={disabled} onClick={(e) => { e.stopPropagation(); setOpen(true) }}><Trash2 size={12} aria-hidden />{label}</button>
      <DeleteDialog open={open} onClose={() => setOpen(false)} what={what} run={run} onDone={onDone} />
    </>
  )
}

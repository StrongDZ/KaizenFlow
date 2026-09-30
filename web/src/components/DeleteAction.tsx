import { useMutation } from '@tanstack/react-query'
import { Trash2 } from 'lucide-react'
import { useState } from 'react'
import { ApiError } from '../api/client'
import { impactText } from '../lib/impact'
import { ConfirmDialog } from './ConfirmDialog'
import { btnDangerOutline } from './ui'

/**
 * Nút xoá với giao thức hai bước của spec §6.3: hỏi trước; nếu server trả 409 kèm `impact`
 * thì liệt kê những gì sẽ mất và chỉ khi xác nhận mới gọi lại với cascade = true.
 */
export function DeleteAction({ what, run, onDone, disabled = false, label = 'Xoá' }: {
  what: string
  run: (cascade: boolean) => Promise<unknown>
  onDone: () => void
  disabled?: boolean
  label?: string
}) {
  const [open, setOpen] = useState(false)
  const [impact, setImpact] = useState<Record<string, number> | null>(null)
  const m = useMutation({
    mutationFn: (cascade: boolean) => run(cascade),
    onSuccess: () => { setOpen(false); setImpact(null); onDone() },
    onError: (e) => { if (e instanceof ApiError && e.status === 409 && e.impact) setImpact(e.impact) },
  })
  const cancel = () => { setOpen(false); setImpact(null); m.reset() }
  return (
    <>
      <button className={btnDangerOutline} disabled={disabled} onClick={(e) => { e.stopPropagation(); setOpen(true) }}><Trash2 size={12} aria-hidden />{label}</button>
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
    </>
  )
}

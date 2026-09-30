import * as Dialog from '@radix-ui/react-dialog'
import { XCircle } from 'lucide-react'
import type { CheckReport } from '../../api/types'
import { groupIssues } from '../../lib/checkView'
import { btn, btnPrimary } from '../ui'

const SHOWN = 6

/**
 * Hộp hiện khi Lưu hoặc Publish mà sơ đồ còn lỗi.
 * Lưu: cho "Vẫn lưu nháp" (bản nháp lỗi không chạy được nên không gây hại, và khỏi mất việc đang dở).
 * Publish: chặn cứng, chỉ có "Quay lại sửa".
 */
export function SaveGuard({ report, mode, onBack, onSaveAnyway }: {
  report: CheckReport; mode: 'save' | 'publish'; onBack: () => void; onSaveAnyway: () => void
}) {
  const { errors } = groupIssues(report)
  return (
    <Dialog.Root open onOpenChange={(o) => { if (!o) onBack() }}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/50" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-[480px] max-w-[92vw] -translate-x-1/2 -translate-y-1/2 space-y-3 rounded-xl border border-line-2 bg-raised p-5 text-xs shadow-xl">
          <Dialog.Title className="text-sm font-semibold text-text">
            {mode === 'publish' ? `Chưa Publish được: còn ${errors.length} lỗi` : `Sơ đồ còn ${errors.length} lỗi`}
          </Dialog.Title>
          <Dialog.Description className="text-text-2">
            {mode === 'publish'
              ? 'Publish khoá phiên bản để chạy mô phỏng, nên cần hết lỗi. Sửa các lỗi dưới đây rồi Publish lại.'
              : 'Bản nháp có lỗi vẫn lưu được nhưng chưa chạy hay Publish được. Bạn nên sửa trước; nếu đang dở tay thì cứ lưu nháp.'}
          </Dialog.Description>
          <ul className="max-h-56 space-y-1 overflow-y-auto rounded-lg border border-line bg-panel-2 p-2">
            {errors.slice(0, SHOWN).map((i) => (
              <li key={`${i.key}|${i.code}|${i.message}`} className="flex items-start gap-2 text-text-2">
                <XCircle size={13} className="mt-0.5 flex-none text-bad-text" aria-hidden />
                <span>{i.message}</span>
              </li>
            ))}
            {errors.length > SHOWN && <li className="pl-5 text-muted">…và {errors.length - SHOWN} lỗi khác (xem ở nút Kiểm tra).</li>}
          </ul>
          <div className="flex justify-end gap-2 pt-1">
            {mode === 'save' && <button className={btn} onClick={onSaveAnyway}>Vẫn lưu nháp</button>}
            <button className={btnPrimary} autoFocus onClick={onBack}>Quay lại sửa</button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

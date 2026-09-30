import * as Dialog from '@radix-ui/react-dialog'
import { X } from 'lucide-react'
import { SHORTCUTS } from '../../lib/shortcuts'

const GROUPS = [...new Set(SHORTCUTS.map((s) => s.group))]

export function ShortcutsDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <Dialog.Root open={open} onOpenChange={(o) => { if (!o) onClose() }}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/50" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 max-h-[86vh] w-[560px] max-w-[94vw] -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-xl border border-line-2 bg-raised p-5 text-xs shadow-xl">
          <div className="flex items-start justify-between">
            <div>
              <Dialog.Title className="text-sm font-semibold text-text">Phím tắt và thao tác</Dialog.Title>
              <Dialog.Description className="mt-1 text-text-2">Trên máy Mac dùng ⌘ thay cho Ctrl.</Dialog.Description>
            </div>
            <button aria-label="Đóng" onClick={onClose} className="text-muted hover:text-text"><X size={14} /></button>
          </div>
          <div className="mt-4 space-y-4">
            {GROUPS.map((g) => (
              <section key={g}>
                <h3 className="mb-1 text-[12px] font-semibold text-text">{g}</h3>
                <dl className="divide-y divide-line">
                  {SHORTCUTS.filter((s) => s.group === g).map((s) => (
                    <div key={s.keys} className="flex items-baseline justify-between gap-4 py-1.5">
                      <dt className="text-text-2">{s.label}</dt>
                      <dd className="flex-none text-right text-muted">{s.keys}</dd>
                    </div>
                  ))}
                </dl>
              </section>
            ))}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

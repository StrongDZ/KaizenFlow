import * as Dropdown from '@radix-ui/react-dropdown-menu'
import { CircleHelp, Hand, Lock, LockOpen, Minus, MousePointer2, MoveHorizontal, MoveVertical, Plus, Redo2, Undo2 } from 'lucide-react'
import type { ReactNode } from 'react'
import type { Dir } from '../../lib/layout'

export type Tool = 'select' | 'hand'

const base = 'inline-flex h-7 min-w-7 items-center justify-center gap-1 rounded-md px-1.5 text-[11px] font-medium text-text-2 hover:bg-raised hover:text-text disabled:pointer-events-none disabled:opacity-40'
const on = 'bg-raised text-text'

function Btn({ label, active, onClick, disabled, children }: { label: string; active?: boolean; onClick: () => void; disabled?: boolean; children: ReactNode }) {
  return (
    <button type="button" aria-label={label} title={label} aria-pressed={active} disabled={disabled} onClick={onClick} className={`${base} ${active ? on : ''}`}>
      {children}
    </button>
  )
}

const Sep = () => <span aria-hidden className="mx-0.5 h-4 w-px flex-none bg-line-2" />

const PRESETS = [0.5, 1, 2]

/**
 * Thanh công cụ nằm ngang, nổi ở đáy canvas: thêm node, chọn công cụ, thu phóng, xếp sơ đồ, hoàn tác, khoá.
 * Gộp mọi thứ vào một chỗ như Figma/n8n, thay cho cụm nút dọc và thanh xếp tách rời trước đây.
 */
export function CanvasToolbar(p: {
  tool: Tool; onTool: (t: Tool) => void
  zoom: number; onZoomBy: (dir: 1 | -1) => void; onZoomTo: (z: number) => void; onFit: () => void; onFitSelection: () => void; hasSelection: boolean
  published: boolean; locked: boolean; onLock: () => void
  canEdit: boolean; onArrange: (d: Dir) => void
  canUndo: boolean; canRedo: boolean; onUndo: () => void; onRedo: () => void
  onAdd: () => void; onHelp: () => void
}) {
  const arrangeHint = p.published ? 'Phiên bản đã Publish: tạo bản sửa để sắp xếp' : p.locked ? 'Đang khoá sơ đồ' : ''
  return (
    <div role="toolbar" aria-label="Công cụ sơ đồ" className="absolute bottom-3 left-1/2 z-10 flex -translate-x-1/2 items-center w-max gap-0.5 whitespace-nowrap rounded-xl border border-line bg-panel p-1 shadow-lg">
      <button
        type="button" disabled={!p.canEdit} onClick={p.onAdd}
        title={p.canEdit ? 'Mở danh sách loại node. Nhấn Tab hoặc / để tìm nhanh.' : arrangeHint || 'Không sửa được'}
        className="inline-flex h-7 items-center gap-1 rounded-md bg-accent px-2.5 text-[11px] font-semibold text-on-accent hover:opacity-90 disabled:pointer-events-none disabled:opacity-40"
      >
        <Plus size={13} />Thêm node
      </button>
      <Sep />
      <Btn label="Công cụ Chọn (V)" active={p.tool === 'select'} onClick={() => p.onTool('select')}><MousePointer2 size={14} /></Btn>
      <Btn label="Công cụ Kéo canvas (H)" active={p.tool === 'hand'} onClick={() => p.onTool('hand')}><Hand size={14} /></Btn>
      <Sep />
      <Btn label="Thu nhỏ" onClick={() => p.onZoomBy(-1)}><Minus size={14} /></Btn>
      <Dropdown.Root>
        <Dropdown.Trigger aria-label="Mức thu phóng" title="Mức thu phóng" className={`${base} w-[52px] tabular-nums`}>
          {Math.round(p.zoom * 100)}%
        </Dropdown.Trigger>
        <Dropdown.Portal>
          <Dropdown.Content side="top" sideOffset={8} className="z-50 min-w-44 rounded-lg border border-line-2 bg-raised p-1 text-xs shadow-xl">
            {PRESETS.map((z) => (
              <Dropdown.Item key={z} onSelect={() => p.onZoomTo(z)} className="flex cursor-pointer justify-between gap-6 rounded-md px-2 py-1.5 text-text-2 outline-none data-[highlighted]:bg-panel">
                Thu phóng {z * 100}%{z === 1 && <kbd className="text-faint">Shift 0</kbd>}
              </Dropdown.Item>
            ))}
            <Dropdown.Separator className="my-1 h-px bg-line" />
            <Dropdown.Item onSelect={p.onFit} className="flex cursor-pointer justify-between gap-6 rounded-md px-2 py-1.5 text-text-2 outline-none data-[highlighted]:bg-panel">
              Vừa khung<kbd className="text-faint">Shift 1</kbd>
            </Dropdown.Item>
            <Dropdown.Item disabled={!p.hasSelection} onSelect={p.onFitSelection} className="flex cursor-pointer justify-between gap-6 rounded-md px-2 py-1.5 text-text-2 outline-none data-[disabled]:opacity-40 data-[highlighted]:bg-panel">
              Vừa vùng chọn<kbd className="text-faint">Shift 2</kbd>
            </Dropdown.Item>
          </Dropdown.Content>
        </Dropdown.Portal>
      </Dropdown.Root>
      <Btn label="Phóng to" onClick={() => p.onZoomBy(1)}><Plus size={14} /></Btn>
      <Sep />
      <button type="button" disabled={!p.canEdit} onClick={() => p.onArrange('LR')} title={p.canEdit ? 'Xếp các node từ trái sang phải' : arrangeHint} className={base}>
        <MoveHorizontal size={14} />Xếp ngang
      </button>
      <button type="button" disabled={!p.canEdit} onClick={() => p.onArrange('TB')} title={p.canEdit ? 'Xếp các node từ trên xuống dưới' : arrangeHint} className={base}>
        <MoveVertical size={14} />Xếp dọc
      </button>
      <Sep />
      <Btn label="Hoàn tác (Ctrl/⌘ Z)" disabled={!p.canUndo} onClick={p.onUndo}><Undo2 size={14} /></Btn>
      <Btn label="Làm lại (Ctrl/⌘ Shift Z)" disabled={!p.canRedo} onClick={p.onRedo}><Redo2 size={14} /></Btn>
      <Sep />
      {!p.published && (
        <Btn label={p.locked ? 'Mở khoá sơ đồ' : 'Khoá sơ đồ: không kéo, nối hay sửa được'} active={p.locked} onClick={p.onLock}>
          {p.locked ? <Lock size={14} /> : <LockOpen size={14} />}
        </Btn>
      )}
      <Btn label="Phím tắt (?)" onClick={p.onHelp}><CircleHelp size={14} /></Btn>
    </div>
  )
}

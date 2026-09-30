import { ChevronDown, ChevronRight, Search } from 'lucide-react'
import { useState } from 'react'
import type { NodeType } from '../../api/types'
import { searchTypes } from '../../lib/nodeSearch'
import { FloatingPanel } from '../FloatingPanel'
import { ARCHETYPE_LABEL } from '../KfNode'
import { NodeIcon } from '../nodeIcons'
import { input } from '../ui'

export const DRAG_TYPE = 'application/kf-node-type'

/**
 * Danh sách loại node để thêm vào sơ đồ: có ô tìm, nhóm gập được, mỗi loại một dòng. Bấm để thêm ở giữa khung nhìn,
 * hoặc kéo thả vào vị trí muốn đặt. Mở bằng nút "Thêm node" ở thanh công cụ; đóng lại thì canvas được trọn khung.
 */
export function NodePalette({ types, canEdit, published, onAdd, onClose }: {
  types: NodeType[]; canEdit: boolean; published: boolean; onAdd: (t: NodeType) => void; onClose: () => void
}) {
  const [q, setQ] = useState('')
  const [shut, setShut] = useState<Record<string, boolean>>({})
  const searching = q.trim() !== ''
  const found = searchTypes(types, q)

  const row = (t: NodeType) => (
    <li key={t.code}>
      <button
        type="button" draggable={canEdit} disabled={!canEdit} onClick={() => onAdd(t)}
        onDragStart={(e) => { e.dataTransfer.setData(DRAG_TYPE, t.code); e.dataTransfer.effectAllowed = 'move' }}
        title={`${t.name} (${t.code}). Bấm để thêm vào giữa khung nhìn, hoặc kéo thả vào chỗ muốn đặt.`}
        className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs text-text ${canEdit ? 'cursor-grab hover:bg-raised active:cursor-grabbing' : 'opacity-50'}`}
      >
        <NodeIcon name={typeof t.ui?.icon === 'string' ? t.ui.icon : undefined} archetype={t.archetype} size={14} className="flex-none text-muted" />
        <span className="min-w-0 flex-1 truncate">{t.name}</span>
      </button>
    </li>
  )

  return (
    <FloatingPanel side="left" width={224} top={12} bottom={64} title="Thêm node" onClose={onClose}>
      <div className="p-2">
        <div className="relative">
          <Search size={13} className="pointer-events-none absolute left-2 top-2 text-faint" aria-hidden />
          <input
            autoFocus className={`${input} w-full pl-7`} placeholder="Tìm loại node" aria-label="Tìm loại node"
            value={q} onChange={(e) => setQ(e.target.value)}
          />
        </div>
        {published && <p className="mt-2 px-1 text-[11px] leading-snug text-muted">Phiên bản đã Publish, chỉ xem. Bấm "Tạo bản sửa" để sửa.</p>}
        {searching ? (
          found.length > 0 ? <ul className="mt-2">{found.map(row)}</ul> : <p className="mt-3 px-1 text-[11px] text-muted">Không có loại node nào khớp "{q}".</p>
        ) : (
          Object.keys(ARCHETYPE_LABEL).map((arch) => {
            const list = searchTypes(types, '', { allow: (t) => t.archetype === arch })
            if (list.length === 0) return null
            const open = !shut[arch]
            return (
              <section key={arch} className="mt-2">
                <button
                  type="button" aria-expanded={open} onClick={() => setShut((s) => ({ ...s, [arch]: open }))}
                  className="flex w-full items-center gap-1 px-1 py-1 text-[11px] font-semibold text-muted hover:text-text"
                >
                  {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                  {ARCHETYPE_LABEL[arch]}
                  <span className="font-normal text-faint">{list.length}</span>
                </button>
                {open && <ul>{list.map(row)}</ul>}
              </section>
            )
          })
        )}
      </div>
    </FloatingPanel>
  )
}

import { useEffect, useMemo, useRef, useState } from 'react'
import type { NodeType } from '../../api/types'
import { searchTypes } from '../../lib/nodeSearch'
import { ARCHETYPE_LABEL } from '../KfNode'
import { NodeIcon } from '../nodeIcons'
import { input } from '../ui'

const W = 264
const H = 300

/**
 * Ô tìm loại node nổi ngay tại con trỏ (Tab, "/", bấm đúp vào chỗ trống, hoặc thả dây ra chỗ trống).
 * ↑ ↓ chọn, Enter thêm, Esc hoặc bấm ra ngoài thì đóng.
 */
export function QuickAdd({ x, y, bounds, types, allow, hint, onPick, onClose }: {
  x: number; y: number; bounds: { w: number; h: number }
  types: NodeType[]; allow?: (t: NodeType) => boolean; hint?: string
  onPick: (t: NodeType) => void; onClose: () => void
}) {
  const [q, setQ] = useState('')
  const [at, setAt] = useState(0)
  const list = useMemo(() => searchTypes(types, q, { allow }), [types, q, allow])
  const ref = useRef<HTMLUListElement>(null)
  useEffect(() => { setAt(0) }, [q])
  useEffect(() => { ref.current?.querySelector('[aria-selected=true]')?.scrollIntoView({ block: 'nearest' }) }, [at])

  const left = Math.max(8, Math.min(x, bounds.w - W - 8))
  const top = Math.max(8, Math.min(y, bounds.h - H - 8))
  return (
    <>
      <div className="absolute inset-0 z-40" onMouseDown={onClose} />
      <div
        role="dialog" aria-label="Thêm node" style={{ left, top, width: W }}
        className="absolute z-50 overflow-hidden rounded-xl border border-line-2 bg-raised text-xs shadow-xl"
        onKeyDown={(e) => {
          if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onClose() }
          else if (e.key === 'ArrowDown') { e.preventDefault(); setAt((i) => Math.min(list.length - 1, i + 1)) }
          else if (e.key === 'ArrowUp') { e.preventDefault(); setAt((i) => Math.max(0, i - 1)) }
          else if (e.key === 'Enter' && list[at]) { e.preventDefault(); onPick(list[at]) }
        }}
      >
        <div className="border-b border-line p-2">
          <input autoFocus className={`${input} w-full`} placeholder="Gõ tên loại node, ví dụ máy dập" aria-label="Tìm loại node" value={q} onChange={(e) => setQ(e.target.value)} />
          {hint && <p className="mt-1.5 px-0.5 text-[11px] text-muted">{hint}</p>}
        </div>
        <ul ref={ref} role="listbox" className="max-h-[220px] overflow-y-auto p-1">
          {list.map((t, i) => (
            <li key={t.code} role="option" aria-selected={i === at}>
              <button
                type="button" onClick={() => onPick(t)} onMouseMove={() => setAt(i)}
                className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-text ${i === at ? 'bg-panel' : ''}`}
              >
                <NodeIcon name={typeof t.ui?.icon === 'string' ? t.ui.icon : undefined} archetype={t.archetype} size={14} className="flex-none text-muted" />
                <span className="min-w-0 flex-1 truncate">{t.name}</span>
                <span className="flex-none text-[10.5px] text-faint">{ARCHETYPE_LABEL[t.archetype] ?? t.archetype}</span>
              </button>
            </li>
          ))}
          {list.length === 0 && <li className="px-2 py-3 text-muted">Không có loại node nào khớp.</li>}
        </ul>
      </div>
    </>
  )
}

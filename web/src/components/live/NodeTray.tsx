import { useState } from 'react'
import { CircleCheck, CircleDashed, Search, Truck } from 'lucide-react'
import type { AgvMap, GraphEdge, GraphNode } from '../../api/types'
import { trayNodes, type TrayType } from '../../lib/nodeTray'
import { NodeIdentity } from '../NodeIdentity'
import { input } from '../ui'

export const NODE_DRAG_TYPE = 'text/kf-node'

/** Trạng thái đặt của một node ở mép phải dòng: biểu tượng là chính, chữ chỉ để đọc màn hình và hiện khi rê chuột. */
function PlacedMark({ stations, needed }: { stations: number; needed: boolean }) {
  if (stations > 0) {
    const label = stations > 1 ? `Đã đặt ${stations} trạm` : 'Đã đặt'
    return (
      <span title={label} className="flex flex-none items-center gap-1 text-[11px] font-medium tabular-nums text-ok">
        <CircleCheck size={15} aria-hidden />{stations > 1 && <span>×{stations}</span>}<span className="sr-only">{label}</span>
      </span>
    )
  }
  if (needed) {
    return (
      <span title="Node có xe chở hàng tới: cần đặt trạm nối vào đường" className="flex flex-none items-center gap-1 rounded-full border border-lock-line bg-lock-bg px-1.5 py-0.5 text-[10.5px] font-medium text-lock-text">
        <Truck size={11} aria-hidden />xe cần tới
      </span>
    )
  }
  return <span title="Chưa đặt" className="flex-none text-faint"><CircleDashed size={15} aria-hidden /><span className="sr-only">Chưa đặt</span></span>
}

/**
 * Khay node của sơ đồ để đặt lên bản đồ: kéo một node thả lên bản đồ, hoặc bấm node rồi bấm chỗ cần đặt. Node đã đặt xuống cuối khay;
 * khi không sửa bản đồ, bấm node đã đặt để chọn trạm của nó trên bản đồ.
 */
export function NodeTray({ nodes, edges, map, names, types, skip, editing, armed, onArm, onFocusNode }: {
  nodes: GraphNode[]; edges: GraphEdge[]; map: AgvMap; names: Record<string, string>
  /** loại node theo mã: cho vai trò và biểu tượng của từng dòng */
  types?: Record<string, TrayType>
  /** node không có vị trí trên mặt bằng (đội xe, người vận hành): không đưa vào khay */
  skip: Set<string>
  editing: boolean
  /** node đang chờ bấm lên bản đồ (null: không có) */
  armed: string | null; onArm: (key: string | null) => void
  onFocusNode: (key: string) => void
}) {
  const [q, setQ] = useState('')
  const list = trayNodes(nodes, edges, map, names, q, skip, types)
  const placeable = nodes.filter((n) => !skip.has(n.key))
  const placed = placeable.filter((n) => map.points.some((p) => p.kind === 'station' && p.node_key === n.key)).length
  const pct = placeable.length === 0 ? 0 : Math.round((placed / placeable.length) * 100)
  const done = placeable.length > 0 && placed === placeable.length
  return (
    <div className="space-y-2.5 text-xs">
      <div>
        <p className="mb-1 text-[11px] text-muted">{done ? 'Đã đặt đủ mọi node.' : `Còn ${placeable.length - placed} node chưa đặt.`}</p>
        <div className="h-1 overflow-hidden rounded-full bg-raised" role="progressbar" aria-valuenow={placed} aria-valuemin={0} aria-valuemax={placeable.length} aria-label="Số node đã đặt">
          <i className={`block h-full rounded-full transition-[width] ${done ? 'bg-ok' : 'bg-accent'}`} style={{ width: `${pct}%` }} />
        </div>
      </div>
      {editing && <p className="text-[11px] text-muted">Kéo node thả lên bản đồ, hoặc bấm node rồi bấm chỗ cần đặt.</p>}
      {placeable.length > 8 && (
        <label className="relative block">
          <Search size={13} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-faint" aria-hidden />
          <input type="search" aria-label="Tìm node" placeholder="Tìm theo tên hoặc mã" value={q} onChange={(e) => setQ(e.target.value)} className={`${input} w-full pl-8`} />
        </label>
      )}
      <ul className="-mx-1.5 max-h-80 overflow-auto">
        {list.map((n) => {
          const isArmed = armed === n.key
          const body = <NodeIdentity name={n.name} code={n.key} icon={n.icon} archetype={n.archetype} trailing={<PlacedMark stations={n.stations} needed={n.needed} />} />
          const row = 'flex w-full items-center rounded-lg px-1.5 py-1.5 text-left'
          return (
            <li key={n.key}>
              {editing ? (
                <button
                  type="button" draggable aria-pressed={isArmed} title="Kéo thả lên bản đồ, hoặc bấm để chọn rồi bấm bản đồ"
                  onDragStart={(e) => { e.dataTransfer.setData(NODE_DRAG_TYPE, n.key); e.dataTransfer.effectAllowed = 'copy'; onArm(null) }}
                  onClick={() => onArm(isArmed ? null : n.key)}
                  className={`${row} cursor-grab active:cursor-grabbing ${isArmed ? 'bg-raised ring-1 ring-accent' : 'hover:bg-raised'}`}
                >{body}</button>
              ) : (
                <button
                  type="button" disabled={n.stations === 0} onClick={() => onFocusNode(n.key)}
                  title={n.stations > 0 ? 'Chọn trạm của node này trên bản đồ' : 'Chưa đặt: bấm "Sửa bản đồ" để đặt'}
                  className={`${row} enabled:hover:bg-raised disabled:cursor-default`}
                >{body}</button>
              )}
            </li>
          )
        })}
        {list.length === 0 && <li className="px-1.5 py-2 text-muted">Không có node nào khớp "{q}".</li>}
      </ul>
    </div>
  )
}

import { useMemo, useRef, useState } from 'react'
import type { AgvMap, Vehicle } from '../../api/types'
import { bounds, laneGeometry, laneTone, occupancy, type LaneTone } from '../../lib/mapGeom'

export type MapSelection = { kind: 'point' | 'lane'; id: string } | null
export type RingTone = 'ok' | 'warn' | 'bad'

const LANE_COLOR: Record<LaneTone, string> = { ok: 'var(--color-line-2)', busy: 'var(--color-warn)', jam: 'var(--color-bad)' }
const VEHICLE_COLOR: Record<string, string> = {
  MOVING: 'var(--color-ok)', WAITING: 'var(--color-bad)', LOADING: 'var(--color-warn)', IDLE: 'var(--color-muted)',
}
const RING_COLOR: Record<RingTone, string> = { ok: 'var(--color-ok)', warn: 'var(--color-warn)', bad: 'var(--color-bad)' }
const LANE_OFFSET = 1.1

/**
 * Bản đồ AGV vẽ bằng SVG (đơn vị vẽ = đơn vị bản đồ). Xe chạy mượt nhờ CSS transition giữa các bản tin vị trí.
 * Khi `editing`, kéo điểm để dời; bấm điểm hoặc làn để chọn. Mọi thay đổi đi ra qua callback, component không giữ dữ liệu bản đồ.
 */
export function AgvMapCanvas({ map, fleets, names, ringOf, blocked, selected, editing, linkFrom, onSelect, onPointClick, onMovePoint, onBackgroundClick }: {
  map: AgvMap
  fleets: Vehicle[][]
  /** node_key → tên hiển thị của trạm */
  names: Record<string, string>
  /** node_key → màu viền theo trạng thái live của node đó */
  ringOf?: (nodeKey: string) => RingTone | undefined
  /** id các làn đang bị chặn (sự cố bơm từ bảng demo) */
  blocked?: Set<string>
  selected: MapSelection
  editing: boolean
  /** Điểm đầu của thao tác "nối làn" đang dở */
  linkFrom?: string | null
  onSelect: (s: MapSelection) => void
  onPointClick?: (id: string) => void
  onMovePoint?: (id: string, x: number, y: number) => void
  onBackgroundClick?: (at: { x: number; y: number }) => void
}) {
  const svg = useRef<SVGSVGElement>(null)
  const [drag, setDrag] = useState<string | null>(null)
  const view = useMemo(() => bounds(map, 12), [map])
  const occ = useMemo(() => occupancy(map, fleets), [map, fleets])

  const toMap = (e: { clientX: number; clientY: number }) => {
    const el = svg.current
    const ctm = el?.getScreenCTM()
    if (!el || !ctm) return { x: 0, y: 0 }
    const p = new DOMPoint(e.clientX, e.clientY).matrixTransform(ctm.inverse())
    return { x: Math.round(p.x), y: Math.round(p.y) }
  }

  return (
    <svg
      ref={svg}
      role="img"
      aria-label="Bản đồ AGV"
      viewBox={`${view.x} ${view.y} ${view.w} ${view.h}`}
      className={`h-full w-full select-none ${editing ? 'cursor-crosshair' : ''}`}
      onPointerMove={(e) => { if (drag) { const p = toMap(e); onMovePoint?.(drag, p.x, p.y) } }}
      onPointerUp={() => setDrag(null)}
      onPointerLeave={() => setDrag(null)}
      onClick={(e) => { if (e.target === e.currentTarget) { onSelect(null); onBackgroundClick?.(toMap(e)) } }}
    >
      <defs>
        {(['ok', 'busy', 'jam'] as LaneTone[]).map((t) => (
          <marker key={t} id={`kf-arrow-${t}`} viewBox="0 0 6 6" refX="5" refY="3" markerUnits="userSpaceOnUse" markerWidth="2.6" markerHeight="2.6" orient="auto">
            <path d="M0,0 L6,3 L0,6 z" fill={LANE_COLOR[t]} />
          </marker>
        ))}
        <marker id="kf-arrow-sel" viewBox="0 0 6 6" refX="5" refY="3" markerUnits="userSpaceOnUse" markerWidth="2.6" markerHeight="2.6" orient="auto">
          <path d="M0,0 L6,3 L0,6 z" fill="var(--color-text)" />
        </marker>
      </defs>

      {map.lanes.map((l) => {
        const g = laneGeometry(map, l, LANE_OFFSET, 3.6)
        const o = occ.get(l.id)
        if (!g || !o) return null
        const tone = laneTone(o)
        const sel = selected?.kind === 'lane' && selected.id === l.id
        const isBlocked = blocked?.has(l.id) ?? false
        return (
          <g key={l.id} onClick={(e) => { e.stopPropagation(); onSelect({ kind: 'lane', id: l.id }) }} className="cursor-pointer">
            <line x1={g.x1} y1={g.y1} x2={g.x2} y2={g.y2} stroke="transparent" strokeWidth={3.4} />
            <line
              x1={g.x1} y1={g.y1} x2={g.x2} y2={g.y2}
              stroke={sel ? 'var(--color-text)' : isBlocked ? 'var(--color-bad)' : LANE_COLOR[tone]} strokeWidth={0.3 + 0.12 * l.capacity} strokeLinecap="round"
              strokeDasharray={isBlocked ? '1.2 0.9' : undefined}
              markerEnd={`url(#kf-arrow-${sel ? 'sel' : isBlocked ? 'jam' : tone})`}
            />
            {isBlocked && (
              <text x={(g.x1 + g.x2) / 2} y={(g.y1 + g.y2) / 2 + 0.7} textAnchor="middle" fontSize={2.4} fontWeight={700} fill="var(--color-bad)" style={{ pointerEvents: 'none' }}>✕</text>
            )}
          </g>
        )
      })}

      {map.points.map((p) => {
        const sel = selected?.kind === 'point' && selected.id === p.id
        const ring = p.node_key ? ringOf?.(p.node_key) : undefined
        const stroke = ring ? RING_COLOR[ring] : sel ? 'var(--color-text)' : 'var(--color-text-2)'
        const linking = linkFrom === p.id
        return (
          <g
            key={p.id}
            className={editing ? 'cursor-grab' : 'cursor-pointer'}
            onPointerDown={(e) => { if (editing) { e.stopPropagation(); (e.currentTarget as SVGGElement).setPointerCapture?.(e.pointerId); setDrag(p.id) } }}
            onClick={(e) => { e.stopPropagation(); onSelect({ kind: 'point', id: p.id }); onPointClick?.(p.id) }}
          >
            {p.kind === 'station' ? (
              <rect x={p.x - 3} y={p.y - 2.2} width={6} height={4.4} rx={1} fill="var(--color-panel)" stroke={stroke} strokeWidth={sel || ring || linking ? 0.8 : 0.45} />
            ) : p.kind === 'charger' ? (
              <path d={`M${p.x},${p.y - 2.4} L${p.x + 2.4},${p.y} L${p.x},${p.y + 2.4} L${p.x - 2.4},${p.y} z`} fill="var(--color-panel)" stroke={stroke} strokeWidth={0.6} />
            ) : (
              <circle cx={p.x} cy={p.y} r={sel || linking ? 1.5 : 1.1} fill="var(--color-panel)" stroke={sel || linking ? 'var(--color-text)' : 'var(--color-faint)'} strokeWidth={0.5} />
            )}
            {p.kind === 'station' && (
              <text x={p.x} y={p.y - 3.4} textAnchor="middle" fontSize={2} fill="var(--color-text)" style={{ pointerEvents: 'none' }}>
                {p.node_key ? names[p.node_key] ?? p.node_key : p.id}
              </text>
            )}
            {editing && p.kind !== 'station' && (
              <text x={p.x + 2} y={p.y - 1.6} fontSize={1.7} fill="var(--color-faint)" style={{ pointerEvents: 'none' }}>{p.id}</text>
            )}
          </g>
        )
      })}

      {fleets.flat().map((v) => (
        <g key={v.id} style={{ transform: `translate(${v.x}px, ${v.y}px)`, transition: 'transform 0.45s linear', pointerEvents: 'none' }}>
          <circle r={1.6} fill={VEHICLE_COLOR[v.state] ?? 'var(--color-muted)'} stroke="var(--color-bg)" strokeWidth={0.4} />
          {v.load > 0 && <circle r={2.5} fill="none" stroke="var(--color-text)" strokeWidth={0.35} strokeDasharray="1 0.8" />}
          <text y={4.6} textAnchor="middle" fontSize={1.5} fill="var(--color-text-2)">{v.id}</text>
        </g>
      ))}
    </svg>
  )
}

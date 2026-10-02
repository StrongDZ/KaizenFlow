import { useMemo, useRef, useState } from 'react'
import type { AgvMap, Pt, Vehicle } from '../../api/types'
import { bounds, laneShape, laneTone, midpointOf, occupancy, polylineD, type LaneTone } from '../../lib/mapGeom'

export type MapSelection = { kind: 'point' | 'lane'; id: string } | null
export type RingTone = 'ok' | 'warn' | 'bad'
/** Làn đang được vẽ dở: từ điểm `from`, đi qua các điểm uốn `via` đã bấm. */
export type DraftLane = { from: string; via: Pt[] }
/** Vị trí gốc của xe (đã đổi theo khung thử) vẽ mờ bên dưới để căn chỉnh khung toạ độ. */
export type Ghost = { id: string; x: number; y: number }

const LANE_COLOR: Record<LaneTone, string> = { ok: 'var(--color-line-2)', busy: 'var(--color-warn)', jam: 'var(--color-bad)' }
const VEHICLE_COLOR: Record<string, string> = {
  MOVING: 'var(--color-ok)', WAITING: 'var(--color-bad)', LOADING: 'var(--color-warn)', IDLE: 'var(--color-muted)',
}
const RING_COLOR: Record<RingTone, string> = { ok: 'var(--color-ok)', warn: 'var(--color-warn)', bad: 'var(--color-bad)' }

type Drag = { kind: 'point'; id: string } | { kind: 'wp'; lane: string; index: number } | null

/**
 * Bản đồ AGV vẽ bằng SVG, đơn vị vẽ là mét. Kích thước hình/chữ tính theo cỡ khung nhìn nên bản đồ nhỏ hay lớn đều đọc được.
 * Xe chạy mượt nhờ CSS transition giữa các bản tin vị trí. Khi `editing`: kéo điểm hoặc điểm uốn để dời, bấm "+" giữa đoạn để thêm
 * điểm uốn, bấm đúp điểm uốn để xoá. Mọi thay đổi đi ra qua callback, component không giữ dữ liệu bản đồ.
 */
export function AgvMapCanvas({
  map, fleets, names, ringOf, blocked, selected, editing, linkFrom, draft, ghosts, onSelect, onPointClick, onMovePoint, onBackgroundClick,
  onMoveWaypoint, onInsertWaypoint, onRemoveWaypoint,
}: {
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
  /** Điểm đầu của thao tác "vẽ làn" đang dở (chỉ để tô sáng điểm đó) */
  linkFrom?: string | null
  /** Làn đang vẽ dở, vẽ nét đứt theo chuột */
  draft?: DraftLane | null
  ghosts?: Ghost[]
  onSelect: (s: MapSelection) => void
  onPointClick?: (id: string) => void
  onMovePoint?: (id: string, x: number, y: number) => void
  onBackgroundClick?: (at: Pt) => void
  onMoveWaypoint?: (laneId: string, index: number, x: number, y: number) => void
  onInsertWaypoint?: (laneId: string, index: number, at: Pt) => void
  onRemoveWaypoint?: (laneId: string, index: number) => void
}) {
  const svg = useRef<SVGSVGElement>(null)
  const [drag, setDrag] = useState<Drag>(null)
  const [cursor, setCursor] = useState<Pt | null>(null)
  const { view, k } = useMemo(() => {
    const raw = bounds(map, 0)
    const k = Math.max(raw.w, raw.h * 1.5, 40) / 85
    return { view: bounds(map, 12 * k), k }
  }, [map])
  const occ = useMemo(() => occupancy(map, fleets), [map, fleets])

  const toMap = (e: { clientX: number; clientY: number }): Pt => {
    const el = svg.current
    const ctm = el?.getScreenCTM()
    if (!el || !ctm) return { x: 0, y: 0 }
    const p = new DOMPoint(e.clientX, e.clientY).matrixTransform(ctm.inverse())
    return { x: Math.round(p.x * 10) / 10, y: Math.round(p.y * 10) / 10 }
  }
  const pointOf = (id: string) => map.points.find((p) => p.id === id)
  const selLane = selected?.kind === 'lane' ? map.lanes.find((l) => l.id === selected.id) : undefined
  const from = draft ? pointOf(draft.from) : undefined

  return (
    <svg
      ref={svg}
      role="img"
      aria-label="Bản đồ AGV"
      viewBox={`${view.x} ${view.y} ${view.w} ${view.h}`}
      className={`h-full w-full select-none ${editing ? 'cursor-crosshair' : ''}`}
      onPointerMove={(e) => {
        const p = toMap(e)
        if (draft) setCursor(p)
        if (drag?.kind === 'point') onMovePoint?.(drag.id, p.x, p.y)
        else if (drag?.kind === 'wp') onMoveWaypoint?.(drag.lane, drag.index, p.x, p.y)
      }}
      onPointerUp={() => setDrag(null)}
      onPointerLeave={() => { setDrag(null); setCursor(null) }}
      onClick={(e) => { if (e.target === e.currentTarget) { onSelect(null); onBackgroundClick?.(toMap(e)) } }}
    >
      <defs>
        {(['ok', 'busy', 'jam'] as LaneTone[]).map((t) => (
          <marker key={t} id={`kf-arrow-${t}`} viewBox="0 0 6 6" refX="5" refY="3" markerUnits="userSpaceOnUse" markerWidth={2.6 * k} markerHeight={2.6 * k} orient="auto">
            <path d="M0,0 L6,3 L0,6 z" fill={LANE_COLOR[t]} />
          </marker>
        ))}
        <marker id="kf-arrow-sel" viewBox="0 0 6 6" refX="5" refY="3" markerUnits="userSpaceOnUse" markerWidth={2.6 * k} markerHeight={2.6 * k} orient="auto">
          <path d="M0,0 L6,3 L0,6 z" fill="var(--color-text)" />
        </marker>
      </defs>

      {map.lanes.map((l) => {
        const g = laneShape(map, l, 1.1 * k, 3.6 * k)
        const o = occ.get(l.id)
        if (!g || !o) return null
        const tone = laneTone(o)
        const sel = selected?.kind === 'lane' && selected.id === l.id
        const isBlocked = blocked?.has(l.id) ?? false
        const mid = midpointOf(g.pts)
        const d = polylineD(g.pts)
        return (
          <g key={l.id} onClick={(e) => { e.stopPropagation(); onSelect({ kind: 'lane', id: l.id }) }} className="cursor-pointer">
            <path d={d} fill="none" stroke="transparent" strokeWidth={3.4 * k} strokeLinejoin="round" />
            <path
              d={d} fill="none"
              stroke={sel ? 'var(--color-text)' : isBlocked ? 'var(--color-bad)' : LANE_COLOR[tone]} strokeWidth={(0.3 + 0.12 * l.capacity) * k} strokeLinecap="round" strokeLinejoin="round"
              strokeDasharray={isBlocked ? `${1.2 * k} ${0.9 * k}` : undefined}
              markerEnd={`url(#kf-arrow-${sel ? 'sel' : isBlocked ? 'jam' : tone})`}
            />
            {isBlocked && (
              <text x={mid.x} y={mid.y + 0.7 * k} textAnchor="middle" fontSize={2.4 * k} fontWeight={700} fill="var(--color-bad)" style={{ pointerEvents: 'none' }}>✕</text>
            )}
          </g>
        )
      })}

      {editing && selLane && <WaypointHandles map={map} laneId={selLane.id} k={k} onDrag={(i) => setDrag({ kind: 'wp', lane: selLane.id, index: i })} onInsert={onInsertWaypoint} onRemove={onRemoveWaypoint} />}

      {draft && from && (
        <path
          d={polylineD([{ x: from.x, y: from.y }, ...draft.via, ...(cursor ? [cursor] : [])])} fill="none" stroke="var(--color-accent)" strokeWidth={0.6 * k}
          strokeDasharray={`${1.4 * k} ${1 * k}`} strokeLinecap="round" strokeLinejoin="round" style={{ pointerEvents: 'none' }}
        />
      )}
      {draft?.via.map((q, i) => <circle key={i} cx={q.x} cy={q.y} r={0.9 * k} fill="var(--color-accent)" style={{ pointerEvents: 'none' }} />)}

      {map.points.map((p) => {
        const sel = selected?.kind === 'point' && selected.id === p.id
        const ring = p.node_key ? ringOf?.(p.node_key) : undefined
        const stroke = ring ? RING_COLOR[ring] : sel ? 'var(--color-text)' : 'var(--color-text-2)'
        const linking = linkFrom === p.id
        return (
          <g
            key={p.id}
            className={editing ? 'cursor-grab' : 'cursor-pointer'}
            onPointerDown={(e) => { if (editing) { e.stopPropagation(); (e.currentTarget as SVGGElement).setPointerCapture?.(e.pointerId); setDrag({ kind: 'point', id: p.id }) } }}
            onClick={(e) => { e.stopPropagation(); onSelect({ kind: 'point', id: p.id }); onPointClick?.(p.id) }}
          >
            {p.kind === 'station' ? (
              <rect x={p.x - 3 * k} y={p.y - 2.2 * k} width={6 * k} height={4.4 * k} rx={1 * k} fill="var(--color-panel)" stroke={stroke} strokeWidth={(sel || ring || linking ? 0.8 : 0.45) * k} />
            ) : p.kind === 'charger' ? (
              <path d={`M${p.x},${p.y - 2.4 * k} L${p.x + 2.4 * k},${p.y} L${p.x},${p.y + 2.4 * k} L${p.x - 2.4 * k},${p.y} z`} fill="var(--color-panel)" stroke={stroke} strokeWidth={0.6 * k} />
            ) : (
              <circle cx={p.x} cy={p.y} r={(sel || linking ? 1.5 : 1.1) * k} fill="var(--color-panel)" stroke={sel || linking ? 'var(--color-text)' : 'var(--color-faint)'} strokeWidth={0.5 * k} />
            )}
            {p.kind === 'station' && (
              <text x={p.x} y={p.y - 3.4 * k} textAnchor="middle" fontSize={2 * k} fill="var(--color-text)" style={{ pointerEvents: 'none' }}>
                {p.node_key ? names[p.node_key] ?? p.node_key : p.id}
              </text>
            )}
            {editing && p.kind !== 'station' && (
              <text x={p.x + 2 * k} y={p.y - 1.6 * k} fontSize={1.7 * k} fill="var(--color-faint)" style={{ pointerEvents: 'none' }}>{p.id}</text>
            )}
          </g>
        )
      })}

      {ghosts?.map((gh) => (
        <g key={gh.id} style={{ pointerEvents: 'none' }}>
          <circle cx={gh.x} cy={gh.y} r={1.9 * k} fill="none" stroke="var(--color-accent)" strokeWidth={0.4 * k} strokeDasharray={`${0.9 * k} ${0.7 * k}`} />
          <text x={gh.x} y={gh.y - 2.6 * k} textAnchor="middle" fontSize={1.4 * k} fill="var(--color-accent)">{gh.id}</text>
        </g>
      ))}

      {fleets.flat().map((v) => (
        <g key={v.id} style={{ transform: `translate(${v.x}px, ${v.y}px)`, transition: 'transform 0.45s linear', pointerEvents: 'none' }}>
          <circle r={1.6 * k} fill={VEHICLE_COLOR[v.state] ?? 'var(--color-muted)'} stroke={v.off_map ? 'var(--color-bad)' : 'var(--color-bg)'} strokeWidth={(v.off_map ? 0.6 : 0.4) * k} strokeDasharray={v.off_map ? `${0.8 * k} ${0.6 * k}` : undefined} />
          {v.heading !== undefined && (
            <path d={`M${2.9 * k},0 L${1.5 * k},${-0.9 * k} L${1.5 * k},${0.9 * k} z`} fill="var(--color-text)" transform={`rotate(${v.heading})`} />
          )}
          {v.load > 0 && <circle r={2.5 * k} fill="none" stroke="var(--color-text)" strokeWidth={0.35 * k} strokeDasharray={`${1 * k} ${0.8 * k}`} />}
          <text y={4.6 * k} textAnchor="middle" fontSize={1.5 * k} fill="var(--color-text-2)">{v.id}{v.off_map ? ' · ngoài đường' : ''}</text>
        </g>
      ))}
    </svg>
  )
}

/** Tay cầm điểm uốn của làn đang chọn: chấm để kéo (bấm đúp để xoá) và dấu "+" giữa mỗi đoạn để thêm điểm uốn. */
function WaypointHandles({ map, laneId, k, onDrag, onInsert, onRemove }: {
  map: AgvMap; laneId: string; k: number; onDrag: (index: number) => void
  onInsert?: (laneId: string, index: number, at: Pt) => void; onRemove?: (laneId: string, index: number) => void
}) {
  const lane = map.lanes.find((l) => l.id === laneId)
  const a = map.points.find((p) => p.id === lane?.from)
  const b = map.points.find((p) => p.id === lane?.to)
  if (!lane || !a || !b) return null
  const via = lane.path ?? []
  const chain: Pt[] = [{ x: a.x, y: a.y }, ...via, { x: b.x, y: b.y }]
  return (
    <g>
      {chain.slice(1).map((q, i) => {
        const p = chain[i]
        const at = { x: Math.round(((p.x + q.x) / 2) * 10) / 10, y: Math.round(((p.y + q.y) / 2) * 10) / 10 }
        return (
          <g key={`add${i}`} className="cursor-copy" onClick={(e) => { e.stopPropagation(); onInsert?.(laneId, i, at) }}>
            <circle cx={at.x} cy={at.y} r={1.3 * k} fill="var(--color-panel)" stroke="var(--color-accent)" strokeWidth={0.35 * k} />
            <path d={`M${at.x - 0.6 * k},${at.y} H${at.x + 0.6 * k} M${at.x},${at.y - 0.6 * k} V${at.y + 0.6 * k}`} stroke="var(--color-accent)" strokeWidth={0.35 * k} style={{ pointerEvents: 'none' }} />
          </g>
        )
      })}
      {via.map((q, i) => (
        <circle
          key={`wp${i}`} cx={q.x} cy={q.y} r={1.2 * k} fill="var(--color-accent)" stroke="var(--color-bg)" strokeWidth={0.3 * k} className="cursor-grab"
          onPointerDown={(e) => { e.stopPropagation(); (e.currentTarget as SVGCircleElement).setPointerCapture?.(e.pointerId); onDrag(i) }}
          onClick={(e) => e.stopPropagation()}
          onDoubleClick={(e) => { e.stopPropagation(); onRemove?.(laneId, i) }}
        >
          <title>Kéo để dời, bấm đúp để xoá điểm uốn</title>
        </circle>
      ))}
    </g>
  )
}

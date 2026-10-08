import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react'
import type { AgvMap, MapBG, Pt, Vehicle } from '../../api/types'
import { bgCenter, bgCorners, moveBg, rotateBg, scaleBg } from '../../lib/mapImage'
import { NodeIcon } from '../nodeIcons'
import { roleColor } from '../NodeIdentity'
import { bounds, laneShape, markScale, midpointOf, occupancy, polylineD, type LaneTone, type Rect } from '../../lib/mapGeom'
import { isOneWay, roadOf, roadsOf, roadTone } from '../../lib/roads'
import type { MapLine, Tone } from '../../lib/nodeFacts'
import type { Trace } from '../../lib/traceMap'

export type MapSelection = { kind: 'point' | 'lane' | 'zone'; id: string } | null
export type RingTone = 'ok' | 'warn' | 'bad'
/** Làn đang được vẽ dở: từ điểm `from`, đi qua các điểm uốn `via` đã bấm. */
export type DraftLane = { from: string; via: Pt[] }
/** Vị trí gốc của xe (đã đổi theo khung thử) vẽ mờ bên dưới để căn chỉnh khung toạ độ. */
export type Ghost = { id: string; x: number; y: number }

const LANE_COLOR: Record<LaneTone, string> = { ok: 'var(--color-line-2)', busy: 'var(--color-warn)', jam: 'var(--color-bad)' }
const VEHICLE_COLOR: Record<string, string> = {
  MOVING: 'var(--color-ok)', WAITING: 'var(--color-bad)', LOADING: 'var(--color-warn)', CHARGING: 'var(--color-accent)', IDLE: 'var(--color-muted)',
}
const RING_COLOR: Record<RingTone, string> = { ok: 'var(--color-ok)', warn: 'var(--color-warn)', bad: 'var(--color-bad)' }
const LINE_COLOR: Record<Tone, string> = { ok: 'var(--color-ok)', warn: 'var(--color-warn)', bad: 'var(--color-bad-text)', muted: 'var(--color-text-2)' }

type Drag = { kind: 'point'; id: string } | { kind: 'wp'; lane: string; index: number } | { kind: 'zv'; zone: string; index: number }
  // chỉnh ảnh nền: dời (từ điểm bấm), đổi cỡ (kéo một góc, quanh tâm), xoay (núm phía trên); bg0 là ảnh lúc bắt đầu kéo
  | { kind: 'bgmove'; bg0: MapBG; start: Pt } | { kind: 'bgscale'; bg0: MapBG; corner: Pt } | { kind: 'bgrot'; bg0: MapBG; a0: number }
  | null

/** Lệnh điều khiển khung nhìn từ ngoài (thanh công cụ): vừa khung, thu phóng quanh tâm. */
export type CanvasHandle = { fit: () => void; zoomBy: (factor: number) => void; toMap: (e: { clientX: number; clientY: number }) => Pt }

/** Mở rộng khung `view` cho cùng tỉ lệ với vùng vẽ (tâm giữ nguyên) để canvas lấp đầy chỗ mà không chừa viền trống. */
export function fitBox(view: Rect, size: { w: number; h: number }, padLeft = 0): Rect {
  if (size.w <= 0 || size.h <= 0) return view
  const free = Math.max(size.w - padLeft, size.w * 0.3)  // phần bề rộng không bị bảng nổi che
  const aspect = free / size.h
  let w = view.w
  let h = view.h
  if (w / h < aspect) w = h * aspect
  else h = w / aspect
  const per = w / free  // mét mỗi pixel
  // Bản đồ nằm giữa phần còn trống; phần bị bảng che nằm bên trái nó.
  return { x: view.x + view.w / 2 - w / 2 - padLeft * per, y: view.y + view.h / 2 - h / 2, w: w + padLeft * per, h }
}

/**
 * Bản đồ AGV vẽ bằng SVG, đơn vị vẽ là mét. Kích thước hình/chữ tính theo cỡ khung nhìn nên bản đồ nhỏ hay lớn đều đọc được.
 * Xe chạy mượt nhờ CSS transition giữa các bản tin vị trí. Khi `editing`: kéo điểm hoặc điểm uốn để dời, bấm "+" giữa đoạn để thêm
 * điểm uốn, bấm đúp điểm uốn để xoá. Mọi thay đổi đi ra qua callback, component không giữ dữ liệu bản đồ.
 */
type Props = {
  map: AgvMap
  fleets: Vehicle[][]
  /** node_key → tên hiển thị của trạm */
  names: Record<string, string>
  /** node_key → màu viền theo trạng thái live của node đó */
  ringOf?: (nodeKey: string) => RingTone | undefined
  /** node_key → vai trò và biểu tượng của node, để trạm có ô icon cùng màu với sơ đồ (bỏ trống thì trạm là ô trơn) */
  kindOf?: (nodeKey: string) => { archetype?: string; icon?: string } | undefined
  /** node_key → vài dòng thông số quan trọng hiện dưới trạm (bỏ trống thì không hiện) */
  linesOf?: (nodeKey: string) => MapLine[] | undefined
  /** id các làn đang bị chặn (sự cố bơm từ bảng demo) */
  blocked?: Set<string>
  selected: MapSelection
  editing: boolean
  /** Điểm đầu của thao tác "vẽ làn" đang dở (chỉ để tô sáng điểm đó) */
  linkFrom?: string | null
  /** Làn đang vẽ dở, vẽ nét đứt theo chuột */
  draft?: DraftLane | null
  ghosts?: Ghost[]
  /** Ảnh mặt bằng làm nền (địa chỉ ảnh); chỗ đặt lấy từ `map.bg`. */
  bgUrl?: string
  bgOpacity?: number
  /** Hai điểm đang bấm để hiệu chuẩn tỉ lệ ảnh nền. */
  calibPts?: Pt[]
  /** Bản nháp đường dò từ ảnh: vẽ nét đứt, chưa phải một phần của bản đồ. */
  tracePreview?: Trace | null
  /** Vùng cấm đang vẽ dở (các đỉnh đã bấm); bấm đỉnh đầu để khép kín khi đã có từ 3 đỉnh. */
  zoneDraft?: Pt[] | null
  /** Bấm vào vùng cấm để chọn được (chỉ khi công cụ là Chọn); các công cụ khác để bấm xuyên qua vùng. */
  zonesClickable?: boolean
  /** id của đường và điểm đang có lỗi (vd. cắt vùng cấm): vẽ màu đỏ. */
  issueIds?: Set<string>
  /** Bề rộng (px) của bảng nổi bên trái: khi vừa khung, bản đồ được dời sang phải để không nằm dưới bảng */
  padLeft?: number
  onSelect: (s: MapSelection) => void
  onPointClick?: (id: string) => void
  onMovePoint?: (id: string, x: number, y: number) => void
  onBackgroundClick?: (at: Pt) => void
  onMoveWaypoint?: (laneId: string, index: number, x: number, y: number) => void
  onInsertWaypoint?: (laneId: string, index: number, at: Pt) => void
  onRemoveWaypoint?: (laneId: string, index: number) => void
  onCloseZone?: () => void
  /** Đang chỉnh ảnh nền: hiện khung có núm để dời, đổi cỡ, xoay ảnh; mỗi thay đổi đi ra qua onBgChange. */
  bgEdit?: boolean
  onBgChange?: (bg: MapBG) => void
  onMoveZoneVertex?: (zoneId: string, index: number, x: number, y: number) => void
  onInsertZoneVertex?: (zoneId: string, index: number, at: Pt) => void
  onRemoveZoneVertex?: (zoneId: string, index: number) => void
}

export const AgvMapCanvas = forwardRef<CanvasHandle, Props>(function AgvMapCanvas({
  map, fleets, names, ringOf, kindOf, linesOf, blocked, selected, editing, linkFrom, draft, ghosts, bgUrl, bgOpacity = 0.55, calibPts, tracePreview, zoneDraft, zonesClickable = true, issueIds, padLeft = 0, onSelect, onPointClick, onMovePoint, onBackgroundClick,
  onMoveWaypoint, onInsertWaypoint, onRemoveWaypoint, onCloseZone, onMoveZoneVertex, onInsertZoneVertex, onRemoveZoneVertex, bgEdit = false, onBgChange,
}, handle) {
  const svg = useRef<SVGSVGElement>(null)
  const [drag, setDrag] = useState<Drag>(null)
  const [cursor, setCursor] = useState<Pt | null>(null)
  const { view, k } = useMemo(() => {
    const k = markScale(map)
    return { view: bounds(map, 12 * k), k }
  }, [map])
  const occ = useMemo(() => occupancy(map, fleets), [map, fleets])
  // Một node có nhiều trạm (nhiều chỗ đỗ) thì chỉ trạm đầu hiện thông số, khỏi lặp lại.
  const firstStation = useMemo(() => {
    const out = new Map<string, string>()
    for (const p of map.points) if (p.kind === 'station' && p.node_key && !out.has(p.node_key)) out.set(p.node_key, p.id)
    return out
  }, [map])
  const roads = useMemo(() => roadsOf(map), [map])

  // Khung nhìn: lấp đầy vùng vẽ, lăn chuột để thu phóng quanh con trỏ, kéo chỗ trống để dời.
  const [size, setSize] = useState({ w: 0, h: 0 })
  const [vb, setVb] = useState<Rect | null>(null)
  const pan = useRef<{ x: number; y: number; vb: Rect; moved: boolean } | null>(null)
  const swallowClick = useRef(false)
  const fitted = useRef(false)
  const prevSize = useRef(size)
  useEffect(() => {
    const el = svg.current
    if (!el) return
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }))
    ro.observe(el)
    setSize({ w: el.clientWidth, h: el.clientHeight })
    return () => ro.disconnect()
  }, [])
  // Lần đầu có chỗ vẽ và có điểm thì vừa khung; đổi cỡ vùng vẽ thì giữ tâm và tỉ lệ.
  useEffect(() => {
    if (size.w <= 0 || size.h <= 0) return
    if (!fitted.current && map.points.length > 0) { fitted.current = true; setVb(fitBox(view, size, padLeft)) }
    else if (prevSize.current.w > 0 && (prevSize.current.w !== size.w || prevSize.current.h !== size.h)) {
      setVb((cur) => {
        if (!cur) return cur
        const per = cur.w / prevSize.current.w
        const w = per * size.w
        const h = per * size.h
        return { x: cur.x + cur.w / 2 - w / 2, y: cur.y + cur.h / 2 - h / 2, w, h }
      })
    }
    prevSize.current = size
  }, [size, view, map.points.length])
  const box = vb ?? fitBox(view, size)
  const zoomAt = (factor: number, at: Pt) => setVb((cur) => {
    const c = cur ?? fitBox(view, size)
    const w = Math.min(Math.max(c.w / factor, view.w * 0.04), view.w * 10)
    const f = w / c.w
    return { x: at.x - (at.x - c.x) * f, y: at.y - (at.y - c.y) * f, w, h: c.h * f }
  })
  useImperativeHandle(handle, () => ({
    fit: () => setVb(fitBox(view, size, padLeft)),
    zoomBy: (factor) => zoomAt(factor, { x: box.x + box.w / 2, y: box.y + box.h / 2 }),
    toMap: (e) => toMap(e),
  }))
  useEffect(() => {
    const el = svg.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      const ctm = el.getScreenCTM()
      if (!ctm) return
      const p = new DOMPoint(e.clientX, e.clientY).matrixTransform(ctm.inverse())
      zoomAt(Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0015)), { x: p.x, y: p.y })
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  })

  const toMap = (e: { clientX: number; clientY: number }): Pt => {
    const el = svg.current
    const ctm = el?.getScreenCTM()
    if (!el || !ctm) return { x: 0, y: 0 }
    const p = new DOMPoint(e.clientX, e.clientY).matrixTransform(ctm.inverse())
    return { x: Math.round(p.x * 10) / 10, y: Math.round(p.y * 10) / 10 }
  }
  /** Như toMap nhưng không làm tròn: dời, đổi cỡ, xoay ảnh cần mượt. */
  const toMapExact = (e: { clientX: number; clientY: number }): Pt => {
    const ctm = svg.current?.getScreenCTM()
    if (!ctm) return { x: 0, y: 0 }
    const p = new DOMPoint(e.clientX, e.clientY).matrixTransform(ctm.inverse())
    return { x: p.x, y: p.y }
  }
  const angleAt = (bg: MapBG, p: Pt) => { const c = bgCenter(bg); return (Math.atan2(p.y - c.y, p.x - c.x) * 180) / Math.PI }
  const pointOf = (id: string) => map.points.find((p) => p.id === id)
  const selRoad = selected?.kind === 'lane' ? roadOf(map, selected.id) : undefined
  const selZone = selected?.kind === 'zone' ? (map.keepouts ?? []).find((z) => z.id === selected.id) : undefined
  const from = draft ? pointOf(draft.from) : undefined

  return (
    <svg
      ref={svg}
      role="img"
      aria-label="Bản đồ AGV"
      viewBox={`${box.x} ${box.y} ${box.w} ${box.h}`}
      className={`h-full w-full select-none ${editing ? 'cursor-crosshair' : pan.current?.moved ? 'cursor-grabbing' : 'cursor-grab'}`}
      onPointerDown={(e) => {
        if (e.target !== e.currentTarget && e.button !== 1) return
        ;(e.currentTarget as SVGSVGElement).setPointerCapture?.(e.pointerId)
        pan.current = { x: e.clientX, y: e.clientY, vb: box, moved: false }
      }}
      onPointerMove={(e) => {
        const pn = pan.current
        if (pn) {
          const dx = e.clientX - pn.x
          const dy = e.clientY - pn.y
          if (pn.moved || Math.hypot(dx, dy) > 4) {
            pn.moved = true
            setVb({ ...pn.vb, x: pn.vb.x - (dx * pn.vb.w) / size.w, y: pn.vb.y - (dy * pn.vb.h) / size.h })
          }
          return
        }
        const p = toMap(e)
        if (draft || zoneDraft) setCursor(p)
        if (drag?.kind === 'bgmove' || drag?.kind === 'bgscale' || drag?.kind === 'bgrot') {
          const q = toMapExact(e)
          if (drag.kind === 'bgmove') onBgChange?.(moveBg(drag.bg0, q.x - drag.start.x, q.y - drag.start.y))
          else if (drag.kind === 'bgscale') {
            const c = bgCenter(drag.bg0)
            const f = Math.hypot(q.x - c.x, q.y - c.y) / Math.max(1e-9, Math.hypot(drag.corner.x - c.x, drag.corner.y - c.y))
            onBgChange?.(scaleBg(drag.bg0, Math.max(0.02, f)))
          } else {
            let rot = (drag.bg0.rot ?? 0) + angleAt(drag.bg0, q) - drag.a0
            if (e.shiftKey) rot = Math.round(rot / 15) * 15 // giữ Shift: bắt theo bước 15°
            onBgChange?.(rotateBg(drag.bg0, rot))
          }
          return
        }
        if (drag?.kind === 'point') onMovePoint?.(drag.id, p.x, p.y)
        else if (drag?.kind === 'wp') onMoveWaypoint?.(drag.lane, drag.index, p.x, p.y)
        else if (drag?.kind === 'zv') onMoveZoneVertex?.(drag.zone, drag.index, p.x, p.y)
      }}
      onPointerUp={() => { setDrag(null); if (pan.current?.moved) swallowClick.current = true; pan.current = null }}
      onPointerLeave={() => { setDrag(null); setCursor(null) }}
      onClick={(e) => {
        if (swallowClick.current) { swallowClick.current = false; return }  // vừa kéo canvas thì không tính là bấm vào chỗ trống
        if (e.target === e.currentTarget) { onSelect(null); onBackgroundClick?.(toMap(e)) }
      }}
    >
      <defs>
        {(['ok', 'busy', 'jam'] as LaneTone[]).map((t) => (
          <marker key={t} id={`kf-arrow-${t}`} viewBox="0 0 6 6" refX="5" refY="3" markerUnits="userSpaceOnUse" markerWidth={2.6 * k} markerHeight={2.6 * k} orient="auto">
            <path d="M0,0 L6,3 L0,6 z" fill={LANE_COLOR[t]} />
          </marker>
        ))}
        <pattern id="kf-hatch" patternUnits="userSpaceOnUse" width={2 * k} height={2 * k} patternTransform="rotate(45)">
          <line x1={0} y1={0} x2={0} y2={2 * k} stroke="var(--color-bad)" strokeWidth={0.45 * k} opacity={0.55} />
        </pattern>
        <marker id="kf-arrow-sel" viewBox="0 0 6 6" refX="5" refY="3" markerUnits="userSpaceOnUse" markerWidth={2.6 * k} markerHeight={2.6 * k} orient="auto">
          <path d="M0,0 L6,3 L0,6 z" fill="var(--color-text)" />
        </marker>
      </defs>

      {map.bg && bgUrl && (
        <image href={bgUrl} x={map.bg.x} y={map.bg.y} width={map.bg.w_px * map.bg.m_per_px} height={map.bg.h_px * map.bg.m_per_px}
          transform={map.bg.rot ? `rotate(${map.bg.rot} ${bgCenter(map.bg).x} ${bgCenter(map.bg).y})` : undefined}
          preserveAspectRatio="none" opacity={bgOpacity} style={{ pointerEvents: 'none' }} />
      )}

      {tracePreview && (
        <g style={{ pointerEvents: 'none' }}>
          {tracePreview.edges.map((e, i) => {
            const a = tracePreview.nodes.find((n) => n.id === e.a)!
            const b = tracePreview.nodes.find((n) => n.id === e.b)!
            return <path key={i} d={polylineD([{ x: a.x, y: a.y }, ...e.via, { x: b.x, y: b.y }])} fill="none" stroke="var(--color-accent)" strokeWidth={0.7 * k} strokeDasharray={`${1.6 * k} ${1 * k}`} strokeLinecap="round" strokeLinejoin="round" />
          })}
          {tracePreview.nodes.map((n) => <circle key={n.id} cx={n.x} cy={n.y} r={0.9 * k} fill="var(--color-accent)" />)}
        </g>
      )}

      {(map.keepouts ?? []).map((z) => {
        const sel = selZone?.id === z.id
        const c = z.poly.reduce((a, q) => ({ x: a.x + q.x / z.poly.length, y: a.y + q.y / z.poly.length }), { x: 0, y: 0 })
        const d = polylineD(z.poly) + 'Z'
        return (
          <g key={z.id} style={{ pointerEvents: zonesClickable ? 'auto' : 'none' }} className="cursor-pointer" onClick={(e) => { e.stopPropagation(); onSelect({ kind: 'zone', id: z.id }) }}>
            <path d={d} fill="var(--color-bad)" fillOpacity={0.1} />
            <path d={d} fill="url(#kf-hatch)" stroke={sel ? 'var(--color-text)' : 'var(--color-bad)'} strokeWidth={(sel ? 0.7 : 0.45) * k} strokeLinejoin="round" strokeDasharray={sel ? undefined : `${1.6 * k} ${1 * k}`} />
            <text x={c.x} y={c.y + 0.4 * k} textAnchor="middle" fontSize={1.25 * k} fontWeight={500} fill="var(--color-bad-text)" stroke="var(--color-bg)" strokeWidth={0.35 * k} paintOrder="stroke" style={{ pointerEvents: 'none' }}>{z.id}</text>
          </g>
        )
      })}

      {roads.map((r) => {
        // Đường hai chiều vẽ một nét giữa, không mũi tên; đường một chiều có mũi tên ở cuối.
        const g = laneShape(map, r.a, 0, 3.6 * k)
        if (!g) return null
        const tone = roadTone(r, occ)
        const sel = selRoad?.a.id === r.a.id
        const isBlocked = (blocked?.has(r.a.id) ?? false) || (r.b ? blocked?.has(r.b.id) ?? false : false)
        const flagged = (issueIds?.has(r.a.id) ?? false) || (r.b ? issueIds?.has(r.b.id) ?? false : false)
        const one = isOneWay(r)
        const cap = Math.max(r.a.capacity, r.b?.capacity ?? 0)
        const mid = midpointOf(g.pts)
        const d = polylineD(g.pts)
        return (
          <g key={r.id} onClick={(e) => { e.stopPropagation(); onSelect({ kind: 'lane', id: r.a.id }) }} className="cursor-pointer">
            <path d={d} fill="none" stroke="transparent" strokeWidth={3.4 * k} strokeLinejoin="round" />
            <path
              d={d} fill="none"
              stroke={sel ? 'var(--color-text)' : isBlocked || flagged ? 'var(--color-bad)' : LANE_COLOR[tone]} strokeWidth={(0.3 + 0.12 * cap) * k} strokeLinecap="round" strokeLinejoin="round"
              strokeDasharray={isBlocked || flagged ? `${1.2 * k} ${0.9 * k}` : undefined}
              markerEnd={one ? `url(#kf-arrow-${sel ? 'sel' : isBlocked ? 'jam' : tone})` : undefined}
            />
            {isBlocked && (
              <text x={mid.x} y={mid.y + 0.7 * k} textAnchor="middle" fontSize={2.4 * k} fontWeight={700} fill="var(--color-bad)" style={{ pointerEvents: 'none' }}>✕</text>
            )}
          </g>
        )
      })}

      {editing && selZone && <ZoneHandles zone={selZone} k={k} onDrag={(i) => setDrag({ kind: 'zv', zone: selZone.id, index: i })} onInsert={onInsertZoneVertex} onRemove={onRemoveZoneVertex} />}

      {zoneDraft && zoneDraft.length > 0 && (
        <g>
          <path d={polylineD([...zoneDraft, ...(cursor ? [cursor] : [])])} fill="none" stroke="var(--color-bad)" strokeWidth={0.6 * k} strokeDasharray={`${1.4 * k} ${1 * k}`} strokeLinecap="round" strokeLinejoin="round" style={{ pointerEvents: 'none' }} />
          {zoneDraft.map((q, i) => (
            <circle key={i} cx={q.x} cy={q.y} r={(i === 0 && zoneDraft.length >= 3 ? 1.6 : 0.9) * k} fill="var(--color-bad)" stroke="var(--color-bg)" strokeWidth={0.3 * k}
              className={i === 0 && zoneDraft.length >= 3 ? 'cursor-pointer' : undefined} style={{ pointerEvents: i === 0 && zoneDraft.length >= 3 ? 'auto' : 'none' }}
              onClick={(e) => { e.stopPropagation(); if (i === 0) onCloseZone?.() }}>
              {i === 0 && zoneDraft.length >= 3 && <title>Bấm để khép kín vùng (hoặc Enter)</title>}
            </circle>
          ))}
        </g>
      )}

      {editing && selRoad && <WaypointHandles map={map} laneId={selRoad.a.id} k={k} onDrag={(i) => setDrag({ kind: 'wp', lane: selRoad.a.id, index: i })} onInsert={onInsertWaypoint} onRemove={onRemoveWaypoint} />}

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
        const flaggedPt = issueIds?.has(p.id) ?? false
        const stroke = flaggedPt ? 'var(--color-bad)' : ring ? RING_COLOR[ring] : sel ? 'var(--color-text)' : 'var(--color-text-2)'
        const linking = linkFrom === p.id
        return (
          <g
            key={p.id}
            className={editing ? 'cursor-grab' : 'cursor-pointer'}
            onPointerDown={(e) => { if (editing) { e.stopPropagation(); (e.currentTarget as SVGGElement).setPointerCapture?.(e.pointerId); setDrag({ kind: 'point', id: p.id }) } }}
            onClick={(e) => { e.stopPropagation(); onSelect({ kind: 'point', id: p.id }); onPointClick?.(p.id) }}
          >
            {p.kind === 'station' ? (() => {
              const kind = p.node_key ? kindOf?.(p.node_key) : undefined
              const role = kind ? roleColor(kind.archetype) : undefined
              const icon = 2.2 * k
              return (
                <>
                  <rect
                    x={p.x - 2.4 * k} y={p.y - 1.7 * k} width={4.8 * k} height={3.4 * k} rx={0.7 * k} strokeWidth={(sel || ring || linking ? 0.8 : 0.45) * k}
                    style={{
                      fill: role ? `color-mix(in srgb, ${role} 22%, var(--color-panel))` : 'var(--color-panel)',
                      stroke: !ring && !sel && !linking && !flaggedPt && role ? `color-mix(in srgb, ${role} 70%, transparent)` : stroke,
                    }}
                  />
                  {kind && (
                    <svg x={p.x - icon / 2} y={p.y - icon / 2} width={icon} height={icon} viewBox="0 0 24 24" overflow="visible" style={{ color: role, pointerEvents: 'none' }}>
                      <NodeIcon name={kind.icon} archetype={kind.archetype} size={24} />
                    </svg>
                  )}
                </>
              )
            })() : p.kind === 'charger' ? (
              <path d={`M${p.x},${p.y - 1.8 * k} L${p.x + 1.8 * k},${p.y} L${p.x},${p.y + 1.8 * k} L${p.x - 1.8 * k},${p.y} z`} fill="var(--color-panel)" stroke={stroke} strokeWidth={0.5 * k} />
            ) : (
              <circle cx={p.x} cy={p.y} r={(sel || linking ? 1.3 : 0.85) * k} fill="var(--color-panel)" stroke={flaggedPt ? 'var(--color-bad)' : sel || linking ? 'var(--color-text)' : 'var(--color-faint)'} strokeWidth={0.4 * k} />
            )}
            {p.kind === 'station' && (
              <text x={p.x} y={p.y - 2.4 * k} textAnchor="middle" fontSize={1.35 * k} fontWeight={600} fill="var(--color-text)" stroke="var(--color-bg)" strokeWidth={0.45 * k} paintOrder="stroke" style={{ pointerEvents: 'none' }}>
                {p.node_key ? names[p.node_key] ?? p.node_key : p.id}
              </text>
            )}
            {p.kind === 'station' && p.node_key && firstStation.get(p.node_key) === p.id && (linesOf?.(p.node_key) ?? []).map((ln, i) => (
              <text
                key={`fact${i}`} x={p.x} y={p.y + (2.9 + i * 1.4) * k} textAnchor="middle" fontSize={1.1 * k} fill={LINE_COLOR[ln.tone]}
                stroke="var(--color-bg)" strokeWidth={0.4 * k} paintOrder="stroke" style={{ pointerEvents: 'none' }}
              >{ln.text}</text>
            ))}
            {editing && p.kind !== 'station' && (
              <text x={p.x + 1.3 * k} y={p.y - 1.1 * k} fontSize={1.15 * k} fill="var(--color-faint)" stroke="var(--color-bg)" strokeWidth={0.3 * k} paintOrder="stroke" style={{ pointerEvents: 'none' }}>{p.id}</text>
            )}
          </g>
        )
      })}

      {calibPts && calibPts.length > 0 && (
        <g style={{ pointerEvents: 'none' }}>
          {calibPts.length === 2 && <line x1={calibPts[0].x} y1={calibPts[0].y} x2={calibPts[1].x} y2={calibPts[1].y} stroke="var(--color-accent)" strokeWidth={0.5 * k} strokeDasharray={`${1.2 * k} ${0.8 * k}`} />}
          {calibPts.map((q, i) => (
            <g key={i}>
              <circle cx={q.x} cy={q.y} r={1.2 * k} fill="var(--color-accent)" stroke="var(--color-bg)" strokeWidth={0.3 * k} />
              <text x={q.x + 1.8 * k} y={q.y - 1.4 * k} fontSize={2 * k} fill="var(--color-accent)">{i + 1}</text>
            </g>
          ))}
        </g>
      )}

      {ghosts?.map((gh) => (
        <g key={gh.id} style={{ pointerEvents: 'none' }}>
          <circle cx={gh.x} cy={gh.y} r={1.9 * k} fill="none" stroke="var(--color-accent)" strokeWidth={0.4 * k} strokeDasharray={`${0.9 * k} ${0.7 * k}`} />
          <text x={gh.x} y={gh.y - 2.6 * k} textAnchor="middle" fontSize={1.4 * k} fill="var(--color-accent)">{gh.id}</text>
        </g>
      ))}

      {fleets.flat().map((v) => {
        // Tuyến đang thực hiện (AMR báo các điểm còn phải qua): nét đứt mảnh từ xe tới đích.
        const stops = (v.route ?? []).map((id) => map.points.find((p) => p.id === id)).filter((p): p is NonNullable<typeof p> => p !== undefined)
        return stops.length === 0 ? null : (
          <path key={`route-${v.id}`} d={polylineD([{ x: v.x, y: v.y }, ...stops.map((p) => ({ x: p.x, y: p.y }))])} fill="none" stroke="var(--color-accent)" strokeOpacity={0.55}
            strokeWidth={0.35 * k} strokeDasharray={`${1 * k} ${0.8 * k}`} strokeLinejoin="round" style={{ pointerEvents: 'none' }} />
        )
      })}

      {fleets.flat().map((v) => (
        <g key={v.id} style={{ transform: `translate(${v.x}px, ${v.y}px)`, transition: 'transform 0.45s linear', pointerEvents: 'none' }}>
          <circle r={1.6 * k} fill={VEHICLE_COLOR[v.state] ?? 'var(--color-muted)'} stroke={v.off_map ? 'var(--color-bad)' : 'var(--color-bg)'} strokeWidth={(v.off_map ? 0.6 : 0.4) * k} strokeDasharray={v.off_map ? `${0.8 * k} ${0.6 * k}` : undefined} />
          {v.heading !== undefined && (
            <path d={`M${2.9 * k},0 L${1.5 * k},${-0.9 * k} L${1.5 * k},${0.9 * k} z`} fill="var(--color-text)" transform={`rotate(${v.heading})`} />
          )}
          {v.load > 0 && <circle r={2.5 * k} fill="none" stroke="var(--color-text)" strokeWidth={0.35 * k} strokeDasharray={`${1 * k} ${0.8 * k}`} />}
          <text x={2.9 * k} y={0.5 * k} textAnchor="start" fontSize={1.5 * k} fill="var(--color-text-2)" stroke="var(--color-bg)" strokeWidth={0.45 * k} paintOrder="stroke">{v.id}{v.battery !== undefined ? ` · ${Math.round(v.battery)}%` : ''}{v.off_map ? ' · ngoài đường' : ''}</text>
        </g>
      ))}
      {editing && bgEdit && map.bg && (
        <BgFrame bg={map.bg} k={k}
          onMove={(e) => { e.stopPropagation(); (e.currentTarget as Element).setPointerCapture?.(e.pointerId); setDrag({ kind: 'bgmove', bg0: map.bg!, start: toMapExact(e) }) }}
          onScale={(e, corner) => { e.stopPropagation(); (e.currentTarget as Element).setPointerCapture?.(e.pointerId); setDrag({ kind: 'bgscale', bg0: map.bg!, corner }) }}
          onRotate={(e) => { e.stopPropagation(); (e.currentTarget as Element).setPointerCapture?.(e.pointerId); setDrag({ kind: 'bgrot', bg0: map.bg!, a0: angleAt(map.bg!, toMapExact(e)) }) }}
        />
      )}
    </svg>
  )
})

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

/** Tay cầm đỉnh của vùng cấm đang chọn: chấm để kéo (bấm đúp để xoá đỉnh) và dấu "+" giữa mỗi cạnh để thêm đỉnh. */
function ZoneHandles({ zone, k, onDrag, onInsert, onRemove }: {
  zone: { id: string; poly: Pt[] }; k: number; onDrag: (index: number) => void
  onInsert?: (zoneId: string, index: number, at: Pt) => void; onRemove?: (zoneId: string, index: number) => void
}) {
  const poly = zone.poly
  return (
    <g>
      {poly.map((p, i) => {
        const q = poly[(i + 1) % poly.length]
        const at = { x: Math.round(((p.x + q.x) / 2) * 10) / 10, y: Math.round(((p.y + q.y) / 2) * 10) / 10 }
        return (
          <g key={`add${i}`} className="cursor-copy" onClick={(e) => { e.stopPropagation(); onInsert?.(zone.id, i, at) }}>
            <circle cx={at.x} cy={at.y} r={1.1 * k} fill="var(--color-panel)" stroke="var(--color-bad)" strokeWidth={0.35 * k} />
            <path d={`M${at.x - 0.5 * k},${at.y} H${at.x + 0.5 * k} M${at.x},${at.y - 0.5 * k} V${at.y + 0.5 * k}`} stroke="var(--color-bad)" strokeWidth={0.35 * k} style={{ pointerEvents: 'none' }} />
          </g>
        )
      })}
      {poly.map((p, i) => (
        <circle
          key={`zv${i}`} cx={p.x} cy={p.y} r={1.2 * k} fill="var(--color-bad)" stroke="var(--color-bg)" strokeWidth={0.3 * k} className="cursor-grab"
          onPointerDown={(e) => { e.stopPropagation(); (e.currentTarget as SVGCircleElement).setPointerCapture?.(e.pointerId); onDrag(i) }}
          onClick={(e) => e.stopPropagation()}
          onDoubleClick={(e) => { e.stopPropagation(); onRemove?.(zone.id, i) }}
        >
          <title>Kéo để dời, bấm đúp để xoá đỉnh</title>
        </circle>
      ))}
    </g>
  )
}

/**
 * Khung chỉnh ảnh nền: kéo bên trong để dời, kéo một góc để đổi cỡ (giữ tỉ lệ, quanh tâm), kéo núm tròn phía trên để xoay
 * (giữ Shift để bắt theo bước 15°).
 */
function BgFrame({ bg, k, onMove, onScale, onRotate }: {
  bg: MapBG; k: number
  onMove: (e: React.PointerEvent) => void
  onScale: (e: React.PointerEvent, corner: Pt) => void
  onRotate: (e: React.PointerEvent) => void
}) {
  const c = bgCorners(bg)
  const center = bgCenter(bg)
  const top = { x: (c[0].x + c[1].x) / 2, y: (c[0].y + c[1].y) / 2 }
  const len = Math.hypot(top.x - center.x, top.y - center.y) || 1
  const knob = { x: top.x + ((top.x - center.x) / len) * 5 * k, y: top.y + ((top.y - center.y) / len) * 5 * k }
  const h = 1.4 * k
  return (
    <g>
      <polygon points={c.map((p) => `${p.x},${p.y}`).join(' ')} fill="var(--color-accent)" fillOpacity={0.06} stroke="var(--color-accent)"
        strokeWidth={0.35 * k} strokeDasharray={`${1.2 * k} ${0.8 * k}`} className="cursor-move" onPointerDown={onMove} />
      <line x1={top.x} y1={top.y} x2={knob.x} y2={knob.y} stroke="var(--color-accent)" strokeWidth={0.3 * k} style={{ pointerEvents: 'none' }} />
      <circle cx={knob.x} cy={knob.y} r={1.1 * k} fill="var(--color-bg)" stroke="var(--color-accent)" strokeWidth={0.4 * k} className="cursor-grab" onPointerDown={onRotate}>
        <title>Kéo để xoay ảnh (giữ Shift: bước 15°)</title>
      </circle>
      {c.map((p, i) => (
        <rect key={i} x={p.x - h / 2} y={p.y - h / 2} width={h} height={h} fill="var(--color-bg)" stroke="var(--color-accent)" strokeWidth={0.4 * k}
          transform={bg.rot ? `rotate(${bg.rot} ${p.x} ${p.y})` : undefined} className={i % 2 === 0 ? 'cursor-nwse-resize' : 'cursor-nesw-resize'}
          onPointerDown={(e) => onScale(e, p)}>
          <title>Kéo để đổi cỡ ảnh</title>
        </rect>
      ))}
    </g>
  )
}

import type { AgvMap, MapLane, Pt } from '../api/types'
import { addLane, lanePolyline, nextId, polylineLength, projectOnPolyline } from './mapGeom'
import { roadOf, roadsOf } from './roads'
import { segmentEntersPolygon } from './zones'

/** Trạm đặt cách đầu đường trong khoảng này thì nối thẳng vào đầu đường, không cắt đường. */
export const JOIN_M = 1.5
/** Trạm cách đường gần nhất hơn khoảng này thì không tự nối (nhiều khả năng đặt nhầm chỗ). */
export const MAX_SNAP_M = 25

const reversed = (p: Pt[]): Pt[] => [...p].reverse()
const EPS = 1e-6

/** Điểm cách điểm đầu `s` mét dọc đường gấp khúc. */
function pointAt(poly: Pt[], s: number): Pt {
  let run = 0
  for (let i = 1; i < poly.length; i++) {
    const seg = Math.hypot(poly[i].x - poly[i - 1].x, poly[i].y - poly[i - 1].y)
    if (s <= run + seg && seg > 0) {
      const t = (s - run) / seg
      return { x: poly[i - 1].x + (poly[i].x - poly[i - 1].x) * t, y: poly[i - 1].y + (poly[i].y - poly[i - 1].y) * t }
    }
    run += seg
  }
  return poly[poly.length - 1]
}

export type Snap = { laneId: string; s: number; dist: number; at: Pt }

/** Chỗ gần nhất trên mọi đường (tính theo làn chính của mỗi đường): làn, mét dọc làn, khoảng cách và toạ độ chỗ đó. */
export function nearestOnRoads(m: AgvMap, p: Pt): Snap | null {
  let best: Snap | null = null
  for (const r of roadsOf(m)) {
    const poly = lanePolyline(m, r.a)
    if (!poly) continue
    const { s, dist } = projectOnPolyline(poly, p.x, p.y)
    if (best === null || dist < best.dist) best = { laneId: r.a.id, s, dist, at: pointAt(poly, s) }
  }
  return best
}

/**
 * Cắt đường chứa `laneId` tại `s` mét dọc làn đó, chèn một ngã ba mới ở chỗ cắt. Cả hai chiều (nếu có) cùng bị cắt, điểm uốn chia về đúng phía;
 * làn gốc giữ id cho nửa đầu, nửa sau lấy id mới.
 */
export function splitRoadAt(m: AgvMap, laneId: string, s: number): { map: AgvMap; pointId: string } {
  const r = roadOf(m, laneId)
  const poly = r && lanePolyline(m, r.a)
  if (!r || !poly) return { map: m, pointId: '' }
  const total = polylineLength(poly)
  const cut = Math.min(Math.max(s, 0), total)
  const arcs: number[] = [0]
  for (let i = 1; i < poly.length; i++) arcs.push(arcs[i - 1] + Math.hypot(poly[i].x - poly[i - 1].x, poly[i].y - poly[i - 1].y))
  const before: Pt[] = []
  const after: Pt[] = []
  for (let i = 1; i < poly.length - 1; i++) {
    if (arcs[i] < cut - EPS) before.push(poly[i])
    else if (arcs[i] > cut + EPS) after.push(poly[i])
  }
  const at = pointAt(poly, cut)
  const pointId = nextId('J', m.points.map((p) => p.id))
  const usedLanes = m.lanes.map((l) => l.id)
  const fresh = () => { const id = nextId('L', usedLanes); usedLanes.push(id); return id }
  const withPath = (l: MapLane, path: Pt[]): MapLane => {
    const { path: _drop, ...rest } = l
    return path.length > 0 ? { ...rest, path } : rest
  }
  const first = (l: MapLane, path: Pt[]) => withPath({ ...l, to: pointId }, path)
  const second = (to: string, capacity: number, path: Pt[]) => withPath({ id: fresh(), from: pointId, to, capacity }, path)
  const lanes = m.lanes.map((l) => (l.id === r.a.id ? first(l, before) : r.b && l.id === r.b.id ? first(l, reversed(after)) : l))
  lanes.push(second(r.a.to, r.a.capacity, after))
  if (r.b) lanes.push(second(r.a.from, r.b.capacity, reversed(before)))
  return {
    map: { ...m, points: [...m.points, { id: pointId, x: at.x, y: at.y, kind: 'junction' }], lanes },
    pointId,
  }
}

export type Placed = { map: AgvMap; pointId: string; connected: 'point' | 'split' | 'none'; reason?: string }

/**
 * Nối điểm `id` (đã có trong bản đồ, chưa có đường) vào đường gần nhất bằng đường hai chiều: sát đầu đường thì nối vào đầu đó, không thì cắt đường
 * tại hình chiếu. Không nối (điểm vẫn ở nguyên chỗ) khi chưa có đường, đường quá xa, hoặc đường nối bị vùng cấm chắn.
 */
function attach(placed: AgvMap, id: string, opts: { maxSnapM?: number; joinM?: number }): Placed {
  const maxSnap = opts.maxSnapM ?? MAX_SNAP_M
  const join = opts.joinM ?? JOIN_M
  const me = placed.points.find((p) => p.id === id)!
  const at: Pt = { x: me.x, y: me.y }
  const stop = (reason: string): Placed => ({ map: placed, pointId: id, connected: 'none', reason })

  const snap = nearestOnRoads(placed, at)
  if (!snap) return stop('bản đồ chưa có đường để nối vào')
  if (snap.dist > maxSnap) {
    return stop(`điểm cách đường gần nhất ${Math.round(snap.dist)} m (xa hơn ${maxSnap} m) nên chưa nối; kéo lại gần đường hoặc vẽ đường tới đó`)
  }
  const road = roadOf(placed, snap.laneId)!
  const length = polylineLength(lanePolyline(placed, road.a)!)
  let end: string | null = null
  let target = snap.at
  if (snap.s <= join) end = road.a.from
  else if (length - snap.s <= join) end = road.a.to
  if (end !== null) {
    const p = placed.points.find((q) => q.id === end)!
    target = { x: p.x, y: p.y }
  }
  const blocker = (placed.keepouts ?? []).find((k) => segmentEntersPolygon(at, target, k.poly))
  if (blocker) return stop(`đường nối tới đường gần nhất bị vùng cấm ${blocker.id} chắn; đặt ở phía bên kia hoặc vẽ đường nối tay`)

  if (end !== null) return { map: addLane(placed, id, end, true), pointId: id, connected: 'point' }
  const cut = splitRoadAt(placed, snap.laneId, snap.s)
  return { map: addLane(cut.map, id, cut.pointId, true), pointId: id, connected: 'split' }
}

/**
 * Đặt node của sơ đồ lên bản đồ thành một trạm tại `at`. Một node đặt nhiều lần cho nhiều trạm (nhiều chỗ đỗ).
 * `connect` (mặc định true): nối trạm vào đường gần nhất (xem `attach`). Đặt false cho node không cần xe tới (máy nhận hàng qua băng chuyền,
 * máy đứng riêng...): trạm chỉ đánh dấu vị trí, không thêm đường và không cắt đường nào.
 */
export function placeNode(m: AgvMap, nodeKey: string, at: Pt, opts: { maxSnapM?: number; joinM?: number; connect?: boolean } = {}): Placed {
  const id = nextId('S', m.points.map((p) => p.id))
  const placed: AgvMap = { ...m, points: [...m.points, { id, x: at.x, y: at.y, kind: 'station', node_key: nodeKey }] }
  if (opts.connect === false) return { map: placed, pointId: id, connected: 'none' }
  return attach(placed, id, opts)
}

/** Đặt chỗ sạc cho AMR tại `at` rồi nối vào đường gần nhất. */
export function placeCharger(m: AgvMap, at: Pt, opts: { maxSnapM?: number; joinM?: number } = {}): Placed {
  const id = nextId('C', m.points.map((p) => p.id))
  return attach({ ...m, points: [...m.points, { id, x: at.x, y: at.y, kind: 'charger' }] }, id, opts)
}

import type { AgvMap, MapLane, Pt } from '../api/types'
import { insertWaypoint, laneTone, moveWaypoint, nextId, removeLane, removeWaypoint, setLaneCapacity, type LaneTone, type Occupancy } from './mapGeom'

/**
 * Đường = một làn, hoặc hai làn ngược chiều giữa cùng hai điểm. Mô hình lưu vẫn là các làn có hướng (sim và feed không đổi);
 * editor gộp cặp làn thành một đối tượng để sửa một lần, và coi mọi đường là hai chiều trừ khi người dùng bật "một chiều".
 */
export type Road = { id: string; a: MapLane; b?: MapLane }

/** Ghép một-một: mỗi làn chỉ ghép với một làn ngược chiều chưa có cặp (theo thứ tự trong bản đồ). Trả về hai chiều tra cứu. */
export function pairLanes(m: AgvMap): Map<string, string> {
  const pairs = new Map<string, string>()
  for (const l of m.lanes) {
    if (pairs.has(l.id)) continue
    const twin = m.lanes.find((o) => o.id !== l.id && !pairs.has(o.id) && o.from === l.to && o.to === l.from)
    if (twin) { pairs.set(l.id, twin.id); pairs.set(twin.id, l.id) }
  }
  return pairs
}

export function roadsOf(m: AgvMap): Road[] {
  const pairs = pairLanes(m)
  const byId = new Map(m.lanes.map((l) => [l.id, l]))
  const seen = new Set<string>()
  const out: Road[] = []
  for (const l of m.lanes) {
    if (seen.has(l.id)) continue
    seen.add(l.id)
    const twin = pairs.has(l.id) ? byId.get(pairs.get(l.id)!) : undefined
    if (twin) seen.add(twin.id)
    out.push({ id: l.id, a: l, b: twin })
  }
  return out
}

/** Đường chứa làn `laneId` (làn nào của cặp cũng được). */
export function roadOf(m: AgvMap, laneId: string): Road | undefined {
  return roadsOf(m).find((r) => r.a.id === laneId || r.b?.id === laneId)
}

export const isOneWay = (r: Road): boolean => r.b === undefined

const reversed = (path: Pt[] | undefined): Pt[] => [...(path ?? [])].reverse()

/** Đặt hoặc bỏ trường path của một làn (path rỗng thì bỏ hẳn trường, như các hàm điểm uốn của mapGeom). */
function withLanePath(l: MapLane, path: Pt[]): MapLane {
  const { path: _drop, ...rest } = l
  return path.length > 0 ? { ...rest, path } : rest
}

/** Chạy `f` trên làn được gọi (chỉ số điểm uốn tính theo làn đó) rồi cho làn ngược chiều của nó (nếu có) có điểm uốn đối xứng. */
function onRoad(m: AgvMap, laneId: string, f: (m: AgvMap, id: string) => AgvMap): AgvMap {
  const r = roadOf(m, laneId)
  if (!r) return m
  const next = f(m, laneId)
  const twinId = laneId === r.a.id ? r.b?.id : r.a.id
  if (!twinId) return next
  const edited = next.lanes.find((l) => l.id === laneId)!
  return { ...next, lanes: next.lanes.map((l) => (l.id === twinId ? withLanePath(l, reversed(edited.path)) : l)) }
}

export const roadInsertWaypoint = (m: AgvMap, laneId: string, index: number, at: Pt): AgvMap =>
  onRoad(m, laneId, (x, id) => insertWaypoint(x, id, index, at))

export const roadMoveWaypoint = (m: AgvMap, laneId: string, index: number, px: number, py: number): AgvMap =>
  onRoad(m, laneId, (x, id) => moveWaypoint(x, id, index, px, py))

export const roadRemoveWaypoint = (m: AgvMap, laneId: string, index: number): AgvMap =>
  onRoad(m, laneId, (x, id) => removeWaypoint(x, id, index))

/** Bỏ mọi điểm uốn: đường thành đoạn thẳng giữa hai điểm. */
export function straightenRoad(m: AgvMap, laneId: string): AgvMap {
  const r = roadOf(m, laneId)
  if (!r) return m
  const ids = new Set([r.a.id, r.b?.id])
  return { ...m, lanes: m.lanes.map((l) => (ids.has(l.id) ? withLanePath(l, []) : l)) }
}

export function setRoadCapacity(m: AgvMap, laneId: string, capacity: number): AgvMap {
  const r = roadOf(m, laneId)
  if (!r) return m
  return [r.a.id, r.b?.id].reduce<AgvMap>((acc, id) => (id ? setLaneCapacity(acc, id, capacity) : acc), m)
}

export function removeRoad(m: AgvMap, laneId: string): AgvMap {
  const r = roadOf(m, laneId)
  if (!r) return m
  return [r.a.id, r.b?.id].reduce<AgvMap>((acc, id) => (id ? removeLane(acc, id) : acc), m)
}

/**
 * Bật một chiều: giữ làn `laneId`, bỏ làn ngược. Tắt một chiều: thêm làn ngược cùng sức chứa, điểm uốn đảo lại.
 * Đã đúng trạng thái yêu cầu thì trả nguyên bản đồ.
 */
export function setOneWay(m: AgvMap, laneId: string, oneWay: boolean): AgvMap {
  const r = roadOf(m, laneId)
  if (!r || isOneWay(r) === oneWay) return m
  if (oneWay) {
    return removeLane(m, laneId === r.a.id ? r.b!.id : r.a.id)
  }
  const twin: MapLane = {
    id: nextId('L', m.lanes.map((l) => l.id)), from: r.a.to, to: r.a.from, capacity: r.a.capacity,
    ...(r.a.path && r.a.path.length > 0 ? { path: reversed(r.a.path) } : {}),
  }
  return { ...m, lanes: [...m.lanes, twin] }
}

/** Đổi chiều đường một chiều (đảo đầu, cuối và điểm uốn). Đường hai chiều không có chiều để đổi nên giữ nguyên. */
export function reverseRoad(m: AgvMap, laneId: string): AgvMap {
  const r = roadOf(m, laneId)
  if (!r || !isOneWay(r)) return m
  return {
    ...m,
    lanes: m.lanes.map((l) => (l.id === r.a.id ? withLanePath({ ...l, from: l.to, to: l.from }, reversed(l.path)) : l)),
  }
}

const RANK: Record<LaneTone, number> = { ok: 0, busy: 1, jam: 2 }

/** Trạng thái tắc của đường = tệ nhất trong hai chiều. */
export function roadTone(r: Road, occ: Map<string, Occupancy>): LaneTone {
  let worst: LaneTone = 'ok'
  for (const l of [r.a, r.b]) {
    const o = l && occ.get(l.id)
    if (!o) continue
    const t = laneTone(o)
    if (RANK[t] > RANK[worst]) worst = t
  }
  return worst
}

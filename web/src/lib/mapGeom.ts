import type { AgvMap, MapLane, MapPoint, Pt, Vehicle } from '../api/types'
import { bgRect } from './mapImage'

export type Rect = { x: number; y: number; w: number; h: number }

/** Khung bao mọi điểm, điểm uốn, vùng cấm và ảnh nền cộng lề; bản đồ rỗng vẫn cho khung dùng được. */
export function bounds(m: AgvMap, pad: number): Rect {
  const pts: Pt[] = [...m.points, ...m.lanes.flatMap((l) => l.path ?? []), ...(m.keepouts ?? []).flatMap((k) => k.poly)]
  if (m.bg) {
    const r = bgRect(m.bg)
    pts.push({ x: r.x, y: r.y }, { x: r.x + r.w, y: r.y + r.h })
  }
  if (pts.length === 0) return { x: -pad, y: -pad, w: 100 + 2 * pad, h: 60 + 2 * pad }
  const xs = pts.map((p) => p.x)
  const ys = pts.map((p) => p.y)
  const x = Math.min(...xs) - pad
  const y = Math.min(...ys) - pad
  return { x, y, w: Math.max(...xs) + pad - x, h: Math.max(...ys) + pad - y }
}

/**
 * Đơn vị cỡ của chữ và ký hiệu (trạm, ngã tư, xe, núm kéo) theo mét, tính từ phần đã vẽ (điểm, đường, vùng cấm) chứ không từ ảnh nền:
 * phóng to, thu nhỏ hay dời ảnh không làm node to nhỏ theo. Chỉ khi chưa vẽ gì mới lấy theo ảnh nền.
 */
export function markScale(m: AgvMap): number {
  const drawn = m.points.length > 0 || m.lanes.length > 0 || (m.keepouts ?? []).length > 0
  const r = bounds(drawn ? { ...m, bg: undefined } : m, 0)
  return Math.max(r.w, r.h * 1.5, 40) / 85
}

/** Đường đi của làn: điểm đầu, các điểm uốn, điểm cuối (mét); undefined nếu làn nối tới điểm không có. */
export function lanePolyline(m: AgvMap, lane: MapLane): Pt[] | undefined {
  const a = m.points.find((p) => p.id === lane.from)
  const b = m.points.find((p) => p.id === lane.to)
  if (!a || !b) return undefined
  return [{ x: a.x, y: a.y }, ...(lane.path ?? []), { x: b.x, y: b.y }]
}

export function polylineLength(p: Pt[]): number {
  let n = 0
  for (let i = 1; i < p.length; i++) n += Math.hypot(p[i].x - p[i - 1].x, p[i].y - p[i - 1].y)
  return n
}

export function laneLengthM(m: AgvMap, lane: MapLane): number {
  const p = lanePolyline(m, lane)
  return p ? polylineLength(p) : 0
}

const round = (n: number) => Math.round(n * 1e6) / 1e6

/** Path SVG của đường gấp khúc ("M0 0L10 0L10 10"). */
export function polylineD(p: Pt[]): string {
  return p.map((q, i) => `${i === 0 ? 'M' : 'L'}${round(q.x)} ${round(q.y)}`).join('')
}

/** Điểm nằm giữa đường theo độ dài (để đặt nhãn); đường rỗng trả gốc toạ độ. */
export function midpointOf(p: Pt[]): Pt {
  if (p.length === 0) return { x: 0, y: 0 }
  let half = polylineLength(p) / 2
  for (let i = 1; i < p.length; i++) {
    const seg = Math.hypot(p[i].x - p[i - 1].x, p[i].y - p[i - 1].y)
    if (half <= seg && seg > 0) {
      const t = half / seg
      return { x: p[i - 1].x + (p[i].x - p[i - 1].x) * t, y: p[i - 1].y + (p[i].y - p[i - 1].y) * t }
    }
    half -= seg
  }
  return p[p.length - 1]
}

/** Chiếu (x, y) lên đường gấp khúc: s là mét dọc đường từ điểm đầu, dist là khoảng cách tới đường. */
export function projectOnPolyline(p: Pt[], x: number, y: number): { s: number; dist: number } {
  let best = { s: 0, dist: Infinity }
  let run = 0
  for (let i = 1; i < p.length; i++) {
    const dx = p[i].x - p[i - 1].x
    const dy = p[i].y - p[i - 1].y
    const seg = Math.hypot(dx, dy)
    const t = seg > 0 ? Math.max(0, Math.min(1, ((x - p[i - 1].x) * dx + (y - p[i - 1].y) * dy) / (seg * seg))) : 0
    const d = Math.hypot(x - (p[i - 1].x + t * dx), y - (p[i - 1].y + t * dy))
    if (d < best.dist) best = { s: run + t * seg, dist: d }
    run += seg
  }
  if (p.length === 1) return { s: 0, dist: Math.hypot(x - p[0].x, y - p[0].y) }
  return best
}

const MITER_LIMIT = 3

/**
 * Đường song song với `p` cách `offset` mét về bên phải hướng đi (y hướng xuống): hai làn ngược chiều giữa cùng hai điểm
 * nằm hai bên nhau thay vì chồng lên. Ở khúc cua dùng góc nhọn (miter) để khoảng cách đều, có giới hạn để cua gấp không văng xa.
 */
export function offsetPolyline(p: Pt[], offset: number): Pt[] {
  const normals: Pt[] = []
  for (let i = 1; i < p.length; i++) {
    const dx = p[i].x - p[i - 1].x
    const dy = p[i].y - p[i - 1].y
    const len = Math.hypot(dx, dy)
    normals.push(len === 0 ? { x: 0, y: 0 } : { x: -dy / len, y: dx / len })
  }
  return p.map((q, i) => {
    const a = normals[i - 1]
    const b = normals[i]
    let nx: number, ny: number
    if (!a) { nx = b?.x ?? 0; ny = b?.y ?? 0 }
    else if (!b) { nx = a.x; ny = a.y }
    else {
      const k = Math.max(1 + a.x * b.x + a.y * b.y, 1 / MITER_LIMIT)
      nx = (a.x + b.x) / k
      ny = (a.y + b.y) / k
    }
    return { x: q.x + nx * offset, y: q.y + ny * offset }
  })
}

export type LaneShape = { pts: Pt[]; length: number }

/**
 * Hình vẽ của một làn: đường gấp khúc dịch ngang `offset` mét sang phải hướng đi, hai đầu rút vào `inset` mét để mũi tên không đè lên
 * hình điểm. `length` là độ dài thật của làn (chưa dịch, chưa rút).
 */
export function laneShape(m: AgvMap, lane: MapLane, offset: number, inset = 0): LaneShape | undefined {
  const base = lanePolyline(m, lane)
  if (!base) return undefined
  const length = polylineLength(base)
  let pts = offset === 0 ? base : offsetPolyline(base, offset)
  if (inset > 0 && length > 2 * inset) pts = trimEnds(pts, inset)
  return { pts, length }
}

function trimEnds(p: Pt[], inset: number): Pt[] {
  const out = [...p]
  const pull = (from: number, toward: number) => {
    const dx = out[toward].x - out[from].x
    const dy = out[toward].y - out[from].y
    const len = Math.hypot(dx, dy)
    if (len > inset) out[from] = { x: out[from].x + (dx / len) * inset, y: out[from].y + (dy / len) * inset }
  }
  pull(0, 1)
  pull(out.length - 1, out.length - 2)
  return out
}

export type Occupancy = { holding: number; waiting: number; capacity: number }

/** Số xe đang giữ mỗi làn (đang chạy hoặc đang chờ ở cuối làn) và số xe đang chờ vào làn kế. */
export function occupancy(m: AgvMap, fleets: Vehicle[][]): Map<string, Occupancy> {
  const out = new Map<string, Occupancy>(m.lanes.map((l) => [l.id, { holding: 0, waiting: 0, capacity: l.capacity }]))
  for (const v of fleets.flat()) {
    const o = out.get(v.lane)
    if (!o || (v.state !== 'MOVING' && v.state !== 'WAITING')) continue
    o.holding++
    if (v.state === 'WAITING') o.waiting++
  }
  return out
}

export type LaneTone = 'ok' | 'busy' | 'jam'

export function laneTone(o: Occupancy): LaneTone {
  if (o.waiting > 0) return 'jam'
  return o.holding >= o.capacity ? 'busy' : 'ok'
}

// --- sửa bản đồ: mọi hàm trả bản sao mới ---------------------------------------------------------

export function nextId(prefix: string, used: string[]): string {
  let n = used.length + 1
  while (used.includes(`${prefix}${String(n).padStart(2, '0')}`)) n++
  return `${prefix}${String(n).padStart(2, '0')}`
}

export function addPoint(m: AgvMap, at: { x: number; y: number }, kind: MapPoint['kind']): AgvMap {
  const id = nextId(kind === 'station' ? 'S' : kind === 'charger' ? 'C' : 'J', m.points.map((p) => p.id))
  return { ...m, points: [...m.points, { id, x: at.x, y: at.y, kind }] }
}

export function addLane(m: AgvMap, from: string, to: string, bothWays: boolean, via: Pt[] = []): AgvMap {
  if (from === to) return m
  const lanes = [...m.lanes]
  const has = (a: string, b: string) => lanes.some((l) => l.from === a && l.to === b)
  const push = (a: string, b: string, path: Pt[]) => {
    if (!has(a, b)) lanes.push({ id: nextId('L', lanes.map((l) => l.id)), from: a, to: b, capacity: 2, ...(path.length > 0 ? { path } : {}) })
  }
  push(from, to, via)
  if (bothWays) push(to, from, [...via].reverse())
  return { ...m, lanes }
}

export function removePoint(m: AgvMap, id: string): AgvMap {
  return { ...m, points: m.points.filter((p) => p.id !== id), lanes: m.lanes.filter((l) => l.from !== id && l.to !== id) }
}

export function removeLane(m: AgvMap, id: string): AgvMap {
  return { ...m, lanes: m.lanes.filter((l) => l.id !== id) }
}

export function setLaneCapacity(m: AgvMap, id: string, capacity: number): AgvMap {
  return { ...m, lanes: m.lanes.map((l) => (l.id === id ? { ...l, capacity: Math.max(1, Math.round(capacity)) } : l)) }
}

export function movePoint(m: AgvMap, id: string, x: number, y: number): AgvMap {
  return { ...m, points: m.points.map((p) => (p.id === id ? { ...p, x, y } : p)) }
}

// --- điểm uốn của làn ---------------------------------------------------------------------------

const withPath = (m: AgvMap, id: string, f: (path: Pt[]) => Pt[]): AgvMap => ({
  ...m,
  lanes: m.lanes.map((l) => {
    if (l.id !== id) return l
    const path = f(l.path ?? [])
    const { path: _drop, ...rest } = l
    return path.length > 0 ? { ...rest, path } : rest
  }),
})

/** Thêm điểm uốn vào làn tại vị trí `index` của danh sách điểm uốn (0 = ngay sau điểm đầu). */
export function insertWaypoint(m: AgvMap, laneId: string, index: number, at: Pt): AgvMap {
  return withPath(m, laneId, (p) => [...p.slice(0, index), at, ...p.slice(index)])
}

export function moveWaypoint(m: AgvMap, laneId: string, index: number, x: number, y: number): AgvMap {
  return withPath(m, laneId, (p) => p.map((q, i) => (i === index ? { x, y } : q)))
}

export function removeWaypoint(m: AgvMap, laneId: string, index: number): AgvMap {
  return withPath(m, laneId, (p) => p.filter((_, i) => i !== index))
}

/** Số xe không nằm trên làn nào (xe ngoài đường) trên tổng số xe đang nhận được. */
export function offMapShare(fleets: Vehicle[][]): { off: number; total: number } {
  const all = fleets.flat()
  return { off: all.filter((v) => v.off_map).length, total: all.length }
}

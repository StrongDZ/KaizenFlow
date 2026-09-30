import type { AgvMap, MapLane, MapPoint, Vehicle } from '../api/types'

export type Rect = { x: number; y: number; w: number; h: number }

/** Khung bao mọi điểm cộng lề; bản đồ rỗng vẫn cho khung dùng được. */
export function bounds(m: AgvMap, pad: number): Rect {
  if (m.points.length === 0) return { x: -pad, y: -pad, w: 100 + 2 * pad, h: 60 + 2 * pad }
  const xs = m.points.map((p) => p.x)
  const ys = m.points.map((p) => p.y)
  const x = Math.min(...xs) - pad
  const y = Math.min(...ys) - pad
  return { x, y, w: Math.max(...xs) + pad - x, h: Math.max(...ys) + pad - y }
}

export type LaneGeom = { x1: number; y1: number; x2: number; y2: number; length: number; angle: number }

/**
 * Toạ độ vẽ của một làn, dịch ngang `offset` đơn vị sang bên phải hướng đi: hai làn ngược chiều giữa cùng hai điểm
 * sẽ nằm hai bên nhau thay vì chồng lên. `inset` rút ngắn hai đầu để mũi tên không đè lên hình điểm.
 */
export function laneGeometry(m: AgvMap, lane: MapLane, offset: number, inset = 0): LaneGeom | undefined {
  const a = m.points.find((p) => p.id === lane.from)
  const b = m.points.find((p) => p.id === lane.to)
  if (!a || !b) return undefined
  const dx = b.x - a.x
  const dy = b.y - a.y
  const length = Math.hypot(dx, dy)
  if (length === 0) return { x1: a.x, y1: a.y, x2: b.x, y2: b.y, length: 0, angle: 0 }
  const ux = dx / length
  const uy = dy / length
  const nx = -uy
  const ny = ux
  return {
    x1: a.x + nx * offset + ux * inset, y1: a.y + ny * offset + uy * inset,
    x2: b.x + nx * offset - ux * inset, y2: b.y + ny * offset - uy * inset,
    length, angle: (Math.atan2(dy, dx) * 180) / Math.PI,
  }
}

export function laneLengthM(m: AgvMap, lane: MapLane): number {
  const g = laneGeometry(m, lane, 0)
  return g ? g.length * (m.unit_m > 0 ? m.unit_m : 1) : 0
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

function nextId(prefix: string, used: string[]): string {
  let n = used.length + 1
  while (used.includes(`${prefix}${String(n).padStart(2, '0')}`)) n++
  return `${prefix}${String(n).padStart(2, '0')}`
}

export function addPoint(m: AgvMap, at: { x: number; y: number }, kind: MapPoint['kind']): AgvMap {
  const id = nextId(kind === 'station' ? 'S' : kind === 'charger' ? 'C' : 'J', m.points.map((p) => p.id))
  return { ...m, points: [...m.points, { id, x: at.x, y: at.y, kind }] }
}

export function addLane(m: AgvMap, from: string, to: string, bothWays: boolean): AgvMap {
  if (from === to) return m
  const lanes = [...m.lanes]
  const has = (a: string, b: string) => lanes.some((l) => l.from === a && l.to === b)
  const push = (a: string, b: string) => {
    if (!has(a, b)) lanes.push({ id: nextId('L', lanes.map((l) => l.id)), from: a, to: b, capacity: 2 })
  }
  push(from, to)
  if (bothWays) push(to, from)
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

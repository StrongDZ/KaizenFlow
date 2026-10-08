import type { AgvMap, MapKeepout, Pt } from '../api/types'
import { lanePolyline, nextId } from './mapGeom'

const EPS = 1e-9
const cross = (ax: number, ay: number, bx: number, by: number) => ax * by - ay * bx

function onSegment(p: Pt, a: Pt, b: Pt): boolean {
  const ab = Math.hypot(b.x - a.x, b.y - a.y)
  if (ab === 0) return Math.hypot(p.x - a.x, p.y - a.y) <= 1e-9
  if (Math.abs(cross(b.x - a.x, b.y - a.y, p.x - a.x, p.y - a.y)) / ab > 1e-9) return false
  const d = ((p.x - a.x) * (b.x - a.x) + (p.y - a.y) * (b.y - a.y)) / (ab * ab)
  return d >= -EPS && d <= 1 + EPS
}

/** Điểm nằm hẳn bên trong đa giác: trên cạnh hay đỉnh tính là ở ngoài (trạm đặt sát mép vùng cấm vẫn hợp lệ). Cùng luật với server. */
export function pointInPolygon(p: Pt, poly: Pt[]): boolean {
  const n = poly.length
  for (let i = 0; i < n; i++) if (onSegment(p, poly[i], poly[(i + 1) % n])) return false
  let inside = false
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const a = poly[i]
    const b = poly[j]
    if ((a.y > p.y) !== (b.y > p.y) && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside
  }
  return inside
}

/**
 * Đoạn ab có khúc nào nằm hẳn trong đa giác. Chạm mép, đi dọc mép hay sượt qua đỉnh thì không tính.
 * Chia đoạn ở mọi chỗ cắt cạnh rồi thử điểm giữa từng khúc.
 */
export function segmentEntersPolygon(a: Pt, b: Pt, poly: Pt[]): boolean {
  if (a.x === b.x && a.y === b.y) return pointInPolygon(a, poly)
  const rx = b.x - a.x
  const ry = b.y - a.y
  const ts = [0, 1]
  const n = poly.length
  for (let i = 0; i < n; i++) {
    const p = poly[i]
    const q = poly[(i + 1) % n]
    const sx = q.x - p.x
    const sy = q.y - p.y
    const denom = cross(rx, ry, sx, sy)
    if (Math.abs(denom) > EPS) {
      const t = cross(p.x - a.x, p.y - a.y, sx, sy) / denom
      const u = cross(p.x - a.x, p.y - a.y, rx, ry) / denom
      if (t >= 0 && t <= 1 && u >= 0 && u <= 1) ts.push(t)
    } else if (Math.abs(cross(p.x - a.x, p.y - a.y, rx, ry)) <= EPS) {
      const rr = rx * rx + ry * ry
      for (const e of [p, q]) {
        const t = ((e.x - a.x) * rx + (e.y - a.y) * ry) / rr
        if (t > 0 && t < 1) ts.push(t)
      }
    }
  }
  ts.sort((x, y) => x - y)
  for (let i = 1; i < ts.length; i++) {
    if (ts[i] - ts[i - 1] <= EPS) continue
    const mid = (ts[i] + ts[i - 1]) / 2
    if (pointInPolygon({ x: a.x + rx * mid, y: a.y + ry * mid }, poly)) return true
  }
  return false
}

/** Diện tích có dấu (công thức dây giày): dương khi các đỉnh đi theo chiều kim đồng hồ trên màn hình (y hướng xuống). */
export function polygonArea(poly: Pt[]): number {
  let s = 0
  for (let i = 0; i < poly.length; i++) {
    const j = (i + 1) % poly.length
    s += poly[i].x * poly[j].y - poly[j].x * poly[i].y
  }
  return s / 2
}

/** Lỗi của bản đồ. `warn`: chỉ là cảnh báo (không chặn lưu); không có thì là lỗi mà server sẽ từ chối. */
export type MapProblem = { key: string; message: string; warn?: boolean }

/**
 * Lỗi liên quan vùng cấm, cùng luật và cùng lời với server (PUT /agv-map trả 422 cho đúng những lỗi này), để báo ngay khi đang vẽ.
 * Vùng hỏng chỉ báo lỗi của chính nó, không dùng để kiểm điểm và đường.
 */
export function keepoutProblems(m: AgvMap): MapProblem[] {
  const out: MapProblem[] = []
  const ids = new Set<string>()
  const usable: MapKeepout[] = []
  for (const k of m.keepouts ?? []) {
    let bad = false
    if (k.id === '') { out.push({ key: 'keepout', message: 'vùng cấm thiếu id' }); bad = true }
    else if (ids.has(k.id)) { out.push({ key: k.id, message: 'id vùng cấm bị trùng' }); bad = true }
    ids.add(k.id)
    if (bad) continue
    if (k.poly.length < 3) out.push({ key: k.id, message: 'vùng cấm cần ít nhất 3 đỉnh' })
    else if (!k.poly.every((q) => Number.isFinite(q.x) && Number.isFinite(q.y))) out.push({ key: k.id, message: 'đỉnh của vùng cấm có toạ độ không hợp lệ' })
    else if (Math.abs(polygonArea(k.poly)) <= EPS) out.push({ key: k.id, message: 'vùng cấm có diện tích bằng 0 (các đỉnh thẳng hàng)' })
    else usable.push(k)
  }
  for (const k of usable) {
    for (const p of m.points) if (pointInPolygon(p, k.poly)) out.push({ key: p.id, message: `điểm nằm trong vùng cấm ${k.id}` })
    for (const l of m.lanes) {
      const poly = lanePolyline(m, l)
      if (!poly) continue
      for (let i = 1; i < poly.length; i++) {
        if (segmentEntersPolygon(poly[i - 1], poly[i], k.poly)) { out.push({ key: l.id, message: `làn cắt vùng cấm ${k.id}` }); break }
      }
    }
  }
  return out
}

// --- sửa vùng cấm: mọi hàm trả bản sao mới ---------------------------------------------------------

const withKeepouts = (m: AgvMap, list: MapKeepout[]): AgvMap => {
  const { keepouts: _drop, ...rest } = m
  return list.length > 0 ? { ...rest, keepouts: list } : rest
}

export function addKeepout(m: AgvMap, poly: Pt[]): AgvMap {
  if (poly.length < 3) return m
  const list = m.keepouts ?? []
  return withKeepouts(m, [...list, { id: nextId('K', list.map((k) => k.id)), poly: poly.map((q) => ({ ...q })) }])
}

export function removeKeepout(m: AgvMap, id: string): AgvMap {
  const list = m.keepouts ?? []
  return list.some((k) => k.id === id) ? withKeepouts(m, list.filter((k) => k.id !== id)) : m
}

const editPoly = (m: AgvMap, id: string, f: (poly: Pt[]) => Pt[]): AgvMap =>
  withKeepouts(m, (m.keepouts ?? []).map((k) => (k.id === id ? { ...k, poly: f(k.poly) } : k)))

export const moveKeepoutVertex = (m: AgvMap, id: string, index: number, x: number, y: number): AgvMap =>
  editPoly(m, id, (p) => p.map((q, i) => (i === index ? { x, y } : q)))

/** Chèn đỉnh mới vào sau đỉnh `index` (giữa đỉnh đó và đỉnh kế). */
export const insertKeepoutVertex = (m: AgvMap, id: string, index: number, at: Pt): AgvMap =>
  editPoly(m, id, (p) => [...p.slice(0, index + 1), at, ...p.slice(index + 1)])

/** Xoá một đỉnh; vùng chỉ còn 3 đỉnh thì giữ nguyên (muốn bỏ hẳn thì xoá cả vùng). */
export function removeKeepoutVertex(m: AgvMap, id: string, index: number): AgvMap {
  const k = (m.keepouts ?? []).find((z) => z.id === id)
  if (!k || k.poly.length <= 3) return m
  return editPoly(m, id, (p) => p.filter((_, i) => i !== index))
}

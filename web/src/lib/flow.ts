import type { Json } from '../api/types'
import { series, type BandIndex, type Point } from './replay'

/** Số hạt tối đa trên một edge: đủ để thấy độ đậm nhạt, chưa kín đường. */
export const MAX_DOTS = 6

/** Trên màn hình 1 giây ứng với 30 giây di chuyển thật, trong khoảng dễ nhìn: edge tức thời vẫn thấy hạt, edge rất dài không bò. */
const SIM_SECONDS_PER_SCREEN_SECOND = 30
const MIN_CYCLE_S = 1.6
const MAX_CYCLE_S = 4

const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)

export function lotOf(params: Json): number {
  const lot = num(params.lot)
  return lot !== undefined && lot >= 1 ? lot : 1
}

export function travelSeconds(params: Json): number {
  const t = params.travel as Json | undefined
  const s = t && typeof t === 'object' ? (num(t.mean) ?? num(t.value)) : undefined
  return s !== undefined && s > 0 ? s : 0
}

export function cycleSeconds(travelSec: number): number {
  return Math.min(MAX_CYCLE_S, Math.max(MIN_CYCLE_S, travelSec / SIM_SECONDS_PER_SCREEN_SECOND))
}

/** Lưu lượng lấy trung bình trên chừng này khoảng lấy mẫu gần nhất: replay đi 0,12 giây một mốc nên một lô lẻ sẽ nháy tắt ngay nếu chỉ nhìn một mốc. */
export const WINDOW_STEPS = 10

function windowRate(pts: Point[], i: number): number {
  const [a, b] = i === 0 ? [0, Math.min(WINDOW_STEPS, pts.length - 1)] : [Math.max(0, i - WINDOW_STEPS), i]
  const dt = (pts[b].t - pts[a].t) / 1000
  return dt > 0 ? Math.max(0, (pts[b].p50 - pts[a].p50) / dt) : 0
}

/**
 * Đơn vị hàng chuyển qua edge mỗi giây mô phỏng, tại mốc t: chênh lệch bộ đếm `moved` trong WINDOW_STEPS khoảng lấy mẫu
 * kết thúc ở t (mốc đầu tiên chưa có quá khứ nên nhìn về phía trước). Không có chuỗi `moved` (run cũ) thì trả undefined.
 */
export function ratePerSec(idx: BandIndex, key: string, t: number): number | undefined {
  const pts = series(idx, key, 'moved')
  if (pts.length < 2) return undefined
  let i = 0
  while (i + 1 < pts.length && pts[i + 1].t <= t) i++
  return windowRate(pts, i)
}

/**
 * Mẫu số để hạt của các edge so được với nhau: phân vị 95 của mọi lưu lượng khác 0 ở mọi edge, mọi mốc trong run.
 * Không dùng mức lớn nhất, vì một lô lớn đến một lần sẽ làm mọi edge còn lại chỉ còn một hạt.
 */
export function peakRate(idx: BandIndex, keys: string[]): number {
  const moving: number[] = []
  for (const key of keys) {
    const pts = series(idx, key, 'moved')
    if (pts.length < 2) continue
    for (let i = 0; i < pts.length; i++) {
      const r = windowRate(pts, i)
      if (r > 0) moving.push(r)
    }
  }
  if (moving.length === 0) return 0
  moving.sort((x, y) => x - y)
  return moving[Math.min(moving.length - 1, Math.floor(0.95 * moving.length))]
}

/**
 * Số hạt hiển thị trên edge tại mốc t. Có `moved`: tỉ lệ với lưu lượng so với mức bận điển hình của run, tối thiểu 1 hạt
 * khi có hàng chảy. Run cũ không có `moved`: mỗi lô đang trên đường một hạt (theo in_transit).
 */
export function dotCount(idx: BandIndex, key: string, params: Json, t: number, peak: number): number {
  const rate = ratePerSec(idx, key, t)
  if (rate !== undefined) {
    if (rate <= 0 || peak <= 0) return 0
    return Math.min(MAX_DOTS, 1 + Math.round((MAX_DOTS - 1) * (rate / peak)))
  }
  const pts = series(idx, key, 'in_transit')
  let inTransit = 0
  for (const p of pts) {
    if (p.t > t) break
    inTransit = p.p50
  }
  if (inTransit < 0.5) return 0
  return Math.min(MAX_DOTS, Math.ceil(inTransit / lotOf(params)))
}

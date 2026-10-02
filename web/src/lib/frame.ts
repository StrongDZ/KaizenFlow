import type { Binding, BindingInput, Frame, Pt } from '../api/types'

export const IDENTITY_FRAME: Frame = { dx: 0, dy: 0, rot_deg: 0, scale: 1, flip_y: false }

/** Đổi toạ độ hãng xe sang toạ độ bản đồ: lật Y → nhân scale → xoay → dịch. Khớp từng số với Frame.Apply của API (scale 0 = 1). */
export function applyFrame(f: Frame, x: number, y: number): [number, number] {
  if (f.flip_y) y = -y
  const s = f.scale || 1
  x *= s
  y *= s
  const r = (f.rot_deg * Math.PI) / 180
  const c = Math.cos(r)
  const sn = Math.sin(r)
  return [f.dx + c * x - sn * y, f.dy + sn * x + c * y]
}

/** Hướng (độ) trong hệ hãng xe sang hệ bản đồ, chuẩn hoá về [0, 360). */
export function frameHeading(f: Frame, h: number): number {
  if (f.flip_y) h = -h
  return (((h + f.rot_deg) % 360) + 360) % 360
}

export type FramePair = { raw: Pt; map: Pt }

/**
 * Tìm khung từ các cặp (vị trí hãng xe báo → vị trí thật trên bản đồ) bằng phép đồng dạng bình phương tối thiểu.
 * Cần ít nhất hai cặp khác nhau; từ ba cặp, rmsM cho biết các cặp lệch nhau bao nhiêu mét sau khi đổi (hai cặp luôn khớp tuyệt đối).
 * flipY do người dùng chọn (một phép đồng dạng thuần không phân biệt được gương).
 */
export function solveFrame(pairs: FramePair[], flipY: boolean): { frame: Frame; rmsM: number } | null {
  if (pairs.length < 2) return null
  const z = pairs.map((p) => ({ x: p.raw.x, y: flipY ? -p.raw.y : p.raw.y }))
  const w = pairs.map((p) => p.map)
  const n = pairs.length
  const zc = { x: z.reduce((a, p) => a + p.x, 0) / n, y: z.reduce((a, p) => a + p.y, 0) / n }
  const wc = { x: w.reduce((a, p) => a + p.x, 0) / n, y: w.reduce((a, p) => a + p.y, 0) / n }
  let nr = 0
  let ni = 0
  let den = 0
  for (let i = 0; i < n; i++) {
    const zx = z[i].x - zc.x
    const zy = z[i].y - zc.y
    const wx = w[i].x - wc.x
    const wy = w[i].y - wc.y
    nr += zx * wx + zy * wy
    ni += zx * wy - zy * wx
    den += zx * zx + zy * zy
  }
  if (den < 1e-12) return null
  const ar = nr / den
  const ai = ni / den
  const scale = Math.hypot(ar, ai)
  if (scale === 0) return null
  const frame: Frame = {
    dx: wc.x - (ar * zc.x - ai * zc.y),
    dy: wc.y - (ar * zc.y + ai * zc.x),
    rot_deg: (Math.atan2(ai, ar) * 180) / Math.PI,
    scale,
    flip_y: flipY,
  }
  let sq = 0
  for (const p of pairs) {
    const [mx, my] = applyFrame(frame, p.raw.x, p.raw.y)
    sq += (mx - p.map.x) ** 2 + (my - p.map.y) ** 2
  }
  return { frame, rmsM: Math.sqrt(sq / n) }
}

/** Khung không đổi gì (scale 0 cũng tính là 1, như API). */
export function isIdentityFrame(f: Frame): boolean {
  return f.dx === 0 && f.dy === 0 && f.rot_deg === 0 && (f.scale === 1 || f.scale === 0) && !f.flip_y
}

/** Dạng gửi lên server của một ghép nối đội xe với khung mới; khung đồng nhất thì bỏ hẳn trường frame. Các phần khác của ghép nối giữ nguyên. */
export function withFrame(b: Binding, frame: Frame): BindingInput {
  const { frame: _old, ...rest } = b.transform ?? {}
  const transform = isIdentityFrame(frame) ? rest : { ...rest, frame }
  return { subject: b.subject, signal: b.signal, mode: 'source', source: b.source, json_path: b.json_path, transform, enabled: b.enabled }
}

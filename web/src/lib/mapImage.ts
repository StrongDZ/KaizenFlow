import type { MapBG, Pt } from '../api/types'
import type { Rect } from './mapGeom'

/** Kích thước ảnh sau khi thu nhỏ để cạnh dài nhất không vượt `max` (giữ tỉ lệ, không phóng to, không bao giờ ra cạnh 0). */
export function fitImage(w: number, h: number, max: number): { w: number; h: number } {
  const k = Math.min(1, max / Math.max(w, h))
  return { w: Math.max(1, Math.round(w * k)), h: Math.max(1, Math.round(h * k)) }
}

/*
 * Hình học ảnh nền: (x, y) là góc trên trái của ảnh khi CHƯA xoay, `rot` là góc xoay (độ, chiều kim đồng hồ trên bản đồ, y hướng xuống)
 * quanh tâm ảnh. Không có `rot` là ảnh thẳng.
 */

const rad = (bg: MapBG) => ((bg.rot ?? 0) * Math.PI) / 180

/** Tâm ảnh (mét); xoay không làm tâm đổi chỗ. */
export function bgCenter(bg: MapBG): Pt {
  return { x: bg.x + (bg.w_px * bg.m_per_px) / 2, y: bg.y + (bg.h_px * bg.m_per_px) / 2 }
}

/** Pixel (u, v) của ảnh sang toạ độ bản đồ (mét). */
export function bgToMap(bg: MapBG, u: number, v: number): Pt {
  const c = bgCenter(bg), a = rad(bg)
  const dx = (u - bg.w_px / 2) * bg.m_per_px, dy = (v - bg.h_px / 2) * bg.m_per_px
  return { x: c.x + dx * Math.cos(a) - dy * Math.sin(a), y: c.y + dx * Math.sin(a) + dy * Math.cos(a) }
}

/** Toạ độ bản đồ (mét) sang pixel của ảnh: phép ngược của bgToMap. */
export function mapToBg(bg: MapBG, p: Pt): Pt {
  const c = bgCenter(bg), a = rad(bg)
  const dx = p.x - c.x, dy = p.y - c.y
  return { x: (dx * Math.cos(a) + dy * Math.sin(a)) / bg.m_per_px + bg.w_px / 2, y: (-dx * Math.sin(a) + dy * Math.cos(a)) / bg.m_per_px + bg.h_px / 2 }
}

/** Bốn góc ảnh trên bản đồ: trên trái, trên phải, dưới phải, dưới trái (đã xoay). */
export function bgCorners(bg: MapBG): [Pt, Pt, Pt, Pt] {
  return [bgToMap(bg, 0, 0), bgToMap(bg, bg.w_px, 0), bgToMap(bg, bg.w_px, bg.h_px), bgToMap(bg, 0, bg.h_px)]
}

/** Khung bao (mét) của chỗ ảnh nền chiếm trên bản đồ, tính theo các góc đã xoay. */
export function bgRect(bg: MapBG): Rect {
  const c = bgCorners(bg)
  const xs = c.map((p) => p.x), ys = c.map((p) => p.y)
  const x = Math.min(...xs), y = Math.min(...ys)
  return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y }
}

/** Đặt góc xoay (độ), chuẩn hoá về (-180, 180]; tâm ảnh đứng yên. Góc 0 thì bỏ trường `rot`. */
export function rotateBg(bg: MapBG, deg: number): MapBG {
  if (!Number.isFinite(deg)) return bg
  let r = ((deg % 360) + 360) % 360
  if (r > 180) r -= 360
  const out: MapBG = { ...bg }
  delete out.rot
  return r === 0 ? out : { ...out, rot: r }
}

/**
 * Phóng to (f > 1) hay thu nhỏ ảnh quanh tâm. Tỉ lệ không còn đo bằng hiệu chuẩn hai điểm nữa nên ảnh mất dấu "đã hiệu chuẩn".
 * f không dương hay không hữu hạn thì giữ nguyên.
 */
export function scaleBg(bg: MapBG, f: number): MapBG {
  if (!(f > 0) || !Number.isFinite(f)) return bg
  const c = bgCenter(bg)
  const m = bg.m_per_px * f
  return { ...bg, m_per_px: m, x: c.x - (bg.w_px * m) / 2, y: c.y - (bg.h_px * m) / 2, calibrated: false }
}

/** Dời ảnh (mét); góc xoay và dấu hiệu chuẩn giữ nguyên. */
export function moveBg(bg: MapBG, dx: number, dy: number): MapBG {
  return { ...bg, x: bg.x + dx, y: bg.y + dy }
}

/** Ảnh vừa tải lên: chưa biết tỉ lệ nên đoán cho bề ngang ảnh bằng `widthM` mét, đặt ở gốc toạ độ, đánh dấu chưa hiệu chuẩn. */
export function defaultBg(wPx: number, hPx: number, widthM: number, rev?: number): MapBG {
  return { x: 0, y: 0, m_per_px: widthM / wPx, w_px: wPx, h_px: hPx, ...(rev !== undefined ? { rev } : {}), calibrated: false }
}

/**
 * Hiệu chuẩn tỉ lệ: p1, p2 là hai điểm người dùng bấm lên ảnh (toạ độ bản đồ, theo tỉ lệ hiện tại), `distM` là khoảng cách thật giữa chúng.
 * Ảnh co giãn quanh p1 nên chỗ đang nhìn không nhảy đi. Dữ liệu không dùng được (hai điểm trùng, khoảng cách không dương) thì giữ nguyên.
 */
export function calibrateBg(bg: MapBG, p1: Pt, p2: Pt, distM: number): MapBG {
  const shown = Math.hypot(p2.x - p1.x, p2.y - p1.y)
  if (!(shown > 0) || !(distM > 0) || !Number.isFinite(distM)) return bg
  const f = distM / shown
  const c = bgCenter(bg)
  const m = bg.m_per_px * f
  // Tâm co giãn quanh p1; xoay quanh tâm nên góc xoay giữ nguyên mà p1 vẫn đứng yên.
  const cx = p1.x + (c.x - p1.x) * f, cy = p1.y + (c.y - p1.y) * f
  return { ...bg, m_per_px: m, x: cx - (bg.w_px * m) / 2, y: cy - (bg.h_px * m) / 2, calibrated: true }
}

import { describe, expect, it } from 'vitest'
import type { AgvMap, MapBG } from '../api/types'
import { bounds } from './mapGeom'
import { bgCenter, bgCorners, bgRect, bgToMap, calibrateBg, defaultBg, fitImage, mapToBg, moveBg, rotateBg, scaleBg } from './mapImage'

const bg = (over: Partial<MapBG> = {}): MapBG => ({ x: 0, y: 0, m_per_px: 0.1, w_px: 1000, h_px: 600, ...over })

describe('thu nhỏ ảnh trước khi tải lên', () => {
  it('cạnh dài nhất không vượt giới hạn, giữ tỉ lệ; ảnh nhỏ hơn thì giữ nguyên, không phóng to', () => {
    expect(fitImage(4800, 3200, 2400)).toEqual({ w: 2400, h: 1600 })
    expect(fitImage(1000, 3000, 1500)).toEqual({ w: 500, h: 1500 })
    expect(fitImage(800, 600, 2400)).toEqual({ w: 800, h: 600 })
  })
  it('không bao giờ ra cạnh 0 với ảnh quá dẹt', () => {
    expect(fitImage(10000, 3, 1000)).toEqual({ w: 1000, h: 1 })
  })
})

describe('chỗ ảnh nền chiếm trên bản đồ', () => {
  it('đổi pixel sang mét theo tỉ lệ, góc trên trái ở (x, y)', () => {
    expect(bgRect(bg({ x: -5, y: 2, m_per_px: 0.05 }))).toEqual({ x: -5, y: 2, w: 50, h: 30 })
  })
  it('ảnh mới chưa hiệu chuẩn: đoán tỉ lệ cho vừa bề ngang mong muốn, đặt ở gốc', () => {
    const d = defaultBg(2000, 1000, 100, 7)
    expect(d).toEqual({ x: 0, y: 0, m_per_px: 0.05, w_px: 2000, h_px: 1000, rev: 7, calibrated: false })
  })
  it('khung bản đồ bao cả ảnh nền để "vừa khung" thấy được ảnh', () => {
    const m: AgvMap = { v: 2, speed_mps: 1, points: [{ id: 'A', x: 10, y: 10, kind: 'junction' }], lanes: [], bg: bg() }
    expect(bounds(m, 0)).toEqual({ x: 0, y: 0, w: 100, h: 60 })
    const far: AgvMap = { ...m, bg: bg({ x: 200, y: 100 }) }
    expect(bounds(far, 0)).toEqual({ x: 10, y: 10, w: 290, h: 150 })
  })
})

describe('hiệu chuẩn tỉ lệ bằng hai điểm đã biết khoảng cách', () => {
  it('điểm thứ nhất đứng yên, tỉ lệ co theo khoảng cách thật, đánh dấu đã hiệu chuẩn', () => {
    // Hai điểm cách nhau 20 m trên bản đồ nhưng ngoài đời chỉ 10 m: ảnh phải co một nửa quanh điểm thứ nhất.
    const out = calibrateBg(bg(), { x: 10, y: 10 }, { x: 30, y: 10 }, 10)
    expect(out.m_per_px).toBeCloseTo(0.05, 10)
    expect(out.x).toBeCloseTo(5, 10)
    expect(out.y).toBeCloseTo(5, 10)
    expect(out.calibrated).toBe(true)
    // pixel dưới điểm thứ nhất vẫn nằm đúng chỗ đó: (10 - 0) / 0.1 = pixel 100 → 5 + 100 × 0.05 = 10
    expect(out.x + 100 * out.m_per_px).toBeCloseTo(10, 10)
  })
  it('khoảng cách thật lớn hơn thì ảnh nở ra; giữ nguyên kích thước pixel và rev', () => {
    const out = calibrateBg(bg({ rev: 9 }), { x: 0, y: 0 }, { x: 0, y: 5 }, 10)
    expect(out.m_per_px).toBeCloseTo(0.2, 10)
    expect([out.w_px, out.h_px, out.rev]).toEqual([1000, 600, 9])
  })
  it('hai điểm trùng nhau hoặc khoảng cách thật không dương thì giữ nguyên, không chia cho 0', () => {
    expect(calibrateBg(bg(), { x: 3, y: 3 }, { x: 3, y: 3 }, 10)).toEqual(bg())
    expect(calibrateBg(bg(), { x: 0, y: 0 }, { x: 5, y: 0 }, 0)).toEqual(bg())
    expect(calibrateBg(bg(), { x: 0, y: 0 }, { x: 5, y: 0 }, Number.NaN)).toEqual(bg())
  })
})

const close = (a: { x: number; y: number }, b: { x: number; y: number }) => {
  expect(a.x).toBeCloseTo(b.x, 6)
  expect(a.y).toBeCloseTo(b.y, 6)
}

describe('xoay, đổi cỡ, dời ảnh nền', () => {
  it('tâm ảnh là tâm của hình chữ nhật chưa xoay; xoay không dời tâm', () => {
    close(bgCenter(bg({ x: 10, y: 20 })), { x: 60, y: 50 })
    close(bgCenter(rotateBg(bg({ x: 10, y: 20 }), 37)), { x: 60, y: 50 })
  })
  it('pixel sang mét: chưa xoay thì như cũ; xoay 90° quanh tâm thì góc trên trái sang góc trên phải', () => {
    close(bgToMap(bg(), 0, 0), { x: 0, y: 0 })
    close(bgToMap(bg(), 1000, 600), { x: 100, y: 60 })
    // ảnh 100×60 m, tâm (50, 30); góc trên trái (-50, -30) so với tâm, xoay 90° chiều kim đồng hồ (y hướng xuống) thành (30, -50)
    close(bgToMap(bg({ rot: 90 }), 0, 0), { x: 80, y: -20 })
  })
  it('mét sang pixel là phép ngược', () => {
    const b = bg({ x: -7, y: 3, rot: -33, m_per_px: 0.07 })
    const p = bgToMap(b, 123, 456)
    close(mapToBg(b, p), { x: 123, y: 456 })
  })
  it('bốn góc theo thứ tự trên trái, trên phải, dưới phải, dưới trái; khung bao lấy theo góc đã xoay', () => {
    const c = bgCorners(bg({ rot: 90 }))
    close(c[0], { x: 80, y: -20 })
    close(c[2], { x: 20, y: 80 })
    const r = bgRect(bg({ rot: 90 }))
    expect(r.x).toBeCloseTo(20); expect(r.y).toBeCloseTo(-20); expect(r.w).toBeCloseTo(60); expect(r.h).toBeCloseTo(100)
  })
  it('xoay chuẩn hoá góc về (-180, 180]; xoay 0 thì bỏ trường rot', () => {
    expect(rotateBg(bg(), 270).rot).toBe(-90)
    expect(rotateBg(bg(), -180).rot).toBe(180)
    expect('rot' in rotateBg(bg({ rot: 30 }), 360)).toBe(false)
  })
  it('đổi cỡ quanh tâm: tâm đứng yên, góc xoay giữ nguyên, ảnh mất dấu đã hiệu chuẩn', () => {
    const b = scaleBg(bg({ x: 10, y: 20, rot: 15, calibrated: true }), 2)
    close(bgCenter(b), { x: 60, y: 50 })
    expect(b.m_per_px).toBeCloseTo(0.2)
    expect(b.rot).toBe(15)
    expect(b.calibrated).toBe(false)
    expect(scaleBg(bg(), 0)).toEqual(bg())
    expect(scaleBg(bg(), Number.NaN)).toEqual(bg())
  })
  it('dời ảnh giữ góc xoay và dấu hiệu chuẩn', () => {
    const b = moveBg(bg({ rot: 20, calibrated: true }), 3, -4)
    expect([b.x, b.y, b.rot, b.calibrated]).toEqual([3, -4, 20, true])
  })
  it('hiệu chuẩn ảnh đã xoay: co giãn quanh điểm thứ nhất, góc xoay giữ nguyên', () => {
    const b = bg({ rot: 40 })
    const p1 = bgToMap(b, 100, 100)
    const p2 = bgToMap(b, 300, 100) // 200 px = 20 m theo tỉ lệ hiện tại
    const c = calibrateBg(b, p1, p2, 40)
    expect(c.m_per_px).toBeCloseTo(0.2)
    expect(c.rot).toBe(40)
    close(bgToMap(c, 100, 100), p1) // điểm thứ nhất đứng yên
    const q = bgToMap(c, 300, 100)
    expect(Math.hypot(q.x - p1.x, q.y - p1.y)).toBeCloseTo(40)
  })
})

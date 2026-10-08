import { describe, expect, it } from 'vitest'
import type { AgvMap, Vehicle } from '../api/types'
import {
  markScale,
  addLane, addPoint, bounds, insertWaypoint, laneLengthM, laneShape, lanePolyline, laneTone, midpointOf, moveWaypoint, movePoint, occupancy, offsetPolyline,
  polylineD, polylineLength, projectOnPolyline, removeLane, removePoint, removeWaypoint, setLaneCapacity,
} from './mapGeom'

const map = (): AgvMap => ({
  v: 2, speed_mps: 1.2,
  points: [
    { id: 'A', x: 0, y: 0, kind: 'station', node_key: 'KHO' },
    { id: 'B', x: 60, y: 80, kind: 'junction' },
    { id: 'C', x: 120, y: 0, kind: 'station', node_key: 'MAY' },
  ],
  lanes: [{ id: 'L01', from: 'A', to: 'B', capacity: 2 }, { id: 'L02', from: 'B', to: 'A', capacity: 1 }, { id: 'L03', from: 'B', to: 'C', capacity: 2 }],
})
const veh = (id: string, lane: string, state: string): Vehicle => ({ id, x: 0, y: 0, raw_x: 0, raw_y: 0, state, lane, s: 0, off_map: false, load: 0, ts: '', age_ms: 0 })

describe('bounds', () => {
  it('bao mọi điểm kèm lề; bản đồ rỗng vẫn có khung', () => {
    expect(bounds(map(), 10)).toEqual({ x: -10, y: -10, w: 140, h: 100 })
    const empty = bounds({ v: 2, speed_mps: 1, points: [], lanes: [] }, 10)
    expect(empty.w).toBeGreaterThan(0)
    expect(empty.h).toBeGreaterThan(0)
  })
})

describe('bounds với điểm uốn', () => {
  it('khung bao cả các điểm uốn của làn', () => {
    const m = map()
    m.lanes[0] = { ...m.lanes[0], path: [{ x: -30, y: 150 }] }
    expect(bounds(m, 0)).toEqual({ x: -30, y: 0, w: 150, h: 150 })
  })
})

describe('đường gấp khúc của làn', () => {
  it('polyline gồm điểm đầu, điểm uốn, điểm cuối; độ dài theo mét', () => {
    const m = map()
    expect(lanePolyline(m, m.lanes[0])).toEqual([{ x: 0, y: 0 }, { x: 60, y: 80 }])
    expect(laneLengthM(m, m.lanes[0])).toBe(100)
    const bent = { ...m.lanes[0], path: [{ x: 0, y: 80 }] }
    expect(lanePolyline(m, bent)).toHaveLength(3)
    expect(laneLengthM(m, bent)).toBe(140) // 80 xuống rồi 60 sang
    expect(polylineLength([])).toBe(0)
  })
  it('làn tới điểm không tồn tại thì không có polyline', () => {
    expect(lanePolyline(map(), { id: 'X', from: 'A', to: 'ZZ', capacity: 1 })).toBeUndefined()
    expect(laneShape(map(), { id: 'X', from: 'A', to: 'ZZ', capacity: 1 }, 0)).toBeUndefined()
  })
  it('làn ngược chiều lệch về hai phía để không chồng lên nhau', () => {
    const m = map()
    const ab = laneShape(m, m.lanes[0], 1.5)!
    const ba = laneShape(m, m.lanes[1], 1.5)!
    expect(ab.length).toBeCloseTo(100, 5)
    // pháp tuyến bên phải của (0.6, 0.8) là (-0.8, 0.6): điểm đầu AB lệch đúng 1,5 m về phía đó
    expect(ab.pts[0].x).toBeCloseTo(-1.2, 5)
    expect(ab.pts[0].y).toBeCloseTo(0.9, 5)
    // BA đi ngược lại nên cùng khoảng cách nhưng về phía đối diện của đường nối
    expect(ba.pts[ba.pts.length - 1].x).toBeCloseTo(1.2, 5)
    expect(ba.pts[ba.pts.length - 1].y).toBeCloseTo(-0.9, 5)
  })
  it('inset rút ngắn hai đầu để mũi tên không đè lên điểm', () => {
    const m = map()
    const g = laneShape(m, m.lanes[0], 0, 5)!
    expect(Math.hypot(g.pts[0].x, g.pts[0].y)).toBeCloseTo(5, 5)
    expect(Math.hypot(g.pts[g.pts.length - 1].x - 60, g.pts[g.pts.length - 1].y - 80)).toBeCloseTo(5, 5)
  })
  it('offset trên đường gấp khúc giữ khoảng cách đều ở khúc cua (miter)', () => {
    const out = offsetPolyline([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }], 1)
    expect(out[0]).toEqual({ x: 0, y: 1 }) // phải của hướng +x là +y (y hướng xuống)
    expect(out[1].x).toBeCloseTo(9, 5)
    expect(out[1].y).toBeCloseTo(1, 5)
    expect(out[2].x).toBeCloseTo(9, 5)
    expect(out[2].y).toBeCloseTo(10, 5)
  })
  it('polylineD viết path SVG; midpointOf là điểm giữa theo độ dài', () => {
    expect(polylineD([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }])).toBe('M0 0L10 0L10 10')
    expect(midpointOf([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }])).toEqual({ x: 10, y: 0 })
    expect(midpointOf([{ x: 0, y: 0 }, { x: 10, y: 0 }])).toEqual({ x: 5, y: 0 })
  })
  it('chiếu một điểm lên đường gấp khúc: s dọc làn, dist tới làn, kẹp ở hai đầu', () => {
    const p = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }]
    expect(projectOnPolyline(p, 5, 2)).toMatchObject({ s: 5, dist: 2 })
    expect(projectOnPolyline(p, 12, 6)).toMatchObject({ s: 16, dist: 2 })
    expect(projectOnPolyline(p, -5, 0)).toMatchObject({ s: 0, dist: 5 })
    expect(projectOnPolyline([{ x: 1, y: 1 }, { x: 1, y: 1 }], 4, 5)).toMatchObject({ s: 0, dist: 5 })
  })
})

describe('sửa điểm uốn (thuần)', () => {
  const withPath = (): AgvMap => { const m = map(); m.lanes[0] = { ...m.lanes[0], path: [{ x: 10, y: 10 }, { x: 20, y: 20 }] }; return m }
  it('thêm điểm uốn vào đúng vị trí, dời, xoá', () => {
    const m = withPath()
    const added = insertWaypoint(m, 'L01', 1, { x: 15, y: 15 })
    expect(added.lanes[0].path).toEqual([{ x: 10, y: 10 }, { x: 15, y: 15 }, { x: 20, y: 20 }])
    expect(m.lanes[0].path).toHaveLength(2)
    expect(moveWaypoint(m, 'L01', 0, 1, 2).lanes[0].path![0]).toEqual({ x: 1, y: 2 })
    expect(removeWaypoint(m, 'L01', 0).lanes[0].path).toEqual([{ x: 20, y: 20 }])
    expect(removeWaypoint(removeWaypoint(m, 'L01', 0), 'L01', 0).lanes[0].path).toBeUndefined() // hết điểm uốn thì bỏ trường path
  })
  it('vẽ làn qua nhiều điểm uốn; hai chiều thì làn ngược đi lại đúng đường đó', () => {
    const out = addLane(map(), 'A', 'C', true, [{ x: 30, y: 30 }, { x: 90, y: 30 }])
    const fwd = out.lanes.find((l) => l.from === 'A' && l.to === 'C')!
    const back = out.lanes.find((l) => l.from === 'C' && l.to === 'A')!
    expect(fwd.path).toEqual([{ x: 30, y: 30 }, { x: 90, y: 30 }])
    expect(back.path).toEqual([{ x: 90, y: 30 }, { x: 30, y: 30 }])
  })
})

describe('occupancy và laneTone', () => {
  it('đếm xe đang giữ làn và xe đang chờ ở cuối làn', () => {
    const occ = occupancy(map(), [[veh('1', 'L01', 'MOVING'), veh('2', 'L01', 'WAITING'), veh('3', '', 'IDLE')], [veh('4', 'L02', 'MOVING')]])
    expect(occ.get('L01')).toEqual({ holding: 2, waiting: 1, capacity: 2 })
    expect(occ.get('L02')).toEqual({ holding: 1, waiting: 0, capacity: 1 })
    expect(occ.get('L03')).toEqual({ holding: 0, waiting: 0, capacity: 2 })
  })
  it('màu: có xe chờ là tắc, đầy chỗ là bận, còn lại thông thoáng', () => {
    expect(laneTone({ holding: 2, waiting: 1, capacity: 2 })).toBe('jam')
    expect(laneTone({ holding: 1, waiting: 0, capacity: 1 })).toBe('busy')
    expect(laneTone({ holding: 1, waiting: 0, capacity: 2 })).toBe('ok')
    expect(laneTone({ holding: 0, waiting: 0, capacity: 2 })).toBe('ok')
  })
})

describe('sửa bản đồ (thuần, không đổi bản gốc)', () => {
  it('thêm điểm với id chưa dùng, đặt đúng chỗ', () => {
    const m = map()
    const out = addPoint(m, { x: 5, y: 6 }, 'junction')
    expect(out.points).toHaveLength(4)
    expect(out.points[3]).toMatchObject({ x: 5, y: 6, kind: 'junction' })
    expect(m.points).toHaveLength(3)
    const again = addPoint(out, { x: 1, y: 1 }, 'station')
    expect(new Set(again.points.map((p) => p.id)).size).toBe(5)
  })
  it('nối hai điểm một chiều hoặc hai chiều, mặc định sức chứa 2, không nối trùng', () => {
    const m = map()
    const one = addLane(m, 'A', 'C', false)
    expect(one.lanes).toHaveLength(4)
    expect(one.lanes[3]).toMatchObject({ from: 'A', to: 'C', capacity: 2 })
    const two = addLane(m, 'C', 'A', true)
    expect(two.lanes.filter((l) => (l.from === 'C' && l.to === 'A') || (l.from === 'A' && l.to === 'C'))).toHaveLength(2)
    expect(new Set(two.lanes.map((l) => l.id)).size).toBe(5)
    expect(addLane(m, 'A', 'B', false).lanes).toHaveLength(3)   // đã có làn A→B
    expect(addLane(m, 'A', 'A', false).lanes).toHaveLength(3)   // không nối điểm với chính nó
  })
  it('xoá điểm kéo theo xoá các làn nối vào nó', () => {
    const out = removePoint(map(), 'B')
    expect(out.points.map((p) => p.id)).toEqual(['A', 'C'])
    expect(out.lanes).toEqual([])
  })
  it('xoá làn, đổi sức chứa (tối thiểu 1), dời điểm', () => {
    expect(removeLane(map(), 'L02').lanes.map((l) => l.id)).toEqual(['L01', 'L03'])
    expect(setLaneCapacity(map(), 'L01', 5).lanes[0].capacity).toBe(5)
    expect(setLaneCapacity(map(), 'L01', 0).lanes[0].capacity).toBe(1)
    expect(movePoint(map(), 'C', 7, 8).points[2]).toMatchObject({ x: 7, y: 8 })
  })
})

describe('markScale (cỡ chữ và ký hiệu trên bản đồ)', () => {
  const base: AgvMap = { v: 2, speed_mps: 1, lanes: [], points: [{ id: 'A', x: 0, y: 0, kind: 'junction' }, { id: 'B', x: 80, y: 30, kind: 'junction' }] }
  const bg = { x: 0, y: 0, m_per_px: 0.1, w_px: 1000, h_px: 600 }
  it('không đổi khi phóng to, thu nhỏ hay dời ảnh nền', () => {
    const k = markScale(base)
    expect(markScale({ ...base, bg })).toBe(k)
    expect(markScale({ ...base, bg: { ...bg, m_per_px: 0.4 } })).toBe(k)
    expect(markScale({ ...base, bg: { ...bg, x: 500, y: -300 } })).toBe(k)
  })
  it('bản đồ chưa vẽ gì thì lấy theo ảnh nền để chữ không quá nhỏ hay quá to so với ảnh', () => {
    const empty: AgvMap = { v: 2, speed_mps: 1, lanes: [], points: [] }
    expect(markScale({ ...empty, bg: { ...bg, m_per_px: 0.4 } })).toBeGreaterThan(markScale({ ...empty, bg }))
  })
})

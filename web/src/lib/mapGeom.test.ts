import { describe, expect, it } from 'vitest'
import type { AgvMap, Vehicle } from '../api/types'
import { addLane, addPoint, bounds, laneGeometry, laneLengthM, movePoint, occupancy, removeLane, removePoint, setLaneCapacity, laneTone } from './mapGeom'

const map = (): AgvMap => ({
  unit_m: 2, speed_mps: 1.2,
  points: [
    { id: 'A', x: 0, y: 0, kind: 'station', node_key: 'KHO' },
    { id: 'B', x: 30, y: 40, kind: 'junction' },
    { id: 'C', x: 60, y: 0, kind: 'station', node_key: 'MAY' },
  ],
  lanes: [{ id: 'L01', from: 'A', to: 'B', capacity: 2 }, { id: 'L02', from: 'B', to: 'A', capacity: 1 }, { id: 'L03', from: 'B', to: 'C', capacity: 2 }],
})
const veh = (id: string, lane: string, state: string): Vehicle => ({ id, x: 0, y: 0, state, lane, load: 0, ts: '', age_ms: 0 })

describe('bounds', () => {
  it('bao mọi điểm kèm lề; bản đồ rỗng vẫn có khung', () => {
    expect(bounds(map(), 10)).toEqual({ x: -10, y: -10, w: 80, h: 60 })
    const empty = bounds({ unit_m: 1, speed_mps: 1, points: [], lanes: [] }, 10)
    expect(empty.w).toBeGreaterThan(0)
    expect(empty.h).toBeGreaterThan(0)
  })
})

describe('laneGeometry', () => {
  it('làn ngược chiều lệch về hai phía để không chồng lên nhau', () => {
    const m = map()
    const ab = laneGeometry(m, m.lanes[0], 1.5)!
    const ba = laneGeometry(m, m.lanes[1], 1.5)!
    // vuông góc với hướng (30,40) → (0.8,-0.6) hoặc ngược lại; hai làn ngược dấu
    expect(ab.x1 - 0).toBeCloseTo(-ba.x2 + 0, 5)
    expect(Math.hypot(ab.x1 - m.points[0].x, ab.y1 - m.points[0].y)).toBeCloseTo(1.5, 5)
    expect(ab.x1 * ba.x2 + ab.y1 * ba.y2).toBeLessThan(0.0001 + 0)  // hai đầu về hai phía đối diện điểm A
    expect(ab.length).toBeCloseTo(50, 5)
  })
  it('làn tới điểm không tồn tại thì bỏ qua', () => {
    expect(laneGeometry(map(), { id: 'X', from: 'A', to: 'ZZ', capacity: 1 }, 0)).toBeUndefined()
  })
  it('độ dài theo mét = khoảng cách bản đồ × unit_m', () => {
    const m = map()
    expect(laneLengthM(m, m.lanes[0])).toBe(100)
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

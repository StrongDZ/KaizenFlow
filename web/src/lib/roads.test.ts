import { describe, expect, it } from 'vitest'
import type { AgvMap } from '../api/types'
import type { Occupancy } from './mapGeom'
import {
  isOneWay, pairLanes, removeRoad, reverseRoad, roadInsertWaypoint, roadMoveWaypoint, roadOf, roadRemoveWaypoint, roadsOf, roadTone, setOneWay, setRoadCapacity, straightenRoad,
} from './roads'

const map = (): AgvMap => ({
  v: 2, speed_mps: 1.2,
  points: [
    { id: 'A', x: 0, y: 0, kind: 'station', node_key: 'KHO' },
    { id: 'B', x: 60, y: 80, kind: 'junction' },
    { id: 'C', x: 120, y: 0, kind: 'station', node_key: 'MAY' },
  ],
  lanes: [
    { id: 'L01', from: 'A', to: 'B', capacity: 2, path: [{ x: 0, y: 40 }, { x: 30, y: 60 }] },
    { id: 'L02', from: 'B', to: 'A', capacity: 1, path: [{ x: 30, y: 60 }, { x: 0, y: 40 }] },
    { id: 'L03', from: 'B', to: 'C', capacity: 2 },
  ],
})

describe('ghép làn thành đường', () => {
  it('hai làn ngược chiều giữa cùng hai điểm là một đường hai chiều; làn lẻ là đường một chiều', () => {
    const roads = roadsOf(map())
    expect(roads.map((r) => [r.a.id, r.b?.id])).toEqual([['L01', 'L02'], ['L03', undefined]])
    expect(isOneWay(roads[0])).toBe(false)
    expect(isOneWay(roads[1])).toBe(true)
  })

  it('chọn làn nào của cặp cũng ra cùng một đường; id không có thì không có đường', () => {
    const m = map()
    expect(roadOf(m, 'L02')?.a.id).toBe('L01')
    expect(roadOf(m, 'L01')?.b?.id).toBe('L02')
    expect(roadOf(m, 'ZZ')).toBeUndefined()
  })

  it('ghép một-một: làn trùng đầu cuối không cướp cặp của làn khác', () => {
    const m = map()
    m.lanes.push({ id: 'L04', from: 'A', to: 'B', capacity: 1 })
    const pairs = pairLanes(m)
    expect(pairs.get('L01')).toBe('L02')
    expect(pairs.get('L02')).toBe('L01')
    expect(pairs.has('L04')).toBe(false)
  })
})

describe('sửa cả đường', () => {
  it('sức chứa ghi cho cả hai làn, tối thiểu 1, làm tròn', () => {
    const m = setRoadCapacity(map(), 'L02', 3.4)
    expect(m.lanes.map((l) => l.capacity)).toEqual([3, 3, 2])
    expect(setRoadCapacity(map(), 'L01', 0).lanes[0].capacity).toBe(1)
  })

  it('xoá đường xoá cả hai làn nhưng không đụng đường khác', () => {
    expect(removeRoad(map(), 'L02').lanes.map((l) => l.id)).toEqual(['L03'])
    expect(removeRoad(map(), 'L03').lanes.map((l) => l.id)).toEqual(['L01', 'L02'])
  })

  it('điểm uốn thêm, dời, xoá ở một làn thì làn ngược chiều tự đối xứng theo', () => {
    let m = roadInsertWaypoint(map(), 'L01', 1, { x: 10, y: 50 })
    expect(m.lanes[0].path).toEqual([{ x: 0, y: 40 }, { x: 10, y: 50 }, { x: 30, y: 60 }])
    expect(m.lanes[1].path).toEqual([{ x: 30, y: 60 }, { x: 10, y: 50 }, { x: 0, y: 40 }])
    m = roadMoveWaypoint(m, 'L02', 0, 31, 61)  // dời bằng làn kia của cặp cũng được
    expect(m.lanes[1].path?.[0]).toEqual({ x: 31, y: 61 })
    expect(m.lanes[0].path?.[2]).toEqual({ x: 31, y: 61 })
    m = roadRemoveWaypoint(m, 'L01', 0)
    expect(m.lanes[0].path).toEqual([{ x: 10, y: 50 }, { x: 31, y: 61 }])
    expect(m.lanes[1].path).toEqual([{ x: 31, y: 61 }, { x: 10, y: 50 }])
  })

  it('xoá hết điểm uốn thì bỏ hẳn trường path ở cả hai làn', () => {
    let m = map()
    m = roadRemoveWaypoint(m, 'L01', 0)
    m = roadRemoveWaypoint(m, 'L01', 0)
    expect('path' in m.lanes[0]).toBe(false)
    expect('path' in m.lanes[1]).toBe(false)
  })

  it('điểm uốn của đường một chiều chỉ ghi một làn', () => {
    const m = roadInsertWaypoint(map(), 'L03', 0, { x: 90, y: 40 })
    expect(m.lanes[2].path).toEqual([{ x: 90, y: 40 }])
    expect(m.lanes).toHaveLength(3)
  })
})

describe('làm thẳng đường', () => {
  it('bỏ điểm uốn của cả hai làn, không đụng đường khác', () => {
    const m = straightenRoad(map(), 'L02')
    expect('path' in m.lanes[0]).toBe(false)
    expect('path' in m.lanes[1]).toBe(false)
    expect(m.lanes[2]).toEqual(map().lanes[2])
  })
})

describe('một chiều và hai chiều', () => {
  it('bật một chiều giữ làn đang chọn và bỏ làn ngược', () => {
    expect(setOneWay(map(), 'L01', true).lanes.map((l) => l.id)).toEqual(['L01', 'L03'])
    expect(setOneWay(map(), 'L02', true).lanes.map((l) => l.id)).toEqual(['L02', 'L03'])
  })

  it('tắt một chiều thêm làn ngược cùng sức chứa, điểm uốn đảo ngược, id mới', () => {
    const m = map()
    m.lanes[2] = { ...m.lanes[2], capacity: 3, path: [{ x: 90, y: 60 }, { x: 110, y: 30 }] }
    const out = setOneWay(m, 'L03', false)
    const twin = out.lanes.find((l) => l.from === 'C' && l.to === 'B')!
    expect(out.lanes).toHaveLength(4)
    expect(twin.id).toBe('L04')
    expect(twin.capacity).toBe(3)
    expect(twin.path).toEqual([{ x: 110, y: 30 }, { x: 90, y: 60 }])
    expect(roadOf(out, 'L03')?.b?.id).toBe('L04')
  })

  it('tắt một chiều với đường đã hai chiều thì không đổi gì; bật một chiều với đường đã một chiều cũng vậy', () => {
    expect(setOneWay(map(), 'L01', false)).toEqual(map())
    expect(setOneWay(map(), 'L03', true)).toEqual(map())
  })

  it('đổi chiều đường một chiều: đảo đầu cuối và điểm uốn; đường hai chiều giữ nguyên', () => {
    const m = map()
    m.lanes[2] = { ...m.lanes[2], path: [{ x: 90, y: 60 }, { x: 110, y: 30 }] }
    const l = reverseRoad(m, 'L03').lanes[2]
    expect([l.from, l.to]).toEqual(['C', 'B'])
    expect(l.path).toEqual([{ x: 110, y: 30 }, { x: 90, y: 60 }])
    expect(reverseRoad(map(), 'L01')).toEqual(map())
  })
})

describe('màu của đường', () => {
  const occ = (rows: Record<string, Partial<Occupancy>>) =>
    new Map(Object.entries(rows).map(([id, o]) => [id, { holding: 0, waiting: 0, capacity: 2, ...o }]))
  it('lấy trạng thái tệ nhất của hai chiều: có xe chờ > đầy chỗ > thông', () => {
    const m = map()
    const r = roadsOf(m)[0]
    expect(roadTone(r, occ({ L01: {}, L02: {} }))).toBe('ok')
    expect(roadTone(r, occ({ L01: { holding: 2 }, L02: {} }))).toBe('busy')
    expect(roadTone(r, occ({ L01: { holding: 2 }, L02: { holding: 1, waiting: 1 } }))).toBe('jam')
  })
})

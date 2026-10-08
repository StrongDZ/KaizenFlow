import { describe, expect, it } from 'vitest'
import type { AgvMap, Pt } from '../api/types'
import { laneLengthM } from './mapGeom'
import { nearestOnRoads, placeCharger, placeNode, splitRoadAt } from './placeNode'
import { roadOf } from './roads'
import { keepoutProblems } from './zones'

// A (0,0) ⇄ B (60,80) qua hai điểm uốn; C đứng riêng ở (200, 0)
const base = (): AgvMap => ({
  v: 2, speed_mps: 1.2,
  points: [
    { id: 'A', x: 0, y: 0, kind: 'junction' },
    { id: 'B', x: 60, y: 80, kind: 'junction' },
  ],
  lanes: [
    { id: 'L01', from: 'A', to: 'B', capacity: 2, path: [{ x: 0, y: 40 }, { x: 30, y: 60 }] },
    { id: 'L02', from: 'B', to: 'A', capacity: 2, path: [{ x: 30, y: 60 }, { x: 0, y: 40 }] },
  ],
})

/** Các điểm tới được từ `from` theo chiều làn. */
function reach(m: AgvMap, from: string): Set<string> {
  const seen = new Set([from])
  const stack = [from]
  while (stack.length > 0) {
    const u = stack.pop()!
    for (const l of m.lanes) if (l.from === u && !seen.has(l.to)) { seen.add(l.to); stack.push(l.to) }
  }
  return seen
}
const totalLen = (m: AgvMap) => m.lanes.reduce((a, l) => a + laneLengthM(m, l), 0)

describe('điểm gần nhất trên đường', () => {
  it('chiếu lên đường gấp khúc, trả mét dọc đường và khoảng cách', () => {
    const snap = nearestOnRoads(base(), { x: -5, y: 20 })!
    expect(roadOf(base(), snap.laneId)?.a.id).toBe('L01')
    expect(snap.dist).toBeCloseTo(5, 6)
    expect(snap.s).toBeCloseTo(20, 6)
    expect(snap.at).toEqual({ x: 0, y: 20 })
  })
  it('bản đồ không có đường thì không có điểm gần nhất', () => {
    expect(nearestOnRoads({ v: 2, speed_mps: 1, points: [], lanes: [] }, { x: 0, y: 0 })).toBeNull()
  })
})

describe('cắt đường tại một điểm', () => {
  it('đường hai chiều thành hai đường, điểm uốn chia đúng về hai phía, tổng chiều dài giữ nguyên', () => {
    const m = base()
    const { map, pointId } = splitRoadAt(m, 'L01', 60)
    const j = map.points.find((p) => p.id === pointId)!
    expect(j.kind).toBe('junction')
    expect(map.lanes).toHaveLength(4)
    const byEnds = (f: string, t: string) => map.lanes.find((l) => l.from === f && l.to === t)!
    expect(byEnds('A', pointId).path).toEqual([{ x: 0, y: 40 }])
    expect(byEnds(pointId, 'B').path).toEqual([{ x: 30, y: 60 }])
    expect(byEnds('B', pointId).path).toEqual([{ x: 30, y: 60 }])
    expect(byEnds(pointId, 'A').path).toEqual([{ x: 0, y: 40 }])
    expect(totalLen(map)).toBeCloseTo(totalLen(m), 6)
    expect(laneLengthM(map, byEnds('A', pointId))).toBeCloseTo(60, 6)
    // làn gốc giữ id của mình
    expect(map.lanes.find((l) => l.id === 'L01')?.to).toBe(pointId)
    expect(map.lanes.find((l) => l.id === 'L02')?.to).toBe(pointId)
  })
  it('đường một chiều vẫn một chiều sau khi cắt', () => {
    const m = base()
    m.lanes = [m.lanes[0]]
    const { map, pointId } = splitRoadAt(m, 'L01', 20)
    expect(map.lanes.map((l) => [l.from, l.to])).toEqual([['A', pointId], [pointId, 'B']])
  })
  it('cắt ngay tại một điểm uốn không sinh điểm uốn thừa', () => {
    const { map, pointId } = splitRoadAt(base(), 'L01', 40)
    expect(map.lanes.find((l) => l.from === 'A' && l.to === pointId)!.path).toBeUndefined()
    expect(map.lanes.find((l) => l.from === pointId && l.to === 'B')!.path).toEqual([{ x: 30, y: 60 }])
  })
})

describe('đặt node lên bản đồ', () => {
  const at = (x: number, y: number): Pt => ({ x, y })

  it('đặt giữa đường: cắt đường tại hình chiếu và nối trạm hai chiều', () => {
    const r = placeNode(base(), 'KHO', at(-6, 20))
    const st = r.map.points.find((p) => p.id === r.pointId)!
    expect(st).toMatchObject({ kind: 'station', node_key: 'KHO', x: -6, y: 20 })
    expect(r.connected).toBe('split')
    expect(r.map.points).toHaveLength(4)       // A, B, trạm, ngã ba mới
    expect(r.map.lanes).toHaveLength(6)        // 4 làn do cắt + 2 làn nối trạm
    expect(reach(r.map, r.pointId)).toEqual(new Set(['A', 'B', r.pointId, ...r.map.points.map((p) => p.id)]))
    expect(reach(r.map, 'A').has(r.pointId)).toBe(true)
  })

  it('đặt sát một đầu đường thì nối thẳng vào điểm đó, không cắt', () => {
    const r = placeNode(base(), 'KHO', at(-3, 0.5))
    expect(r.connected).toBe('point')
    expect(r.map.points).toHaveLength(3)
    expect(r.map.lanes).toHaveLength(4)
    expect(r.map.lanes.some((l) => l.from === r.pointId && l.to === 'A')).toBe(true)
    expect(r.map.lanes.some((l) => l.from === 'A' && l.to === r.pointId)).toBe(true)
  })

  it('đặt xa đường quá thì chỉ đặt trạm và nói rõ lý do', () => {
    const r = placeNode(base(), 'KHO', at(500, 500))
    expect(r.connected).toBe('none')
    expect(r.reason).toMatch(/xa/)
    expect(r.map.lanes).toHaveLength(2)
    expect(r.map.points.find((p) => p.id === r.pointId)?.node_key).toBe('KHO')
  })

  it('bản đồ chưa có đường thì chỉ đặt trạm', () => {
    const r = placeNode({ v: 2, speed_mps: 1, points: [], lanes: [] }, 'KHO', at(1, 1))
    expect(r.connected).toBe('none')
    expect(r.reason).toMatch(/chưa có đường/)
    expect(r.map.points).toHaveLength(1)
  })

  it('đường nối bị vùng cấm chắn thì không nối và không tạo lỗi mới cho bản đồ', () => {
    const m: AgvMap = { ...base(), keepouts: [{ id: 'K01', poly: [at(-12, 10), at(-8, 10), at(-8, 30), at(-12, 30)] }] }
    const r = placeNode(m, 'KHO', at(-20, 20))
    expect(r.connected).toBe('none')
    expect(r.reason).toMatch(/vùng cấm/)
    expect(keepoutProblems(r.map)).toEqual([])
    expect(r.map.lanes).toHaveLength(2)
  })

  it('node không cần xe tới (connect: false): chỉ đánh dấu vị trí, không thêm đường, không cắt đường, không báo lỗi nối', () => {
    const m = base()
    const r = placeNode(m, 'MAY', at(-6, 20), { connect: false })
    expect(r.connected).toBe('none')
    expect(r.reason).toBeUndefined()
    expect(r.map.lanes).toEqual(m.lanes)
    expect(r.map.points).toHaveLength(3)
    expect(r.map.points.find((p) => p.id === r.pointId)).toMatchObject({ kind: 'station', node_key: 'MAY', x: -6, y: 20 })
  })

  it('mỗi lần đặt cho trạm id mới; đặt cùng một node hai lần cho hai trạm (hai chỗ đỗ)', () => {
    const r1 = placeNode(base(), 'KHO', at(-6, 20))
    const r2 = placeNode(r1.map, 'KHO', at(-6, 30))
    expect(r2.pointId).not.toBe(r1.pointId)
    expect(r2.map.points.filter((p) => p.node_key === 'KHO')).toHaveLength(2)
  })
})

describe('đặt chỗ sạc lên bản đồ', () => {
  it('chỗ sạc cũng tự nối vào đường gần nhất bằng đường hai chiều, id bắt đầu bằng C', () => {
    const r = placeCharger(base(), { x: -6, y: 20 })
    const ch = r.map.points.find((p) => p.id === r.pointId)!
    expect(ch).toMatchObject({ kind: 'charger', x: -6, y: 20 })
    expect(ch.node_key).toBeUndefined()
    expect(r.pointId).toMatch(/^C\d+$/)
    expect(r.connected).toBe('split')
    expect(r.map.lanes).toHaveLength(6)
    expect(reach(r.map, 'A').has(r.pointId)).toBe(true)
    expect(reach(r.map, r.pointId).has('B')).toBe(true)
  })
  it('đặt xa đường thì chỉ đặt điểm và nêu lý do', () => {
    const r = placeCharger(base(), { x: 800, y: 800 })
    expect(r.connected).toBe('none')
    expect(r.reason).toMatch(/xa/)
  })
})

import { describe, expect, it } from 'vitest'
import type { AgvMap, Pt } from '../api/types'
import {
  addKeepout, insertKeepoutVertex, keepoutProblems, moveKeepoutVertex, pointInPolygon, polygonArea, removeKeepout, removeKeepoutVertex, segmentEntersPolygon,
} from './zones'

const square: Pt[] = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }]
const P = (x: number, y: number): Pt => ({ x, y })

describe('điểm trong đa giác (chặt: trên mép là ở ngoài)', () => {
  it.each([
    ['bên trong', P(5, 5), true], ['bên ngoài', P(15, 5), false], ['trên cạnh', P(0, 5), false], ['trên đỉnh', P(10, 10), false],
  ])('%s', (_n, p, want) => expect(pointInPolygon(p, square)).toBe(want))

  it('đa giác lõm: điểm trong hõm là ở ngoài', () => {
    const u = [P(0, 0), P(10, 0), P(10, 10), P(7, 10), P(7, 3), P(3, 3), P(3, 10), P(0, 10)]
    expect(pointInPolygon(P(5, 8), u)).toBe(false)
    expect(pointInPolygon(P(1, 8), u)).toBe(true)
  })
})

describe('đoạn đi vào đa giác', () => {
  it.each([
    ['xuyên qua', P(-5, 5), P(15, 5), true],
    ['kết thúc ở trong', P(-5, 5), P(5, 5), true],
    ['nằm hẳn trong', P(2, 2), P(8, 8), true],
    ['nằm hẳn ngoài', P(-5, -5), P(-1, 10), false],
    ['chạy dọc cạnh', P(0, 0), P(10, 0), false],
    ['sượt qua đỉnh', P(-5, 5), P(5, -5), false],
    ['dừng ngay trên mép', P(-5, 5), P(0, 5), false],
    ['cắt qua một góc', P(-2, 8), P(2, 10.4), true],
    ['chỉ chạm đỉnh (0,10)', P(-2, 8), P(2, 12), false],
    ['qua hai đỉnh đối diện', P(-1, -1), P(11, 11), true],
  ])('%s', (_n, a, b, want) => expect(segmentEntersPolygon(a, b, square)).toBe(want))
})

describe('diện tích', () => {
  it('có dấu theo chiều đỉnh', () => {
    expect(polygonArea(square)).toBe(100)
    expect(polygonArea([...square].reverse())).toBe(-100)
  })
})

const base = (): AgvMap => ({
  v: 2, speed_mps: 1,
  keepouts: [{ id: 'K01', poly: [P(20, -5), P(30, -5), P(30, 5), P(20, 5)] }],
  points: [{ id: 'A', x: 0, y: 0, kind: 'junction' }, { id: 'B', x: 50, y: 0, kind: 'junction' }, { id: 'C', x: 0, y: 20, kind: 'junction' }],
  lanes: [],
})

describe('lỗi vùng cấm (cùng luật với server)', () => {
  it('làn đi vòng quanh vùng thì không lỗi; làn xuyên vùng thì báo đúng làn', () => {
    const ok = { ...base(), lanes: [{ id: 'L1', from: 'A', to: 'C', capacity: 1 }] }
    expect(keepoutProblems(ok)).toEqual([])
    const bad = { ...base(), lanes: [{ id: 'L1', from: 'A', to: 'B', capacity: 1 }] }
    expect(keepoutProblems(bad)).toEqual([{ key: 'L1', message: 'làn cắt vùng cấm K01' }])
  })
  it('điểm uốn nằm trong vùng cũng bị bắt; điểm nằm trong vùng báo theo điểm', () => {
    const bent = { ...base(), lanes: [{ id: 'L1', from: 'A', to: 'C', capacity: 1, path: [P(25, 0)] }] }
    expect(keepoutProblems(bent).map((p) => p.key)).toEqual(['L1'])
    const pt = { ...base(), points: [{ id: 'S', x: 25, y: 0, kind: 'station' as const }] }
    expect(keepoutProblems(pt)).toEqual([{ key: 'S', message: 'điểm nằm trong vùng cấm K01' }])
  })
  it('vùng hỏng chỉ báo lỗi của nó và không dùng để kiểm đường', () => {
    const m: AgvMap = { ...base(), keepouts: [{ id: 'K01', poly: [P(0, 0), P(5, 5)] }], lanes: [{ id: 'L1', from: 'A', to: 'B', capacity: 1 }] }
    expect(keepoutProblems(m)).toEqual([{ key: 'K01', message: 'vùng cấm cần ít nhất 3 đỉnh' }])
    const flat: AgvMap = { ...base(), keepouts: [{ id: 'K01', poly: [P(0, 0), P(5, 5), P(10, 10)] }] }
    expect(keepoutProblems(flat)[0].message).toContain('diện tích')
  })
  it('bản đồ không có vùng cấm thì không có lỗi', () => {
    expect(keepoutProblems({ v: 2, speed_mps: 1, points: [], lanes: [] })).toEqual([])
  })
})

describe('sửa vùng cấm', () => {
  it('thêm vùng cấp id K01, K02…; bản đồ gốc không bị đổi', () => {
    const m0: AgvMap = { v: 2, speed_mps: 1, points: [], lanes: [] }
    const m1 = addKeepout(m0, square)
    const m2 = addKeepout(m1, square)
    expect(m1.keepouts).toEqual([{ id: 'K01', poly: square }])
    expect(m2.keepouts?.map((k) => k.id)).toEqual(['K01', 'K02'])
    expect(m0.keepouts).toBeUndefined()
  })
  it('thêm vùng chưa đủ 3 đỉnh thì bỏ qua', () => {
    const m0: AgvMap = { v: 2, speed_mps: 1, points: [], lanes: [] }
    expect(addKeepout(m0, [P(0, 0), P(1, 1)])).toBe(m0)
  })
  it('dời, thêm, xoá đỉnh; xoá đỉnh khi chỉ còn 3 thì giữ nguyên', () => {
    let m = addKeepout({ v: 2, speed_mps: 1, points: [], lanes: [] }, square)
    m = moveKeepoutVertex(m, 'K01', 2, 12, 13)
    expect(m.keepouts![0].poly[2]).toEqual(P(12, 13))
    m = insertKeepoutVertex(m, 'K01', 0, P(5, -2))  // chèn sau đỉnh 0, giữa đỉnh 0 và 1
    expect(m.keepouts![0].poly.map((q) => [q.x, q.y])).toEqual([[0, 0], [5, -2], [10, 0], [12, 13], [0, 10]])
    m = removeKeepoutVertex(m, 'K01', 1)
    expect(m.keepouts![0].poly).toHaveLength(4)
    const three = addKeepout({ v: 2, speed_mps: 1, points: [], lanes: [] }, [P(0, 0), P(4, 0), P(0, 4)])
    expect(removeKeepoutVertex(three, 'K01', 0)).toBe(three)
  })
  it('xoá vùng; xoá hết thì bỏ trường keepouts', () => {
    const m = addKeepout({ v: 2, speed_mps: 1, points: [], lanes: [] }, square)
    const out = removeKeepout(m, 'K01')
    expect('keepouts' in out).toBe(false)
    expect(removeKeepout(m, 'ZZ')).toEqual(m)
  })
})

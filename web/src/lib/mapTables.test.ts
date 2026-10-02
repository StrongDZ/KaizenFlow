import { describe, expect, it } from 'vitest'
import type { AgvMap } from '../api/types'
import { filterLaneRows, filterPointRows, laneRows, pointLabel, pointRows } from './mapTables'

const map: AgvMap = {
  v: 2, speed_mps: 1.2,
  points: [
    { id: 'A', x: 0, y: 0, kind: 'station', node_key: 'KHO' },
    { id: 'B', x: 60, y: 80, kind: 'junction' },
    { id: 'C', x: 120, y: 0, kind: 'station' },
    { id: 'D', x: 20, y: 20, kind: 'charger' },
  ],
  lanes: [{ id: 'L01', from: 'A', to: 'B', capacity: 2 }, { id: 'L02', from: 'B', to: 'C', capacity: 1 }],
}
const names = { KHO: 'Kho NVL A' }

describe('pointLabel', () => {
  it('trạm gắn node thì hiện tên node, không thì mã điểm kèm loại', () => {
    expect(pointLabel(map.points[0], names)).toBe('Kho NVL A')
    expect(pointLabel(map.points[1], names)).toBe('B')
    expect(pointLabel({ id: 'C', x: 0, y: 0, kind: 'station' }, names)).toBe('C (trạm chưa gắn node)')
  })
})

describe('pointRows', () => {
  it('mỗi điểm một dòng với loại tiếng Việt, node gắn, số làn đi qua', () => {
    const rows = pointRows(map, names)
    expect(rows.map((r) => r.id)).toEqual(['A', 'B', 'C', 'D'])
    expect(rows[0]).toMatchObject({ kind: 'Trạm', node: 'Kho NVL A', lanes: 1 })
    expect(rows[1]).toMatchObject({ kind: 'Ngã tư', node: '', lanes: 2 })
    expect(rows[2]).toMatchObject({ kind: 'Trạm', node: 'chưa gắn' })
    expect(rows[3].kind).toBe('Chỗ sạc')
  })
})

describe('laneRows', () => {
  it('từ, đến theo nhãn điểm; dài theo mét; sức chứa; trạng thái từ chiếm chỗ và chặn', () => {
    const occ = new Map([['L01', { holding: 2, waiting: 0, capacity: 2 }], ['L02', { holding: 0, waiting: 1, capacity: 1 }]])
    const rows = laneRows(map, names, occ, new Set(['L02']))
    expect(rows[0]).toMatchObject({ id: 'L01', from: 'Kho NVL A', to: 'B', capacity: 2, status: 'Đầy chỗ' })
    expect(rows[0].lengthM).toBeCloseTo(100, 5) // hypot(60,80) = 100 m
    expect(rows[1]).toMatchObject({ id: 'L02', status: 'Đang bị chặn' })
  })
  it('không có dữ liệu chiếm chỗ thì thông thoáng', () => {
    expect(laneRows(map, names, new Map(), new Set())[0].status).toBe('Thông thoáng')
  })
})

describe('filter', () => {
  it('tìm theo mã, nhãn, không phân biệt dấu', () => {
    expect(filterPointRows(pointRows(map, names), 'kho').map((r) => r.id)).toEqual(['A'])
    expect(filterPointRows(pointRows(map, names), 'sac').map((r) => r.id)).toEqual(['D'])
    expect(filterLaneRows(laneRows(map, names, new Map(), new Set()), 'l02').map((r) => r.id)).toEqual(['L02'])
    expect(filterLaneRows(laneRows(map, names, new Map(), new Set()), 'kho').map((r) => r.id)).toEqual(['L01'])
  })
})

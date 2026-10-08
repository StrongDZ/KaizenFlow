import { describe, expect, it } from 'vitest'
import type { AgvMap, GraphEdge, MapLane, MapPoint } from '../api/types'
import { connectivityProblems, routeStatus } from './mapCheck'

const st = (id: string, node_key: string): MapPoint => ({ id, x: 0, y: 0, kind: 'station', node_key })
const j = (id: string): MapPoint => ({ id, x: 0, y: 0, kind: 'junction' })
const ln = (id: string, from: string, to: string): MapLane => ({ id, from, to, capacity: 1 })
const mk = (points: MapPoint[], lanes: MapLane[]): AgvMap => ({ v: 2, speed_mps: 1, points, lanes })
const pool = (key: string, src: string, dst: string): GraphEdge => ({ key, src, dst, material: 'X', params: { mode: 'POOL' } })

const pts = [st('A', 'KHO'), j('B'), st('C', 'MAY'), st('D', 'KHO')]
const fwd = [ln('L1', 'A', 'B'), ln('L2', 'B', 'C')]
const back = [ln('L3', 'C', 'B'), ln('L4', 'B', 'A')]

describe('đường nối của xe có chạy được trên bản đồ', () => {
  it.each([
    ['đi và về đều có', mk(pts, [...fwd, ...back]), 'ok'],
    ['không có làn nào', mk(pts, []), 'no_path'],
    ['chỉ có chiều đi: xe không về được', mk(pts, fwd), 'no_return'],
    ['chỉ có chiều về: không đi được', mk(pts, back), 'no_path'],
    ['node không có trạm', mk([j('A'), j('C')], [...fwd, ...back]), 'no_station'],
    ['điểm ngã tư mang mã node không phải trạm', mk([j('A'), st('C', 'MAY')].map((p, i) => (i === 0 ? { ...p, node_key: 'KHO' } : p)), [...fwd, ...back]), 'no_station'],
    ['chỗ đỗ thứ hai của kho là đủ', mk(pts, [ln('L2', 'B', 'C'), ln('L3', 'C', 'B'), ln('L5', 'D', 'B'), ln('L6', 'B', 'D')]), 'ok'],
  ])('%s → %s', (_n, m, want) => expect(routeStatus(m, 'KHO', 'MAY')).toBe(want))
})

describe('cảnh báo liên thông cho từng đường nối xe', () => {
  const names = { KHO: 'Kho A', MAY: 'Máy 1' }
  const e = [pool('e1', 'KHO', 'MAY')]

  it('đủ đường đi về thì không cảnh báo; đường nối không phải xe chở thì bỏ qua', () => {
    expect(connectivityProblems(mk(pts, [...fwd, ...back]), e, names)).toEqual([])
    expect(connectivityProblems(mk(pts, []), [{ ...e[0], params: {} }], names)).toEqual([])
  })

  it('mỗi loại lỗi một lời riêng, đều là cảnh báo (không chặn lưu) và gắn khoá đường nối', () => {
    const noPath = connectivityProblems(mk(pts, []), e, names)
    expect(noPath).toEqual([{ key: 'e1', warn: true, message: expect.stringContaining('không có đường đi từ Kho A tới Máy 1') }])
    const noReturn = connectivityProblems(mk(pts, fwd), e, names)
    expect(noReturn[0].message).toContain('đường về')
    const noStation = connectivityProblems(mk([j('A'), j('C')], []), e, names)
    expect(noStation[0].message).toContain('chưa có trạm')
    expect(noStation[0].warn).toBe(true)
  })

  it('bản đồ chưa có điểm nào thì chưa có gì để cảnh báo', () => {
    expect(connectivityProblems(mk([], []), e, names)).toEqual([])
  })
})

import { describe, expect, it } from 'vitest'
import type { AgvMap, GraphEdge, GraphNode } from '../api/types'
import { servedNodes, trayNodes } from './nodeTray'

const node = (key: string, name?: string): GraphNode => ({ key, node_type: 'T', name, params: {} })
const edge = (key: string, src: string, dst: string, mode?: string): GraphEdge => ({ key, src, dst, material: 'X', params: mode ? { mode } : {} })
const map = (stations: [string, string][]): AgvMap => ({
  v: 2, speed_mps: 1, lanes: [],
  points: stations.map(([id, node_key]) => ({ id, x: 0, y: 0, kind: 'station' as const, node_key })),
})

const nodes = [node('KHO', 'Kho A'), node('M1', 'Máy 1'), node('M2', 'Máy 2'), node('OUT', 'Xuất')]
const edges = [edge('e1', 'KHO', 'M1', 'POOL'), edge('e2', 'M1', 'M2'), edge('e3', 'M2', 'OUT', 'DIRECT')]

describe('khay node chưa đặt trên bản đồ', () => {
  it('node ở hai đầu một đường nối xe (POOL) là "cần", node khác thì không', () => {
    const t = trayNodes(nodes, edges, map([]), {}, '')
    expect(Object.fromEntries(t.map((n) => [n.key, n.needed]))).toEqual({ KHO: true, M1: true, M2: false, OUT: false })
  })

  it('đếm số trạm đã đặt cho mỗi node (một node có thể có nhiều chỗ đỗ); điểm không phải trạm không tính', () => {
    const m = map([['S01', 'KHO'], ['S02', 'KHO'], ['S03', 'M1']])
    m.points.push({ id: 'J1', x: 0, y: 0, kind: 'junction', node_key: 'M2' })
    const t = Object.fromEntries(trayNodes(nodes, edges, m, {}, '').map((n) => [n.key, n.stations]))
    expect(t).toEqual({ KHO: 2, M1: 1, M2: 0, OUT: 0 })
  })

  it('xếp: cần mà chưa đặt lên đầu, rồi chưa đặt không cần, cuối cùng là đã đặt; cùng nhóm giữ thứ tự sơ đồ', () => {
    const t = trayNodes(nodes, edges, map([['S01', 'KHO']]), {}, '')
    expect(t.map((n) => n.key)).toEqual(['M1', 'M2', 'OUT', 'KHO'])
  })

  it('tên lấy theo bảng tên (loại node mặc định), không có thì dùng mã', () => {
    const t = trayNodes([node('A'), node('B', 'Tên riêng')], [], map([]), { A: 'Tên từ loại node' }, '')
    expect(t.map((n) => n.name)).toEqual(['Tên từ loại node', 'Tên riêng'])
    expect(trayNodes([node('Z')], [], map([]), {}, '')[0].name).toBe('Z')
  })

  it('lọc theo mã hoặc tên, không phân biệt hoa thường', () => {
    expect(trayNodes(nodes, edges, map([]), {}, 'máy').map((n) => n.key)).toEqual(['M1', 'M2'])
    expect(trayNodes(nodes, edges, map([]), {}, 'KHO').map((n) => n.key)).toEqual(['KHO'])
    expect(trayNodes(nodes, edges, map([]), {}, 'zzz')).toEqual([])
  })

  it('node không có vị trí trên mặt bằng (đội xe, người vận hành) được bỏ khỏi khay', () => {
    const t = trayNodes(nodes, edges, map([]), {}, '', new Set(['M2', 'OUT']))
    expect(t.map((n) => n.key)).toEqual(['KHO', 'M1'])
  })

  it('servedNodes: chỉ node ở đầu hay cuối đường nối do xe chở; máy nhận hàng qua băng chuyền thì không', () => {
    expect([...servedNodes(edges)].sort()).toEqual(['KHO', 'M1'])
    expect(servedNodes([])).toEqual(new Set())
  })

  it('mang theo vai trò và biểu tượng của loại node để khay hiện ô icon; node tự ghi vai trò thì dùng của node', () => {
    const types = { T: { archetype: 'PROCESS', ui: { icon: 'drill' } }, W: { archetype: 'STORAGE' } }
    const list = [node('M1', 'Máy 1'), { ...node('K', 'Kho'), node_type: 'W' }, { ...node('X'), node_type: 'NOPE' }, { ...node('S'), archetype: 'SINK' }]
    const t = Object.fromEntries(trayNodes(list, [], map([]), {}, '', new Set(), types).map((n) => [n.key, [n.archetype, n.icon]]))
    expect(t).toEqual({ M1: ['PROCESS', 'drill'], K: ['STORAGE', undefined], X: [undefined, undefined], S: ['SINK', 'drill'] })
  })
})

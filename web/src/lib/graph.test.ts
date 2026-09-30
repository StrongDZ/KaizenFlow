import { describe, expect, it } from 'vitest'
import type { Graph, NodeType } from '../api/types'
import { defaultMaterial, edgeKey, fromFlow, makeNode, newNodeKey, outputMaterials, toFlow } from './graph'

const types: Record<string, NodeType> = {
  DOCK_IN: { id: 1, code: 'DOCK_IN', name: 'Cửa nhận hàng', archetype: 'SOURCE', param_schema: {}, default_params: {}, signals: [], failure_modes: [], ui: { color: '#111111' }, is_builtin: true },
  PACKING: { id: 2, code: 'PACKING', name: 'Đóng gói', archetype: 'PROCESS', param_schema: {}, default_params: {}, signals: [], failure_modes: [], ui: {}, is_builtin: true },
}

const graph: Graph = {
  version_id: 1, model_key: 'm', version: 1, status: 'DRAFT', settings: {},
  nodes: [
    { key: 'SRC', node_type: 'DOCK_IN', archetype: 'SOURCE', name: '', params: { lots: [{ material: 'RAW-01', qty: 1 }] }, canvas_pos: { x: 10, y: 20 } },
    { key: 'P', node_type: 'PACKING', archetype: 'PROCESS', name: 'Đóng gói A', params: {} },
  ],
  edges: [{ key: 'SRC>P', src: 'SRC', dst: 'P', material: 'RAW-01', params: { mode: 'POOL', pool: 'TUG' } }],
}

describe('graph conversion', () => {
  it('round-trips through React Flow shapes', () => {
    const flow = toFlow(graph, types)
    expect(flow.nodes[0].position).toEqual({ x: 10, y: 20 })
    expect(flow.nodes[0].data.name).toBe('Cửa nhận hàng')
    expect('color' in flow.nodes[0].data).toBe(false)
    expect(flow.nodes[1].position.x).toBeGreaterThan(0)
    expect(flow.edges[0].label).toBe('RAW-01 · TUG')
    const back = fromFlow(flow.nodes, flow.edges)
    expect(back.nodes[0]).toMatchObject({ key: 'SRC', node_type: 'DOCK_IN', canvas_pos: { x: 10, y: 20 } })
    expect(back.edges[0]).toEqual(graph.edges[0])
  })

  it('tells every node which way the diagram runs, from where the nodes sit', () => {
    const vertical: Graph = {
      ...graph,
      nodes: [
        { ...graph.nodes[0], canvas_pos: { x: 0, y: 0 } },
        { ...graph.nodes[1], canvas_pos: { x: 5, y: 200 } },
      ],
    }
    expect(toFlow(vertical, types).nodes.map((n) => n.data.dir)).toEqual(['TB', 'TB'])
    const horizontal: Graph = { ...vertical, nodes: [vertical.nodes[0], { ...vertical.nodes[1], canvas_pos: { x: 300, y: 5 } }] }
    expect(toFlow(horizontal, types).nodes.map((n) => n.data.dir)).toEqual(['LR', 'LR'])
  })

  it('makes a fresh node of a chosen type at a position, with a key no other node has', () => {
    const type = { ...types.DOCK_IN, ui: { icon: 'truck' } }
    const n = makeNode(type, ['DOCK_IN_1', 'SRC'], { x: 12, y: 34 })
    expect(n).toMatchObject({ id: 'DOCK_IN_2', type: 'kf', position: { x: 12, y: 34 } })
    expect(n.data).toMatchObject({ key: 'DOCK_IN_2', nodeType: 'DOCK_IN', archetype: 'SOURCE', name: 'Cửa nhận hàng', params: {}, icon: 'truck' })
  })

  it('carries the type icon onto nodes loaded from a saved diagram', () => {
    const withIcon = { ...types, DOCK_IN: { ...types.DOCK_IN, ui: { icon: 'truck', color: '#111111' } } }
    expect(toFlow(graph, withIcon).nodes[0].data.icon).toBe('truck')
    expect(toFlow(graph, withIcon).nodes[1].data.icon).toBeUndefined()
  })

  it('makes unique keys', () => {
    expect(newNodeKey(['STAMP_PRESS_1'], 'STAMP_PRESS')).toBe('STAMP_PRESS_2')
    expect(newNodeKey([], 'AOI')).toBe('AOI_1')
    expect(edgeKey('A', 'B', ['A>B'])).toBe('A>B#2')
  })

  it('picks a sensible default material', () => {
    const flow = toFlow(graph, types)
    expect(defaultMaterial(flow.nodes[0], ['X'])).toBe('RAW-01')
    const proc = { ...flow.nodes[1], data: { ...flow.nodes[1].data, params: { recipes: [{ inputs: [], outputs: [{ material: 'BOX', qty: 1 }] }] } } }
    expect(defaultMaterial(proc, ['X'])).toBe('BOX')
    expect(defaultMaterial(undefined, ['X'])).toBe('X')
  })

  it('đọc cả mặc định của loại node khi node chưa tự đặt tham số', () => {
    const withDefaults: Record<string, NodeType> = {
      ...types,
      PACKING: { ...types.PACKING, default_params: { recipes: [{ inputs: [], outputs: [{ material: 'BOX', qty: 1 }] }] } },
      RACK: { id: 3, code: 'RACK', name: 'Kho', archetype: 'STORAGE', param_schema: {}, default_params: { stock: [{ material: 'PART' }, { material: 'SUB' }] }, signals: [], failure_modes: [], ui: {}, is_builtin: true },
    }
    const flow = toFlow(graph, withDefaults)
    expect(defaultMaterial(flow.nodes[1], ['X'], withDefaults)).toBe('BOX')
    const store = makeNode(withDefaults.RACK, [], { x: 0, y: 0 })
    expect(outputMaterials(store, withDefaults)).toEqual(['PART', 'SUB'])
    expect(defaultMaterial(store, ['X'], withDefaults)).toBe('PART')
  })

  it('tránh vật tư đã có trên cặp node này, rồi mới tới vật tư bất kỳ trong Thư viện', () => {
    const src = toFlow({ ...graph, nodes: [{ ...graph.nodes[0], params: { lots: [{ material: 'RAW-01', qty: 1 }, { material: 'RAW-02', qty: 1 }] } }, graph.nodes[1]] }, types).nodes[0]
    expect(defaultMaterial(src, ['X'], types, ['RAW-01'])).toBe('RAW-02')
    expect(defaultMaterial(src, ['RAW-01', 'RAW-02', 'Y'], types, ['RAW-01', 'RAW-02'])).toBe('Y')
    expect(defaultMaterial(src, ['RAW-01'], types, ['RAW-01', 'RAW-02'])).toBe('RAW-01') // hết lựa chọn: để bước Kiểm tra báo trùng
  })
})

describe('change detection', () => {
  it('counts only real edits as dirty', async () => {
    const { isEdit } = await import('./graph')
    expect(isEdit({ type: 'select', id: 'a', selected: true })).toBe(false)
    expect(isEdit({ type: 'dimensions', id: 'a' })).toBe(false)
    expect(isEdit({ type: 'position', id: 'a', dragging: false })).toBe(false)
    expect(isEdit({ type: 'position', id: 'a', dragging: true, position: { x: 1, y: 2 } })).toBe(true)
    expect(isEdit({ type: 'remove', id: 'a' })).toBe(true)
  })
})

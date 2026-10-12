import { describe, expect, it } from 'vitest'
import type { Graph, NodeType } from '../api/types'
import { colorOfType, defaultMaterial, edgeKey, fromFlow, makeNode, newNodeKey, outputMaterials, prepareConnection, toFlow, type FlowNode } from './graph'

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
    expect(flow.nodes[0].data.accent).toBe('#111111')
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

  it('đặt một thiết bị đã khai lên sơ đồ: mã node là mã thiết bị, tên lấy theo thiết bị', () => {
    const type = { ...types.DOCK_IN, ui: { icon: 'truck' } }
    const n = makeNode(type, { key: 'CUA_NHAN_1', name: 'Cửa nhận hàng 1' }, { x: 12, y: 34 })
    expect(n).toMatchObject({ id: 'CUA_NHAN_1', type: 'kf', position: { x: 12, y: 34 } })
    expect(n.data).toMatchObject({ key: 'CUA_NHAN_1', nodeType: 'DOCK_IN', archetype: 'SOURCE', name: 'Cửa nhận hàng 1', params: {}, icon: 'truck' })
    // Thiết bị không đặt tên riêng thì lấy tên loại.
    expect(makeNode(type, { key: 'CUA_NHAN_2' }, { x: 0, y: 0 }).data.name).toBe('Cửa nhận hàng')
  })

  it('carries the type icon onto nodes loaded from a saved diagram', () => {
    const withIcon = { ...types, DOCK_IN: { ...types.DOCK_IN, ui: { icon: 'truck', color: '#111111' } } }
    expect(toFlow(graph, withIcon).nodes[0].data.icon).toBe('truck')
    expect(toFlow(graph, withIcon).nodes[0].data.accent).toBe('#111111')
    expect(toFlow(graph, withIcon).nodes[1].data.icon).toBeUndefined()
  })

  it('uses only non-empty ui colors as node accents', () => {
    expect(colorOfType(types.DOCK_IN)).toBe('#111111')
    expect(colorOfType({ ...types.PACKING, ui: { color: '  ' } })).toBeUndefined()
    expect(colorOfType(undefined)).toBeUndefined()
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
    const store = makeNode(withDefaults.RACK, { key: 'KHO_1' }, { x: 0, y: 0 })
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

const processNode = (id: string, params: Record<string, unknown> = {}): FlowNode => ({
  id, type: 'kf', position: { x: 0, y: 0 },
  data: { key: id, nodeType: 'PACKING', archetype: 'PROCESS', name: id, params },
})

describe('smart connection setup', () => {
  it('prefers a material shared by both recipes and uses the destination BOM quantity as lot', () => {
    const src = processNode('A', { recipes: [{ inputs: [], outputs: [{ material: 'PART', qty: 1 }, { material: 'SUB', qty: 1 }] }] })
    const dst = processNode('B', { recipes: [{ inputs: [{ material: 'SUB', qty: 2 }], outputs: [{ material: 'BOX', qty: 1 }] }] })
    const setup = prepareConnection([src, dst], [], 'A', 'B', ['PART', 'SUB', 'BOX'], types)
    expect(setup.material).toBe('SUB')
    expect(setup.params).toEqual({ lot: 2 })
    expect(setup.needsReview).toBe(false)
  })

  it('fills an empty process input from the upstream output without overwriting its output', () => {
    const src = processNode('A', { recipes: [{ inputs: [], outputs: [{ material: 'PART', qty: 1 }] }] })
    const dst = processNode('B', { recipes: [{ inputs: [], outputs: [{ material: 'SUB', qty: 1 }] }] })
    const setup = prepareConnection([src, dst], [], 'A', 'B', ['PART', 'SUB'], types)
    const recipe = (setup.nodes.find((node) => node.id === 'B')!.data.params.recipes as { inputs: { material: string; qty: number }[]; outputs: { material: string }[] }[])[0]
    expect(recipe.inputs).toEqual([{ material: 'PART', qty: 1 }])
    expect(recipe.outputs[0].material).toBe('SUB')
    expect(setup.note).toContain('thêm đầu vào PART ×1 mặc định cho B')
  })

  it('completes both blank process sides with one library material', () => {
    const setup = prepareConnection([processNode('A'), processNode('B')], [], 'A', 'B', ['RAW-01'], types)
    const a = setup.nodes.find((node) => node.id === 'A')!
    const b = setup.nodes.find((node) => node.id === 'B')!
    expect(outputMaterials(a, types)).toEqual(['RAW-01'])
    expect((b.data.params.recipes as { inputs: { material: string }[] }[])[0].inputs[0].material).toBe('RAW-01')
    expect(setup.needsReview).toBe(false)
  })

  it('preserves an existing conflicting BOM and tells the user what to review', () => {
    const src = processNode('A', { recipes: [{ inputs: [], outputs: [{ material: 'PART', qty: 1 }] }] })
    const dst = processNode('B', { recipes: [{ inputs: [{ material: 'SUB', qty: 1 }], outputs: [{ material: 'BOX', qty: 1 }] }] })
    const setup = prepareConnection([src, dst], [], 'A', 'B', ['PART', 'SUB'], types)
    expect(setup.material).toBe('PART')
    expect(setup.nodes.find((node) => node.id === 'B')!.data.params).toEqual(dst.data.params)
    expect(setup.needsReview).toBe(true)
    expect(setup.note).toContain('B đang nhận SUB, không nhận PART')
  })

  it('adds an incoming material to storage tracking automatically', () => {
    const src = processNode('A', { recipes: [{ inputs: [], outputs: [{ material: 'SUB', qty: 1 }] }] })
    const store: FlowNode = {
      id: 'WIP', type: 'kf', position: { x: 0, y: 0 },
      data: { key: 'WIP', nodeType: 'RACK', archetype: 'STORAGE', name: 'Kho WIP', params: { stock: [{ material: 'PART', initial: 4 }] } },
    }
    const setup = prepareConnection([src, store], [], 'A', 'WIP', ['PART', 'SUB'], types)
    expect(setup.nodes.find((node) => node.id === 'WIP')!.data.params.stock).toEqual([
      { material: 'PART', initial: 4 }, { material: 'SUB', initial: 0 },
    ])
  })

  it('configures an empty upstream storage from the destination recipe', () => {
    const store: FlowNode = {
      id: 'WIP', type: 'kf', position: { x: 0, y: 0 },
      data: { key: 'WIP', nodeType: 'RACK', archetype: 'STORAGE', name: 'Kho WIP', params: {} },
    }
    const dst = processNode('B', { recipes: [{ inputs: [{ material: 'PART', qty: 2 }], outputs: [{ material: 'SUB', qty: 1 }] }] })
    const setup = prepareConnection([store, dst], [], 'WIP', 'B', ['PART', 'SUB'], types)
    expect(setup.material).toBe('PART')
    expect(setup.params).toEqual({ lot: 2 })
    expect(setup.nodes.find((node) => node.id === 'WIP')!.data.params.stock).toEqual([{ material: 'PART', initial: 0 }])
  })

  it('warns when the only possible material would duplicate an existing edge', () => {
    const src = processNode('A', { recipes: [{ inputs: [], outputs: [{ material: 'PART', qty: 1 }] }] })
    const dst = processNode('B', { recipes: [{ inputs: [{ material: 'PART', qty: 1 }], outputs: [{ material: 'SUB', qty: 1 }] }] })
    const setup = prepareConnection([src, dst], [{ id: 'A>B', source: 'A', target: 'B', data: { material: 'PART', params: {} } }], 'A', 'B', ['PART'], types)
    expect(setup.material).toBe('PART')
    expect(setup.needsReview).toBe(true)
    expect(setup.note).toContain('đường nối trùng')
  })

  it('does not ask for demand when connecting to a non-throughput scrap sink', () => {
    const src = processNode('QC', { recipes: [{ inputs: [], outputs: [{ material: 'NG', qty: 1, port: 'NG' }] }] })
    const scrap: FlowNode = {
      id: 'SCRAP', type: 'kf', position: { x: 0, y: 0 },
      data: { key: 'SCRAP', nodeType: 'SCRAP', archetype: 'SINK', name: 'Phế phẩm', params: { throughput: false } },
    }
    const setup = prepareConnection([src, scrap], [], 'QC', 'SCRAP', ['NG'], types)
    expect(setup.needsReview).toBe(false)
    expect(setup.note).toContain('Tham số hai đầu đã khớp')
  })

  it('builds PART to SUB for a blank assembly connected between configured neighbours', () => {
    const wip: FlowNode = {
      id: 'WIP', type: 'kf', position: { x: 0, y: 0 },
      data: { key: 'WIP', nodeType: 'RACK', archetype: 'STORAGE', name: 'Kho WIP', params: { stock: [{ material: 'PART', initial: 10 }] } },
    }
    const assy = processNode('ASSY')
    const qc = processNode('QC', { recipes: [{ inputs: [{ material: 'SUB', qty: 1 }], outputs: [{ material: 'SUB_OK', qty: 1 }] }] })
    const incoming = prepareConnection([wip, assy, qc], [], 'WIP', 'ASSY', ['PART', 'SUB'], types)
    const outgoing = prepareConnection(incoming.nodes, [
      { id: 'WIP>ASSY', source: 'WIP', target: 'ASSY', data: { material: incoming.material, params: incoming.params } },
    ], 'ASSY', 'QC', ['PART', 'SUB'], types)
    const recipe = (outgoing.nodes.find((node) => node.id === 'ASSY')!.data.params.recipes as {
      inputs: { material: string; qty: number }[]; outputs: { material: string; qty: number; port: string }[]
    }[])[0]
    expect(recipe).toEqual({
      inputs: [{ material: 'PART', qty: 1 }],
      outputs: [{ material: 'SUB', qty: 1, port: 'OK' }],
    })
  })
})

import { describe, expect, it } from 'vitest'
import type { Graph, NodeType } from '../api/types'
import { defaultMaterial, edgeKey, fromFlow, newNodeKey, toFlow } from './graph'

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
    expect(flow.nodes[0].data.color).toBe('#111111')
    expect(flow.nodes[1].position.x).toBeGreaterThan(0)
    expect(flow.edges[0].label).toBe('RAW-01 · TUG')
    const back = fromFlow(flow.nodes, flow.edges)
    expect(back.nodes[0]).toMatchObject({ key: 'SRC', node_type: 'DOCK_IN', canvas_pos: { x: 10, y: 20 } })
    expect(back.edges[0]).toEqual(graph.edges[0])
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

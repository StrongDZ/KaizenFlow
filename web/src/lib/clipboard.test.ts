import { describe, expect, it } from 'vitest'
import { copyOf, nextKey, pasteOf } from './clipboard'
import type { FlowEdge, FlowNode } from './graph'

const node = (id: string, over: Partial<FlowNode> = {}, archetype = 'PROCESS'): FlowNode => ({
  id, type: 'kf', position: { x: 100, y: 50 },
  data: { key: id, nodeType: 'STAMP_PRESS', archetype, name: id, params: { cycle: 45 } },
  ...over,
})
const edge = (src: string, dst: string, params: Record<string, unknown> = {}): FlowEdge => ({
  id: `${src}>${dst}`, source: src, target: dst, data: { material: 'PART', params }, label: 'PART',
})

describe('nextKey', () => {
  it('counts on from the number a key already ends with', () => {
    expect(nextKey(['STAMP_1', 'STAMP_2'], 'STAMP_1')).toBe('STAMP_3')
    expect(nextKey(['STAMP_1', 'STAMP_3'], 'STAMP_1')).toBe('STAMP_2')
  })
  it('adds a number to a key that has none', () => {
    expect(nextKey(['KHO_NVL'], 'KHO_NVL')).toBe('KHO_NVL_2')
  })
})

describe('copyOf', () => {
  it('takes the selected nodes and only the edges that join two of them', () => {
    const nodes = [node('A', { selected: true }), node('B', { selected: true }), node('C')]
    const edges = [edge('A', 'B'), edge('B', 'C'), edge('C', 'A')]
    const clip = copyOf(nodes, edges)!
    expect(clip.nodes.map((n) => n.id)).toEqual(['A', 'B'])
    expect(clip.edges.map((e) => e.id)).toEqual(['A>B'])
  })
  it('has nothing to copy when nothing is selected', () => {
    expect(copyOf([node('A')], [])).toBeNull()
  })
})

describe('pasteOf', () => {
  const clip = copyOf(
    [node('STAMP_1', { selected: true }), node('WIP', { selected: true }, 'STORAGE')],
    [edge('STAMP_1', 'WIP')],
  )!

  it('gives the copies fresh keys, an offset, and selects only them', () => {
    const out = pasteOf(clip, { nodeKeys: ['STAMP_1', 'WIP'], edgeKeys: ['STAMP_1>WIP'], offset: 40 })
    expect(out.nodes.map((n) => n.id)).toEqual(['STAMP_2', 'WIP_2'])
    expect(out.nodes[0].data.key).toBe('STAMP_2')
    expect(out.nodes[0].position).toEqual({ x: 140, y: 90 })
    expect(out.nodes.every((n) => n.selected === true)).toBe(true)
  })

  it('reconnects the copied edge between the copies, with its own unique key', () => {
    const out = pasteOf(clip, { nodeKeys: ['STAMP_1', 'WIP'], edgeKeys: ['STAMP_1>WIP'], offset: 40 })
    expect(out.edges).toHaveLength(1)
    expect(out.edges[0]).toMatchObject({ id: 'STAMP_2>WIP_2', source: 'STAMP_2', target: 'WIP_2', selected: false })
    expect(out.edges[0].data?.material).toBe('PART')
  })

  it('does not share parameter objects with the originals', () => {
    const out = pasteOf(clip, { nodeKeys: [], edgeKeys: [], offset: 0 })
    expect(out.nodes[0].data.params).toEqual(clip.nodes[0].data.params)
    expect(out.nodes[0].data.params).not.toBe(clip.nodes[0].data.params)
  })

  it('points a copied edge at the copied pool when the pool was copied too, and at the original otherwise', () => {
    const pool = node('TUG_A', { selected: true }, 'RESOURCE_POOL')
    const withPool = copyOf(
      [node('K', { selected: true }, 'STORAGE'), node('S', { selected: true }), pool],
      [edge('K', 'S', { mode: 'POOL', pool: 'TUG_A', hook_pool: 'OPS' })],
    )!
    const out = pasteOf(withPool, { nodeKeys: ['K', 'S', 'TUG_A'], edgeKeys: ['K>S'], offset: 40 })
    expect(out.edges[0].data?.params).toMatchObject({ pool: 'TUG_A_2', hook_pool: 'OPS' })
  })

  it('never reuses a key within one paste', () => {
    const two = copyOf([node('M_1', { selected: true }), node('M_2', { selected: true })], [])!
    const out = pasteOf(two, { nodeKeys: ['M_1', 'M_2'], edgeKeys: [], offset: 0 })
    expect(new Set(out.nodes.map((n) => n.id)).size).toBe(2)
    expect(out.nodes.map((n) => n.id).every((id) => !['M_1', 'M_2'].includes(id))).toBe(true)
  })
})

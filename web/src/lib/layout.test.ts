import { describe, expect, it } from 'vitest'
import { autoLayout, inferDir, type LayoutEdge, type LayoutNode } from './layout'

const box = (id: string, pool = false): LayoutNode => ({ id, w: 140, h: 64, pool })
const e = (source: string, target: string): LayoutEdge => ({ source, target })

function overlaps(pos: Record<string, { x: number; y: number }>, nodes: LayoutNode[]): [string, string][] {
  const bad: [string, string][] = []
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      const a = nodes[i]
      const b = nodes[j]
      const pa = pos[a.id]
      const pb = pos[b.id]
      if (pa.x < pb.x + b.w && pb.x < pa.x + a.w && pa.y < pb.y + b.h && pb.y < pa.y + a.h) bad.push([a.id, b.id])
    }
  }
  return bad
}

// Hai kho nguyên liệu nuôi ba máy dập, một máy lấy từ cả hai kho; hai máy đổ chung vào buffer.
const plant = {
  nodes: ['KHO_A', 'KHO_B', 'M1', 'M2', 'M3', 'BUF'].map((id) => box(id)),
  edges: [e('KHO_A', 'M1'), e('KHO_A', 'M2'), e('KHO_B', 'M2'), e('KHO_B', 'M3'), e('M1', 'BUF'), e('M2', 'BUF'), e('M3', 'BUF')],
}

describe('autoLayout', () => {
  it('lays a chain left to right, one rank per step', () => {
    const nodes = [box('A'), box('B'), box('C')]
    const p = autoLayout(nodes, [e('A', 'B'), e('B', 'C')], 'LR')
    expect(p.A.x).toBeLessThan(p.B.x)
    expect(p.B.x).toBeLessThan(p.C.x)
    expect(Math.abs(p.A.y - p.C.y)).toBeLessThan(2)
  })

  it('lays a chain top to bottom in vertical mode', () => {
    const nodes = [box('A'), box('B'), box('C')]
    const p = autoLayout(nodes, [e('A', 'B'), e('B', 'C')], 'TB')
    expect(p.A.y).toBeLessThan(p.B.y)
    expect(p.B.y).toBeLessThan(p.C.y)
    expect(Math.abs(p.A.x - p.C.x)).toBeLessThan(2)
  })

  it('keeps many-to-many warehouse and machine graphs free of overlaps in both directions', () => {
    for (const dir of ['LR', 'TB'] as const) {
      const p = autoLayout(plant.nodes, plant.edges, dir)
      expect(Object.keys(p).sort()).toEqual(plant.nodes.map((n) => n.id).sort())
      expect(overlaps(p, plant.nodes)).toEqual([])
      const axis = dir === 'LR' ? 'x' : 'y'
      expect(p.KHO_A[axis]).toBeLessThan(p.M1[axis])
      expect(p.M2[axis]).toBeLessThan(p.BUF[axis])
    }
  })

  it('survives a rework loop', () => {
    const nodes = [box('A'), box('B'), box('C')]
    const p = autoLayout(nodes, [e('A', 'B'), e('B', 'C'), e('C', 'A')], 'LR')
    expect(Object.keys(p).sort()).toEqual(['A', 'B', 'C'])
    expect(overlaps(p, nodes)).toEqual([])
  })

  it('ignores edges to unknown nodes, self loops and duplicates', () => {
    const nodes = [box('A'), box('B')]
    const p = autoLayout(nodes, [e('A', 'B'), e('A', 'B'), e('A', 'A'), e('A', 'GHOST'), e('GHOST', 'B')], 'LR')
    expect(Object.keys(p).sort()).toEqual(['A', 'B'])
    expect(p.A.x).toBeLessThan(p.B.x)
  })

  it('parks pools (no edges) outside the flow: below it when horizontal, to its right when vertical', () => {
    const nodes = [...plant.nodes, box('TUG', true), box('OP', true)]
    const flowIds = plant.nodes.map((n) => n.id)
    const lr = autoLayout(nodes, plant.edges, 'LR')
    const flowBottom = Math.max(...flowIds.map((id) => lr[id].y + 64))
    expect(lr.TUG.y).toBeGreaterThanOrEqual(flowBottom)
    expect(lr.OP.y).toBeGreaterThanOrEqual(flowBottom)
    expect(lr.TUG.x).not.toBe(lr.OP.x)
    const tb = autoLayout(nodes, plant.edges, 'TB')
    const flowRight = Math.max(...flowIds.map((id) => tb[id].x + 140))
    expect(tb.TUG.x).toBeGreaterThanOrEqual(flowRight)
    expect(overlaps(lr, nodes)).toEqual([])
    expect(overlaps(tb, nodes)).toEqual([])
  })

  it('starts at the origin with whole-pixel positions', () => {
    const p = autoLayout(plant.nodes, plant.edges, 'LR')
    const xs = Object.values(p).map((q) => q.x)
    const ys = Object.values(p).map((q) => q.y)
    expect(Math.min(...xs)).toBe(0)
    expect(Math.min(...ys)).toBe(0)
    for (const q of Object.values(p)) expect(Number.isInteger(q.x) && Number.isInteger(q.y)).toBe(true)
  })

  it('lays out a diagram made only of pools', () => {
    const nodes = [box('TUG', true), box('OP', true)]
    for (const dir of ['LR', 'TB'] as const) {
      const p = autoLayout(nodes, [], dir)
      expect(Object.keys(p).sort()).toEqual(['OP', 'TUG'])
      expect(overlaps(p, nodes)).toEqual([])
    }
  })

  it('handles an empty graph', () => {
    expect(autoLayout([], [], 'LR')).toEqual({})
  })
})

describe('inferDir', () => {
  it('reads a left-to-right layout as LR and a top-to-bottom one as TB', () => {
    const edges = [e('A', 'B'), e('B', 'C')]
    expect(inferDir({ A: { x: 0, y: 0 }, B: { x: 200, y: 10 }, C: { x: 400, y: 0 } }, edges)).toBe('LR')
    expect(inferDir({ A: { x: 0, y: 0 }, B: { x: 10, y: 150 }, C: { x: 0, y: 300 } }, edges)).toBe('TB')
  })
  it('defaults to LR when there is nothing to judge from', () => {
    expect(inferDir({}, [])).toBe('LR')
    expect(inferDir({ A: { x: 0, y: 0 } }, [e('A', 'GHOST')])).toBe('LR')
  })
})

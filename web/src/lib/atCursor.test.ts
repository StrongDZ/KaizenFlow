import { describe, expect, it } from 'vitest'
import type { BandRow, GraphNode, NodeType } from '../api/types'
import { atCursor, MAX_POOL_CHIPS } from './atCursor'
import { byCode } from './model'
import { indexBands } from './replay'

const types = byCode([
  { id: 1, code: 'RACK', name: 'Kho kệ', archetype: 'STORAGE', param_schema: {}, signals: [], failure_modes: [], ui: {}, is_builtin: true,
    default_params: { coverage_thresholds: { red_h: 1, yellow_low_h: 4, yellow_high_h: 12 } } },
  { id: 2, code: 'TUGGER', name: 'Xe kéo', archetype: 'RESOURCE_POOL', param_schema: {}, signals: [], failure_modes: [], ui: {}, is_builtin: true,
    default_params: { kind: 'TUGGER', count: 2 } },
] satisfies NodeType[])

const node = (key: string, node_type: string, archetype: string): GraphNode => ({ key, node_type, archetype, params: {} })
const nodes = [node('S1', 'RACK', 'STORAGE'), node('S2', 'RACK', 'STORAGE'), node('TUG', 'TUGGER', 'RESOURCE_POOL')]

const T0 = '2026-10-01T01:00:00Z'
const T1 = '2026-10-01T01:01:00Z'
const row = (subject: string, metric: string, t: string, p50: number): BandRow => ({ subject, metric, t, p10: p50, p50, p90: p50 })
const idx = indexBands([
  row('S1', 'coverage_h', T0, 0.5), row('S1', 'coverage_h', T1, 3),
  row('S2', 'coverage_h', T0, 8), row('S2', 'coverage_h', T1, 8),
  row('TUG', 'busy', T0, 2), row('TUG', 'busy', T1, 1),
])

describe('atCursor', () => {
  it('counts red and yellow storages at the cursor time', () => {
    expect(atCursor(idx, nodes, types, Date.parse(T0))).toMatchObject({ red: 1, yellow: 0 })
    expect(atCursor(idx, nodes, types, Date.parse(T1))).toMatchObject({ red: 0, yellow: 1 })
  })

  it('reports resource pools as busy/count with a readable name', () => {
    expect(atCursor(idx, nodes, types, Date.parse(T0)).pools).toEqual([{ key: 'TUG', name: 'Xe kéo', busy: 2, count: 2 }])
    expect(atCursor(idx, nodes, types, Date.parse(T1)).pools[0].busy).toBe(1)
  })

  it('does not break without bands, storages or pools', () => {
    expect(atCursor(indexBands([]), nodes, types, 0)).toEqual({ red: 0, yellow: 0, pools: [] })
    expect(atCursor(idx, [], types, Date.parse(T0))).toEqual({ red: 0, yellow: 0, pools: [] })
  })

  it('shows at most three pool chips', () => {
    const many = ['A', 'B', 'C', 'D'].map((k) => node(k, 'TUGGER', 'RESOURCE_POOL'))
    const rows = many.map((n) => row(n.key, 'busy', T0, 1))
    expect(atCursor(indexBands(rows), many, types, Date.parse(T0)).pools).toHaveLength(MAX_POOL_CHIPS)
  })
})

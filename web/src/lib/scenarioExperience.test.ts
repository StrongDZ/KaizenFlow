import { describe, expect, it } from 'vitest'
import type { Graph, NodeType } from '../api/types'
import { applyScenarioTemplate, comparisonSummarySvg, downstreamKeys, scenarioTemplates, storyBookmarks } from './scenarioExperience'
import { EMPTY_FORM } from './scenarioForm'

const graph: Graph = {
  version_id: 7,
  model_key: 'demo',
  version: 1,
  status: 'PUBLISHED',
  settings: {},
  nodes: [
    { key: 'A', node_type: 'MACHINE', archetype: 'PROCESS', name: 'Máy A', params: {} },
    { key: 'B', node_type: 'MACHINE', archetype: 'PROCESS', name: 'Máy B', params: {} },
    { key: 'POOL', node_type: 'AGV', archetype: 'RESOURCE_POOL', name: 'Đội AGV', params: { count: 2 } },
  ],
  edges: [
    { key: 'A>B', src: 'A', dst: 'B', material: 'PART', params: {} },
    { key: 'B>POOL', src: 'B', dst: 'POOL', material: 'PART', params: {} },
  ],
}

const types: Record<string, NodeType> = {
  MACHINE: { id: 1, code: 'MACHINE', name: 'Máy', archetype: 'PROCESS', param_schema: {}, default_params: {}, signals: [], failure_modes: [{ code: 'JAM' }], ui: {}, is_builtin: false },
  AGV: { id: 2, code: 'AGV', name: 'AGV', archetype: 'RESOURCE_POOL', param_schema: {}, default_params: { count: 2 }, signals: [], failure_modes: [], ui: {}, is_builtin: false },
}

describe('scenario experience', () => {
  it('builds only templates supported by the graph', () => {
    const rows = scenarioTemplates(graph, types)
    expect(rows.find((row) => row.key === 'failure')?.available).toBe(true)
    expect(rows.find((row) => row.key === 'resource')?.available).toBe(true)
  })

  it('creates a valid failure template inside the horizon', () => {
    const value = applyScenarioTemplate('failure', EMPTY_FORM, graph, types)
    expect(value.inj).toEqual([{ target: 'A', kind: 'failure', failure: 'JAM', at_min: 60, duration_min: 30 }])
    expect(value.inj[0].at_min).toBeLessThan(value.hours * 60)
  })

  it('traces downstream nodes without looping forever', () => {
    expect(downstreamKeys(graph, 'A')).toEqual(['A', 'B', 'POOL'])
  })

  it('sorts story milestones and keeps maintenance recovery', () => {
    const rows = storyBookmarks({
      times: [1_000, 2_000, 3_000],
      events: [{ t: new Date(1_500).toISOString(), rep: 0, subject: 'A', type: 'FAILURE', payload: {} }],
      maintenance: [{ target: 'B', from: 1_800, to: 2_500 }],
      zones: [{ from: 2_200, to: 2_800 }],
    })
    expect(rows.map((row) => row.label)).toContain('Kết thúc bảo trì B')
    expect(rows.map((row) => row.t)).toEqual([...rows.map((row) => row.t)].sort((a, b) => a - b))
  })

  it('escapes text in the downloadable comparison image', () => {
    const svg = comparisonSummarySvg({ baselineId: 1, candidateId: 2, candidateName: 'A < B', metrics: [{ label: 'Phút Đỏ', before: 10, after: 4 }] })
    expect(svg).toContain('A &lt; B')
    expect(svg).not.toContain('A < B')
  })
})


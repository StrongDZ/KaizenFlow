import { describe, expect, it } from 'vitest'
import type { Insight } from '../api/types'
import { assignPins, pinsByNode } from './pins'

const ins = (over: Partial<Insight>): Insight => ({
  id: 1, sim_run_id: 1, kind: 'RED_RISK', subject_key: 'WIP', eta: null, probability: 0.8, severity: 3,
  payload: {}, status: 'OPEN', created_at: '', ...over,
})

describe('assignPins', () => {
  it('numbers by severity, then eta, then id', () => {
    const pins = assignPins([
      ins({ id: 3, kind: 'BOTTLENECK', subject_key: 'S3', severity: 2, eta: null }),
      ins({ id: 1, kind: 'RED_RISK', subject_key: 'WIP', severity: 3, eta: '2026-10-01T03:35:00Z' }),
      ins({ id: 2, kind: 'RED_RISK', subject_key: 'FG', severity: 3, eta: '2026-10-01T02:00:00Z' }),
    ])
    expect(pins.map((p) => [p.n, p.node])).toEqual([[1, 'FG'], [2, 'WIP'], [3, 'S3']])
  })

  it('colours red risks red and everything else yellow', () => {
    const pins = assignPins([ins({ id: 1 }), ins({ id: 2, kind: 'BOTTLENECK', severity: 2 }), ins({ id: 3, kind: 'FAULT_RISK', severity: 1 })])
    expect(pins.map((p) => p.tone)).toEqual(['bad', 'warn', 'warn'])
  })

  it('ignores recommendations and insights without a subject', () => {
    const pins = assignPins([
      ins({ id: 1, kind: 'RECOMMENDATION' }),
      ins({ id: 2, subject_key: null }),
      ins({ id: 3 }),
    ])
    expect(pins).toHaveLength(1)
    expect(pins[0].insight.id).toBe(3)
  })

  it('handles empty input and missing severity', () => {
    expect(assignPins([])).toEqual([])
    const pins = assignPins([ins({ id: 1, severity: null }), ins({ id: 2, severity: 1 })])
    expect(pins.map((p) => p.insight.id)).toEqual([2, 1])
  })
})

describe('pinsByNode', () => {
  it('groups several pins on one node in number order', () => {
    const pins = assignPins([
      ins({ id: 1, subject_key: 'S3', severity: 3 }),
      ins({ id: 2, kind: 'BOTTLENECK', subject_key: 'S3', severity: 2 }),
      ins({ id: 3, subject_key: 'WIP', severity: 1 }),
    ])
    const map = pinsByNode(pins)
    expect(map.get('S3')?.map((p) => p.n)).toEqual([1, 2])
    expect(map.get('WIP')?.map((p) => p.n)).toEqual([3])
    expect(map.get('NOPE')).toBeUndefined()
  })
})

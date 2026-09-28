import { describe, expect, it } from 'vitest'
import type { NodeType } from '../api/types'
import { byCode, failureModesOf, poolCount, poolKind, signalsOf, thresholdsFor } from './model'
import { colorFor } from './replay'

const types = byCode([
  { id: 1, code: 'STAMP_PRESS', name: 'Máy dập', archetype: 'PROCESS', param_schema: {}, default_params: {},
    signals: [{ name: 'vibration' }], failure_modes: [{ code: 'bearing_wear' }], ui: {}, is_builtin: true },
  { id: 2, code: 'HOOK_OPERATOR', name: 'Người móc', archetype: 'RESOURCE_POOL', param_schema: {},
    default_params: { kind: 'OPERATOR', count: 1 }, signals: [], failure_modes: [], ui: {}, is_builtin: true },
  { id: 3, code: 'SUPERMARKET', name: 'SM', archetype: 'STORAGE', param_schema: {},
    default_params: { coverage_thresholds: { red_h: 0.5, yellow_low_h: 1.5, yellow_high_h: 6 } }, signals: [], failure_modes: [], ui: {}, is_builtin: true },
] satisfies NodeType[])

describe('catalog lookups', () => {
  it('reads pool kind/count with node override', () => {
    expect(poolKind({ node_type: 'HOOK_OPERATOR', params: {} }, types)).toBe('OPERATOR')
    expect(poolCount({ node_type: 'HOOK_OPERATOR', params: { count: 3 } }, types)).toBe(3)
  })

  it('reads failure modes and signals', () => {
    expect(failureModesOf({ node_type: 'STAMP_PRESS', params: {} }, types)).toEqual(['bearing_wear'])
    expect(signalsOf({ node_type: 'STAMP_PRESS', params: {} }, types)).toEqual(['vibration'])
    expect(failureModesOf({ node_type: 'STAMP_PRESS', params: { failure_modes: [] } }, types)).toEqual([])
  })

  it('merges thresholds and colours like the simulator', () => {
    const th = thresholdsFor({ node_type: 'SUPERMARKET', params: { coverage_thresholds: { red_h: 0.25 } } }, types)
    expect(th).toEqual({ red_h: 0.25, yellow_low_h: 1.5, yellow_high_h: 6 })
    expect(colorFor(0.1, th)).toBe('RED')
    expect(colorFor(1, th)).toBe('YELLOW')
    expect(colorFor(3, th)).toBe('GREEN')
    expect(colorFor(8, th)).toBe('YELLOW')
    expect(colorFor(999, th)).toBe('GREEN')
    expect(colorFor(undefined, th)).toBe('NONE')
  })
})

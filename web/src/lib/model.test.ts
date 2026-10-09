import { describe, expect, it } from 'vitest'
import type { NodeType } from '../api/types'
import { byCode, failureModeOptionsOf, failureModesOf, poolCount, poolKind, signalsOf, thresholdsFor } from './model'
import { colorFor } from './replay'

const types = byCode([
  { id: 1, code: 'STAMP_PRESS', name: 'Máy dập', archetype: 'PROCESS', param_schema: {}, default_params: {},
    signals: [{ name: 'vibration' }], failure_modes: [{ code: 'bearing_wear', label: 'Mòn vòng bi', description: 'Rung tăng dần' }], ui: {}, is_builtin: true },
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
    expect(failureModeOptionsOf({ node_type: 'STAMP_PRESS', params: {} }, types)).toEqual([
      { code: 'bearing_wear', label: 'Mòn vòng bi', description: 'Rung tăng dần' },
    ])
    expect(signalsOf({ node_type: 'STAMP_PRESS', params: {} }, types)).toEqual(['vibration'])
    expect(failureModesOf({ node_type: 'STAMP_PRESS', params: { failure_modes: [] } }, types)).toEqual([])
  })

  it('falls back to the code for custom failure modes without display metadata', () => {
    expect(failureModeOptionsOf({ node_type: 'STAMP_PRESS', params: { failure_modes: [{ code: 'CUSTOM_JAM' }] } }, types))
      .toEqual([{ code: 'CUSTOM_JAM', label: 'CUSTOM_JAM', description: '' }])
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

describe('sensor default', () => {
  it('prefers the machine with an injected fault', async () => {
    const { defaultSensorSubject } = await import('./model')
    expect(defaultSensorSubject(['STAMP_1', 'STAMP_3'], [{ target: 'STAMP_3', failure: 'bearing_wear' }])).toBe('STAMP_3')
    expect(defaultSensorSubject(['STAMP_1', 'STAMP_3'], [{ target: 'NOPE' }])).toBe('STAMP_1')
    expect(defaultSensorSubject([], [])).toBe('')
  })
})

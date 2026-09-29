import { describe, expect, it } from 'vitest'
import { EMPTY_FORM, formToScenarioBody, scenarioToForm } from './scenarioForm'

const sc = {
  name: 'Ca sáng', horizon_s: 14400, replications: 20, start_state: 'WARMUP',
  injections: [{ target: 'STAMP_3', failure: 'bearing_wear', at_s: 7200 }],
  overrides: [{ target: 'TUG', path: '/count', value: 3 }, { target: 'SM', path: '/replenish/rop', value: 40 }],
}

describe('scenario form', () => {
  it('turns a scenario into form rows, keeping unsupported overrides aside', () => {
    const f = scenarioToForm(sc)
    expect(f).toMatchObject({ name: 'Ca sáng', hours: 4, reps: 20, start: 'WARMUP' })
    expect(f.inj).toEqual([{ target: 'STAMP_3', failure: 'bearing_wear', at_min: 120 }])
    expect(f.ovr).toEqual([{ target: 'TUG', count: 3 }])
    expect(f.extra).toEqual([{ target: 'SM', path: '/replenish/rop', value: 40 }])
  })

  it('round-trips without losing anything', () => {
    expect(formToScenarioBody(scenarioToForm(sc))).toEqual({
      name: 'Ca sáng', horizon_s: 14400, replications: 20, start_state: 'WARMUP',
      injections: [{ target: 'STAMP_3', failure: 'bearing_wear', at_s: 7200 }],
      overrides: [{ target: 'TUG', path: '/count', value: 3 }, { target: 'SM', path: '/replenish/rop', value: 40 }],
    })
  })

  it('converts hours and minutes to seconds and trims the name', () => {
    const body = formToScenarioBody({ ...EMPTY_FORM, name: '  Ca tối ', hours: 0.25, inj: [{ target: 'A', failure: 'x', at_min: 1.5 }] })
    expect(body.name).toBe('Ca tối')
    expect(body.horizon_s).toBe(900)
    expect(body.injections).toEqual([{ target: 'A', failure: 'x', at_s: 90 }])
    expect(body.overrides).toEqual([])
  })

  it('handles empty lists and a non-numeric override value', () => {
    const f = scenarioToForm({ ...sc, injections: [], overrides: [{ target: 'TUG', path: '/count', value: 'ba' }] })
    expect(f.inj).toEqual([])
    expect(f.ovr).toEqual([])
    expect(f.extra).toHaveLength(1)
  })
})

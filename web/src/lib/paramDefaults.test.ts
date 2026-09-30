import { describe, expect, it } from 'vitest'
import { defaultAt, placeholderUi } from './paramDefaults'

const defaults = {
  assumed: true,
  cycle: { dist: 'lognorm', mean: 45, cv: 0.15 },
  in_buffer: 40,
  ng_rate: 0.03,
  arrivals: { interarrival: { dist: 'norm', mean: 1800, sd: 120 } },
  coverage_thresholds: { red_h: 1, yellow_low_h: 4 },
  stock: [{ material: 'RAW-01' }],
}

describe('defaultAt', () => {
  it('finds a top-level default from an rjsf field id', () => {
    expect(defaultAt(defaults, 'root_cycle')).toEqual({ dist: 'lognorm', mean: 45, cv: 0.15 })
  })
  it('finds a nested default even though keys themselves contain underscores', () => {
    expect(defaultAt(defaults, 'root_arrivals_interarrival')).toEqual({ dist: 'norm', mean: 1800, sd: 120 })
    expect(defaultAt(defaults, 'root_coverage_thresholds_red_h')).toBe(1)
    expect(defaultAt(defaults, 'root_in_buffer')).toBe(40)
  })
  it('is undefined when the type has no default there (or the path is inside an array)', () => {
    expect(defaultAt(defaults, 'root_mtbf')).toBeUndefined()
    expect(defaultAt(defaults, 'root_stock_0_material')).toBeUndefined()
    expect(defaultAt(defaults, 'root_cycle_nope')).toBeUndefined()
    expect(defaultAt(undefined, 'root_cycle')).toBeUndefined()
  })
})

describe('placeholderUi', () => {
  it('turns numeric defaults into placeholders so an empty box says what it will use', () => {
    const ui = placeholderUi(defaults) as Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(ui.in_buffer['ui:placeholder']).toBe('40')
    expect(ui.ng_rate['ui:placeholder']).toBe('0,03')
    expect(ui.coverage_thresholds.red_h['ui:placeholder']).toBe('1')
  })
  it('skips flags, arrays and text, which have no useful placeholder', () => {
    const ui = placeholderUi(defaults) as Record<string, unknown>
    expect(ui.assumed).toBeUndefined()
    expect(ui.stock).toBeUndefined()
  })
  it('copes with nothing', () => {
    expect(placeholderUi(undefined)).toEqual({})
  })
})

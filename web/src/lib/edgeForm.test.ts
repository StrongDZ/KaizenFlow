import { describe, expect, it } from 'vitest'
import { edgeSchema, edgeToForm, formToEdge } from './edgeForm'

describe('edge form', () => {
  it('maps params to form and back', () => {
    const form = edgeToForm('RAW-01', { mode: 'POOL', pool: 'TUG', hook_pool: 'OPS', lot: 20, travel: { dist: 'norm', mean: 90, sd: 15 }, poll_s: 5 })
    expect(form).toEqual({ material: 'RAW-01', mode: 'POOL', pool: 'TUG', hook_pool: 'OPS', lot: 20, travel_s: 90 })
    const back = formToEdge({ ...form, travel_s: 60 }, { poll_s: 5, mode: 'POOL' })
    expect(back).toEqual({ material: 'RAW-01', params: { poll_s: 5, mode: 'POOL', pool: 'TUG', hook_pool: 'OPS', lot: 20, travel: { dist: 'const', value: 60 } } })
  })

  it('drops pool fields when not POOL', () => {
    expect(formToEdge({ material: 'X', mode: 'NONE', pool: 'TUG', hook_pool: 'OPS', lot: 1 }).params).toEqual({})
  })

  it('schema lists pools and operators', () => {
    const s = edgeSchema(['X'], ['TUG'], ['OPS']) as { properties: Record<string, { enum?: string[] }> }
    expect(s.properties.pool.enum).toEqual(['TUG'])
    expect(s.properties.hook_pool.enum).toEqual(['', 'OPS'])
  })
})

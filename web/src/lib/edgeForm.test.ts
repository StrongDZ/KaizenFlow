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

describe('edge schema for a newcomer', () => {
  type Props = Record<string, { title?: string; enum?: string[]; enumNames?: string[]; oneOf?: { const: string; title: string }[] }>
  const props = (s: unknown) => (s as { properties: Props }).properties

  it('shows the truck pool and hook person only when the edge is carried by a pool', () => {
    expect(Object.keys(props(edgeSchema(['X'], ['TUG'], ['OPS'], { mode: 'NONE' })))).toEqual(['material', 'mode', 'lot', 'travel_s'])
    expect(Object.keys(props(edgeSchema(['X'], ['TUG'], ['OPS'], { mode: 'CONVEYOR' })))).toEqual(['material', 'mode', 'lot', 'travel_s'])
    expect(Object.keys(props(edgeSchema(['X'], ['TUG'], ['OPS'], { mode: 'POOL' })))).toEqual(['material', 'mode', 'pool', 'hook_pool', 'lot', 'travel_s'])
  })

  it('names the transport modes in words instead of NONE / CONVEYOR / POOL', () => {
    const titles = props(edgeSchema(['X'], [], [])).mode.oneOf?.map((o) => o.title)
    expect(titles).toEqual(['Chuyển thẳng, không cần xe', 'Băng chuyền', 'Bằng xe kéo hoặc AGV (dùng đội xe)'])
  })

  it('lists pools and operators by display name with the key beside it', () => {
    const p = props(edgeSchema(['X'], ['TUG'], ['OPS'], { mode: 'POOL', names: { TUG: 'Xe kéo A', OPS: 'Người móc kéo A' } }))
    expect(p.pool.enum).toEqual(['TUG'])
    expect(p.pool.enumNames).toEqual(['Xe kéo A (TUG)'])
    expect(p.hook_pool.enumNames).toEqual(['Không cần', 'Người móc kéo A (OPS)'])
  })

  it('says so when the diagram has no pool to choose yet', () => {
    expect(props(edgeSchema(['X'], [], [], { mode: 'POOL' })).pool.enumNames).toEqual(['(chưa có đội xe nào trong sơ đồ)'])
  })
})

describe('travel distribution is preserved', () => {
  it('keeps a stochastic travel time when the form did not change it', () => {
    const prev = { mode: 'POOL', pool: 'TUG', travel: { dist: 'norm', mean: 90, sd: 15 } }
    const form = edgeToForm('RAW-01', prev)
    expect(formToEdge({ ...form, lot: 20 }, prev).params.travel).toEqual({ dist: 'norm', mean: 90, sd: 15 })
    expect(formToEdge({ ...form, travel_s: 120 }, prev).params.travel).toEqual({ dist: 'const', value: 120 })
  })
})

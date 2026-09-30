import { describe, expect, it } from 'vitest'
import type { NodeType } from '../api/types'
import { searchTypes } from './nodeSearch'

const t = (code: string, name: string, archetype: string): NodeType =>
  ({ id: 1, code, name, archetype, param_schema: {}, default_params: {}, signals: [], failure_modes: [], ui: {}, is_builtin: true }) as NodeType

const types = [
  t('STAMP_PRESS', 'Máy dập', 'PROCESS'),
  t('TUGGER', 'Xe kéo (tugger)', 'RESOURCE_POOL'),
  t('SHIP_DOCK', 'Cửa xuất hàng', 'SINK'),
  t('RACK_WAREHOUSE', 'Kho kệ', 'STORAGE'),
  t('DOCK_IN', 'Cửa nhận hàng', 'SOURCE'),
  t('PACKING', 'Trạm đóng gói', 'PROCESS'),
]

describe('searchTypes', () => {
  it('lists everything in flow order (sources first, pools last) when the box is empty', () => {
    expect(searchTypes(types, '').map((x) => x.code)).toEqual(['DOCK_IN', 'RACK_WAREHOUSE', 'STAMP_PRESS', 'PACKING', 'SHIP_DOCK', 'TUGGER'])
  })
  it('finds Vietnamese names typed without accents', () => {
    expect(searchTypes(types, 'may dap').map((x) => x.code)).toEqual(['STAMP_PRESS'])
    expect(searchTypes(types, 'CUA').map((x) => x.code).sort()).toEqual(['DOCK_IN', 'SHIP_DOCK'])
  })
  it('finds by code too', () => {
    expect(searchTypes(types, 'stamp').map((x) => x.code)).toEqual(['STAMP_PRESS'])
    expect(searchTypes(types, 'warehouse').map((x) => x.code)).toEqual(['RACK_WAREHOUSE'])
  })
  it('puts names that start with the text before names that only contain it', () => {
    expect(searchTypes(types, 'k').map((x) => x.code).slice(0, 2)).toEqual(['RACK_WAREHOUSE', 'TUGGER'])
  })
  it('can leave out types that make no sense in this spot', () => {
    const noPool = searchTypes(types, '', { allow: (x) => x.archetype !== 'RESOURCE_POOL' })
    expect(noPool.map((x) => x.code)).not.toContain('TUGGER')
  })
  it('returns nothing when nothing matches', () => {
    expect(searchTypes(types, 'zzzz')).toEqual([])
  })
})

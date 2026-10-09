import { describe, expect, it } from 'vitest'
import type { NodeType } from '../api/types'
import { designRows, effectiveParams } from './nodeSummary'

describe('designRows', () => {
  it('tóm tắt nguồn bằng lô hàng và nhịp đến', () => {
    expect(designRows('SOURCE', { lots: [{ material: 'RAW-01', qty: 150 }], arrivals: { interarrival: { dist: 'norm', mean: 1800, sd: 120 } } })).toEqual([
      { label: 'Mỗi lô', value: '150 RAW-01' }, { label: 'Cách nhau', value: '~30 phút' },
    ])
  })

  it('kho: tổng tồn đầu trên sức chứa và danh sách vật tư rút gọn', () => {
    expect(designRows('STORAGE', { stock: [{ material: 'PART', initial: 60, max: 400 }, { material: 'SUB', initial: 30, max: 200 }] })).toEqual([
      { label: 'Tồn đầu', value: '90 / 600' }, { label: 'Vật tư', value: 'PART, SUB' },
    ])
    expect(designRows('STORAGE', { stock: [{ material: 'A', initial: 1200 }, { material: 'B' }, { material: 'C' }] })).toEqual([
      { label: 'Tồn đầu', value: '1.200' }, { label: 'Vật tư', value: 'A, B +1' },
    ])
    expect(designRows('STORAGE', { capacity: 2000 })).toEqual([{ label: 'Sức chứa', value: '2.000' }])
  })

  it('trạm: chu kỳ và công thức, bỏ đầu ra NG', () => {
    expect(designRows('PROCESS', {
      cycle: { dist: 'lognorm', mean: 45, cv: 0.15 },
      recipes: [{ inputs: [{ material: 'PART', qty: 2 }], outputs: [{ material: 'SUB', port: 'OK', qty: 1 }, { material: 'SUB_NG', port: 'NG', qty: 1 }] }],
    })).toEqual([{ label: 'Chu kỳ', value: '~45 giây' }, { label: 'Công thức', value: '2 PART → SUB' }])
    expect(designRows('PROCESS', { cycle: { dist: 'const', value: 90 }, slots: 2 })).toEqual([
      { label: 'Chu kỳ', value: '1,5 phút' }, { label: 'Song song', value: '2 vị trí' },
    ])
  })

  it('đích và đội xe', () => {
    expect(designRows('SINK', { demand: [{ kind: 'TAKT', material: 'BOX', takt: { dist: 'exp', mean: 420 } }] })).toEqual([{ label: 'Nhu cầu', value: '1 BOX mỗi ~7 phút' }])
    expect(designRows('SINK', { throughput: false })).toEqual([{ label: 'Nhận', value: 'hàng loại, không tính sản lượng' }])
    expect(designRows('RESOURCE_POOL', { count: 2, kind: 'AMR', service: { dist: 'const', value: 25 } })).toEqual([
      { label: 'Số lượng', value: '2 AMR' }, { label: 'Mỗi lượt', value: '25 giây' },
    ])
    expect(designRows('RESOURCE_POOL', { count: 1, kind: 'OPERATOR' })[0].value).toBe('1 người')
  })

  it('không có gì để nói thì trả rỗng, và không quá hai dòng', () => {
    expect(designRows('SINK', {})).toEqual([])
    expect(designRows('X', { a: 1 })).toEqual([])
    expect(designRows('PROCESS', { cycle: 30, recipes: [{ inputs: [{ material: 'A' }], outputs: [{ material: 'B' }] }], slots: 3 })).toHaveLength(2)
  })
})

describe('effectiveParams', () => {
  it('tham số của node đè mặc định của loại', () => {
    const t = { default_params: { count: 3, kind: 'AGV' } } as unknown as NodeType
    expect(effectiveParams({ count: 2 }, t)).toEqual({ count: 2, kind: 'AGV' })
    expect(effectiveParams({ a: 1 }, undefined)).toEqual({ a: 1 })
  })
})

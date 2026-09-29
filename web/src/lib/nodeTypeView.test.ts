import { describe, expect, it } from 'vitest'
import type { NodeType } from '../api/types'
import { describeDist, failureModeRows, fmtSeconds, isAssumed, paramGroups, recipeOf, signalDefRows } from './nodeTypeView'

const stamp = {
  archetype: 'PROCESS',
  default_params: { assumed: true, cycle: { dist: 'lognorm', mean: 45, cv: 0.15 }, in_buffer: 40, out_buffer: 20, ng_rate: 0.012,
    mtbf: { dist: 'exp', mean: 21600 }, mttr: { dist: 'const', value: 1500 } },
  signals: [{ name: 'vibration', unit: 'mm/s', base: { dist: 'normal', mean: 0.42, sd: 0.08 }, hz: 0.2 }],
  failure_modes: [{ code: 'bearing_wear', onset: { dist: 'weibull', shape: 2, scale_s: 604800 },
    p_to_f: { dist: 'tri', min_s: 3600, mode_s: 5400, max_s: 7200 }, effects: [{ signal: 'vibration', kind: 'exp', mag_sd: 3 }],
    on_fail: { state: 'DOWN', mttr: { dist: 'lognorm', mean_s: 3600, cv: 0.3 } } }],
} as unknown as NodeType

describe('fmtSeconds', () => {
  it('picks a readable unit', () => {
    expect(fmtSeconds(8)).toBe('8 giây')
    expect(fmtSeconds(1500)).toBe('25 phút')
    expect(fmtSeconds(3600)).toBe('1 giờ')
    expect(fmtSeconds(5400)).toBe('1,5 giờ')
    expect(fmtSeconds(21600)).toBe('6 giờ')
  })
})

describe('describeDist', () => {
  it('describes each distribution in Vietnamese', () => {
    expect(describeDist(45)).toBe('45 giây')
    expect(describeDist({ dist: 'lognorm', mean: 45, cv: 0.15 })).toBe('log-normal, trung bình 45 giây, cv 0,15')
    expect(describeDist({ dist: 'norm', mean: 30, sd: 5 })).toBe('chuẩn, trung bình 30 giây, độ lệch 5')
    expect(describeDist({ dist: 'exp', mean: 1800 })).toBe('mũ, trung bình 30 phút')
    expect(describeDist({ dist: 'const', value: 30 })).toBe('30 giây')
    expect(describeDist({ dist: 'tri', min: 20, mode: 30, max: 60 })).toBe('tam giác 20 giây, 30 giây, 60 giây')
    expect(describeDist({ dist: 'uniform', min: 10, max: 20 })).toBe('đều từ 10 giây đến 20 giây')
    expect(describeDist({ dist: 'weibull', shape: 2, scale_s: 3600 })).toBe('Weibull, shape 2, scale 1 giờ')
  })
  it('uses the given unit for non-time quantities and survives junk', () => {
    expect(describeDist({ dist: 'normal', mean: 0.42, sd: 0.08 }, 'mm/s')).toBe('chuẩn, trung bình 0,42 mm/s, độ lệch 0,08')
    expect(describeDist(undefined)).toBe('—')
    expect(describeDist('lạ')).toBe('—')
    expect(describeDist({ dist: 'khác' })).toBe('khác')
  })
})

describe('paramGroups', () => {
  it('groups a process type by OEE component', () => {
    const groups = paramGroups(stamp)
    expect(groups.map((g) => g.title)).toEqual(['Hiệu suất', 'Chất lượng', 'Khả dụng'])
    expect(groups[0].rows).toContainEqual({ label: 'Thời gian chu kỳ', value: 'log-normal, trung bình 45 giây, cv 0,15' })
    expect(groups[0].rows).toContainEqual({ label: 'Bộ đệm vào', value: '40' })
    expect(groups[1].rows).toEqual([{ label: 'Tỉ lệ NG', value: '1,2%' }])
    expect(groups[2].rows.map((r) => r.label)).toEqual(['MTBF', 'MTTR'])
  })
  it('describes storage thresholds and pools', () => {
    const rack = paramGroups({ archetype: 'STORAGE', default_params: { capacity: 2000, coverage_thresholds: { red_h: 1, yellow_low_h: 4, yellow_high_h: 12 } } })
    expect(rack[0].rows).toContainEqual({ label: 'Ngưỡng tồn kho', value: 'Đỏ dưới 1 giờ, Vàng dưới 4 giờ hoặc trên 12 giờ' })
    const pool = paramGroups({ archetype: 'RESOURCE_POOL', default_params: { kind: 'TUGGER', count: 2, service: { dist: 'const', value: 30 } } })
    expect(pool[0].rows).toEqual([
      { label: 'Loại', value: 'TUGGER' }, { label: 'Số lượng', value: '2' }, { label: 'Thời gian phục vụ', value: '30 giây' },
    ])
  })
  it('keeps unknown keys under "Khác" and ignores markers', () => {
    const g = paramGroups({ archetype: 'SINK', default_params: { assumed: true, buffer: 2, mystery: { a: 1 } } })
    expect(g.map((x) => x.title)).toEqual(['Tham số', 'Khác'])
    expect(g[1].rows).toEqual([{ label: 'mystery', value: '{"a":1}' }])
  })
  it('returns no groups for empty defaults', () => {
    expect(paramGroups({ archetype: 'SOURCE', default_params: {} })).toEqual([])
  })
})

describe('isAssumed and recipeOf', () => {
  it('reads the assumed marker', () => {
    expect(isAssumed(stamp)).toBe(true)
    expect(isAssumed({ default_params: {} })).toBe(false)
  })
  it('reads the first recipe and returns null when there is none', () => {
    expect(recipeOf(stamp)).toBeNull()
    const r = recipeOf({ default_params: { recipes: [{ inputs: [{ material: 'A', qty: 1 }],
      outputs: [{ material: 'B', qty: 1, port: 'OK' }, { material: 'C', qty: 1, port: 'NG' }] }] } } as unknown as NodeType)
    expect(r?.inputs).toEqual([{ material: 'A', qty: 1 }])
    expect(r?.outputs.map((o) => o.port)).toEqual(['OK', 'NG'])
  })
})

describe('failure modes and signals', () => {
  it('summarises a P–F failure mode', () => {
    expect(failureModeRows(stamp)).toEqual([{
      code: 'bearing_wear', onset: 'Weibull, shape 2, scale 168 giờ', pf: 'từ 1 giờ đến 2 giờ',
      repair: 'log-normal, trung bình 1 giờ, cv 0,3', effects: ['vibration: exp'],
    }])
    expect(failureModeRows({ failure_modes: [] } as unknown as NodeType)).toEqual([])
  })
  it('summarises sensor definitions', () => {
    expect(signalDefRows(stamp)).toEqual([{ name: 'vibration', unit: 'mm/s', rate: '0,2 Hz', base: 'chuẩn, trung bình 0,42 mm/s, độ lệch 0,08' }])
    expect(signalDefRows({ signals: [{ name: 'x' }] } as unknown as NodeType)).toEqual([{ name: 'x', unit: '', rate: '—', base: '—' }])
  })
})

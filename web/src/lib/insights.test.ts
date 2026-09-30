import { describe, expect, it } from 'vitest'
import type { Insight } from '../api/types'
import { candidatesOf, describeAction, describeInsight, insightDetail, kpiBand, kpiP50 } from './insights'

const base: Insight = { id: 1, sim_run_id: 1, kind: 'RED_RISK', subject_key: 'FG', eta: '2026-10-01T01:30:00Z',
  probability: 0.8, severity: 3, payload: {}, status: 'OPEN', created_at: '' }

describe('insights', () => {
  it('describes insights in Vietnamese', () => {
    expect(describeInsight(base)).toContain('FG có 80% khả năng chuyển Đỏ')
    expect(describeInsight({ ...base, kind: 'BOTTLENECK', subject_key: 'STAMP_1', probability: 0.9 })).toContain('Bottleneck: STAMP_1')
  })

  it('reads candidates and describes actions', () => {
    const rec = { ...base, kind: 'RECOMMENDATION' as const, payload: { candidates: [
      { rank: 1, action: { type: 'PLANNED_STOP', target: 'STAMP_3', at_s: 1800, duration_s: 1800, cost: 2 },
        delta_kpi: { red_minutes: 13.4, throughput: 0.8 }, score: 6.7 }] } }
    const c = candidatesOf(rec)
    expect(c).toHaveLength(1)
    expect(describeAction(c[0].action)).toBe('Dừng bảo trì STAMP_3 ở phút 30, trong 30 phút')
    expect(describeAction({ type: 'REALLOCATE_OPERATOR', target: 'OPS', cost: 1 })).toBe('Điều thêm 1 người vào OPS')
    expect(candidatesOf(base)).toEqual([])
  })

  it('reads kpi p50', () => {
    expect(kpiP50({ throughput: { p50: 42 } }, 'throughput')).toBe(42)
    expect(kpiP50(null, 'throughput')).toBeUndefined()
  })
})

describe('pin details', () => {
  it('reads the p10–p90 band of a kpi', () => {
    expect(kpiBand({ red_minutes: { p10: 1, p50: 2, p90: 3 } }, 'red_minutes')).toEqual({ p10: 1, p50: 2, p90: 3 })
    expect(kpiBand({ red_minutes: { p50: 2 } }, 'red_minutes')).toBeUndefined()
    expect(kpiBand(null, 'x')).toBeUndefined()
  })

  it('describes fault risk', () => {
    expect(describeInsight({ ...base, kind: 'FAULT_RISK', subject_key: 'STAMP_3', eta: null, probability: 0.82 })).toBe('STAMP_3 có nguy cơ hỏng (82%)')
  })

  it('explains each insight kind on the second line', () => {
    expect(insightDetail(base)).toBe('80% số lần lặp')
    expect(insightDetail({ ...base, kind: 'BOTTLENECK', probability: 0.61, payload: { method: 'active_period' } })).toBe('là điểm nghẽn 61% thời gian')
    expect(insightDetail({ ...base, kind: 'BOTTLENECK', probability: 1, payload: { method: 'wait_pool_mean', mean_s: 240 } })).toBe('chờ trung bình 4 phút')
    expect(insightDetail({ ...base, kind: 'RECOMMENDATION' })).toBe('')
  })
})

import { describeDrift } from './insights'

describe('describeDrift', () => {
  const drift = (payload: Record<string, unknown>) => ({
    id: 1, sim_run_id: 9, kind: 'DRIFT' as const, subject_key: 'KHO_A', eta: null, probability: null, severity: 2, payload, status: 'OPEN', created_at: '',
  })
  it('nói rõ kho, vật tư, lệch về phía nào và dải dự báo', () => {
    const p = { metric: 'level:RAW-01', direction: 'below', actual: 41.6, p10: 88.2, p90: 109.9 }
    expect(describeDrift(drift(p), (k) => (k === 'KHO_A' ? 'Kho NVL A' : k)))
      .toBe('Kho NVL A · RAW-01 đang thấp hơn dự báo: thực tế 42, dải dự báo 88–110')
    expect(describeDrift(drift({ ...p, direction: 'above', actual: 200 }))).toBe('KHO_A · RAW-01 đang cao hơn dự báo: thực tế 200, dải dự báo 88–110')
  })
  it('thiếu số liệu thì vẫn ra câu đọc được', () => {
    expect(describeDrift(drift({}))).toBe('KHO_A đang lệch dự báo')
  })
  it('describeInsight dùng chung câu này cho DRIFT', () => {
    const ins = drift({ metric: 'level:X', direction: 'below', actual: 1, p10: 5, p90: 9 })
    expect(describeInsight(ins)).toContain('thấp hơn dự báo')
  })
})

import { describe, expect, it } from 'vitest'
import type { Insight } from '../api/types'
import { candidatesOf, describeAction, describeInsight, kpiP50 } from './insights'

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

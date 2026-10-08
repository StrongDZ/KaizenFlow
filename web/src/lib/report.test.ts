import { describe, expect, it } from 'vitest'
import type { Insight, Run } from '../api/types'
import { appliedVerdict, failureImpactsOf, pickParentBaseline, reportMetricText } from './report'

const run = (id: number, created: string, simStart = '2026-10-01T01:00:00Z', red = 10, throughput = 20): Run => ({
  id, scenario_id: 1, purpose: 'FORECAST', status: 'DONE', sim_start: simStart,
  kpis: { red_minutes: { p50: red }, throughput: { p50: throughput } }, error: null, engine_version: 'x',
  created_at: created, finished_at: created,
})

describe('report helpers', () => {
  it('selects the exact source run from child seed when the parent has no fixed seed', () => {
    const current = run(20, '2026-10-01T03:00:00Z')
    expect(pickParentBaseline([
      run(8, '2026-10-01T01:00:00Z'), run(12, '2026-10-01T02:00:00Z'),
    ], current, 8, null)?.id).toBe(8)
  })

  it('selects the latest same-start run for a parent with a fixed seed', () => {
    const current = run(20, '2026-10-01T03:00:00Z')
    expect(pickParentBaseline([
      run(8, '2026-10-01T02:30:00Z', '2026-09-30T01:00:00Z'),
      run(12, '2026-10-01T02:00:00Z'),
    ], current, 42, 42)?.id).toBe(12)
  })

  it('keeps meaningful small deltas and never prints negative zero', () => {
    expect(reportMetricText(0.05, '', true)).toBe('+0,05')
    expect(reportMetricText(-0.00001, '', true)).toBe('0')
    expect(reportMetricText(-0.0008, ' phút', true)).toBe('0 phút')
  })

  it('evaluates applied results from actual P50 KPIs', () => {
    expect(appliedVerdict(run(1, '2026-10-01T01:00:00Z'), run(2, '2026-10-01T02:00:00Z', undefined, 8, 21)).tone).toBe('good')
    expect(appliedVerdict(run(1, '2026-10-01T01:00:00Z'), run(2, '2026-10-01T02:00:00Z', undefined, 8, 18)).tone).toBe('warn')
  })

  it('reads failure impacts only from recommendation payloads', () => {
    const insights = [{ kind: 'RECOMMENDATION', payload: { failure_impacts: [{ failed_machine: 'STAMP_1', downtime_s: 1800 }] } }] as unknown as Insight[]
    expect(failureImpactsOf(insights)).toEqual([{ failed_machine: 'STAMP_1', downtime_s: 1800 }])
  })
})

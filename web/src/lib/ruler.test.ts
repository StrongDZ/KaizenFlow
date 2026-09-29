import { describe, expect, it } from 'vitest'
import type { BandRow, EventRow, GraphNode, NodeType } from '../api/types'
import { byCode } from './model'
import { indexBands } from './replay'
import { failureMarks, hourTicks, minorEvery, nearestIndex, pct, redZones, rulerOf, tFromPct } from './ruler'

describe('rulerOf', () => {
  it('uses the median gap as the step', () => {
    expect(rulerOf([0, 60_000, 120_000, 300_000])).toEqual({ start: 0, end: 300_000, step: 60_000 })
  })
  it('survives empty and single-sample timelines', () => {
    expect(rulerOf([])).toEqual({ start: 0, end: 0, step: 60_000 })
    expect(rulerOf([5_000])).toEqual({ start: 5_000, end: 5_000, step: 60_000 })
  })
})

describe('pct and tFromPct', () => {
  const r = { start: 1000, end: 3000, step: 1000 }
  it('maps and clamps', () => {
    expect(pct(r, 2000)).toBe(50)
    expect(pct(r, 0)).toBe(0)
    expect(pct(r, 9999)).toBe(100)
    expect(tFromPct(r, 25)).toBe(1500)
    expect(tFromPct(r, 150)).toBe(3000)
  })
  it('never divides by zero', () => {
    expect(pct({ start: 5, end: 5, step: 1 }, 5)).toBe(0)
  })
})

describe('nearestIndex', () => {
  const times = [0, 60, 120]
  it('picks the closest sample, earlier on ties', () => {
    expect(nearestIndex(times, 50)).toBe(1)
    expect(nearestIndex(times, 20)).toBe(0)
    expect(nearestIndex(times, 30)).toBe(0)
    expect(nearestIndex(times, -5)).toBe(0)
    expect(nearestIndex(times, 500)).toBe(2)
    expect(nearestIndex([], 5)).toBe(0)
    expect(nearestIndex([7], 100)).toBe(0)
  })
})

describe('hourTicks', () => {
  it('returns whole local hours inside the range', () => {
    const start = new Date(2026, 9, 1, 8, 30).getTime()
    const end = new Date(2026, 9, 1, 11, 0).getTime()
    const ticks = hourTicks({ start, end, step: 60_000 })
    expect(ticks.map((t) => new Date(t.t).getHours())).toEqual([9, 10, 11])
    expect(ticks[0].pct).toBeCloseTo(20)
    expect(hourTicks({ start: 1, end: 1, step: 1 })).toEqual([])
  })
})

describe('minorEvery', () => {
  it('thins ticks when samples are dense', () => {
    expect(minorEvery(480)).toBe(10)
    expect(minorEvery(20)).toBe(1)
    expect(minorEvery(1)).toBe(1)
    expect(minorEvery(0)).toBe(1)
  })
})

describe('redZones', () => {
  const types = byCode([
    { id: 1, code: 'RACK', name: 'Kho', archetype: 'STORAGE', param_schema: {}, signals: [], failure_modes: [], ui: {}, is_builtin: true,
      default_params: { coverage_thresholds: { red_h: 1, yellow_low_h: 4, yellow_high_h: 12 } } },
  ] satisfies NodeType[])
  const n = (key: string): GraphNode => ({ key, node_type: 'RACK', archetype: 'STORAGE', params: {} })
  const row = (subject: string, min: number, p50: number): BandRow => ({
    subject, metric: 'coverage_h', t: new Date(Date.UTC(2026, 9, 1, 1, min)).toISOString(), p10: p50, p50, p90: p50,
  })
  const at = (min: number) => Date.UTC(2026, 9, 1, 1, min)

  it('merges red spans of several storages into one zone list', () => {
    const idx = indexBands([
      row('A', 0, 5), row('A', 1, 0.5), row('A', 2, 0.5), row('A', 3, 5),
      row('B', 2, 0.2), row('B', 3, 0.2), row('B', 4, 5),
    ])
    expect(redZones(idx, [n('A'), n('B')], types, 60_000)).toEqual([{ from: at(1), to: at(4) }])
  })

  it('returns nothing when no storage is red or there are no bands', () => {
    expect(redZones(indexBands([row('A', 0, 5)]), [n('A')], types, 60_000)).toEqual([])
    expect(redZones(indexBands([]), [n('A')], types, 60_000)).toEqual([])
  })

  it('closes the last open zone with one step', () => {
    expect(redZones(indexBands([row('A', 0, 0.1)]), [n('A')], types, 60_000)).toEqual([{ from: at(0), to: at(1) }])
  })
})

describe('failureMarks', () => {
  const ev = (rep: number, type: string, t: string): EventRow => ({ t, rep, subject: 'S3', type, payload: {} })
  it('keeps rep 0 failures only, sorted and de-duplicated', () => {
    const marks = failureMarks([
      ev(0, 'FAILURE', '2026-10-01T03:00:00Z'), ev(1, 'FAILURE', '2026-10-01T02:00:00Z'),
      ev(0, 'REPAIRED', '2026-10-01T03:56:00Z'), ev(0, 'FAILURE', '2026-10-01T03:00:00Z'),
    ])
    expect(marks).toEqual([Date.parse('2026-10-01T03:00:00Z')])
    expect(failureMarks([])).toEqual([])
  })
})

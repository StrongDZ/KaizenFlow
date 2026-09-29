import { describe, expect, it } from 'vitest'
import type { BandRow } from '../api/types'
import { clip, indexBands, series, timeline, valueAt } from './replay'

const rows: BandRow[] = [
  { subject: 'FG', metric: 'coverage_h', t: '2026-10-01T01:01:00Z', p10: 1, p50: 2, p90: 3 },
  { subject: 'FG', metric: 'coverage_h', t: '2026-10-01T01:00:00Z', p10: 0, p50: 5, p90: 999 },
  { subject: 'TUG', metric: 'busy', t: '2026-10-01T01:02:00Z', p10: 1, p50: 2, p90: 2 },
]

describe('replay', () => {
  it('indexes and sorts series by time', () => {
    const idx = indexBands(rows)
    const fg = series(idx, 'FG', 'coverage_h')
    expect(fg.map((p) => p.p50)).toEqual([5, 2])
    expect(series(idx, 'NOPE', 'x')).toEqual([])
    expect(timeline(idx)).toHaveLength(3)
  })

  it('looks up the last point at or before t', () => {
    const fg = series(indexBands(rows), 'FG', 'coverage_h')
    const t0 = Date.parse('2026-10-01T01:00:00Z')
    expect(valueAt(fg, t0 - 1)?.p50).toBe(5)
    expect(valueAt(fg, t0 + 30_000)?.p50).toBe(5)
    expect(valueAt(fg, t0 + 60_000)?.p50).toBe(2)
    expect(valueAt([], t0)).toBeUndefined()
  })

  it('clips huge coverage for charts', () => {
    const fg = clip(series(indexBands(rows), 'FG', 'coverage_h'), 24)
    expect(fg[0].p90).toBe(24)
    expect(fg[1].p90).toBe(3)
  })
})

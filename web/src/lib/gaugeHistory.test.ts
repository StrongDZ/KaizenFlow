import { describe, expect, it } from 'vitest'
import type { HistoryPoint } from '../api/gauge'
import {
  axisLabel, durationLabel, gapLimit, historyEvents, historyStats, nearestSample, rangeBounds, segments, timeTicks, valueDomain,
} from './gaugeHistory'

const T0 = Date.parse('2026-10-08T03:00:00Z')
function point(offsetS: number, value: number | null, min = value, max = value, n = 1): HistoryPoint {
  return { ts: new Date(T0 + offsetS * 1000).toISOString(), value, min, max, quality: null, n }
}

describe('rangeBounds', () => {
  it('counts a preset back from now, rounded down to the step', () => {
    expect(rangeBounds({ preset: '1h' }, T0 + 7_000)).toEqual({ from: T0 - 3_600_000, to: T0 })
  })

  it('keeps a chosen range as it is', () => {
    expect(rangeBounds({ from: 5, to: 9 }, T0)).toEqual({ from: 5, to: 9 })
  })
})

describe('gapLimit', () => {
  it('follows the bucket, and waits longer for a counter', () => {
    expect(gapLimit(1, 'seg7')).toBe(5_000)
    expect(gapLimit(60, 'seg7')).toBe(180_000)
    expect(gapLimit(1, 'rolling_counter')).toBe(180_000)
    expect(gapLimit(600, 'rolling_counter')).toBe(1_800_000)
  })
})

describe('segments', () => {
  it('cuts where the data stops for longer than the limit', () => {
    const parts = segments([point(0, 1), point(10, 2), point(100, 3)], 30_000)
    expect(parts.map((s) => s.map((p) => p.value))).toEqual([[1, 2], [3]])
  })

  it('leaves out the buckets that gave no value', () => {
    const parts = segments([point(0, 1), point(10, null), point(20, null), point(30, null), point(40, 5)], 30_000)
    expect(parts.map((s) => s.map((p) => p.value))).toEqual([[1], [5]])
  })

  it('falls back to the value when a bucket has no extremes', () => {
    expect(segments([{ ...point(0, 4), min: null, max: null }], 1000)[0][0]).toEqual({ t: T0, value: 4, min: 4, max: 4 })
  })
})

describe('historyEvents', () => {
  const bounds = { from: T0, to: T0 + 60_000 }

  it('finds an excursion by the extremes of a bucket, not its average', () => {
    const points = [point(0, 50, 49, 51), point(10, 60, 55, 84), point(20, 62, 60, 90), point(30, 50, 49, 51), point(40, 50), point(50, 50)]
    expect(historyEvents(points, 10, 30_000, { min: 0, max: 80 }, bounds)).toEqual([
      { kind: 'high', from: T0 + 10_000, to: T0 + 30_000, peak: 90 },
    ])
  })

  it('finds values under the lower limit and keeps the lowest', () => {
    const points = [point(0, 5), point(10, -1, -3, 0), point(20, -2, -4, -1), point(30, 5), point(40, 5), point(50, 5)]
    expect(historyEvents(points, 10, 30_000, { min: 0, max: null }, bounds)).toEqual([
      { kind: 'low', from: T0 + 10_000, to: T0 + 30_000, peak: -4 },
    ])
  })

  it('reports the time without data, at the start, in the middle and at the end', () => {
    const wide = { from: T0 - 120_000, to: T0 + 400_000 }
    const events = historyEvents([point(0, 1), point(10, 1), point(200, 1)], 10, 30_000, { min: null, max: null }, wide)
    expect(events).toEqual([
      { kind: 'gap', from: T0 - 120_000, to: T0, peak: null },
      { kind: 'gap', from: T0 + 20_000, to: T0 + 200_000, peak: null },
      { kind: 'gap', from: T0 + 210_000, to: T0 + 400_000, peak: null },
    ])
  })

  it('joins excursions that follow each other closely, and keeps the highest peak', () => {
    const points = [point(0, 85), point(10, 50), point(20, 90), point(30, 50), point(40, 50), point(50, 86)]
    const limits = { min: null, max: 80 }
    expect(historyEvents(points, 10, 30_000, limits, bounds)).toHaveLength(3)
    expect(historyEvents(points, 10, 30_000, limits, bounds, 10_000)).toEqual([
      { kind: 'high', from: T0, to: T0 + 30_000, peak: 90 },
      { kind: 'high', from: T0 + 50_000, to: T0 + 60_000, peak: 86 },
    ])
  })

  it('does not join two excursions across a time without data', () => {
    const wide = { from: T0, to: T0 + 220_000 }
    const events = historyEvents([point(0, 85), point(200, 85), point(210, 85)], 10, 30_000, { min: null, max: 80 }, wide, 600_000)
    expect(events.map((e) => e.kind)).toEqual(['high', 'gap', 'high'])
  })

  it('finds nothing in a steady series without limits', () => {
    expect(historyEvents([0, 10, 20, 30, 40, 50].map((s) => point(s, 1)), 10, 30_000, { min: null, max: null }, bounds)).toEqual([])
  })
})

describe('historyStats', () => {
  it('weighs the average by the readings of each bucket and takes the extremes', () => {
    expect(historyStats([point(0, 10, 8, 12, 3), point(10, null), point(20, 20, 19, 30, 1)])).toEqual({ mean: 12.5, min: 8, max: 30, first: 10, last: 20, count: 4 })
  })

  it('has nothing to say without values', () => {
    expect(historyStats([point(0, null)])).toBeNull()
  })
})

describe('valueDomain', () => {
  const stats = { mean: 55, min: 50, max: 60, first: 50, last: 60, count: 2 }

  it('covers the data with a margin', () => {
    expect(valueDomain(stats, { min: null, max: null })).toEqual([49, 61])
  })

  it('reaches a limit that is close to the data, not one far away', () => {
    expect(valueDomain(stats, { min: 0, max: 65 })).toEqual([48.5, 66.5])
  })

  it('gives a flat series some room', () => {
    const [lo, hi] = valueDomain({ ...stats, min: 7, max: 7 }, { min: null, max: null })
    expect(lo).toBeLessThan(7); expect(hi).toBeGreaterThan(7)
  })
})

describe('timeTicks', () => {
  it('uses round local times', () => {
    // UTC+7: 10:00 local is 03:00 UTC.
    expect(timeTicks(T0 + 60_000, T0 + 3_600_000, 6, -420)).toEqual([10, 20, 30, 40, 50, 60].map((m) => T0 + m * 60_000))
  })

  it('puts day ticks at local midnight', () => {
    const ticks = timeTicks(T0, T0 + 3 * 86_400_000, 4, -420)
    expect(new Date(ticks[0]).toISOString()).toBe('2026-10-08T17:00:00.000Z')
    expect(ticks).toHaveLength(3)
  })
})

describe('durationLabel', () => {
  it('names a duration with two units at most', () => {
    expect(durationLabel(42_000)).toBe('42 giây')
    expect(durationLabel(200_000)).toBe('3 phút 20 giây')
    expect(durationLabel(600_000)).toBe('10 phút')
    expect(durationLabel(7_500_000)).toBe('2 giờ 5 phút')
    expect(durationLabel(4 * 86_400_000 + 3 * 3_600_000)).toBe('4 ngày 3 giờ')
  })
})

describe('nearestSample', () => {
  const parts = segments([point(0, 1), point(10, 2), point(100, 3)], 30_000)

  it('takes the closest point of any segment', () => {
    expect(nearestSample(parts, T0 + 12_000, 30_000)?.value).toBe(2)
    expect(nearestSample(parts, T0 + 90_000, 30_000)?.value).toBe(3)
  })

  it('gives nothing in the middle of a gap', () => {
    expect(nearestSample(parts, T0 + 55_000, 30_000)).toBeNull()
  })
})

describe('axisLabel', () => {
  it('uses as many decimals as the range needs', () => {
    expect(axisLabel(69.24, 54, 84)).toBe('69')
    expect(axisLabel(0.24, -0.4, 0.8)).toBe('0,2')
    expect(axisLabel(0.0712, 0.06, 0.09)).toBe('0,071')
    expect(axisLabel(5600.4, 5599, 5602)).toBe('5600,4')
  })
})

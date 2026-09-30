import { describe, expect, it } from 'vitest'
import type { BandRow } from '../api/types'
import { MAX_DOTS, WINDOW_STEPS, cycleSeconds, dotCount, lotOf, peakRate, ratePerSec, travelSeconds } from './flow'
import { indexBands } from './replay'

const START = Date.parse('2026-10-01T00:00:00Z')
const iso = (step: number) => new Date(START + step * 60_000).toISOString()
const at = (step: number) => START + step * 60_000
const rowsOf = (subject: string, metric: string, values: number[]): BandRow[] =>
  values.map((v, i) => ({ subject, metric, t: iso(i), p10: v, p50: v, p90: v }))
/** Bộ đếm tích luỹ từ số đơn vị chuyển mỗi phút. */
const cumulative = (perStep: number[]) => perStep.reduce<number[]>((acc, d) => [...acc, (acc.at(-1) ?? 0) + d], [])
const steady = (n: number, per: number) => cumulative(Array.from({ length: n }, () => per))

describe('ratePerSec', () => {
  const idx = indexBands([
    // 6 đơn vị mỗi phút trong 30 phút rồi ngừng.
    ...rowsOf('STEADY', 'moved', cumulative([...Array(30).fill(6), ...Array(30).fill(0)])),
    // Một lô 150 đơn vị đến ở phút 20.
    ...rowsOf('BURST', 'moved', cumulative(Array.from({ length: 60 }, (_, i) => (i === 20 ? 150 : 0)))),
    ...rowsOf('OLD', 'in_transit', [0, 0, 45, 0]),
  ])
  it('is the average over the last WINDOW_STEPS sample intervals, in units per second', () => {
    expect(ratePerSec(idx, 'STEADY', at(15))).toBeCloseTo(6 / 60)
  })
  it('keeps a burst visible for the length of the window, then lets it go', () => {
    expect(ratePerSec(idx, 'BURST', at(19))).toBe(0)
    expect(ratePerSec(idx, 'BURST', at(20))).toBeCloseTo(150 / (WINDOW_STEPS * 60))
    expect(ratePerSec(idx, 'BURST', at(20 + WINDOW_STEPS - 1))).toBeGreaterThan(0)
    expect(ratePerSec(idx, 'BURST', at(20 + WINDOW_STEPS))).toBe(0)
  })
  it('drops to zero once the flow has stopped for a whole window', () => {
    expect(ratePerSec(idx, 'STEADY', at(30 + WINDOW_STEPS))).toBe(0)
  })
  it('looks forward from the very first sample, which has no past', () => {
    expect(ratePerSec(idx, 'STEADY', at(0))).toBeCloseTo(6 / 60)
  })
  it('is undefined for an edge that has no moved series (an older run)', () => {
    expect(ratePerSec(idx, 'OLD', at(2))).toBeUndefined()
    expect(ratePerSec(idx, 'NOPE', at(2))).toBeUndefined()
  })
})

describe('peakRate', () => {
  it('is the 95th percentile of the moments something moves, so one big lot does not flatten every other edge', () => {
    const idx = indexBands([
      ...rowsOf('X', 'moved', steady(300, 6)),
      ...rowsOf('Y', 'moved', cumulative(Array.from({ length: 300 }, (_, i) => (i === 100 ? 6000 : 0)))),
    ])
    expect(peakRate(idx, ['X', 'Y'])).toBeCloseTo(6 / 60, 2)
  })
  it('is zero when nothing ever moves or there are no edges', () => {
    const idx = indexBands(rowsOf('Z', 'moved', steady(20, 0)))
    expect(peakRate(idx, ['Z'])).toBe(0)
    expect(peakRate(idx, [])).toBe(0)
  })
})

describe('dotCount', () => {
  const idx = indexBands([
    ...rowsOf('BUSY', 'moved', steady(60, 6)),
    ...rowsOf('HALF', 'moved', steady(60, 3)),
    ...rowsOf('TRICKLE', 'moved', steady(60, 0.1)),
    ...rowsOf('IDLE', 'moved', steady(60, 0)),
    ...rowsOf('OLD', 'in_transit', [0, 0, 45, 0, 0]),
    ...rowsOf('TINY', 'in_transit', [0, 0.4, 0.4, 0, 0]),
  ])
  const peak = 6 / 60
  it('shows nothing when nothing moves', () => {
    expect(dotCount(idx, 'IDLE', {}, at(30), peak)).toBe(0)
  })
  it('gives the busiest flow the most dots and scales the rest in proportion', () => {
    expect(dotCount(idx, 'BUSY', {}, at(30), peak)).toBe(MAX_DOTS)
    const half = dotCount(idx, 'HALF', {}, at(30), peak)
    expect(half).toBeGreaterThan(1)
    expect(half).toBeLessThan(MAX_DOTS)
  })
  it('shows at least one dot for any real flow, however small', () => {
    expect(dotCount(idx, 'TRICKLE', {}, at(30), peak)).toBe(1)
  })
  it('falls back to lots in transit for a run without moved', () => {
    expect(dotCount(idx, 'OLD', { lot: 20 }, at(2), peak)).toBe(3)
    expect(dotCount(idx, 'OLD', { lot: 20 }, at(3), peak)).toBe(0)
    expect(dotCount(idx, 'OLD', { lot: 1 }, at(2), peak)).toBe(MAX_DOTS)
  })
  it('ignores a fraction of a lot in transit, as the old dashed animation did', () => {
    expect(dotCount(idx, 'TINY', { lot: 1 }, at(2), peak)).toBe(0)
  })
})

describe('params', () => {
  it('reads lot size and travel time from the edge parameters, tolerating junk', () => {
    expect(lotOf({ lot: 20 })).toBe(20)
    expect(lotOf({ lot: 0 })).toBe(1)
    expect(lotOf({ lot: 'x' })).toBe(1)
    expect(lotOf({})).toBe(1)
    expect(travelSeconds({ travel: { dist: 'norm', mean: 90, sd: 15 } })).toBe(90)
    expect(travelSeconds({ travel: { dist: 'const', value: 40 } })).toBe(40)
    expect(travelSeconds({ travel: { dist: 'norm', mean: 'lots' } })).toBe(0)
    expect(travelSeconds({})).toBe(0)
  })
})

describe('cycleSeconds', () => {
  it('keeps one time scale (30 s of travel per second on screen) inside a readable range', () => {
    expect(cycleSeconds(90)).toBeCloseTo(3)
    expect(cycleSeconds(0)).toBeCloseTo(1.6)
    expect(cycleSeconds(600)).toBeCloseTo(4)
  })
})

import { describe, expect, it } from 'vitest'
import { fmtDelta, fmtStep, statusLabel, versionStatusLabel } from './format'

describe('format', () => {
  it('formats deltas with a real minus and comma decimals', () => {
    expect(fmtDelta(-31.42)).toBe('−31,4')
    expect(fmtDelta(12)).toBe('+12,0')
    expect(fmtDelta(0.01)).toBe('0,0')
  })

  it('describes the sampling step', () => {
    expect(fmtStep(60_000)).toBe('1 phút mỗi bước')
    expect(fmtStep(300_000)).toBe('5 phút mỗi bước')
    expect(fmtStep(30_000)).toBe('30 giây mỗi bước')
    expect(fmtStep(0)).toBe('1 giây mỗi bước')
  })

  it('labels statuses in Vietnamese', () => {
    expect(statusLabel('DONE')).toBe('Đã xong')
    expect(versionStatusLabel('DRAFT')).toBe('Nháp')
    expect(versionStatusLabel('WEIRD')).toBe('WEIRD')
  })
})

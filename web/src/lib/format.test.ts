import { describe, expect, it } from 'vitest'
import { fmtDateTime, fmtDelta, fmtDuration, fmtStep, statusLabel, usedIn, versionStatusLabel } from './format'

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

describe('tables formatting', () => {
  it('shows a dash for missing dates and never Invalid Date', () => {
    expect(fmtDateTime(null)).toBe('—')
    expect(fmtDateTime('không phải ngày')).toBe('—')
    expect(fmtDateTime('2026-10-01T08:00:00Z')).not.toBe('—')
  })
  it('formats durations', () => {
    expect(fmtDuration('2026-10-01T08:00:00Z', null)).toBe('—')
    expect(fmtDuration('2026-10-01T08:00:00Z', '2026-10-01T08:00:45Z')).toBe('45 giây')
    expect(fmtDuration('2026-10-01T08:00:00Z', '2026-10-01T08:12:10Z')).toBe('12 phút')
    expect(fmtDuration('2026-10-01T08:00:00Z', '2026-10-01T09:05:00Z')).toBe('1 giờ 5 phút')
    expect(fmtDuration('2026-10-01T08:00:00Z', '2026-10-01T07:00:00Z')).toBe('—')
  })
  it('says how many versions use something', () => {
    expect(usedIn(undefined)).toBe('—')
    expect(usedIn(0)).toBe('chưa dùng')
    expect(usedIn(3)).toBe('3 version')
  })
})

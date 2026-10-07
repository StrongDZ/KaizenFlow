import { describe, expect, it } from 'vitest'
import type { DataSourceRow } from '../api/types'
import { ageText, parseSample, rateText, summarizeSources, validSourceName } from './sourceView'

const row = (over: Partial<DataSourceRow>): DataSourceRow => ({
  source: 's', desc: '', origin: 'feed', first_seen: '', last_seen: '', count: 1, sample: null, live: true, age_ms: 0, per_min: 0, bindings: [], ...over,
})

describe('ageText', () => {
  it('từ vừa xong đến giờ và ngày', () => {
    expect(ageText(500)).toBe('vừa xong')
    expect(ageText(12_000)).toBe('12 giây trước')
    expect(ageText(3 * 60_000)).toBe('3 phút trước')
    expect(ageText(2 * 3600_000)).toBe('2 giờ trước')
    expect(ageText(3 * 86_400_000)).toBe('3 ngày trước')
  })
  it('giá trị lạ thì gạch ngang', () => {
    expect(ageText(-1)).toBe('—')
    expect(ageText(Number.NaN)).toBe('—')
  })
})

describe('rateText', () => {
  it('bản tin mỗi phút, hoặc mỗi N phút khi thưa', () => {
    expect(rateText(0)).toBe('—')
    expect(rateText(240)).toBe('240 bản tin/phút')
    expect(rateText(12.4)).toBe('12 bản tin/phút')
    expect(rateText(0.5)).toBe('1 bản tin/2 phút')
    expect(rateText(0.1)).toBe('1 bản tin/10 phút')
  })
})

describe('summarizeSources', () => {
  it('đếm đang phát và chưa ghép', () => {
    const s = summarizeSources([row({}), row({ live: false }), row({ bindings: [{ subject: 'A', signal: 'x' }] })])
    expect(s).toEqual({ total: 3, live: 2, unbound: 2 })
  })
})

describe('validSourceName', () => {
  it('chấp nhận tên kiểu topic', () => {
    expect(validSourceName('plc/prs-02/status')).toBeNull()
  })
  it('từ chối rỗng, có khoảng trắng, quá dài, nói rõ lý do', () => {
    expect(validSourceName('')).toContain('tên')
    expect(validSourceName('plc prs')).toContain('khoảng trắng')
    expect(validSourceName('x'.repeat(201))).toContain('200')
  })
})

describe('parseSample', () => {
  it('rỗng là chưa có mẫu', () => {
    expect(parseSample('  ')).toEqual({ ok: true, value: undefined })
  })
  it('JSON hợp lệ', () => {
    expect(parseSample('{"n": 3}')).toEqual({ ok: true, value: { n: 3 } })
  })
  it('JSON hỏng: lỗi bằng tiếng Việt', () => {
    const r = parseSample('{n: 3}')
    expect(r.ok).toBe(false)
    expect(r.ok === false && r.error).toContain('JSON')
  })
})

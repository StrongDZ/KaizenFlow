import { describe, expect, it } from 'vitest'
import type { Json } from '../api/types'
import { EFFECT_LABEL, failureProblems, newFailureMode, newSignal, signalProblems, withEffect, withoutEffect } from './sensorsEdit'

const sensor = (over: Json = {}): Json => ({ name: 'vibration', unit: 'mm/s', hz: 0.2, base: { dist: 'norm', mean: 0.4, sd: 0.08 }, ...over })

describe('newSignal và newFailureMode', () => {
  it('cảm biến mới có sẵn giá trị nền và tần số hợp lệ', () => {
    const s = newSignal()
    expect(s.name).toBe('')
    expect(s.hz).toBeGreaterThan(0)
    expect(s.base).toMatchObject({ dist: 'norm' })
  })
  it('chế độ hỏng mới điền sẵn các phân phối và kết thúc ở trạng thái DOWN', () => {
    const m = newFailureMode()
    expect(m.code).toBe('')
    expect(m.onset).toMatchObject({ dist: 'weibull' })
    expect(m.p_to_f).toMatchObject({ dist: 'tri' })
    expect(m.effects).toEqual([])
    expect(m.on_fail).toMatchObject({ state: 'DOWN', mttr: { dist: 'lognorm' } })
  })
})

describe('signalProblems', () => {
  it('không có vấn đề với cảm biến đủ thông tin', () => {
    expect(signalProblems([sensor()])).toEqual([])
  })
  it('tên trống, trùng tên, tần số không dương, thiếu giá trị nền', () => {
    const got = signalProblems([sensor({ name: '' }), sensor(), sensor(), sensor({ name: 'temp', hz: 0 }), sensor({ name: 'rpm', base: undefined })])
    expect(got).toHaveLength(4)
    expect(got.some((m) => m.includes('dòng 1') && m.includes('tên'))).toBe(true)
    expect(got.some((m) => m.includes('vibration') && m.includes('trùng'))).toBe(true)
    expect(got.some((m) => m.includes('temp') && m.includes('tần số'))).toBe(true)
    expect(got.some((m) => m.includes('rpm') && m.includes('nền'))).toBe(true)
  })
})

describe('failureProblems', () => {
  const mode = (over: Json = {}): Json => ({ ...newFailureMode(), code: 'bearing_wear', ...over })
  it('hợp lệ', () => {
    expect(failureProblems([mode({ effects: [{ signal: 'vibration', kind: 'exp', mag_sd: 3 }] })], ['vibration'])).toEqual([])
  })
  it('mã trống hoặc trùng; ảnh hưởng trỏ tới cảm biến không có; kiểu ảnh hưởng lạ; thiếu thời gian', () => {
    const got = failureProblems([
      mode({ code: '' }), mode(), mode(),
      mode({ code: 'x', effects: [{ signal: 'nope', kind: 'exp', mag_sd: 1 }] }),
      mode({ code: 'y', effects: [{ signal: 'vibration', kind: 'lạ', mag_sd: 1 }] }),
      mode({ code: 'z', onset: undefined }),
    ], ['vibration'])
    expect(got.some((m) => m.includes('dòng 1') && m.includes('mã'))).toBe(true)
    expect(got.some((m) => m.includes('bearing_wear') && m.includes('trùng'))).toBe(true)
    expect(got.some((m) => m.includes('x') && m.includes('nope'))).toBe(true)
    expect(got.some((m) => m.includes('y') && m.includes('kiểu'))).toBe(true)
    expect(got.some((m) => m.includes('z') && m.includes('suy giảm'))).toBe(true)
  })
})

describe('withEffect và withoutEffect', () => {
  it('thêm ảnh hưởng mặc định vào cảm biến đầu tiên, xoá theo chỉ số, không đổi bản gốc', () => {
    const m = newFailureMode()
    const a = withEffect(m, 'vibration')
    expect(m.effects).toEqual([])
    expect(a.effects).toEqual([{ signal: 'vibration', kind: 'ramp', mag_sd: 3 }])
    expect(withoutEffect(a, 0).effects).toEqual([])
  })
  it('có nhãn tiếng Việt cho mọi kiểu ảnh hưởng của sim', () => {
    for (const k of ['ramp', 'exp', 'step', 'spike', 'freeze', 'zero']) expect(EFFECT_LABEL[k]).toBeTruthy()
  })
})

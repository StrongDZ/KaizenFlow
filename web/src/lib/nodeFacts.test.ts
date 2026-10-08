import { describe, expect, it } from 'vitest'
import type { SubjectSnap } from '../api/types'
import { DEFAULT_THRESHOLDS } from './replay'
import { distMean, formatSeconds, mapLines, nodeFacts } from './nodeFacts'

const snap = (signals: Record<string, number>, over: Partial<SubjectSnap> = {}): SubjectSnap => ({
  signals: Object.fromEntries(Object.entries(signals).map(([k, v]) => [k, { v, ts: '2026-10-07T08:00:00Z' }])), age_ms: 500, ...over,
})
const th = DEFAULT_THRESHOLDS

describe('thời gian chu kỳ từ phân phối', () => {
  it('lấy giá trị trung bình của các dạng phân phối hay gặp; không hiểu thì thôi', () => {
    expect(distMean({ dist: 'const', value: 45 })).toBe(45)
    expect(distMean({ dist: 'norm', mean: 90, sd: 15 })).toBe(90)
    expect(distMean({ dist: 'exp', mean: 330 })).toBe(330)
    expect(distMean({ dist: 'uniform', min: 10, max: 30 })).toBe(20)
    expect(distMean({ dist: 'tri', min: 10, mode: 20, max: 30 })).toBe(20)
    expect(distMean({ dist: 'weird' })).toBeUndefined()
    expect(distMean(undefined)).toBeUndefined()
    expect(distMean('45')).toBeUndefined()
  })
  it('đọc được: giây, phút, giờ, dấu phẩy thập phân', () => {
    expect(formatSeconds(45)).toBe('45 giây')
    expect(formatSeconds(90)).toBe('1,5 phút')
    expect(formatSeconds(7200)).toBe('2 giờ')
    expect(formatSeconds(0.5)).toBe('0,5 giây')
  })
})

describe('thông số hiện trên node ở bản đồ', () => {
  it('máy: dòng 1 là trạng thái và số đạt, dòng 2 là số lỗi và chu kỳ', () => {
    const lines = mapLines('PROCESS', snap({ count_ok: 1234, count_ng: 12 }, { state: 'RUNNING' }), { cycle: { dist: 'const', value: 45 } }, th)
    expect(lines).toEqual([
      { text: 'Đang chạy · 1234 đạt', tone: 'ok' },
      { text: 'lỗi 12 · chu kỳ 45 giây', tone: 'muted' },
    ])
  })
  it('máy hỏng báo đỏ; máy thiếu liệu báo vàng', () => {
    expect(mapLines('PROCESS', snap({}, { state: 'DOWN' }), {}, th)[0]).toEqual({ text: 'Hỏng', tone: 'bad' })
    expect(mapLines('PROCESS', snap({}, { state: 'STARVED' }), {}, th)[0].tone).toBe('warn')
  })
  it('kho: dòng 1 là số giờ còn dùng (màu theo ngưỡng), dòng 2 là tồn từng vật tư', () => {
    const lines = mapLines('STORAGE', snap({ coverage_h: 0.2, 'level:RAW-01': 300, 'level:RAW-02': 200.4 }), {}, th)
    expect(lines[0]).toEqual({ text: 'còn 0,2 giờ', tone: 'bad' })
    expect(lines[1]).toEqual({ text: 'RAW-01 300 · RAW-02 200', tone: 'muted' })
  })
  it('kho có hơn hai vật tư thì gộp phần còn lại, không làm nhãn dài ra', () => {
    const lines = mapLines('STORAGE', snap({ 'level:A': 1, 'level:B': 2, 'level:C': 3, 'level:D': 4 }), {}, th)
    expect(lines[lines.length - 1].text).toBe('A 1 · B 2 · +2 vật tư')
  })
  it('đích xuất hàng: số đã giao trên nhu cầu, nợ đơn báo vàng', () => {
    const lines = mapLines('SINK', snap({ demand: 440, fulfilled: 432, backorder: 8 }), {}, th)
    expect(lines).toEqual([{ text: 'nợ 8 đơn', tone: 'warn' }, { text: 'giao 432 / nhu cầu 440', tone: 'muted' }])
  })
  it('nguồn nhập: số đã nhập', () => {
    expect(mapLines('SOURCE', snap({ arrived: 150 }), {}, th)).toEqual([{ text: 'đã nhập 150', tone: 'muted' }])
  })
  it('chưa có dữ liệu live thì hiện thông số cấu hình để node vẫn có thông tin', () => {
    expect(mapLines('PROCESS', undefined, { cycle: { dist: 'norm', mean: 90, sd: 15 }, slots: 2 }, th)).toEqual([{ text: 'chu kỳ 1,5 phút · 2 vị trí', tone: 'muted' }])
    expect(mapLines('STORAGE', undefined, { stock: [{ material: 'RAW-01', initial: 300, max: 1000 }] }, th)).toEqual([{ text: 'RAW-01 tồn đầu 300 / 1000', tone: 'muted' }])
    expect(mapLines('SOURCE', undefined, {}, th)).toEqual([])
  })
  it('mất tín hiệu thì nói mất tín hiệu, không hiện số cũ', () => {
    expect(mapLines('PROCESS', snap({ count_ok: 5 }, { state: 'RUNNING', age_ms: 60000 }), {}, th)).toEqual([{ text: 'mất tín hiệu', tone: 'muted' }])
  })
  it('pool xe: số xe bận trên tổng, số lượt chờ', () => {
    expect(mapLines('RESOURCE_POOL', snap({ busy: 1, queue_len: 3 }), {}, th, 2)[0].text).toBe('1/2 bận, 3 chờ')
  })
})

describe('bảng thông số đầy đủ cho tấm chi tiết', () => {
  it('máy: trạng thái và các bộ đếm (trực tiếp) rồi chu kỳ, số vị trí (cấu hình)', () => {
    const f = nodeFacts('PROCESS', snap({ count_in: 100, count_ok: 90, count_ng: 4 }, { state: 'BLOCKED' }), { cycle: { dist: 'const', value: 30 }, slots: 3 }, th)
    expect(f.map((x) => [x.label, x.value, x.section])).toEqual([
      ['Trạng thái', 'Tắc đầu ra', 'live'], ['Đầu vào', '100', 'live'], ['Đạt', '90', 'live'], ['Lỗi', '4', 'live'],
      ['Chu kỳ', '30 giây', 'config'], ['Số vị trí chạy song song', '3', 'config'],
    ])
  })
  it('kho: giờ còn dùng, tồn từng vật tư, sức chứa', () => {
    const f = nodeFacts('STORAGE', snap({ coverage_h: 2.5, 'level:RAW-01': 300 }), { capacity: 5000, stock: [{ material: 'RAW-01', initial: 100, max: 1000 }] }, th)
    expect(f.find((x) => x.label === 'Còn dùng')?.value).toBe('2,5 giờ')
    expect(f.find((x) => x.label === 'Tồn RAW-01')?.value).toBe('300 / 1000')
    expect(f.find((x) => x.label === 'Sức chứa tổng')?.value).toBe('5000')
  })
  it('không có gì để hiện thì mảng rỗng', () => {
    expect(nodeFacts('SOURCE', undefined, {}, th)).toEqual([])
  })
})

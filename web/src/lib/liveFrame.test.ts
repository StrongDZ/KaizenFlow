import { describe, expect, it } from 'vitest'
import type { SubjectSnap } from '../api/types'
import { STALE_MS, dotsFromRate, nodeBadge, stateLabel, trackPeak } from './liveFrame'

const th = { red_h: 1, yellow_low_h: 4, yellow_high_h: 12 }
const snap = (o: Partial<SubjectSnap>): SubjectSnap => ({ signals: {}, age_ms: 100, ...o })
const v = (x: number) => ({ v: x, ts: '2026-10-01T08:00:00Z' })

describe('nodeBadge', () => {
  it('chưa có dữ liệu thì không có nhãn', () => {
    expect(nodeBadge('PROCESS', undefined, th)).toBeUndefined()
  })
  it('máy: trạng thái chữ, màu theo mức nghiêm trọng, kèm số đạt', () => {
    expect(nodeBadge('PROCESS', snap({ state: 'RUNNING', signals: { count_ok: v(4) } }), th))
      .toMatchObject({ color: 'GREEN', text: 'Đang chạy · 4 đạt' })
    expect(nodeBadge('PROCESS', snap({ state: 'DOWN' }), th)).toMatchObject({ color: 'RED', text: 'Hỏng' })
    expect(nodeBadge('PROCESS', snap({ state: 'STARVED' }), th)).toMatchObject({ color: 'YELLOW', text: 'Thiếu liệu' })
    expect(nodeBadge('PROCESS', snap({ state: 'BLOCKED' }), th)?.color).toBe('YELLOW')
  })
  it('máy chưa báo trạng thái nhưng có số đếm: chỉ hiện số đạt', () => {
    expect(nodeBadge('PROCESS', snap({ signals: { count_ok: v(7) } }), th)).toMatchObject({ color: 'INFO', text: '7 đạt' })
  })
  it('mất tín hiệu quá ngưỡng thì báo mất tín hiệu, không hiện số cũ', () => {
    expect(nodeBadge('PROCESS', snap({ state: 'RUNNING', age_ms: STALE_MS + 1 }), th)).toMatchObject({ color: 'INFO', text: 'mất tín hiệu' })
  })
  it('kho: còn bao nhiêu giờ, cùng ngưỡng màu với Control Room', () => {
    expect(nodeBadge('STORAGE', snap({ signals: { coverage_h: v(6.84) } }), th)).toMatchObject({ color: 'GREEN', text: 'còn 6,8 giờ' })
    expect(nodeBadge('STORAGE', snap({ signals: { coverage_h: v(0.4) } }), th)?.color).toBe('RED')
    expect(nodeBadge('STORAGE', snap({ signals: { coverage_h: v(2) } }), th)?.color).toBe('YELLOW')
    expect(nodeBadge('STORAGE', snap({ signals: { coverage_h: v(999) } }), th)).toMatchObject({ color: 'GREEN', text: 'không tiêu thụ' })
  })
  it('kho chưa đủ lịch sử để tính giờ thì hiện tồn', () => {
    expect(nodeBadge('STORAGE', snap({ signals: { 'level:RAW-01': v(230), 'level:RAW-02': v(15) } }), th))
      .toMatchObject({ color: 'INFO', text: 'tồn 245' })
  })
  it('đích xuất và nguồn và đội xe', () => {
    expect(nodeBadge('SINK', snap({ signals: { backorder: v(3) } }), th)).toMatchObject({ color: 'YELLOW', text: 'nợ 3 đơn' })
    expect(nodeBadge('SINK', snap({ signals: { backorder: v(0) } }), th)).toMatchObject({ color: 'GREEN', text: 'không nợ đơn' })
    expect(nodeBadge('SOURCE', snap({ signals: { arrived: v(120) } }), th)).toMatchObject({ color: 'INFO', text: 'đã nhập 120' })
    expect(nodeBadge('RESOURCE_POOL', snap({ signals: { busy: v(2), queue_len: v(1) } }), th, 3))
      .toMatchObject({ color: 'INFO', text: '2/3 bận, 1 chờ' })
  })
})

describe('stateLabel', () => {
  it('nhãn tiếng Việt, trạng thái lạ giữ nguyên', () => {
    expect(stateLabel('RUNNING')).toBe('Đang chạy')
    expect(stateLabel('WEIRD')).toBe('WEIRD')
  })
})

describe('dotsFromRate và trackPeak', () => {
  it('không có lưu lượng thì không có hạt, có thì từ 1 đến 6 theo tỉ lệ với mức bận', () => {
    expect(dotsFromRate(0, 5)).toBe(0)
    expect(dotsFromRate(1, 0)).toBe(0)
    expect(dotsFromRate(undefined, 5)).toBe(0)
    expect(dotsFromRate(0.01, 5)).toBe(1)
    expect(dotsFromRate(5, 5)).toBe(6)
    expect(dotsFromRate(50, 5)).toBe(6)
    expect(dotsFromRate(2.5, 5)).toBeGreaterThan(1)
  })
  it('mức bận chuẩn tăng ngay khi có lưu lượng lớn hơn và giảm rất chậm', () => {
    expect(trackPeak(0, [1, 3])).toBe(3)
    expect(trackPeak(3, [1])).toBeLessThan(3)
    expect(trackPeak(3, [1])).toBeGreaterThan(2.9)
    expect(trackPeak(3, [])).toBeLessThan(3)
  })
})

import { STALE_TEXT, summarize } from './liveFrame'

describe('summarize', () => {
  it('đếm kho Đỏ/Vàng, máy hỏng, thiết bị mất tín hiệu và node chưa có dữ liệu', () => {
    const items = [
      { archetype: 'STORAGE', badge: { color: 'RED' as const, text: 'còn 0,4 giờ' } },
      { archetype: 'STORAGE', badge: { color: 'YELLOW' as const, text: 'còn 2 giờ' } },
      { archetype: 'STORAGE', badge: { color: 'GREEN' as const, text: 'còn 8 giờ' } },
      { archetype: 'PROCESS', badge: { color: 'RED' as const, text: 'Hỏng' } },
      { archetype: 'PROCESS', badge: { color: 'INFO' as const, text: STALE_TEXT } },
      { archetype: 'PROCESS', badge: undefined },
      { archetype: 'SINK', badge: { color: 'RED' as const, text: 'nợ 99 đơn' } },
    ]
    expect(summarize(items)).toEqual({ redStorages: 1, yellowStorages: 1, downMachines: 1, stale: 1, silent: 1 })
  })
  it('rỗng thì toàn số 0', () => {
    expect(summarize([])).toEqual({ redStorages: 0, yellowStorages: 0, downMachines: 0, stale: 0, silent: 0 })
  })
})

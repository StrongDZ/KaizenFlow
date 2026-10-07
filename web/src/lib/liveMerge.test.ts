import { describe, expect, it } from 'vitest'
import type { LiveMsg, LiveSnapshot } from '../api/types'
import { mergeLive } from './liveMerge'

const base = (over: Partial<LiveSnapshot> = {}): LiveSnapshot => ({
  model: 'm', now: '2026-10-01T08:00:00Z', bindings: 3, errors: [{ message: 'x', count: 2, last: '' }],
  subjects: { A: { signals: {}, age_ms: 1000, state: 'IDLE' } },
  fleet: { TUG: [{ id: 'T1', x: 0, y: 0, raw_x: 0, raw_y: 0, state: 'IDLE', lane: '', s: 0, off_map: false, load: 0, ts: '', age_ms: 1000 }] },
  sources: [{ source: 's', desc: 'd', last_ts: '', age_ms: 0, count: 1, last: {}, bound: true }],
  ...over,
})
const push = (over: Partial<LiveMsg> = {}): LiveMsg => ({
  type: 'live', model: 'm', now: '2026-10-01T08:00:05Z', sources: 1,
  subjects: { A: { signals: {}, age_ms: 10, state: 'RUNNING' } },
  fleet: { TUG: [{ id: 'T1', x: 9, y: 9, raw_x: 9, raw_y: 9, state: 'MOVING', lane: 'L1', s: 0, off_map: false, load: 1, ts: '', age_ms: 10 }] },
  ...over,
})

describe('mergeLive', () => {
  it('không có gì thì undefined', () => {
    expect(mergeLive(undefined, undefined, 1000)).toBeUndefined()
  })
  it('chỉ có bản chụp: dùng nó và cộng thời gian đã trôi vào tuổi dữ liệu', () => {
    const got = mergeLive({ data: base(), at: 1000 }, undefined, 6000)!
    expect(got.subjects.A.age_ms).toBe(1000 + 5000)
    expect(got.fleet.TUG[0].age_ms).toBe(1000 + 5000)
    expect(got.sources).toHaveLength(1)
  })
  it('bản đẩy mới hơn ghi đè trạng thái và xe, nhưng nguồn/lỗi/số ghép vẫn lấy từ bản chụp', () => {
    const got = mergeLive({ data: base(), at: 1000 }, { data: push(), at: 2000 }, 2500)!
    expect(got.subjects.A.state).toBe('RUNNING')
    expect(got.subjects.A.age_ms).toBe(10 + 500)
    expect(got.fleet.TUG[0].x).toBe(9)
    expect(got.now).toBe('2026-10-01T08:00:05Z')
    expect(got.bindings).toBe(3)
    expect(got.errors).toHaveLength(1)
    expect(got.sources).toHaveLength(1)
  })
  it('bản chụp mới hơn bản đẩy thì bản chụp thắng', () => {
    const got = mergeLive({ data: base(), at: 5000 }, { data: push(), at: 2000 }, 5000)!
    expect(got.subjects.A.state).toBe('IDLE')
  })
  it('chỉ có bản đẩy (chưa tải xong bản chụp): vẫn hiển thị được, các danh sách rỗng', () => {
    const got = mergeLive(undefined, { data: push(), at: 2000 }, 2000)!
    expect(got.subjects.A.state).toBe('RUNNING')
    expect(got.sources).toEqual([])
    expect(got.errors).toEqual([])
    expect(got.bindings).toBe(0)
  })
  it('không sửa dữ liệu gốc', () => {
    const b = base()
    mergeLive({ data: b, at: 0 }, undefined, 9999)
    expect(b.subjects.A.age_ms).toBe(1000)
  })
})

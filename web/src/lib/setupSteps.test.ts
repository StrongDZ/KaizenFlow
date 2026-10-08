import { describe, expect, it } from 'vitest'
import { nextStep, setupSteps, type SetupInput } from './setupSteps'

const full: SetupInput = {
  model: 'm', materials: 6,
  versions: [{ id: 1, status: 'PUBLISHED', nodes: 12 }, { id: 2, status: 'DRAFT', nodes: 14 }],
  sources: 63, coverage: { source: 130, derived: 2, signals: 138, liveReady: true }, hasMap: true,
  feed: { state: 'running' },
}

describe('setupSteps', () => {
  it('đủ mọi thứ thì mọi bước xong và không còn bước kế tiếp', () => {
    const steps = setupSteps(full)
    expect(steps.map((s) => s.key)).toEqual(['materials', 'diagram', 'publish', 'sources', 'bindings', 'map', 'live'])
    expect(steps.every((s) => s.done)).toBe(true)
    expect(nextStep(steps)).toBeUndefined()
  })
  it('mô hình mới tinh: chưa có gì, bước kế tiếp là vật tư', () => {
    const steps = setupSteps({ model: 'm', materials: 0, versions: [{ id: 1, status: 'DRAFT', nodes: 0 }], sources: 0, coverage: { source: 0, derived: 0, signals: 0, liveReady: false }, hasMap: false, feed: { state: 'idle' } })
    expect(steps.filter((s) => s.done)).toHaveLength(0)
    expect(nextStep(steps)?.key).toBe('materials')
  })
  it('bước kế tiếp là bước đầu tiên chưa xong và không tuỳ chọn', () => {
    const steps = setupSteps({ ...full, versions: [{ id: 1, status: 'DRAFT', nodes: 5 }], hasMap: false })
    expect(steps.find((s) => s.key === 'publish')?.done).toBe(false)
    expect(nextStep(steps)?.key).toBe('publish')
    // bản đồ AGV là tuỳ chọn nên không bao giờ là bước kế tiếp
    const onlyMap = setupSteps({ ...full, hasMap: false })
    expect(nextStep(onlyMap)).toBeUndefined()
  })
  it('sơ đồ: dựa trên phiên bản mới nhất, liên kết tới nó', () => {
    const steps = setupSteps({ ...full, versions: [{ id: 7, status: 'PUBLISHED', nodes: 4 }, { id: 9, status: 'DRAFT', nodes: 0 }] })
    const d = steps.find((s) => s.key === 'diagram')!
    expect(d.done).toBe(false)
    expect(d.to).toBe('/versions/9')
    expect(d.detail).toContain('trống')
  })
  it('Publish: nêu phiên bản đã Publish mới nhất; nếu chưa thì liên kết tới bản nháp mới nhất', () => {
    const p = setupSteps(full).find((s) => s.key === 'publish')!
    expect(p.detail).toContain('v1')
    const np = setupSteps({ ...full, versions: [{ id: 3, status: 'DRAFT', nodes: 3 }] }).find((s) => s.key === 'publish')!
    expect(np.done).toBe(false)
    expect(np.to).toBe('/versions/3')
  })
  it('kết nối: xong khi Live đủ tín hiệu, detail nói tiến độ', () => {
    const b = setupSteps({ ...full, coverage: { source: 100, derived: 0, signals: 138, liveReady: false } }).find((s) => s.key === 'bindings')!
    expect(b.done).toBe(false)
    expect(b.detail).toContain('100/138')
  })
  it('chưa biết (đang tải) thì chưa xong và không khẳng định', () => {
    const steps = setupSteps({ ...full, sources: undefined, coverage: undefined, hasMap: undefined, feed: undefined })
    for (const k of ['sources', 'bindings', 'map', 'live']) expect(steps.find((s) => s.key === k)?.done).toBe(false)
    expect(steps.find((s) => s.key === 'sources')?.detail).toContain('…')
  })
  it('feed của mô hình này tạm dừng thì chưa tính là đang chạy trực tiếp', () => {
    const l = setupSteps({ ...full, feed: { state: 'paused' } }).find((s) => s.key === 'live')!
    expect(l.done).toBe(false)
    expect(l.detail).toContain('tạm dừng')
  })
  it('liên kết mã hoá khoá mô hình', () => {
    const s = setupSteps({ ...full, model: 'a b' }).find((x) => x.key === 'sources')!
    expect(s.to).toBe('/models/a%20b/sources')
  })
})

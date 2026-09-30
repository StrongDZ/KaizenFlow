import { describe, expect, it } from 'vitest'
import { previewBinding } from './bindingPreview'

const last = { st: 'ALARM', cnt: { ok: '12.5' }, items: [{ sku: 'RAW-01', qty: 320 }], txt: 'hello', pos: { id: 'V1', x: 1, y: 2 } }

describe('previewBinding', () => {
  it('số: biến đổi nhân rồi cộng, nhận cả số viết dạng chữ', () => {
    expect(previewBinding(last, 'items[sku=RAW-01].qty', 'number', { scale: 2, offset: 1 })).toEqual({ ok: true, text: '641' })
    expect(previewBinding(last, 'cnt.ok', 'number', {})).toEqual({ ok: true, text: '12,5' })
  })
  it('chữ: đổi theo bảng, trạng thái lạ báo rõ để người dùng bổ sung bảng', () => {
    expect(previewBinding(last, 'st', 'text', { enum: { ALARM: 'DOWN' } })).toEqual({ ok: true, text: 'DOWN' })
    const r = previewBinding(last, 'st', 'text', { enum: { RUN: 'RUNNING' } })
    expect(r.ok).toBe(false)
    expect(r.ok === false && r.reason).toMatch(/ALARM/)
    expect(previewBinding(last, 'st', 'text', {})).toEqual({ ok: true, text: 'ALARM' })
  })
  it('lỗi: không thấy trường, không phải số', () => {
    const missing = previewBinding(last, 'nope', 'number', {})
    expect(missing.ok === false && missing.reason).toMatch(/nope/)
    const nan = previewBinding(last, 'txt', 'number', {})
    expect(nan.ok === false && nan.reason).toMatch(/không phải số/)
  })
  it('đội xe: cần id, x, y trong bản tin', () => {
    expect(previewBinding(last.pos, '', 'fleet', {})).toEqual({ ok: true, text: 'xe V1 tại (1, 2)' })
    const bad = previewBinding({ x: 1 }, '', 'fleet', {})
    expect(bad.ok).toBe(false)
    expect(previewBinding({ vid: 'V9', pos: { a: 5, b: 6 } }, '', 'fleet', { fields: { id: 'vid', x: 'pos.a', y: 'pos.b' } }))
      .toEqual({ ok: true, text: 'xe V9 tại (5, 6)' })
  })
})

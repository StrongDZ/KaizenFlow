import { describe, expect, it } from 'vitest'
import { canConnect } from './connect'

const arche: Record<string, string> = { SRC: 'SOURCE', P: 'PROCESS', S: 'STORAGE', OUT: 'SINK', TUG: 'RESOURCE_POOL' }
const of = (id: string) => arche[id]

describe('canConnect', () => {
  it('cho nối Nguồn, Trạm, Kho, Đích theo chiều hợp lý', () => {
    expect(canConnect({ source: 'SRC', target: 'S' }, of)).toEqual({ ok: true })
    expect(canConnect({ source: 'S', target: 'P' }, of)).toEqual({ ok: true })
    expect(canConnect({ source: 'P', target: 'OUT' }, of)).toEqual({ ok: true })
  })
  it('chặn nối node với chính nó', () => {
    const r = canConnect({ source: 'P', target: 'P' }, of)
    expect(r).toMatchObject({ ok: false })
    expect(r.ok === false && r.reason).toContain('chính nó')
  })
  it('chặn đội xe, nói rõ phải gán ở thuộc tính của đường nối', () => {
    for (const c of [{ source: 'TUG', target: 'P' }, { source: 'S', target: 'TUG' }]) {
      const r = canConnect(c, of)
      expect(r.ok).toBe(false)
      expect(r.ok === false && r.reason).toContain('Cách vận chuyển')
    }
  })
  it('Đích không đưa hàng đi, Nguồn không nhận hàng', () => {
    expect(canConnect({ source: 'OUT', target: 'S' }, of).ok).toBe(false)
    expect(canConnect({ source: 'S', target: 'SRC' }, of).ok).toBe(false)
  })
  it('thiếu đầu nối', () => {
    expect(canConnect({ source: 'S', target: null }, of).ok).toBe(false)
    expect(canConnect({}, of).ok).toBe(false)
  })
})

import { describe, expect, it } from 'vitest'
import { sparkGeom } from './spark'

const pt = (t: number, p10: number, p50: number, p90: number) => ({ t, p10, p50, p90 })

describe('sparkGeom', () => {
  it('maps a flat band onto the drawing box', () => {
    const g = sparkGeom([pt(0, 0, 5, 10), pt(10, 0, 5, 10), pt(20, 0, 5, 10)], 100, 54, { redH: 5, cursor: 10 })
    expect(g.band).toBe('0.0,2.0 50.0,2.0 100.0,2.0 100.0,52.0 50.0,52.0 0.0,52.0')
    expect(g.line).toBe('0.0,27.0 50.0,27.0 100.0,27.0')
    expect(g.thresholdY).toBe(27)
    expect(g.cursorX).toBe(50)
  })

  it('returns empty paths for fewer than two points and hides an out-of-range cursor', () => {
    expect(sparkGeom([pt(0, 1, 1, 1)], 100, 40)).toEqual({ band: '', line: '' })
    expect(sparkGeom([pt(0, 1, 1, 1), pt(10, 1, 1, 1)], 100, 40, { cursor: 99 }).cursorX).toBeUndefined()
  })

  it('caps huge values (no-consumption coverage of 999)', () => {
    const g = sparkGeom([pt(0, 0, 999, 999), pt(10, 0, 999, 999)], 100, 54, { cap: 24 })
    expect(g.line).toBe('0.0,2.0 100.0,2.0')
  })
})

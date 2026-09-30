import { describe, expect, it } from 'vitest'
import { KINDS, describeDist, isDistSchema, kindOf, paramsOf, readParam, setKind, setParam, typicalOf, unitFor } from './dist'

describe('kindOf', () => {
  it('reads a bare number as a fixed value, and a dist object by its name', () => {
    expect(kindOf(40)).toBe('const')
    expect(kindOf({ dist: 'tri', min: 1, mode: 2, max: 3 })).toBe('tri')
    expect(kindOf({ dist: 'normal', mean: 1, sd: 1 })).toBe('norm')
    expect(kindOf({ dist: 'const', value: 3 })).toBe('const')
  })
  it('treats nothing as empty and an unknown distribution as unknown', () => {
    expect(kindOf(undefined)).toBe('empty')
    expect(kindOf(null)).toBe('empty')
    expect(kindOf({ dist: 'gamma', k: 1 })).toBe('unknown')
    expect(kindOf('x')).toBe('unknown')
  })
})

describe('paramsOf', () => {
  it('lists only the parameters the chosen distribution uses, with plain-language labels', () => {
    expect(paramsOf('const').map((p) => p.key)).toEqual(['value'])
    expect(paramsOf('norm').map((p) => p.key)).toEqual(['mean', 'sd'])
    expect(paramsOf('lognorm').map((p) => p.key)).toEqual(['mean', 'cv'])
    expect(paramsOf('tri').map((p) => p.key)).toEqual(['min', 'mode', 'max'])
    expect(paramsOf('uniform').map((p) => p.key)).toEqual(['min', 'max'])
    expect(paramsOf('exp').map((p) => p.key)).toEqual(['mean'])
    expect(paramsOf('weibull').map((p) => p.key)).toEqual(['shape', 'scale'])
    for (const k of KINDS) for (const p of paramsOf(k)) expect(p.label).toMatch(/\S/)
  })
})

describe('readParam', () => {
  it('finds a value under its name or its _s twin (mean_s is what the sim also accepts)', () => {
    expect(readParam({ dist: 'exp', mean: 5 }, 'mean')).toBe(5)
    expect(readParam({ dist: 'exp', mean_s: 7 }, 'mean')).toBe(7)
    expect(readParam({ dist: 'exp' }, 'mean')).toBeUndefined()
    expect(readParam(3, 'mean')).toBeUndefined()
  })
})

describe('typicalOf', () => {
  it('is the mean the sim would use, or 1 when there is nothing to go on', () => {
    expect(typicalOf(40)).toBe(40)
    expect(typicalOf({ dist: 'norm', mean: 90, sd: 15 })).toBe(90)
    expect(typicalOf({ dist: 'tri', min: 15, mode: 20, max: 30 })).toBeCloseTo(65 / 3)
    expect(typicalOf({ dist: 'uniform', min: 10, max: 30 })).toBe(20)
    expect(typicalOf({ dist: 'const', value: 8 })).toBe(8)
    expect(typicalOf({ dist: 'weibull', shape: 2, scale: 100 })).toBeGreaterThan(80)
    expect(typicalOf(undefined)).toBe(1)
    expect(typicalOf({ dist: 'exp' })).toBe(1)
  })
})

describe('setKind', () => {
  it('turns a fixed value into a bare number and keeps its size when changing kind', () => {
    expect(setKind({ dist: 'norm', mean: 90, sd: 15 }, 'const')).toBe(90)
    expect(setKind(45, 'norm')).toEqual({ dist: 'norm', mean: 45, sd: 4.5 })
  })
  it('fills every parameter the new kind needs, so the sim never meets a missing key', () => {
    for (const kind of KINDS.filter((k) => k !== 'const')) {
      const v = setKind(60, kind) as Record<string, unknown>
      expect(v.dist).toBe(kind)
      for (const p of paramsOf(kind)) expect(typeof v[p.key]).toBe('number')
    }
  })
  it('makes a triangle that brackets the old value and keeps min <= mode <= max', () => {
    const v = setKind(20, 'tri') as { min: number; mode: number; max: number }
    expect(v.min).toBeLessThanOrEqual(v.mode)
    expect(v.mode).toBeLessThanOrEqual(v.max)
    expect(v.mode).toBe(20)
  })
  it('starts from 1 when there was no value', () => {
    expect(setKind(undefined, 'const')).toBe(1)
  })
})

describe('setParam', () => {
  it('changes one number without touching the rest, keeping the _s spelling already in use', () => {
    expect(setParam({ dist: 'norm', mean: 90, sd: 15 }, 'sd', 20)).toEqual({ dist: 'norm', mean: 90, sd: 20 })
    expect(setParam({ dist: 'exp', mean_s: 5 }, 'mean', 6)).toEqual({ dist: 'exp', mean_s: 6 })
  })
  it('sets a fixed value directly, and drops a field that was cleared', () => {
    expect(setParam(40, 'value', 50)).toBe(50)
    expect(setParam({ dist: 'norm', mean: 90, sd: 15 }, 'sd', undefined)).toEqual({ dist: 'norm', mean: 90 })
    expect(setParam({ dist: 'const', value: 3 }, 'value', 4)).toEqual({ dist: 'const', value: 4 })
  })
})

describe('unitFor', () => {
  it('counts pieces for quantities and seconds for everything else', () => {
    expect(unitFor('qty')).toBe('đơn vị')
    expect(unitFor('cycle')).toBe('giây')
    expect(unitFor('takt')).toBe('giây')
  })
})

describe('isDistSchema', () => {
  it('recognises the fixed-or-random schema the catalog uses', () => {
    expect(isDistSchema({ oneOf: [{ type: 'number' }, { type: 'object', properties: { dist: {} } }] })).toBe(true)
    expect(isDistSchema({ oneOf: [{ type: 'string' }, { type: 'number' }] })).toBe(false)
    expect(isDistSchema({ type: 'number' })).toBe(false)
  })
})

describe('describeDist', () => {
  it('says in plain words what a default value is', () => {
    expect(describeDist(30, 'giây')).toBe('30 giây')
    expect(describeDist({ dist: 'lognorm', mean: 45, cv: 0.15 }, 'giây')).toBe('Log-chuẩn, trung bình 45 giây')
    expect(describeDist({ dist: 'tri', min: 15, mode: 20, max: 30 }, 'giây')).toBe('Tam giác, từ 15 đến 30 giây, hay gặp nhất 20')
    expect(describeDist({ dist: 'uniform', min: 10, max: 30 }, 'giây')).toBe('Đều, từ 10 đến 30 giây')
    expect(describeDist({ dist: 'const', value: 8 }, 'đơn vị')).toBe('8 đơn vị')
    expect(describeDist({ dist: 'exp', mean: 5 }, 'giây')).toBe('Hàm mũ, trung bình 5 giây')
    expect(describeDist({ dist: 'norm', mean: 90, sd: 15 }, 'giây')).toBe('Chuẩn, trung bình 90 giây')
  })
  it('gives up gracefully on shapes it does not know', () => {
    expect(describeDist(undefined, 'giây')).toBe('')
    expect(describeDist({ dist: 'gamma' }, 'giây')).toBe('')
  })
})

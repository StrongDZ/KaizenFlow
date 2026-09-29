import { describe, expect, it } from 'vitest'
import { impactText } from './impact'

describe('impactText', () => {
  it('lists what will be lost, in a fixed order, skipping zeros', () => {
    expect(impactText({ runs: 12, scenarios: 3 })).toBe('3 scenario, 12 lần chạy')
    expect(impactText({ versions: 2, scenarios: 0, runs: 5 })).toBe('2 phiên bản, 5 lần chạy')
    expect(impactText({})).toBe('')
  })
  it('keeps unknown keys at the end instead of dropping them', () => {
    expect(impactText({ runs: 1, mystery: 4 })).toBe('1 lần chạy, 4 mystery')
  })
})

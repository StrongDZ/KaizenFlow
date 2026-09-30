import { describe, expect, it } from 'vitest'
import { COMMON_UNITS, unitOptions } from './units'

describe('unitOptions', () => {
  it('đơn vị hay gặp đứng trước, theo thứ tự cố định', () => {
    expect(unitOptions([]).map((o) => o.value)).toEqual(COMMON_UNITS.map((o) => o.value))
  })
  it('thêm đơn vị khác đang dùng, bỏ trùng và rỗng, sắp theo chữ', () => {
    const got = unitOptions(['tấm', 'pcs', '', ' tấm ', 'cuộn']).map((o) => o.value)
    expect(got.slice(COMMON_UNITS.length)).toEqual(['cuộn', 'tấm'])
  })
  it('đơn vị đang dùng có nhãn "đang dùng"', () => {
    expect(unitOptions(['cuộn']).find((o) => o.value === 'cuộn')?.hint).toBe('đang dùng')
  })
})

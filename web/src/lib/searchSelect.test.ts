import { describe, expect, it } from 'vitest'
import { fold, rankOptions, type Option } from './searchSelect'

const opts: Option[] = [
  { value: 'RAW-01', label: 'RAW-01', hint: 'Thép tấm · kg' },
  { value: 'PART', label: 'PART', hint: 'Chi tiết dập · pcs' },
  { value: 'SUB_OK', label: 'SUB_OK', hint: 'Bán thành phẩm đạt · pcs' },
  { value: 'BOX', label: 'BOX', hint: 'Thùng thành phẩm · pcs' },
]

describe('fold', () => {
  it('bỏ dấu tiếng Việt và hoa thường', () => {
    expect(fold('Thép Tấm')).toBe('thep tam')
    expect(fold('Đạt')).toBe('dat')
  })
})

describe('rankOptions', () => {
  it('chuỗi rỗng giữ nguyên thứ tự', () => {
    expect(rankOptions(opts, '').map((o) => o.value)).toEqual(['RAW-01', 'PART', 'SUB_OK', 'BOX'])
    expect(rankOptions(opts, '   ').map((o) => o.value)).toEqual(['RAW-01', 'PART', 'SUB_OK', 'BOX'])
  })
  it('khớp đầu từ xếp trước khớp giữa chuỗi', () => {
    // "ok" khớp đầu từ "OK" của SUB_OK (sau gạch dưới)
    expect(rankOptions(opts, 'ok').map((o) => o.value)).toEqual(['SUB_OK'])
    expect(rankOptions(opts, 'pa')[0].value).toBe('PART')
  })
  it('không phân biệt dấu và hoa thường, tìm cả trong gợi ý', () => {
    expect(rankOptions(opts, 'THEP').map((o) => o.value)).toEqual(['RAW-01'])
    expect(rankOptions(opts, 'thung').map((o) => o.value)).toEqual(['BOX'])
  })
  it('bỏ qua dấu gạch khi gõ mã: raw01 tìm ra RAW-01', () => {
    expect(rankOptions(opts, 'raw01').map((o) => o.value)).toEqual(['RAW-01'])
  })
  it('đầu từ thắng chứa chuỗi', () => {
    const list: Option[] = [{ value: 'XBOX', label: 'XBOX' }, { value: 'BOX', label: 'BOX' }]
    expect(rankOptions(list, 'box').map((o) => o.value)).toEqual(['BOX', 'XBOX'])
  })
  it('không khớp thì rỗng', () => {
    expect(rankOptions(opts, 'zzz')).toEqual([])
  })
})

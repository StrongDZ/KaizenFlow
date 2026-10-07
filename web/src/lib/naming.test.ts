import { describe, expect, it } from 'vitest'
import { nextName, slugCode } from './naming'

describe('slugCode', () => {
  it('bỏ dấu tiếng Việt, viết hoa, nối bằng gạch', () => {
    expect(slugCode('Thép tấm 1.2 mm')).toBe('THEP-TAM-1-2-MM')
    expect(slugCode('Đế đỡ')).toBe('DE-DO')
  })
  it('đổi dấu nối theo loại mã', () => {
    expect(slugCode('Máy dập lớn', '_')).toBe('MAY_DAP_LON')
  })
  it('bỏ ký hiệu thừa ở hai đầu, gộp nhiều ký hiệu liền nhau', () => {
    expect(slugCode('  --raw  //  01--  ')).toBe('RAW-01')
  })
  it('rỗng thì rỗng; mã loại node phải bắt đầu bằng chữ', () => {
    expect(slugCode('   ')).toBe('')
    expect(slugCode('123 máy', '_', { startWithLetter: true })).toBe('X_123_MAY')
    expect(slugCode('123 máy', '_')).toBe('123_MAY')
  })
})

describe('nextName', () => {
  it('số thứ tự đầu tiên chưa dùng', () => {
    expect(nextName('Kịch bản', [])).toBe('Kịch bản 1')
    expect(nextName('Kịch bản', ['Kịch bản 1', 'Kịch bản 2'])).toBe('Kịch bản 3')
  })
  it('lấp chỗ trống và không phân biệt hoa thường', () => {
    expect(nextName('Kịch bản', ['kịch bản 1', 'Kịch bản 3'])).toBe('Kịch bản 2')
  })
  it('tên khác không làm lệch', () => {
    expect(nextName('Kịch bản', ['Ca sáng', 'Kịch bản'])).toBe('Kịch bản 1')
  })
})

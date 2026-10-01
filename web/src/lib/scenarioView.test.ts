import { describe, expect, it } from 'vitest'
import { describeOverride } from './scenarioView'

describe('describeOverride', () => {
  it('số lượng: nhãn tiếng Việt và một dòng giá trị', () => {
    expect(describeOverride({ target: 'TUG', path: '/count', value: 3 })).toEqual({ label: 'TUG · số lượng', lines: ['3'] })
  })

  it('tồn kho đầu kỳ: mỗi vật tư một dòng, không bao giờ ra [object Object]', () => {
    const d = describeOverride({
      target: 'KHO_B', path: '/stock',
      value: [{ material: 'RAW-01', initial: 310, max: 600 }, { material: 'RAW-02', initial: 320, max: 800 }],
    })
    expect(d.label).toBe('KHO_B · tồn kho đầu kỳ')
    expect(d.lines).toEqual(['RAW-01: 310 (tối đa 600)', 'RAW-02: 320 (tối đa 800)'])
  })

  it('tồn kho thiếu trần thì chỉ ghi lượng đầu kỳ', () => {
    expect(describeOverride({ target: 'K', path: '/stock', value: [{ material: 'BOX', initial: 7 }] }).lines).toEqual(['BOX: 7'])
  })

  it('đường dẫn lạ giữ nguyên, giá trị đối tượng hiện dạng JSON gọn thay vì [object Object]', () => {
    const d = describeOverride({ target: 'M1', path: '/params/rate', value: { a: 1 } })
    expect(d.label).toBe('M1/params/rate')
    expect(d.lines).toEqual(['{"a":1}'])
  })

  it('số thập phân dùng dấu phẩy', () => {
    expect(describeOverride({ target: 'M1', path: '/params/rate', value: 1.5 }).lines).toEqual(['1,5'])
  })
})

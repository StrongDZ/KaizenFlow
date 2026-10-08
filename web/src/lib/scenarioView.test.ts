import { describe, expect, it } from 'vitest'
import { describeInjection, describeOverride, formatScenarioDuration, scenarioWarmupSeconds, startStateLabel } from './scenarioView'

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

describe('scenario setup formatting', () => {
  it('giữ phần phút khi thời lượng không tròn giờ', () => {
    expect(formatScenarioDuration(30 * 60)).toBe('30 phút')
    expect(formatScenarioDuration(4.5 * 3600)).toBe('4 giờ 30 phút')
    expect(formatScenarioDuration(8 * 3600)).toBe('8 giờ')
  })

  it('mô tả failure và planned stop cho timeline', () => {
    expect(describeInjection({ target: 'STAMP_3', failure: 'bearing_wear', at_s: 7200 })).toEqual({
      atS: 7200, label: 'STAMP_3', detail: 'Lỗi bearing_wear',
    })
    expect(describeInjection({ target: 'A', kind: 'planned_stop', at_s: 900, duration_s: 1800 })).toEqual({
      atS: 900, label: 'A', detail: 'Dừng có kế hoạch trong 30 phút', kind: 'planned_stop', durationS: 1800,
    })
  })

  it('tính warm-up ngoài horizon theo start state và model settings', () => {
    expect(scenarioWarmupSeconds('WARMUP', {})).toBe(3600)
    expect(scenarioWarmupSeconds('WARMUP', { warmup_s: 1800 })).toBe(1800)
    expect(scenarioWarmupSeconds('WARMUP', { warmup_s: null })).toBe(3600)
    expect(scenarioWarmupSeconds('EMPTY', { warmup_s: 1800 })).toBe(0)
    expect(scenarioWarmupSeconds('LIVE_SNAPSHOT', { warmup_s: 1800 })).toBe(0)
  })

  it('dịch start state thống nhất cho setup, detail và report', () => {
    expect(startStateLabel('WARMUP')).toBe('Làm nóng rồi mới ghi')
    expect(startStateLabel('EMPTY')).toBe('Nhà máy rỗng')
    expect(startStateLabel('LIVE_SNAPSHOT')).toBe('Từ ảnh chụp trực tiếp')
    expect(startStateLabel('CUSTOM')).toBe('CUSTOM')
  })
})

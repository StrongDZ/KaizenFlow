import { describe, expect, it } from 'vitest'
import type { Binding, CoverageStatus, SubjectView } from '../api/types'
import { bindingRows, describeBinding, filterBindingRows, toggleInput } from './bindingsTable'

const subjects: SubjectView[] = [
  { subject: 'P', kind: 'node', name: 'Máy dập', archetype: 'PROCESS', signals: [{ name: 'state', label: 'Trạng thái máy', kind: 'text' }, { name: 'count_in', label: 'Số lượt đã nhận vật tư', kind: 'number' }] },
  { subject: 'A>P', kind: 'edge', name: 'Kho A → Máy dập', material: 'RAW-01', signals: [{ name: 'in_transit', label: 'Số đang trên đường', kind: 'number' }, { name: 'moved', label: 'Tổng số đã chuyển', kind: 'number' }] },
]

const base = { id: 0, model_key: 'm', transform: {}, enabled: true }
const b = (over: Partial<Binding>): Binding => ({ ...base, subject: 'P', signal: 'count_in', source: 'plc/p', json_path: 'cnt.in', mode: 'source', ...over })

const bindings: Binding[] = [
  b({ id: 1, subject: 'A>P', signal: 'moved', source: 'belt/a', json_path: 'moved' }),
  b({ id: 2, signal: 'count_in' }),
  b({ id: 3, signal: 'state', source: 'plc/p', json_path: 'st', enabled: false }),
  b({ id: 4, subject: 'A>P', signal: 'in_transit', source: '', json_path: '', mode: 'derived', derive: { kind: 'sum', terms: [{ subject: 'P', signal: 'count_in', sign: 1, factor: 2 }] } }),
  b({ id: 5, subject: 'GONE', signal: 'x' }), // trỏ tới đối tượng không còn
]

const status = (s: string, g: string): CoverageStatus | undefined => ({ 'P|count_in': 'source', 'A>P|moved': 'broken' } as Record<string, CoverageStatus>)[`${s}|${g}`]
const value = (s: string, g: string) => (s === 'P' && g === 'count_in' ? '188' : undefined)

describe('describeBinding', () => {
  const nameOf = (id: string) => subjects.find((s) => s.subject === id)?.name ?? id
  const labelOf = (id: string, g: string) => subjects.find((s) => s.subject === id)?.signals.find((x) => x.name === g)?.label.toLowerCase() ?? g
  it('từ nguồn: nguồn và trường', () => {
    expect(describeBinding(bindings[1], nameOf, labelOf)).toBe('plc/p → cnt.in')
    expect(describeBinding(b({ json_path: '' }), nameOf, labelOf)).toBe('plc/p → (cả bản tin)')
  })
  it('tự tính: câu công thức', () => {
    expect(describeBinding(bindings[3], nameOf, labelOf)).toBe('2 × số lượt đã nhận vật tư của Máy dập')
  })
})

describe('bindingRows', () => {
  const rows = bindingRows(bindings, subjects, (x) => `${x.source}|${x.signal}`, status, value)
  it('sắp theo thứ tự đối tượng trong sơ đồ rồi theo tín hiệu; đối tượng không còn xuống cuối', () => {
    expect(rows.map((r) => r.binding.id)).toEqual([3, 2, 4, 1, 5])
  })
  it('điền tên, nhãn, cách lấy, mô tả, trạng thái, giá trị', () => {
    const r = rows[1]
    expect(r.detail).toBe('plc/p|count_in')
    expect(r).toMatchObject({ subjectName: 'Máy dập', signalLabel: 'Số lượt đã nhận vật tư', how: 'Thiết bị', status: 'source', value: '188', orphan: false })
    expect(rows[2].how).toBe('Tự tính')
    expect(rows[4]).toMatchObject({ orphan: true, subjectName: 'GONE' })
  })
  it('ghép nối đang tắt có trạng thái riêng, không hiện giá trị', () => {
    expect(rows[0].status).toBe('off')
    expect(rows[0].value).toBeUndefined()
  })
})

describe('filterBindingRows', () => {
  const rows = bindingRows(bindings, subjects, (x) => `${x.source}|${x.signal}`, status, value)
  it('chữ tìm khớp tên, nhãn, nguồn, không phân biệt dấu', () => {
    expect(filterBindingRows(rows, { q: 'may dap', view: 'all' }).map((r) => r.binding.id)).toEqual([3, 2, 4, 1])
    expect(filterBindingRows(rows, { q: 'belt', view: 'all' }).map((r) => r.binding.id)).toEqual([1])
  })
  it('lọc theo nhóm', () => {
    expect(filterBindingRows(rows, { q: '', view: 'problem' }).map((r) => r.binding.id)).toEqual([1, 5])
    expect(filterBindingRows(rows, { q: '', view: 'off' }).map((r) => r.binding.id)).toEqual([3])
    expect(filterBindingRows(rows, { q: '', view: 'derived' }).map((r) => r.binding.id)).toEqual([4])
  })
})

describe('toggleInput', () => {
  it('giữ nguyên nội dung, chỉ đổi bật/tắt, và gửi đúng kiểu', () => {
    expect(toggleInput(bindings[2], true)).toEqual({ subject: 'P', signal: 'state', mode: 'source', source: 'plc/p', json_path: 'st', transform: {}, enabled: true })
    const d = toggleInput(bindings[3], false)
    expect(d).toMatchObject({ subject: 'A>P', signal: 'in_transit', mode: 'derived', enabled: false })
    expect(d.derive?.terms?.[0].factor).toBe(2)
    expect(d.source).toBeUndefined()
  })
})

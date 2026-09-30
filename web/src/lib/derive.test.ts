import { describe, expect, it } from 'vitest'
import type { Derive } from '../api/types'
import { addTerm, describeDerive, emptyDerive, isComplete, previewDerive, toInput, updateTerm, removeTerm } from './derive'

const names: Record<string, string> = { A: 'Nhà cung cấp', 'A>K': 'Nhà cung cấp → Kho A', 'K>P': 'Kho A → Máy dập', P: 'Máy dập' }
const labelOf = (_subject: string, signal: string) => ({ moved: 'số đã chuyển', count_in: 'số lượt đã nhận', arrived: 'số đã nhập về', level: 'tồn' })[signal] ?? signal
const nameOf = (s: string) => names[s] ?? s

describe('emptyDerive', () => {
  it('cộng trừ rỗng, hoạt động có sẵn số giây nghỉ', () => {
    expect(emptyDerive('sum')).toEqual({ kind: 'sum', const: 0, terms: [] })
    expect(emptyDerive('activity', 90)).toEqual({ kind: 'activity', idle_after_s: 90 })
    expect(emptyDerive('activity').idle_after_s).toBe(60)
  })
})

describe('term editing', () => {
  it('thêm, sửa, xoá số hạng không đổi bản gốc', () => {
    const d = emptyDerive('sum')
    const d1 = addTerm(d)
    expect(d.terms).toHaveLength(0)
    expect(d1.terms).toEqual([{ subject: '', signal: '', sign: 1 }])
    const d2 = updateTerm(d1, 0, { subject: 'A', signal: 'arrived', sign: -1 })
    expect(d2.terms![0]).toEqual({ subject: 'A', signal: 'arrived', sign: -1 })
    expect(removeTerm(d2, 0).terms).toEqual([])
  })
})

describe('isComplete', () => {
  it('cộng trừ cần ít nhất một số hạng đủ đối tượng và tín hiệu, hệ số không âm', () => {
    expect(isComplete(emptyDerive('sum'))).toBe(false)
    expect(isComplete(addTerm(emptyDerive('sum')))).toBe(false)
    expect(isComplete({ kind: 'sum', terms: [{ subject: 'A', signal: 'arrived', sign: 1 }] })).toBe(true)
    expect(isComplete({ kind: 'sum', terms: [{ subject: 'A', signal: 'arrived', sign: 1, factor: -1 }] })).toBe(false)
  })
  it('hoạt động cần tín hiệu theo dõi và số giây lớn hơn 0', () => {
    expect(isComplete({ kind: 'activity', idle_after_s: 60 })).toBe(false)
    expect(isComplete({ kind: 'activity', watch: { subject: 'P', signal: 'count_in' }, idle_after_s: 0 })).toBe(false)
    expect(isComplete({ kind: 'activity', watch: { subject: 'P', signal: 'count_in' }, idle_after_s: 60 })).toBe(true)
  })
})

describe('toInput', () => {
  it('bỏ số hạng chưa chọn, hệ số 1 và hằng 0 không gửi', () => {
    const d: Derive = { kind: 'sum', const: 0, terms: [{ subject: 'A', signal: 'arrived', sign: 1, factor: 1 }, { subject: '', signal: '', sign: 1 }, { subject: 'B', signal: 'moved', sign: -1, factor: 2 }] }
    expect(toInput(d)).toEqual({ kind: 'sum', terms: [{ subject: 'A', signal: 'arrived', sign: 1 }, { subject: 'B', signal: 'moved', sign: -1, factor: 2 }] })
    expect(toInput({ kind: 'sum', const: 40, terms: [{ subject: 'A', signal: 'arrived', sign: 1 }] }).const).toBe(40)
  })
})

describe('describeDerive', () => {
  it('cộng trừ đọc được bằng tiếng Việt', () => {
    const d: Derive = { kind: 'sum', const: 40, terms: [{ subject: 'A>K', signal: 'moved', sign: 1 }, { subject: 'K>P', signal: 'moved', sign: -1 }] }
    expect(describeDerive(d, nameOf, labelOf)).toBe('40 + số đã chuyển của Nhà cung cấp → Kho A − số đã chuyển của Kho A → Máy dập')
  })
  it('hệ số nhân và số hạng đầu là dấu trừ', () => {
    const d: Derive = { kind: 'sum', terms: [{ subject: 'P', signal: 'count_in', sign: -1, factor: 2 }, { subject: 'A', signal: 'arrived', sign: 1 }] }
    expect(describeDerive(d, nameOf, labelOf)).toBe('−2 × số lượt đã nhận của Máy dập + số đã nhập về của Nhà cung cấp')
  })
  it('trạng thái từ hoạt động', () => {
    const d: Derive = { kind: 'activity', watch: { subject: 'P', signal: 'count_in' }, idle_after_s: 60 }
    expect(describeDerive(d, nameOf, labelOf)).toBe('Đang chạy khi số lượt đã nhận của Máy dập còn tăng trong 60 giây gần nhất, ngược lại là nghỉ')
  })
  it('chưa chọn gì thì nói vậy', () => {
    expect(describeDerive(emptyDerive('sum'), nameOf, labelOf)).toBe('Chưa chọn tín hiệu nào')
  })
})

describe('previewDerive', () => {
  const vals: Record<string, number> = { 'A>K|moved': 30, 'K>P|moved': 12 }
  const read = (subject: string, signal: string) => vals[`${subject}|${signal}`]
  it('tính từ giá trị hiện tại', () => {
    const d: Derive = { kind: 'sum', const: 40, terms: [{ subject: 'A>K', signal: 'moved', sign: 1 }, { subject: 'K>P', signal: 'moved', sign: -1, factor: 2 }] }
    expect(previewDerive(d, read)).toBe(46) // 40 + 30 − 24
  })
  it('thiếu một đầu vào thì chưa xem trước được; trạng thái không xem trước bằng số', () => {
    expect(previewDerive({ kind: 'sum', terms: [{ subject: 'Z', signal: 'moved', sign: 1 }] }, read)).toBeUndefined()
    expect(previewDerive({ kind: 'activity', watch: { subject: 'A>K', signal: 'moved' }, idle_after_s: 60 }, read)).toBeUndefined()
  })
})

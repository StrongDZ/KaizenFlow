import { describe, expect, it } from 'vitest'
import { runRows } from './runNode'

describe('runRows', () => {
  it('trạm: hàng chờ vào là tổng các đầu vào, cộng số đã làm', () => {
    expect(runRows('PROCESS', { 'in:PART': 3, 'in:SUB': 4.5, count_ok: 69.5, count_in: 80 })).toEqual([
      { label: 'Chờ vào', value: '8' }, { label: 'Đã làm', value: '70' },
    ])
  })

  it('kho: tồn tổng, kèm sức chứa khi biết', () => {
    expect(runRows('STORAGE', { 'level:PART': 120, 'level:SUB': 30, coverage_h: 4 }, { maxStock: 600 })).toEqual([{ label: 'Tồn', value: '150 / 600' }])
    expect(runRows('STORAGE', { coverage_h: 4 })).toEqual([])
  })

  it('đích có nhu cầu thì hiện đã giao và nợ đơn; nợ đơn > 0 là cảnh báo', () => {
    expect(runRows('SINK', { demand: 25, fulfilled: 22, backorder: 3 })).toEqual([
      { label: 'Đã giao', value: '22 / 25' }, { label: 'Nợ đơn', value: '3', tone: 'warn' },
    ])
    expect(runRows('SINK', { demand: 0, fulfilled: 12, backorder: 0 })).toEqual([{ label: 'Đã nhận', value: '12' }])
  })

  it('nguồn và đội xe', () => {
    expect(runRows('SOURCE', { 'arrived:RAW-01': 450 })).toEqual([{ label: 'Đã nhập', value: '450' }])
    expect(runRows('RESOURCE_POOL', { busy: 1, queue_len: 0 }, { poolCount: 2 })).toEqual([
      { label: 'Đang bận', value: '1 / 2' }, { label: 'Lượt chờ', value: '0' },
    ])
    expect(runRows('RESOURCE_POOL', { busy: 2, queue_len: 3 })[1].tone).toBe('warn')
  })
})

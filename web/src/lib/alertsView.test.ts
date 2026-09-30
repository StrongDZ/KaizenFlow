import { describe, expect, it } from 'vitest'
import type { InsightRow } from '../api/types'
import { KIND_LABEL, countByKind, filterAlerts, statusLabel } from './alertsView'

const row = (over: Partial<InsightRow>): InsightRow => ({
  id: 1, sim_run_id: 10, kind: 'RED_RISK', subject_key: 'KHO_A', eta: null, probability: 0.5, severity: null, payload: {}, status: 'OPEN',
  created_at: '2026-10-01T08:00:00Z', model_key: 'denso-plant', version: 1, scenario_name: 'Ca sáng', ...over,
})

const rows: InsightRow[] = [
  row({ id: 1 }),
  row({ id: 2, kind: 'DRIFT', subject_key: 'KHO_B', status: 'ACK', model_key: 'denso-mini', scenario_name: 'Ca tối' }),
  row({ id: 3, kind: 'BOTTLENECK', subject_key: 'STAMP_2', status: 'DONE' }),
  row({ id: 4, kind: 'DRIFT', subject_key: 'KHO_A', status: 'OPEN' }),
]

describe('labels', () => {
  it('có nhãn cho mọi loại cảnh báo và trạng thái', () => {
    for (const k of ['RED_RISK', 'BOTTLENECK', 'FAULT_RISK', 'RECOMMENDATION', 'DRIFT']) expect(KIND_LABEL[k]).toBeTruthy()
    expect(statusLabel('OPEN')).toBe('Đang mở')
    expect(statusLabel('ACK')).toBe('Đã xem')
    expect(statusLabel('DONE')).toBe('Đã xong')
    expect(statusLabel('LẠ')).toBe('LẠ')
  })
})

describe('filterAlerts', () => {
  it('mặc định lọc theo trạng thái và loại', () => {
    expect(filterAlerts(rows, { kind: 'ALL', status: 'OPEN', q: '' }).map((r) => r.id)).toEqual([1, 4])
    expect(filterAlerts(rows, { kind: 'DRIFT', status: 'ALL', q: '' }).map((r) => r.id)).toEqual([2, 4])
    expect(filterAlerts(rows, { kind: 'DRIFT', status: 'OPEN', q: '' }).map((r) => r.id)).toEqual([4])
  })
  it('tìm theo đối tượng, mô hình, tên scenario, không phân biệt dấu', () => {
    expect(filterAlerts(rows, { kind: 'ALL', status: 'ALL', q: 'kho_b' }).map((r) => r.id)).toEqual([2])
    expect(filterAlerts(rows, { kind: 'ALL', status: 'ALL', q: 'mini' }).map((r) => r.id)).toEqual([2])
    expect(filterAlerts(rows, { kind: 'ALL', status: 'ALL', q: 'ca sang' }).map((r) => r.id)).toEqual([1, 3, 4])
  })
})

describe('countByKind', () => {
  it('đếm theo loại trong tập đã có, kèm tổng', () => {
    expect(countByKind(rows)).toEqual({ ALL: 4, RED_RISK: 1, BOTTLENECK: 1, DRIFT: 2 })
  })
})

import { describe, expect, it } from 'vitest'
import type { CheckReport } from '../api/types'
import { groupIssues, issuesFor, mergeServerIssues, nodeSummary, reportLabel, toneOf } from './checkView'

const report: CheckReport = {
  ok: false,
  issues: [
    { key: 'A', message: 'lỗi A', severity: 'error', code: 'x' },
    { key: 'A', message: 'cảnh báo A', severity: 'warning', code: 'y' },
    { key: 'B', message: 'cảnh báo B', severity: 'warning', code: 'y' },
    { key: 'C', message: 'cũ không ghi mức' },
  ],
  inferred: [{ key: 'A', param: 'cycle', value: '45 giây', source: 'node_type_default', message: 'm' }],
}

describe('groupIssues', () => {
  it('tách lỗi, cảnh báo; không ghi mức là lỗi', () => {
    const g = groupIssues(report)
    expect(g.errors.map((i) => i.key)).toEqual(['A', 'C'])
    expect(g.warnings.map((i) => i.key)).toEqual(['A', 'B'])
    expect(g.inferred).toHaveLength(1)
  })
  it('báo cáo chưa có thì rỗng', () => {
    expect(groupIssues(undefined)).toEqual({ errors: [], warnings: [], inferred: [] })
  })
})

describe('toneOf và nodeSummary', () => {
  it('lỗi thắng cảnh báo khi cùng khoá', () => {
    expect(toneOf('A', report)).toBe('error')
    expect(toneOf('B', report)).toBe('warning')
    expect(toneOf('Z', report)).toBeUndefined()
  })
  it('tóm tắt đếm đúng', () => {
    expect(nodeSummary('A', report)).toBe('1 lỗi, 1 cảnh báo')
    expect(nodeSummary('B', report)).toBe('1 cảnh báo')
    expect(nodeSummary('Z', report)).toBeUndefined()
    expect(issuesFor('A', report)).toHaveLength(2)
  })
})

describe('reportLabel', () => {
  it('các trạng thái của nút Kiểm tra', () => {
    expect(reportLabel(undefined, true)).toBe('Đang kiểm tra…')
    expect(reportLabel(undefined, false)).toBe('Chưa kiểm tra')
    expect(reportLabel({ ok: true, issues: [], inferred: [] }, false)).toBe('Hợp lệ')
    expect(reportLabel(report, false)).toBe('2 lỗi, 2 cảnh báo')
    expect(reportLabel({ ok: true, issues: [{ key: 'B', message: 'w', severity: 'warning' }], inferred: [] }, false)).toBe('1 cảnh báo')
  })
})

describe('mergeServerIssues', () => {
  it('thêm lỗi server chưa có, đặt lên đầu, báo cáo thành không hợp lệ', () => {
    const base: CheckReport = { ok: true, issues: [], inferred: [] }
    const got = mergeServerIssues(base, [{ key: 'E', message: 'lưu thất bại' }])!
    expect(got.ok).toBe(false)
    expect(got.issues[0]).toMatchObject({ key: 'E', severity: 'error' })
  })
  it('bỏ trùng theo khoá và thông điệp', () => {
    const got = mergeServerIssues(report, [{ key: 'A', message: 'lỗi A' }])!
    expect(got.issues).toHaveLength(4)
  })
  it('không có lỗi server thì trả nguyên báo cáo', () => {
    expect(mergeServerIssues(report, [])).toBe(report)
    expect(mergeServerIssues(undefined, [])).toBeUndefined()
  })
})

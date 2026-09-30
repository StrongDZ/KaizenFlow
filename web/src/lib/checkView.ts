import type { CheckInferred, CheckIssue, CheckReport, Issue } from '../api/types'

export type Tone = 'error' | 'warning'

/** Phát hiện không ghi mức (từ chỗ cũ) được coi là lỗi. */
const toneOfIssue = (i: CheckIssue): Tone => (i.severity === 'warning' ? 'warning' : 'error')

export function groupIssues(r?: CheckReport): { errors: CheckIssue[]; warnings: CheckIssue[]; inferred: CheckInferred[] } {
  const issues = r?.issues ?? []
  return {
    errors: issues.filter((i) => toneOfIssue(i) === 'error'),
    warnings: issues.filter((i) => toneOfIssue(i) === 'warning'),
    inferred: r?.inferred ?? [],
  }
}

export const issuesFor = (key: string, r?: CheckReport): CheckIssue[] => (r?.issues ?? []).filter((i) => i.key === key)

/** Mức của một node/edge: lỗi thắng cảnh báo. */
export function toneOf(key: string, r?: CheckReport): Tone | undefined {
  const list = issuesFor(key, r)
  if (list.some((i) => toneOfIssue(i) === 'error')) return 'error'
  return list.length > 0 ? 'warning' : undefined
}

/** Dòng tóm tắt ngắn ghi trên thẻ node: "1 lỗi", "2 cảnh báo", "1 lỗi, 1 cảnh báo". */
export function nodeSummary(key: string, r?: CheckReport): string | undefined {
  const list = issuesFor(key, r)
  const e = list.filter((i) => toneOfIssue(i) === 'error').length
  const w = list.length - e
  const parts = [e > 0 ? `${e} lỗi` : '', w > 0 ? `${w} cảnh báo` : ''].filter(Boolean)
  return parts.length > 0 ? parts.join(', ') : undefined
}

/** Chữ trên nút Kiểm tra. */
export function reportLabel(r: CheckReport | undefined, checking: boolean): string {
  if (!r) return checking ? 'Đang kiểm tra…' : 'Chưa kiểm tra'
  const { errors, warnings } = groupIssues(r)
  if (errors.length === 0 && warnings.length === 0) return 'Hợp lệ'
  return [errors.length > 0 ? `${errors.length} lỗi` : '', warnings.length > 0 ? `${warnings.length} cảnh báo` : ''].filter(Boolean).join(', ')
}

/** Gộp lỗi server trả về khi Lưu/Publish thất bại vào báo cáo hiện có (là lỗi, bỏ trùng theo khoá và thông điệp). */
export function mergeServerIssues(r: CheckReport | undefined, server: Issue[]): CheckReport | undefined {
  if (server.length === 0) return r
  const base: CheckReport = r ?? { ok: false, issues: [], inferred: [] }
  const seen = new Set(base.issues.map((i) => `${i.key}|${i.message}`))
  const extra = server.filter((i) => !seen.has(`${i.key}|${i.message}`)).map((i): CheckIssue => ({ ...i, severity: 'error' }))
  if (extra.length === 0) return base
  return { ...base, ok: false, issues: [...extra, ...base.issues] }
}

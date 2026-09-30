import type { CoverageReport, CoverageStatus, Readiness, SignalCoverage, SubjectView } from '../api/types'
import { norm } from './suggestMapping'

/** Tên các chức năng mà độ phủ tín hiệu quyết định. */
export const FEATURE_LABEL: Record<string, string> = {
  live: 'Live', forecast: 'Dự báo từ live', calibration: 'Hiệu chỉnh AGV', map: 'Bản đồ xe',
}

/** Thứ tự nhóm node ở trang Kết nối: theo dòng chảy của hàng. */
export const ARCHETYPE_ORDER = ['SOURCE', 'STORAGE', 'PROCESS', 'SINK', 'RESOURCE_POOL']

export function splitSubjects(subjects: SubjectView[]): { nodes: SubjectView[]; edges: SubjectView[] } {
  return { nodes: subjects.filter((s) => s.kind === 'node'), edges: subjects.filter((s) => s.kind === 'edge') }
}

export type NodeGroup = { key: string; title: string; subjects: SubjectView[] }

export function groupNodes(nodes: SubjectView[], labels: Record<string, string>): NodeGroup[] {
  const order = [...ARCHETYPE_ORDER, ...new Set(nodes.map((n) => n.archetype ?? '').filter((a) => a !== '' && !ARCHETYPE_ORDER.includes(a)))]
  return order
    .map((key) => ({ key, title: labels[key] ?? key, subjects: nodes.filter((n) => n.archetype === key) }))
    .filter((g) => g.subjects.length > 0)
}

export const statusKey = (subject: string, signal: string) => `${subject}|${signal}`

export function indexCoverage(report: CoverageReport | undefined): Map<string, SignalCoverage> {
  return new Map((report?.signals ?? []).map((s) => [statusKey(s.subject, s.signal), s]))
}

export const statusOf = (idx: Map<string, SignalCoverage>, subject: string, signal: string): CoverageStatus | undefined => idx.get(statusKey(subject, signal))?.status

/** Đã có giá trị từ đâu đó: nguồn hoặc tự tính. Chưa có và hỏng đều là chưa ghép xong. */
export const isBound = (s: CoverageStatus | undefined): boolean => s === 'source' || s === 'derived'

export type Filter = { q: string; onlyMissing: boolean; feature?: string; missingFor?: Set<string> }

/** Lọc danh sách đối tượng: theo chữ tìm (tên, khoá; không phân biệt dấu), chỉ cái chưa ghép đủ, hoặc chỉ cái còn thiếu cho một chức năng. */
export function filterSubjects(list: SubjectView[], idx: Map<string, SignalCoverage>, f: Filter): SubjectView[] {
  const q = norm(f.q)
  return list.filter((s) => {
    if (q !== '' && !norm(s.name).includes(q) && !norm(s.subject).includes(q)) return false
    if (f.feature && f.missingFor) return s.signals.some((g) => f.missingFor!.has(statusKey(s.subject, g.name)))
    if (f.onlyMissing) return s.signals.some((g) => !isBound(statusOf(idx, s.subject, g.name)))
    return true
  })
}

/** "Live: đủ" hoặc "Dự báo từ live: thiếu 2". */
export function readinessLabel(r: Readiness): string {
  const name = FEATURE_LABEL[r.feature] ?? r.feature
  return r.ok ? `${name}: đủ` : `${name}: thiếu ${r.missing.length}`
}

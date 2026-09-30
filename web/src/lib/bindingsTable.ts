import type { Binding, BindingInput, CoverageStatus, SubjectView } from '../api/types'
import { describeDerive } from './derive'
import { norm } from './suggestMapping'

/** Mô tả ngắn một ghép nối: "nguồn → trường" hoặc câu công thức. */
export function describeBinding(b: Binding, nameOf: (subject: string) => string, labelOf: (subject: string, signal: string) => string): string {
  if (b.mode === 'derived' && b.derive) return describeDerive(b.derive, nameOf, labelOf)
  return `${b.source} → ${b.json_path || '(cả bản tin)'}`
}

export type RowStatus = CoverageStatus | 'off'

export type BindingRow = {
  binding: Binding
  subjectName: string
  signalLabel: string
  how: 'Thiết bị' | 'Tự tính'
  /** Lấy từ nguồn nào, trường nào; hoặc câu công thức. */
  detail: string
  status: RowStatus
  value?: string
  /** Trỏ tới node hoặc edge không còn trong sơ đồ. */
  orphan: boolean
}

/** Mỗi ghép nối một dòng, theo thứ tự đối tượng trong sơ đồ rồi theo thứ tự tín hiệu; ghép nối mồ côi (đối tượng đã xoá) xuống cuối. */
export function bindingRows(
  bindings: Binding[], subjects: SubjectView[],
  describe: (b: Binding) => string,
  statusOf: (subject: string, signal: string) => CoverageStatus | undefined,
  valueOf: (subject: string, signal: string) => string | undefined,
): BindingRow[] {
  const order = new Map(subjects.map((s, i) => [s.subject, i]))
  const rows = bindings.map((b): BindingRow => {
    const s = subjects.find((x) => x.subject === b.subject)
    const sig = s?.signals.find((x) => x.name === b.signal)
    return {
      binding: b,
      subjectName: s?.name ?? b.subject,
      signalLabel: sig?.label ?? b.signal,
      how: b.mode === 'derived' ? 'Tự tính' : 'Thiết bị',
      detail: describe(b),
      status: !b.enabled ? 'off' : s ? statusOf(b.subject, b.signal) ?? 'source' : 'broken',
      value: b.enabled ? valueOf(b.subject, b.signal) : undefined,
      orphan: !s,
    }
  })
  const pos = (r: BindingRow) => (r.orphan ? Number.MAX_SAFE_INTEGER : order.get(r.binding.subject) ?? 0)
  const sigPos = (r: BindingRow) => subjects.find((x) => x.subject === r.binding.subject)?.signals.findIndex((x) => x.name === r.binding.signal) ?? 0
  return rows.sort((a, b) => pos(a) - pos(b) || sigPos(a) - sigPos(b) || a.binding.id - b.binding.id)
}

export type TableView = 'all' | 'problem' | 'off' | 'derived'

export function filterBindingRows(rows: BindingRow[], f: { q: string; view: TableView }): BindingRow[] {
  const q = norm(f.q)
  return rows.filter((r) => {
    if (f.view === 'problem' && r.status !== 'broken') return false
    if (f.view === 'off' && r.status !== 'off') return false
    if (f.view === 'derived' && r.how !== 'Tự tính') return false
    if (q === '') return true
    return [r.subjectName, r.binding.subject, r.signalLabel, r.binding.signal, r.binding.source].some((t) => norm(t).includes(q))
  })
}

/** Dạng gửi lên server để đổi bật/tắt mà giữ nguyên nội dung ghép nối. */
export function toggleInput(b: Binding, enabled: boolean): BindingInput {
  if (b.mode === 'derived') return { subject: b.subject, signal: b.signal, mode: 'derived', derive: b.derive ?? undefined, enabled }
  return { subject: b.subject, signal: b.signal, mode: 'source', source: b.source, json_path: b.json_path, transform: b.transform, enabled }
}

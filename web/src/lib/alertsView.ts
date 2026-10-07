import type { InsightRow } from '../api/types'
import { norm } from './suggestMapping'

export const KIND_LABEL: Record<string, string> = {
  RED_RISK: 'Sắp Đỏ',
  BOTTLENECK: 'Điểm nghẽn',
  FAULT_RISK: 'Nguy cơ hỏng',
  DRIFT: 'Lệch dự báo',
  RECOMMENDATION: 'Đề xuất',
}

const STATUS_LABEL: Record<string, string> = { OPEN: 'Đang mở', ACK: 'Đã xem', DONE: 'Đã xong' }
export const statusLabel = (s: string): string => STATUS_LABEL[s] ?? s

export type AlertFilter = { kind: string; status: string; q: string }

/** Lọc danh sách cảnh báo theo loại ('ALL' là mọi loại), trạng thái ('ALL' là mọi trạng thái) và chữ tìm (đối tượng, mô hình, scenario). */
export function filterAlerts(rows: InsightRow[], f: AlertFilter): InsightRow[] {
  const q = norm(f.q)
  return rows.filter((r) => {
    if (f.kind !== 'ALL' && r.kind !== f.kind) return false
    if (f.status !== 'ALL' && r.status !== f.status) return false
    if (q === '') return true
    return [r.subject_key ?? '', r.model_key, r.scenario_name].some((t) => norm(t).includes(q))
  })
}

export function countByKind(rows: InsightRow[]): Record<string, number> {
  const out: Record<string, number> = { ALL: rows.length }
  for (const r of rows) out[r.kind] = (out[r.kind] ?? 0) + 1
  return out
}

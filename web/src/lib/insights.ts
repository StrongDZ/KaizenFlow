import type { Insight, Json } from '../api/types'

export type Action = { type: string; target: string; cost: number; at_s?: number; duration_s?: number; delta?: number; rop?: number }
export type Candidate = { rank: number; action: Action; delta_kpi: { red_minutes: number; throughput: number }; score: number }

export function candidatesOf(ins: Insight): Candidate[] {
  const c = ins.payload?.candidates
  return Array.isArray(c) ? (c as Candidate[]) : []
}

const minutes = (s?: number) => Math.round((s ?? 0) / 60)

export function describeAction(a: Action): string {
  switch (a.type) {
    case 'PLANNED_STOP':
      return `Dừng bảo trì ${a.target} ở phút ${minutes(a.at_s)}, trong ${minutes(a.duration_s)} phút`
    case 'REALLOCATE_OPERATOR':
      return `Điều thêm 1 người vào ${a.target}`
    case 'FLEET_SIZE':
      return `Thêm 1 xe cho ${a.target}`
    case 'REPLENISH':
      return `Nâng điểm đặt hàng của ${a.target} lên ${a.rop ?? '?'}`
    default:
      return `${a.type} ${a.target}`
  }
}

function fmtEta(eta: string | null): string {
  return eta ? ` (dự kiến ${new Date(eta).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' })})` : ''
}

export function describeInsight(ins: Insight): string {
  const p = Math.round((ins.probability ?? 0) * 100)
  switch (ins.kind) {
    case 'RED_RISK':
      return `${ins.subject_key} có ${p}% khả năng chuyển Đỏ${fmtEta(ins.eta)}`
    case 'BOTTLENECK':
      return `Bottleneck: ${ins.subject_key} (${p}% thời gian)`
    case 'RECOMMENDATION':
      return `Đề xuất xử lý cho ${ins.subject_key}`
    default:
      return `${ins.kind} ${ins.subject_key ?? ''}`
  }
}

export function kpiP50(kpis: Json | null | undefined, key: string): number | undefined {
  const v = kpis?.[key] as { p50?: number } | undefined
  return v?.p50
}

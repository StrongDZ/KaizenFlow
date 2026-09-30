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

/** Câu cảnh báo lệch dự báo: "Kho NVL A · RAW-01 đang thấp hơn dự báo: thực tế 42, dải dự báo 88–110". */
export function describeDrift(ins: Insight, nameOf: (key: string) => string = (k) => k): string {
  const who = nameOf(ins.subject_key ?? '')
  const p = ins.payload ?? {}
  const metric = typeof p.metric === 'string' ? p.metric.replace(/^level:/, '') : ''
  const subject = metric ? `${who} · ${metric}` : who
  const [actual, p10, p90] = [p.actual, p.p10, p.p90]
  if (typeof actual !== 'number' || typeof p10 !== 'number' || typeof p90 !== 'number' || (p.direction !== 'below' && p.direction !== 'above')) {
    return `${subject} đang lệch dự báo`
  }
  const side = p.direction === 'below' ? 'thấp' : 'cao'
  return `${subject} đang ${side} hơn dự báo: thực tế ${Math.round(actual)}, dải dự báo ${Math.round(p10)}–${Math.round(p90)}`
}

export function describeInsight(ins: Insight): string {
  const p = Math.round((ins.probability ?? 0) * 100)
  switch (ins.kind) {
    case 'RED_RISK':
      return `${ins.subject_key} có ${p}% khả năng chuyển Đỏ${fmtEta(ins.eta)}`
    case 'BOTTLENECK':
      return `Bottleneck: ${ins.subject_key} (${p}% thời gian)`
    case 'FAULT_RISK':
      return `${ins.subject_key} có nguy cơ hỏng (${p}%)${fmtEta(ins.eta)}`
    case 'RECOMMENDATION':
      return `Đề xuất xử lý cho ${ins.subject_key}`
    case 'DRIFT':
      return describeDrift(ins)
    default:
      return `${ins.kind} ${ins.subject_key ?? ''}`
  }
}

export function kpiP50(kpis: Json | null | undefined, key: string): number | undefined {
  const v = kpis?.[key] as { p50?: number } | undefined
  return v?.p50
}

export function kpiBand(kpis: Json | null | undefined, key: string): { p10: number; p50: number; p90: number } | undefined {
  const v = kpis?.[key] as { p10?: number; p50?: number; p90?: number } | undefined
  if (v?.p10 === undefined || v.p50 === undefined || v.p90 === undefined) return undefined
  return { p10: v.p10, p50: v.p50, p90: v.p90 }
}

export function insightDetail(ins: Insight): string {
  const p = Math.round((ins.probability ?? 0) * 100)
  switch (ins.kind) {
    case 'RED_RISK':
    case 'FAULT_RISK':
      return `${p}% số lần lặp`
    case 'BOTTLENECK': {
      const meanS = ins.payload?.mean_s
      if (typeof meanS === 'number') return `chờ trung bình ${Math.round(meanS / 60)} phút`
      return `là điểm nghẽn ${p}% thời gian`
    }
    default:
      return ''
  }
}

import type { Insight, Json } from '../api/types'

export type Action = {
  type: string
  target: string
  cost: number
  at_s?: number
  duration_s?: number
  delta?: number
  rop?: number
  qty?: number
  material?: string
  from_rate?: number
  to_rate?: number
  from_slots?: number
  to_slots?: number
  from_level?: number
  to_level?: number
}
type NumericMetrics = Record<string, number | null | undefined>
export type Candidate = {
  rank: number
  action: Action
  delta_kpi: { red_minutes: number; throughput: number }
  score: number
  score_v2?: number
  reason?: string | null
  evidence?: NumericMetrics | null
  expected_impact?: {
    baseline?: NumericMetrics
    candidate?: NumericMetrics
    delta?: NumericMetrics
  } | null
}

export type DetailRow = { label: string; value: string }

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
      if (typeof a.qty === 'number') {
        const levels = isFiniteNumber(a.from_level) && isFiniteNumber(a.to_level) ? ` (${formatNumber(a.from_level)} → ${formatNumber(a.to_level)})` : ''
        return `Bổ sung ${formatNumber(a.qty)} ${a.material ?? ''} vào ${a.target} trước ca${levels}`.trim()
      }
      return `Nâng điểm đặt hàng của ${a.target} lên ${a.rop ?? '?'}`
    case 'INCREASE_PROCESS_CAPACITY':
      return `Tăng năng lực ${a.target} thêm ${a.delta ?? 1} slot`
    case 'REDUCE_MACHINE_RATE':
      return !isFiniteNumber(a.to_rate)
        ? `Giảm nhịp máy ${a.target}`
        : `Giảm nhịp ${a.target} xuống ${formatNumber(a.to_rate)} u/h`
    case 'STOP_MACHINE':
      return `Tạm dừng ${a.target} ở phút ${minutes(a.at_s)}, trong ${minutes(a.duration_s)} phút`
    default:
      return `${a.type} ${a.target}`
  }
}

const formatNumber = (value: number, digits = 1): string => value.toLocaleString('vi-VN', { maximumFractionDigits: digits })
const signed = (value: number, suffix = ''): string => `${value > 0 ? '+' : ''}${formatNumber(value)}${suffix}`
const isFiniteNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)

export function evidenceRows(evidence?: NumericMetrics | null): DetailRow[] {
  if (!evidence) return []
  const rows: DetailRow[] = []
  if (isFiniteNumber(evidence.utilization)) rows.push({ label: 'Mức sử dụng', value: `${formatNumber(evidence.utilization * 100)}%` })
  if (isFiniteNumber(evidence.nominal_rate)) rows.push({ label: 'Năng lực danh nghĩa', value: `${formatNumber(evidence.nominal_rate)} u/h` })
  if (isFiniteNumber(evidence.effective_throughput)) rows.push({ label: 'Lưu lượng thực tế', value: `${formatNumber(evidence.effective_throughput)} u/h` })
  if (isFiniteNumber(evidence.capacity_gap)) rows.push({ label: 'Chênh năng lực thượng nguồn', value: signed(evidence.capacity_gap, ' u/h') })
  if (isFiniteNumber(evidence.upstream_wip_growth)) rows.push({ label: 'Mức tăng WIP thượng nguồn', value: signed(evidence.upstream_wip_growth) })
  if (isFiniteNumber(evidence.downtime_s)) rows.push({ label: 'Thời gian dừng', value: `${formatNumber(evidence.downtime_s / 60)} phút` })
  if (isFiniteNumber(evidence.initial_stock)) rows.push({ label: 'Tồn đầu ca hiện tại', value: formatNumber(evidence.initial_stock) })
  if (isFiniteNumber(evidence.target_stock)) rows.push({ label: 'Tồn mục tiêu', value: formatNumber(evidence.target_stock) })
  if (isFiniteNumber(evidence.recommended_replenish)) rows.push({ label: 'Lượng cần bổ sung', value: formatNumber(evidence.recommended_replenish) })
  if (isFiniteNumber(evidence.demand_rate_h)) rows.push({ label: 'Nhu cầu ước tính', value: `${formatNumber(evidence.demand_rate_h)} / giờ` })
  if (isFiniteNumber(evidence.target_coverage_h)) rows.push({ label: 'Mức phủ mục tiêu', value: `${formatNumber(evidence.target_coverage_h)} giờ` })
  return rows
}

export function expectedImpactRows(candidate: Candidate): DetailRow[] {
  const delta = candidate.expected_impact?.delta
  if (!delta) return []
  const rows: DetailRow[] = []
  if (isFiniteNumber(delta.throughput)) rows.push({ label: 'Sản lượng', value: signed(delta.throughput) })
  if (isFiniteNumber(delta.backorder)) rows.push({ label: 'Đơn thiếu', value: signed(delta.backorder) })
  if (isFiniteNumber(delta.blocked_s)) rows.push({ label: 'Thời gian blocked', value: signed(delta.blocked_s / 60, ' phút') })
  if (isFiniteNumber(delta.starved_s)) rows.push({ label: 'Thời gian starved', value: signed(delta.starved_s / 60, ' phút') })
  if (isFiniteNumber(delta.wip_peak)) rows.push({ label: 'Đỉnh WIP', value: signed(delta.wip_peak) })
  return rows
}

export function tradeOffRows(candidate: Candidate): DetailRow[] {
  const delta = candidate.expected_impact?.delta
  if (!delta) return []
  const rows: DetailRow[] = []
  if (isFiniteNumber(delta.throughput) && delta.throughput < 0) rows.push({ label: 'Sản lượng', value: signed(delta.throughput) })
  if (isFiniteNumber(delta.red_minutes) && delta.red_minutes > 0) rows.push({ label: 'Phút Đỏ', value: signed(delta.red_minutes, ' phút') })
  if (isFiniteNumber(delta.backorder) && delta.backorder > 0) rows.push({ label: 'Đơn thiếu', value: signed(delta.backorder) })
  if (isFiniteNumber(delta.blocked_s) && delta.blocked_s > 0) rows.push({ label: 'Thời gian blocked', value: signed(delta.blocked_s / 60, ' phút') })
  if (isFiniteNumber(delta.starved_s) && delta.starved_s > 0) rows.push({ label: 'Thời gian starved', value: signed(delta.starved_s / 60, ' phút') })
  if (isFiniteNumber(delta.wip_peak) && delta.wip_peak > 0) rows.push({ label: 'Đỉnh WIP', value: signed(delta.wip_peak) })
  return rows
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
      if (ins.payload?.ambiguous === true && Array.isArray(ins.payload?.co_bottlenecks)) {
        return `Điểm nghẽn tương đương: ${(ins.payload.co_bottlenecks as string[]).join(', ')}`
      }
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
      if (ins.payload?.ambiguous === true && Array.isArray(ins.payload?.co_bottlenecks)) {
        return 'các công đoạn có mức nghẽn tương đương; cần thêm bằng chứng để chọn một công đoạn'
      }
      const evidence = ins.payload?.evidence as NumericMetrics | null | undefined
      const parts: string[] = []
      const meanS = ins.payload?.mean_s
      parts.push(typeof meanS === 'number' ? `chờ trung bình ${Math.round(meanS / 60)} phút` : `là điểm nghẽn ${p}% thời gian`)
      if (isFiniteNumber(evidence?.utilization)) parts.push(`sử dụng ${Math.round(evidence.utilization * 100)}%`)
      if (isFiniteNumber(evidence?.capacity_gap) && evidence.capacity_gap > 0) parts.push(`năng lực upstream cao hơn ${formatNumber(evidence.capacity_gap)} u/h`)
      if (isFiniteNumber(evidence?.upstream_wip_growth) && evidence.upstream_wip_growth > 0) parts.push('WIP đang tăng')
      return parts.join(' · ')
    }
    default:
      return ''
  }
}

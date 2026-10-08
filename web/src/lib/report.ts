import type { Insight, Run } from '../api/types'
import { kpiP50 } from './insights'

export type FailureImpact = {
  failed_machine: string
  failure_at?: number
  downtime_s?: number
  failed_upstream_blocked_s?: number
  failed_downstream_starved_s?: number
  reference_upstream_blocked_s?: number
  reference_downstream_starved_s?: number
  throughput_loss?: number
  throughput_loss_pct?: number | null
  backorder_delta?: number
  additional_upstream_blocked_s?: number
  additional_downstream_starved_s?: number
  time_to_first_upstream_block?: number | null
  time_to_first_downstream_starve?: number | null
  recovery_delay_s?: number | null
  WIP_peak_delta?: number
}

/** Lấy impact do sim-service gắn trong recommendation, loại bản ghi thiếu máy hỏng. */
export function failureImpactsOf(insights: Insight[]): FailureImpact[] {
  return insights.flatMap((insight) => {
    if (insight.kind !== 'RECOMMENDATION' || !Array.isArray(insight.payload?.failure_impacts)) return []
    return insight.payload.failure_impacts.flatMap((raw) => {
      if (!raw || typeof raw !== 'object') return []
      const value = raw as Record<string, unknown>
      return typeof value.failed_machine === 'string' ? [value as FailureImpact] : []
    })
  })
}

/**
 * Scenario con không lưu trực tiếp source run. Khi parent không cố định seed, child seed chính là source run id.
 * Với parent có seed cố định, chọn run DONE cùng mốc mô phỏng gần nhất trước child.
 */
export function pickParentBaseline(runs: Run[], current: Run, childSeed: number | null, parentSeed: number | null): Run | undefined {
  const doneBefore = runs.filter((run) => run.status === 'DONE' && Date.parse(run.created_at) <= Date.parse(current.created_at))
  if (parentSeed === null && childSeed !== null) {
    const exact = doneBefore.find((run) => run.id === childSeed)
    if (exact) return exact
  }
  const sameStart = doneBefore.filter((run) => run.sim_start === current.sim_start)
  const pool = sameStart.length > 0 ? sameStart : doneBefore
  return [...pool].sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))[0]
}

export function reportMetricText(value: number | undefined, suffix = '', signed = false, maximumFractionDigits = 1): string {
  if (value === undefined || !Number.isFinite(value)) return '—'
  const digits = signed && value !== 0 && Math.abs(value) < 0.1 ? Math.max(2, maximumFractionDigits) : maximumFractionDigits
  // Tránh hiển thị “-0”: mọi giá trị sẽ bị làm tròn về 0 với số chữ số hiện tại đều được chuẩn hoá trước khi format.
  const clean = Math.abs(value) < 0.5 * 10 ** -digits ? 0 : value
  const prefix = signed && clean > 0 ? '+' : ''
  return `${prefix}${clean.toLocaleString('vi-VN', { maximumFractionDigits: digits })}${suffix}`
}

export type AppliedVerdict = { tone: 'good' | 'warn' | 'neutral'; title: string; detail: string }

/** Kết luận chỉ dựa trên KPI thực tế P50 của hai run cùng điều kiện, không dùng expected impact cũ. */
export function appliedVerdict(baseline: Run, current: Run): AppliedVerdict {
  const baseRed = kpiP50(baseline.kpis, 'red_minutes')
  const nowRed = kpiP50(current.kpis, 'red_minutes')
  const baseThroughput = kpiP50(baseline.kpis, 'throughput')
  const nowThroughput = kpiP50(current.kpis, 'throughput')
  if ([baseRed, nowRed, baseThroughput, nowThroughput].some((value) => value === undefined)) {
    return { tone: 'neutral', title: 'Chưa đủ KPI để kết luận', detail: 'Cần đủ Red minutes và sản lượng của cả baseline lẫn run sau áp dụng.' }
  }
  const redDelta = nowRed! - baseRed!
  const throughputDelta = nowThroughput! - baseThroughput!
  if (redDelta < 0 && throughputDelta >= 0) {
    return { tone: 'good', title: 'Action có hiệu quả trong lần mô phỏng này', detail: 'Phút Đỏ giảm trong khi sản lượng được giữ nguyên hoặc tăng.' }
  }
  if (redDelta < 0) {
    return { tone: 'warn', title: 'Giảm rủi ro nhưng có đánh đổi sản lượng', detail: 'Phút Đỏ giảm, nhưng sản lượng cũng giảm; cần kiểm tra mức đánh đổi trước khi triển khai.' }
  }
  if (throughputDelta > 0) {
    return { tone: 'warn', title: 'Sản lượng tăng nhưng rủi ro chưa giảm', detail: 'Cần kiểm tra tồn kho và các KPI bảo vệ trước khi coi action là hiệu quả.' }
  }
  return { tone: 'neutral', title: 'Chưa chứng minh được cải thiện', detail: 'Run sau áp dụng không cải thiện Phút Đỏ hoặc sản lượng so với baseline.' }
}

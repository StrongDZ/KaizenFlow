import type { SubjectSnap } from '../api/types'

export type ActualPoint = { t: number; v: number }
export type BandPoint = { t: number; p10: number; p50: number; p90: number }
/** low + range là hai lớp Area xếp chồng để tô dải P10–P90; p50 vẽ thành đường. */
export type ChartRow = { t: number; actual?: number; p50?: number; low?: number; range?: number }

export const HORIZONS = [
  { s: 1800, label: '30 phút' },
  { s: 7200, label: '2 giờ' },
  { s: 28800, label: '8 giờ' },
  { s: 86400, label: '1 ngày' },
  { s: 259200, label: '3 ngày' },
  { s: 604800, label: '1 tuần' },
] as const

/** Ghép chuỗi thực tế (live) với dải dự báo thành các dòng thưa theo thời gian; fromT bỏ phần thực tế cũ hơn. */
export function buildForecastRows(actual: ActualPoint[], bands: BandPoint[], fromT?: number): ChartRow[] {
  const byT = new Map<number, ChartRow>()
  const row = (t: number) => {
    let r = byT.get(t)
    if (!r) byT.set(t, (r = { t }))
    return r
  }
  for (const a of actual) if (fromT === undefined || a.t >= fromT) row(a.t).actual = a.v
  for (const b of bands) {
    const r = row(b.t)
    r.p50 = b.p50
    r.low = b.p10
    r.range = Math.max(0, b.p90 - b.p10)
  }
  return [...byT.values()].sort((x, y) => x.t - y.t)
}

export type LevelMetric = { id: string; subject: string; metric: string; label: string }

/** Các chuỗi tồn kho đang nhận từ live (mỗi kho, mỗi vật tư một chuỗi), để chọn xem dự báo. */
export function levelMetrics(subjects: Record<string, SubjectSnap>, names: Record<string, string>): LevelMetric[] {
  const out: LevelMetric[] = []
  for (const [subject, snap] of Object.entries(subjects)) {
    for (const name of Object.keys(snap.signals)) {
      if (!name.startsWith('level:')) continue
      out.push({ id: `${subject}|${name}`, subject, metric: name, label: `${names[subject] ?? subject} · ${name.slice(6)}` })
    }
  }
  return out.sort((a, b) => a.id.localeCompare(b.id))
}

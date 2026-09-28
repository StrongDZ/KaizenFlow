import type { BandRow } from '../api/types'

export type Thresholds = { red_h: number; yellow_low_h: number; yellow_high_h: number }
export const DEFAULT_THRESHOLDS: Thresholds = { red_h: 1, yellow_low_h: 4, yellow_high_h: 12 }
export const NO_USE_COVERAGE = 999

/** Cùng luật với sim-service (nodes/storage.py). */
export function colorFor(cov: number | undefined, th: Thresholds): 'GREEN' | 'YELLOW' | 'RED' | 'NONE' {
  if (cov === undefined) return 'NONE'
  if (cov >= NO_USE_COVERAGE) return 'GREEN'
  if (cov < th.red_h) return 'RED'
  if (cov < th.yellow_low_h || cov > th.yellow_high_h) return 'YELLOW'
  return 'GREEN'
}

export type Point = { t: number; p10: number; p50: number; p90: number }
export type BandIndex = Map<string, Map<string, Point[]>>

export function indexBands(rows: BandRow[]): BandIndex {
  const idx: BandIndex = new Map()
  for (const r of rows) {
    let bySubject = idx.get(r.subject)
    if (!bySubject) idx.set(r.subject, (bySubject = new Map()))
    let pts = bySubject.get(r.metric)
    if (!pts) bySubject.set(r.metric, (pts = []))
    pts.push({ t: Date.parse(r.t), p10: r.p10, p50: r.p50, p90: r.p90 })
  }
  for (const m of idx.values()) for (const pts of m.values()) pts.sort((a, b) => a.t - b.t)
  return idx
}

export function series(idx: BandIndex, subject: string, metric: string): Point[] {
  return idx.get(subject)?.get(metric) ?? []
}

/** Điểm cuối cùng có t ≤ thời điểm hỏi (trước điểm đầu thì trả điểm đầu). */
export function valueAt(points: Point[], t: number): Point | undefined {
  if (points.length === 0) return undefined
  if (t < points[0].t) return points[0]
  let lo = 0
  let hi = points.length - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (points[mid].t <= t) lo = mid
    else hi = mid - 1
  }
  return points[lo]
}

export function timeline(idx: BandIndex): number[] {
  const set = new Set<number>()
  for (const m of idx.values()) for (const pts of m.values()) for (const p of pts) set.add(p.t)
  return [...set].sort((a, b) => a - b)
}

export function clip(points: Point[], max: number): Point[] {
  return points.map((p) => ({ t: p.t, p10: Math.min(p.p10, max), p50: Math.min(p.p50, max), p90: Math.min(p.p90, max) }))
}

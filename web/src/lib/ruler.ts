import type { EventRow, GraphNode, Json, NodeType } from '../api/types'
import { thresholdsFor } from './model'
import { colorFor, series, type BandIndex } from './replay'

export type Ruler = { start: number; end: number; step: number }
export type Zone = { from: number; to: number }
export type MaintenanceWindow = { target: string; from: number; to: number }

const DEFAULT_STEP = 60_000

export function rulerOf(times: number[]): Ruler {
  if (times.length === 0) return { start: 0, end: 0, step: DEFAULT_STEP }
  const gaps: number[] = []
  for (let i = 1; i < times.length; i++) gaps.push(times[i] - times[i - 1])
  gaps.sort((a, b) => a - b)
  const step = gaps.length ? gaps[Math.floor(gaps.length / 2)] : DEFAULT_STEP
  return { start: times[0], end: times[times.length - 1], step: step > 0 ? step : DEFAULT_STEP }
}

export function pct(r: Ruler, t: number): number {
  if (r.end <= r.start) return 0
  return Math.min(100, Math.max(0, ((t - r.start) / (r.end - r.start)) * 100))
}

export function tFromPct(r: Ruler, p: number): number {
  return r.start + (Math.min(100, Math.max(0, p)) / 100) * (r.end - r.start)
}

/** Chỉ số mốc lấy mẫu gần t nhất (hoà thì chọn mốc trước). */
export function nearestIndex(times: number[], t: number): number {
  if (times.length === 0) return 0
  let lo = 0
  let hi = times.length - 1
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (times[mid] < t) lo = mid + 1
    else hi = mid
  }
  if (lo > 0 && t - times[lo - 1] <= times[lo] - t) return lo - 1
  return lo
}

export function hourTicks(r: Ruler): { t: number; pct: number }[] {
  if (r.end <= r.start) return []
  const out: { t: number; pct: number }[] = []
  const d = new Date(r.start)
  d.setMinutes(0, 0, 0)
  if (d.getTime() < r.start) d.setHours(d.getHours() + 1)
  for (; d.getTime() <= r.end; d.setHours(d.getHours() + 1)) out.push({ t: d.getTime(), pct: pct(r, d.getTime()) })
  return out
}

const NICE = [1, 2, 5, 10, 15, 30]

/** Vạch phụ mỗi bao nhiêu mốc lấy mẫu để không dày đặc hơn minGapPx. */
export function minorEvery(count: number, widthPx = 640, minGapPx = 8): number {
  if (count < 2) return 1
  const gap = widthPx / (count - 1)
  const need = Math.ceil(minGapPx / gap)
  return NICE.find((n) => n >= need) ?? NICE[NICE.length - 1]
}

export function redZones(idx: BandIndex, nodes: GraphNode[], types: Record<string, NodeType>, step: number): Zone[] {
  const raw: Zone[] = []
  for (const n of nodes) {
    if (n.archetype !== 'STORAGE') continue
    const th = thresholdsFor({ node_type: n.node_type, params: n.params ?? {} }, types)
    const pts = series(idx, n.key, 'coverage_h')
    pts.forEach((p, i) => {
      if (colorFor(p.p50, th) === 'RED') raw.push({ from: p.t, to: pts[i + 1]?.t ?? p.t + step })
    })
  }
  raw.sort((a, b) => a.from - b.from)
  const out: Zone[] = []
  for (const z of raw) {
    const last = out[out.length - 1]
    if (last && z.from <= last.to) last.to = Math.max(last.to, z.to)
    else out.push({ ...z })
  }
  return out
}

export function failureMarks(events: EventRow[]): number[] {
  const times = events.filter((e) => e.rep === 0 && e.type === 'FAILURE').map((e) => Date.parse(e.t))
  return [...new Set(times)].sort((a, b) => a - b)
}

/** Đổi planned_stop của scenario thành khoảng thời gian tuyệt đối trên Control Room. */
export function maintenanceWindows(injections: Json[], simStart: string): MaintenanceWindow[] {
  const start = Date.parse(simStart)
  if (!Number.isFinite(start)) return []
  return injections.flatMap((inj) => {
    const atS = inj.at_s
    const durationS = inj.duration_s
    const target = inj.target
    if (inj.kind !== 'planned_stop' || typeof target !== 'string' || target === ''
      || typeof atS !== 'number' || !Number.isFinite(atS)
      || typeof durationS !== 'number' || !Number.isFinite(durationS) || durationS <= 0) return []
    return [{ target, from: start + atS * 1000, to: start + (atS + durationS) * 1000 }]
  }).sort((a, b) => a.from - b.from || a.target.localeCompare(b.target))
}

export function maintenanceAt(windows: MaintenanceWindow[], target: string, t: number): MaintenanceWindow | undefined {
  return windows.find((w) => w.target === target && t >= w.from && t < w.to)
}

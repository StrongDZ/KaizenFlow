import type { HistoryPoint } from '../api/gauge'

/** Khoảng thời gian xem lịch sử: một khoảng tính lùi từ bây giờ, hoặc một khoảng do người dùng chọn. */
export type HistoryRange = { preset: string } | { from: number; to: number }

export const PRESETS: { key: string; label: string; ms: number }[] = [
  { key: '1h', label: '1 giờ', ms: 3_600_000 },
  { key: '6h', label: '6 giờ', ms: 6 * 3_600_000 },
  { key: '24h', label: '24 giờ', ms: 24 * 3_600_000 },
  { key: '7d', label: '7 ngày', ms: 7 * 24 * 3_600_000 },
  { key: '30d', label: '30 ngày', ms: 30 * 24 * 3_600_000 },
]

/** Hai đầu mút (ms) của một khoảng. Khoảng tính lùi được làm tròn xuống `step` để câu hỏi gửi server không đổi từng giây. */
export function rangeBounds(range: HistoryRange, now: number, step = 15_000): { from: number; to: number } {
  if ('from' in range) return { from: range.from, to: range.to }
  const to = Math.floor(now / step) * step
  const ms = PRESETS.find((p) => p.key === range.preset)?.ms ?? PRESETS[0].ms
  return { from: to - ms, to }
}

/** Khoảng trống dài hơn mức này giữa hai điểm là mất dữ liệu chứ không phải nhịp gửi bình thường.
    Bộ đếm chỉ được gửi khi đổi số hoặc mỗi phút một lần, nên được chờ lâu hơn. */
export function gapLimit(bucketS: number, type: string): number {
  return Math.max(3 * bucketS * 1000, type === 'rolling_counter' ? 180_000 : 5_000)
}

export type Sample = { t: number; value: number; min: number; max: number }

/** Các đoạn liền nhau của lịch sử: cắt ở chỗ không có điểm, hoặc điểm không đọc ra số, lâu hơn `gapMs`. */
export function segments(points: HistoryPoint[], gapMs: number): Sample[][] {
  const out: Sample[][] = []
  let current: Sample[] = []
  for (const p of points) {
    if (p.value === null) continue
    const t = Date.parse(p.ts)
    if (current.length > 0 && t - current[current.length - 1].t > gapMs) { out.push(current); current = [] }
    current.push({ t, value: p.value, min: p.min ?? p.value, max: p.max ?? p.value })
  }
  if (current.length > 0) out.push(current)
  return out
}

export type HistoryEvent = {
  /** high, low: vượt ngưỡng trên, dưới; gap: không có số liệu. */
  kind: 'high' | 'low' | 'gap'
  from: number
  to: number
  /** Giá trị xa ngưỡng nhất trong lúc vượt; null với khoảng không có số liệu. */
  peak: number | null
}

/** Các lần vượt ngưỡng và các khoảng không có số liệu trong [from, to], theo thứ tự thời gian.
    Một điểm vượt ngưỡng khi cực trị của nó vượt, không phải trung bình: lần vọt ngắn vẫn được tính. */
export function historyEvents(
  points: HistoryPoint[], bucketS: number, gapMs: number, limits: { min: number | null; max: number | null }, bounds: { from: number; to: number },
  /** Hai lần vượt cùng chiều cách nhau không quá mức này là một sự kiện: giá trị dao động quanh ngưỡng không sinh ra hàng chục dòng. */
  mergeMs = 0,
): HistoryEvent[] {
  const bucket = bucketS * 1000
  const out: HistoryEvent[] = []
  const open: Partial<Record<'high' | 'low', HistoryEvent>> = {}
  const close = (kind: 'high' | 'low') => { if (open[kind]) { out.push(open[kind]); delete open[kind] } }
  let last = bounds.from
  for (const s of segments(points, gapMs)) {
    if (s[0].t - last > gapMs) { close('high'); close('low'); out.push({ kind: 'gap', from: last, to: s[0].t, peak: null }) }
    for (const p of s) {
      const over = { high: limits.max !== null && p.max > limits.max, low: limits.min !== null && p.min < limits.min }
      for (const kind of ['high', 'low'] as const) {
        if (!over[kind]) { close(kind); continue }
        const peak = kind === 'high' ? p.max : p.min
        const event = open[kind]
        if (!event) open[kind] = { kind, from: p.t, to: p.t + bucket, peak }
        else { event.to = p.t + bucket; event.peak = kind === 'high' ? Math.max(event.peak ?? peak, peak) : Math.min(event.peak ?? peak, peak) }
      }
    }
    last = s[s.length - 1].t + bucket
  }
  close('high'); close('low')
  if (bounds.to - last > gapMs) out.push({ kind: 'gap', from: last, to: bounds.to, peak: null })
  out.sort((a, b) => a.from - b.from)
  const merged: HistoryEvent[] = []
  for (const event of out) {
    const before = event.kind === 'gap' ? undefined : [...merged].reverse().find((e) => e.kind === event.kind)
    // Một khoảng mất số liệu nằm giữa thì hai lần vượt không còn là một.
    const split = before && merged.some((e) => e.kind === 'gap' && e.from >= before.to && e.to <= event.from)
    if (before && !split && event.from - before.to <= mergeMs) {
      before.to = event.to
      before.peak = event.kind === 'high' ? Math.max(before.peak ?? -Infinity, event.peak ?? -Infinity) : Math.min(before.peak ?? Infinity, event.peak ?? Infinity)
    } else merged.push(event)
  }
  return merged
}

export type HistoryStats = { mean: number; min: number; max: number; first: number; last: number; count: number }

/** Trung bình (theo số lần đọc), nhỏ nhất, lớn nhất của khoảng; null khi không có điểm nào ra số. */
export function historyStats(points: HistoryPoint[]): HistoryStats | null {
  let sum = 0, n = 0, min = Infinity, max = -Infinity
  let first: number | null = null, last = 0
  for (const p of points) {
    if (p.value === null) continue
    const weight = Math.max(p.n, 1)
    sum += p.value * weight; n += weight
    min = Math.min(min, p.min ?? p.value); max = Math.max(max, p.max ?? p.value)
    first ??= p.value; last = p.value
  }
  return first === null ? null : { mean: sum / n, min, max, first, last, count: n }
}

/** Khoảng trục tung: phủ dữ liệu, thêm lề, và phủ cả ngưỡng khi ngưỡng nằm gần dữ liệu. */
export function valueDomain(stats: HistoryStats | null, limits: { min: number | null; max: number | null }): [number, number] {
  if (!stats) return [limits.min ?? 0, limits.max ?? 1]
  let lo = stats.min, hi = stats.max
  const reach = Math.max(hi - lo, Math.abs(hi) * 0.1, 0.5)
  for (const limit of [limits.min, limits.max]) {
    if (limit !== null && limit > lo - reach && limit < hi + reach) { lo = Math.min(lo, limit); hi = Math.max(hi, limit) }
  }
  const pad = (hi - lo || Math.max(Math.abs(hi) * 0.05, 0.5)) * 0.1
  return [lo - pad, hi + pad]
}

const STEPS = [60_000, 5 * 60_000, 10 * 60_000, 15 * 60_000, 30 * 60_000, 3_600_000, 2 * 3_600_000, 3 * 3_600_000, 6 * 3_600_000, 12 * 3_600_000,
  86_400_000, 2 * 86_400_000, 7 * 86_400_000, 14 * 86_400_000, 30 * 86_400_000]

/** Các vạch trên trục thời gian: bước tròn, tính theo giờ địa phương, không quá `count` vạch. */
export function timeTicks(from: number, to: number, count: number, offsetMin = new Date(from).getTimezoneOffset()): number[] {
  const step = STEPS.find((s) => (to - from) / s <= count) ?? STEPS[STEPS.length - 1]
  const shift = offsetMin * 60_000
  const out: number[] = []
  for (let t = Math.ceil((from - shift) / step) * step + shift; t <= to; t += step) out.push(t)
  return out
}

/** Nhãn một vạch trục tung: số chữ số thập phân vừa đủ để các vạch của khoảng [lo, hi] khác nhau. */
export function axisLabel(value: number, lo: number, hi: number): string {
  const step = (hi - lo) / 2
  const decimals = step >= 5 ? 0 : step >= 0.5 ? 1 : step >= 0.05 ? 2 : 3
  return value.toFixed(decimals).replace('.', ',')
}

const two = (n: number) => String(n).padStart(2, '0')

/** Nhãn một thời điểm, vừa đủ chi tiết cho độ dài của khoảng đang xem. */
export function timeLabel(t: number, spanMs: number, seconds = false): string {
  const d = new Date(t)
  const clock = `${two(d.getHours())}:${two(d.getMinutes())}${seconds ? `:${two(d.getSeconds())}` : ''}`
  const day = `${two(d.getDate())}/${two(d.getMonth() + 1)}`
  if (spanMs <= 24 * 3_600_000 && !seconds) return clock
  if (spanMs > 7 * 24 * 3_600_000 && !seconds) return day
  return `${day} ${clock}`
}

/** "3 phút 20 giây", "2 giờ 5 phút", "4 ngày 3 giờ". */
export function durationLabel(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s} giây`
  if (s < 3600) return s % 60 ? `${Math.floor(s / 60)} phút ${s % 60} giây` : `${s / 60} phút`
  if (s < 86400) return `${Math.floor(s / 3600)} giờ${Math.floor((s % 3600) / 60) ? ` ${Math.floor((s % 3600) / 60)} phút` : ''}`
  return `${Math.floor(s / 86400)} ngày${Math.floor((s % 86400) / 3600) ? ` ${Math.floor((s % 86400) / 3600)} giờ` : ''}`
}

/** Điểm gần thời điểm `t` nhất trong các đoạn, không xa quá `within` ms. */
export function nearestSample(parts: Sample[][], t: number, within: number): Sample | null {
  let best: Sample | null = null
  for (const part of parts) for (const p of part) if (!best || Math.abs(p.t - t) < Math.abs(best.t - t)) best = p
  return best && Math.abs(best.t - t) <= within ? best : null
}

/** Giá trị cho ô datetime-local (giờ địa phương) và ngược lại. */
export function toLocalInput(t: number): string {
  const d = new Date(t)
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}T${two(d.getHours())}:${two(d.getMinutes())}`
}

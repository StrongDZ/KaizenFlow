import type { Point } from './replay'

export type SparkGeom = { band: string; line: string; thresholdY?: number; cursorX?: number }

export function sparkGeom(
  points: Point[], w: number, h: number, opts: { redH?: number; cursor?: number; cap?: number } = {},
): SparkGeom {
  if (points.length < 2) return { band: '', line: '' }
  const cap = opts.cap ?? Number.POSITIVE_INFINITY
  const pts = points.map((p) => ({ t: p.t, lo: Math.min(p.p10, cap), mid: Math.min(p.p50, cap), hi: Math.min(p.p90, cap) }))
  const t0 = pts[0].t
  const t1 = pts[pts.length - 1].t
  const yMax = Math.max(1e-9, opts.redH ?? 0, ...pts.map((p) => p.hi))
  const pad = 2
  const x = (t: number) => ((t - t0) / (t1 - t0 || 1)) * w
  const y = (v: number) => pad + (1 - v / yMax) * (h - 2 * pad)
  const f = (n: number) => n.toFixed(1)
  const upper = pts.map((p) => `${f(x(p.t))},${f(y(p.hi))}`)
  const lower = [...pts].reverse().map((p) => `${f(x(p.t))},${f(y(p.lo))}`)
  const cursor = opts.cursor
  return {
    band: [...upper, ...lower].join(' '),
    line: pts.map((p) => `${f(x(p.t))},${f(y(p.mid))}`).join(' '),
    thresholdY: opts.redH !== undefined ? y(opts.redH) : undefined,
    cursorX: cursor !== undefined && cursor >= t0 && cursor <= t1 ? x(cursor) : undefined,
  }
}

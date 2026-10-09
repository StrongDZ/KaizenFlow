import { useEffect, useMemo, useRef, useState } from 'react'
import type { GaugeHistory } from '../../api/gauge'
import { fmtValue } from '../../lib/gaugeView'
import { axisLabel, type HistoryEvent, nearestSample, type Sample, segments, timeLabel, timeTicks, valueDomain, type HistoryStats } from '../../lib/gaugeHistory'

const HEIGHT = 168
const PAD = { left: 52, right: 10, top: 10, bottom: 22 }

/** Chiều rộng hiện tại của một phần tử, để biểu đồ vẽ đúng kích thước thật chứ không co giãn chữ. */
function useWidth() {
  const ref = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(0)
  useEffect(() => {
    if (!ref.current) return
    const observer = new ResizeObserver(([entry]) => setWidth(Math.round(entry.contentRect.width)))
    observer.observe(ref.current)
    return () => observer.disconnect()
  }, [])
  return [ref, width] as const
}

/** Biểu đồ lịch sử của một đồng hồ: đường trung bình, dải thấp nhất – cao nhất của mỗi ô thời gian, ngưỡng,
    các lúc vượt ngưỡng và các khoảng không có số liệu. Rê chuột để đọc số, kéo ngang để phóng to một khoảng. */
export function HistoryChart({ history, type, bounds, limits, stats, events, gapMs, hover, onHover, onZoom }: {
  history: GaugeHistory | undefined
  type: string
  bounds: { from: number; to: number }
  limits: { min: number | null; max: number | null }
  stats: HistoryStats | null
  events: HistoryEvent[]
  gapMs: number
  /** Thời điểm đang rê chuột, dùng chung cho mọi biểu đồ của trang. */
  hover: number | null
  onHover: (t: number | null) => void
  onZoom: (from: number, to: number) => void
}) {
  const [ref, width] = useWidth()
  const [drag, setDrag] = useState<{ from: number; to: number } | null>(null)
  const parts = useMemo(() => segments(history?.points ?? [], gapMs), [history, gapMs])
  const span = bounds.to - bounds.from
  const inner = { width: Math.max(width - PAD.left - PAD.right, 1), height: HEIGHT - PAD.top - PAD.bottom }
  const [lo, hi] = valueDomain(stats, limits)
  const x = (t: number) => PAD.left + ((t - bounds.from) / span) * inner.width
  const y = (v: number) => PAD.top + (1 - (v - lo) / (hi - lo)) * inner.height
  const clampX = (t: number) => Math.min(Math.max(x(t), PAD.left), PAD.left + inner.width)
  const timeAt = (clientX: number, target: Element) => {
    const px = clientX - target.getBoundingClientRect().left
    return bounds.from + (Math.min(Math.max(px - PAD.left, 0), inner.width) / inner.width) * span
  }
  const step = type === 'rolling_counter'
  const path = (s: Sample[]) => s.map((p, i) => (i === 0 ? `M${x(p.t)},${y(p.value)}` : step ? `H${x(p.t)}V${y(p.value)}` : `L${x(p.t)},${y(p.value)}`)).join('')
  const band = (s: Sample[]) => `M${s.map((p) => `${x(p.t)},${y(p.max)}`).join('L')}L${[...s].reverse().map((p) => `${x(p.t)},${y(p.min)}`).join('L')}Z`
  const bucket = (history?.bucket_s ?? 1) * 1000
  const at = hover === null ? null : nearestSample(parts, hover, Math.max(bucket * 1.5, span / 200))
  const yTicks = [lo + (hi - lo) * 0.1, (lo + hi) / 2, hi - (hi - lo) * 0.1]

  return (
    <div ref={ref} className="relative select-none">
      {width > 0 && (
        <svg
          width={width} height={HEIGHT} role="img" aria-label="Biểu đồ lịch sử" className="block cursor-crosshair touch-none"
          onPointerMove={(e) => {
            const t = timeAt(e.clientX, e.currentTarget)
            onHover(t)
            if (drag) setDrag({ from: drag.from, to: t })
          }}
          onPointerLeave={() => { onHover(null); setDrag(null) }}
          onPointerDown={(e) => { const t = timeAt(e.clientX, e.currentTarget); setDrag({ from: t, to: t }) }}
          onPointerUp={() => {
            // Kéo ngắn hơn 8 px là một cú bấm, không phải chọn khoảng.
            if (drag && Math.abs(x(drag.to) - x(drag.from)) > 8) onZoom(Math.min(drag.from, drag.to), Math.max(drag.from, drag.to))
            setDrag(null)
          }}
        >
          {yTicks.map((v) => (
            <g key={v}>
              <line x1={PAD.left} x2={PAD.left + inner.width} y1={y(v)} y2={y(v)} stroke="var(--color-line)" />
              <text x={PAD.left - 8} y={y(v) + 4} textAnchor="end" className="fill-faint tabular-nums text-[11px]">{axisLabel(v, lo, hi)}</text>
            </g>
          ))}
          {timeTicks(bounds.from, bounds.to, Math.max(2, Math.floor(inner.width / 110))).map((t) => (
            <text key={t} x={x(t)} y={HEIGHT - 5} textAnchor="middle" className="fill-faint tabular-nums text-[11px]">{timeLabel(t, span)}</text>
          ))}
          {events.map((e) => (
            <rect key={`${e.kind}${e.from}`} x={clampX(e.from)} width={Math.max(clampX(e.to) - clampX(e.from), 2)} y={PAD.top} height={inner.height}
              fill={e.kind === 'gap' ? 'var(--color-line)' : 'var(--color-bad)'} opacity={e.kind === 'gap' ? 0.45 : 0.2} />
          ))}
          {[limits.max, limits.min].map((limit, i) => limit !== null && limit >= lo && limit <= hi && (
            <g key={i}>
              <line x1={PAD.left} x2={PAD.left + inner.width} y1={y(limit)} y2={y(limit)} stroke="var(--color-bad)" strokeDasharray="6 5" />
              <text x={PAD.left + 6} y={y(limit) + (i === 0 ? -5 : 13)} className="fill-bad tabular-nums text-[11px]">
                ngưỡng {i === 0 ? 'trên' : 'dưới'} {fmtValue(limit, 'seg7')}
              </text>
            </g>
          ))}
          {parts.map((s) => (
            <g key={s[0].t}>
              {s.length > 1 && <path d={band(s)} fill="var(--color-accent)" opacity={0.16} />}
              {s.length > 1
                ? <path d={path(s)} fill="none" stroke="var(--color-accent)" strokeWidth={1.75} strokeLinejoin="round" />
                : <circle cx={x(s[0].t)} cy={y(s[0].value)} r={2.5} fill="var(--color-accent)" />}
            </g>
          ))}
          {drag && <rect x={Math.min(x(drag.from), x(drag.to))} width={Math.abs(x(drag.to) - x(drag.from))} y={PAD.top} height={inner.height} fill="var(--color-text)" opacity={0.12} />}
          {hover !== null && hover >= bounds.from && hover <= bounds.to && (
            <line x1={x(hover)} x2={x(hover)} y1={PAD.top} y2={PAD.top + inner.height} stroke="var(--color-muted)" strokeDasharray="2 3" />
          )}
          {at && <circle cx={x(at.t)} cy={y(at.value)} r={4} fill="var(--color-bg)" stroke="var(--color-accent)" strokeWidth={2} />}
        </svg>
      )}
      {history && parts.length === 0 && (
        <p className="pointer-events-none absolute inset-0 flex items-center justify-center text-xs text-faint">Không có số liệu trong khoảng này.</p>
      )}
      {at && (
        <p className="pointer-events-none absolute right-2 top-1 rounded-md bg-bg px-2 py-1 tabular-nums text-xs text-text">
          {timeLabel(at.t, span, bucket < 60_000)} · <span className="font-semibold">{fmtValue(at.value, type)}</span>
          {at.max > at.min && <span className="text-muted"> ({fmtValue(at.min, type)} … {fmtValue(at.max, type)})</span>}
        </p>
      )}
    </div>
  )
}

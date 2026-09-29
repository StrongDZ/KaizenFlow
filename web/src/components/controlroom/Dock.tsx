import { ChevronLeft, ChevronRight, Pause, Play } from 'lucide-react'
import { useMemo, useRef, type PointerEvent } from 'react'
import { fmtStep, fmtTime } from '../../lib/format'
import { stepIndex, type Speed } from '../../lib/playback'
import { hourTicks, minorEvery, nearestIndex, pct, rulerOf, tFromPct, type Zone } from '../../lib/ruler'

function Ruler({ times, ti, onSeek, zones, marks }: {
  times: number[]; ti: number; onSeek: (i: number) => void; zones: Zone[]; marks: number[]
}) {
  const r = useMemo(() => rulerOf(times), [times])
  const ref = useRef<HTMLDivElement>(null)
  const seek = (clientX: number) => {
    const box = ref.current?.getBoundingClientRect()
    if (!box || box.width === 0) return
    onSeek(nearestIndex(times, tFromPct(r, ((clientX - box.left) / box.width) * 100)))
  }
  const onDown = (e: PointerEvent<HTMLDivElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId)
    seek(e.clientX)
  }
  const onMove = (e: PointerEvent<HTMLDivElement>) => {
    if (e.buttons === 1) seek(e.clientX)
  }
  const t = times[ti] ?? r.start
  const minorPct = r.end > r.start ? ((minorEvery(times.length) * r.step) / (r.end - r.start)) * 100 : 0
  return (
    <div
      ref={ref}
      role="slider"
      tabIndex={0}
      aria-label="Thời gian mô phỏng"
      aria-valuemin={0}
      aria-valuemax={Math.max(0, times.length - 1)}
      aria-valuenow={ti}
      aria-valuetext={times.length ? fmtTime(t) : ''}
      onPointerDown={onDown}
      onPointerMove={onMove}
      className="relative mt-2 h-11 flex-1 cursor-pointer touch-none select-none"
    >
      {minorPct > 0.2 && (
        <div
          className="absolute inset-x-0 top-3.5 h-1.5"
          style={{ backgroundImage: `repeating-linear-gradient(90deg, var(--color-faint) 0 1px, transparent 1px ${minorPct}%)` }}
        />
      )}
      {hourTicks(r).map((h) => (
        <div key={h.t} className="absolute top-3.5 h-3" style={{ left: `${h.pct}%` }}>
          <div className="h-3 w-px bg-muted" />
          <div className="absolute top-3.5 -translate-x-1/2 text-[9.5px] tabular-nums text-muted">{fmtTime(h.t)}</div>
        </div>
      ))}
      {zones.map((z) => (
        <div
          key={z.from}
          className="absolute top-2.5 h-[3px] rounded-sm bg-bad"
          style={{ left: `${pct(r, z.from)}%`, width: `${Math.max(0.3, pct(r, z.to) - pct(r, z.from))}%` }}
        />
      ))}
      {marks.map((m) => (
        <i key={m} title="Máy hỏng" className="absolute top-0.5 -ml-[3px] h-[7px] w-[7px] rotate-45 bg-warn" style={{ left: `${pct(r, m)}%` }} />
      ))}
      {times.length > 0 && (
        <div className="absolute top-3 h-4 border-l-2 border-text" style={{ left: `${pct(r, t)}%` }}>
          <span className="absolute -left-5 -top-4 rounded-md bg-text px-1.5 py-px text-[10.5px] font-semibold tabular-nums text-bg">{fmtTime(t)}</span>
        </div>
      )}
    </div>
  )
}

export function Dock({ times, ti, onSeek, playing, onToggle, speed, onSpeed, zones, marks, insetRight }: {
  times: number[]; ti: number; onSeek: (i: number) => void; playing: boolean; onToggle: () => void
  speed: Speed; onSpeed: () => void; zones: Zone[]; marks: number[]; insetRight: number
}) {
  const step = rulerOf(times).step
  const btn = 'flex h-[18px] w-[22px] items-center justify-center rounded-[5px] border border-line-2 text-muted hover:text-text'
  return (
    <div className="absolute bottom-3 left-3.5 z-10 flex h-[62px] items-center gap-2.5 rounded-xl border border-line bg-panel px-3.5" style={{ right: insetRight }}>
      <button
        aria-label={playing ? 'Dừng' : 'Phát'}
        onClick={onToggle}
        className="flex h-[26px] w-[26px] flex-none items-center justify-center rounded-full bg-text text-bg"
      >
        {playing ? <Pause size={12} fill="currentColor" /> : <Play size={12} fill="currentColor" className="ml-0.5" />}
      </button>
      <div className="flex flex-none flex-col gap-0.5">
        <button className={btn} aria-label="Lùi một bước" onClick={() => onSeek(stepIndex(ti, times.length, 'ArrowLeft', false))}><ChevronLeft size={12} /></button>
        <button className={btn} aria-label="Tiến một bước" onClick={() => onSeek(stepIndex(ti, times.length, 'ArrowRight', false))}><ChevronRight size={12} /></button>
      </div>
      <Ruler times={times} ti={ti} onSeek={onSeek} zones={zones} marks={marks} />
      <button onClick={onSpeed} aria-label="Đổi tốc độ phát" className="flex-none rounded-md border border-line-2 px-2 py-0.5 text-[11px] font-semibold tabular-nums text-text-2 hover:text-text">
        ×{speed}
      </button>
      <span className="w-24 flex-none text-[11px] leading-tight text-muted">{fmtStep(step)}</span>
    </div>
  )
}

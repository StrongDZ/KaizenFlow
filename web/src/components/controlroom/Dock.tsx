import { ChevronLeft, ChevronRight, Pause, Play } from 'lucide-react'
import { useMemo, useRef, type PointerEvent } from 'react'
import { fmtStep, fmtTime } from '../../lib/format'
import { stepIndex, type Speed } from '../../lib/playback'
import { hourTicks, minorEvery, nearestIndex, pct, rulerOf, tFromPct, type MaintenanceWindow, type Zone } from '../../lib/ruler'
import type { StoryBookmark } from '../../lib/scenarioExperience'

function Ruler({ times, ti, onSeek, zones, marks, maintenance, bookmarks }: {
  times: number[]; ti: number; onSeek: (i: number) => void; zones: Zone[]; marks: number[]; maintenance: MaintenanceWindow[]; bookmarks: StoryBookmark[]
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
  const minorPct = r.end > r.start ? (minorEvery(times.length) * r.step / (r.end - r.start)) * 100 : 0
  // Bốn làn từ trên xuống, không chồng lên nhau: bảo trì, mốc đánh số, vạch thời gian (kèm vùng Đỏ và lần hỏng), nhãn giờ.
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
      className="relative h-[62px] flex-1 cursor-pointer touch-none select-none"
    >
      {maintenance.map((w, index) => {
        const left = pct(r, w.from)
        const right = pct(r, w.to)
        const start = fmtTime(w.from)
        const end = fmtTime(w.to)
        return (
          <div key={`${w.target}-${w.from}-${index}`}>
            <div
              title={`Bảo trì ${w.target}: bắt đầu ${start}, kết thúc ${end}`}
              className="absolute top-0 h-3 min-w-px rounded-sm bg-warn/30"
              style={{ left: `${left}%`, width: `${Math.max(0.3, right - left)}%` }}
            >
              <span className="absolute left-full top-0 ml-1 whitespace-nowrap text-[9.5px] leading-3 text-warn">
                Bảo trì {w.target}, {start}–{end}
              </span>
            </div>
          </div>
        )
      })}
      {minorPct > 0.2 && (
        <div
          className="absolute inset-x-0 top-[38px] h-1.5"
          style={{ backgroundImage: `repeating-linear-gradient(90deg, var(--color-faint) 0 1px, transparent 1px ${minorPct}%)` }}
        />
      )}
      {hourTicks(r).map((h) => (
        <div key={h.t} className="absolute top-[38px] h-2.5" style={{ left: `${h.pct}%` }}>
          <div className="h-2.5 w-px bg-muted" />
          <div className="absolute top-3 -translate-x-1/2 text-[10px] tabular-nums text-muted">{fmtTime(h.t)}</div>
        </div>
      ))}
      {zones.map((z) => (
        <div
          key={z.from}
          className="absolute top-[34px] h-[3px] rounded-sm bg-bad"
          style={{ left: `${pct(r, z.from)}%`, width: `${Math.max(0.3, pct(r, z.to) - pct(r, z.from))}%` }}
        />
      ))}
      {marks.map((m) => (
        <i key={m} title="Máy hỏng" className="absolute top-[32px] -ml-[3.5px] h-[7px] w-[7px] rotate-45 border border-bg bg-bad" style={{ left: `${pct(r, m)}%` }} />
      ))}
      {bookmarks.map((bookmark, index) => (
        <button
          key={bookmark.id}
          type="button"
          title={`${bookmark.label}: ${bookmark.detail}`}
          aria-label={`Tới mốc ${bookmark.label}`}
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => { event.stopPropagation(); onSeek(nearestIndex(times, bookmark.t)) }}
          className={`absolute top-[14px] z-10 -ml-2 flex h-4 min-w-4 items-center justify-center rounded-full border border-bg px-1 text-[9px] font-semibold text-white ${
            bookmark.tone === 'bad' ? 'bg-bad' : bookmark.tone === 'warn' ? 'bg-warn' : bookmark.tone === 'ok' ? 'bg-ok-solid' : 'bg-accent'
          }`}
          style={{ left: `${pct(r, bookmark.t)}%` }}
        >{index + 1}</button>
      ))}
      {times.length > 0 && (
        <div className="pointer-events-none absolute top-[12px] h-[36px] -ml-px border-l-2 border-text" style={{ left: `${pct(r, t)}%` }}>
          <i className="absolute -left-[5px] top-[20px] h-2 w-2 rounded-full bg-text" />
        </div>
      )}
    </div>
  )
}

export function Dock({ times, ti, onSeek, playing, onToggle, speed, onSpeed, zones, marks, maintenance, bookmarks = [], insetRight }: {
  times: number[]; ti: number; onSeek: (i: number) => void; playing: boolean; onToggle: () => void
  speed: Speed; onSpeed: () => void; zones: Zone[]; marks: number[]; maintenance: MaintenanceWindow[]; bookmarks?: StoryBookmark[]; insetRight: number
}) {
  const step = rulerOf(times).step
  const t = times[ti]
  const short = (ms: number) => fmtStep(ms).replace(' mô phỏng mỗi bước', '')
  const btn = 'flex h-[18px] w-[22px] items-center justify-center rounded-[5px] border border-line-2 text-muted hover:text-text'
  return (
    <div className="absolute bottom-3 left-3.5 z-10 flex h-[80px] items-center gap-2.5 rounded-xl border border-line bg-panel px-3.5" style={{ right: insetRight }}>
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
      <Ruler times={times} ti={ti} onSeek={onSeek} zones={zones} marks={marks} maintenance={maintenance} bookmarks={bookmarks} />
      <button onClick={onSpeed} aria-label="Đổi tốc độ phát" title={`Tốc độ phát ×${speed}. Bấm để đổi giữa ×1, ×4 và ×16.`} className="flex-none rounded-md border border-line-2 px-2 py-0.5 text-[11px] font-semibold tabular-nums text-text-2 hover:text-text">
        ×{speed}
      </button>
      <span className="w-[104px] flex-none leading-tight" title={`Mỗi lần tiến/lùi là ${short(step)} mô phỏng; mỗi vạch nhỏ trên thước là ${short(minorEvery(times.length) * step)}.`}>
        <b className="block text-[15px] font-semibold tabular-nums text-text">{t === undefined ? '—' : fmtTime(t)}</b>
        <span className="text-[10px] text-muted">mỗi bước {short(step)}</span>
      </span>
    </div>
  )
}

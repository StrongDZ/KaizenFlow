export type ScenarioTimelineEvent = {
  atS: number
  label: string
  detail?: string
}

const timeLabel = (seconds: number) => {
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes}p`
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  return rest ? `${hours}g${rest}` : `${hours}g`
}

/** Timeline cấu hình scenario: giúp nhìn ngay lỗi xảy ra ở đâu trong horizon, trước khi chạy mô phỏng. */
export function ScenarioTimeline({ horizonS, events, startLabel }: {
  horizonS: number
  events: ScenarioTimelineEvent[]
  startLabel?: string
}) {
  const safeHorizon = Number.isFinite(horizonS) && horizonS > 0 ? horizonS : 1
  const sorted = [...events]
    .map((event) => ({ ...event, atS: Number.isFinite(event.atS) ? event.atS : 0 }))
    .sort((a, b) => a.atS - b.atS)
  const ticks = [0, 0.25, 0.5, 0.75, 1]
  return (
    <div className="space-y-3" aria-label="Timeline scenario">
      <div className="relative h-20 px-2 pt-7">
        <div className="absolute left-2 right-2 top-10 h-px bg-line-2" />
        {ticks.map((ratio) => (
          <div
            key={ratio}
            className={`absolute top-8 text-center ${ratio === 0 ? '' : ratio === 1 ? '-translate-x-full' : '-translate-x-1/2'}`}
            style={{ left: `${ratio * 100}%` }}
          >
            <i className="mx-auto block h-5 w-px bg-line-2" />
            <span className="mt-1 block whitespace-nowrap text-[10px] tabular-nums text-faint">{timeLabel(safeHorizon * ratio)}</span>
          </div>
        ))}
        {sorted.map((event, index) => {
          const pct = Math.min(100, Math.max(0, event.atS / safeHorizon * 100))
          const edge = pct === 0 ? '' : pct === 100 ? '-translate-x-full' : '-translate-x-1/2'
          return (
            <div
              key={`${event.label}-${event.atS}-${index}`}
              className={`absolute top-5 z-10 ${edge}`}
              style={{ left: `${pct}%` }}
              title={`${event.label}: ${event.detail ?? 'Sự kiện'} ở ${timeLabel(event.atS)}`}
            >
              <span className="block h-4 w-4 rounded-full border-2 border-panel bg-warn shadow-sm" />
            </div>
          )
        })}
      </div>
      <div className="flex flex-wrap gap-2 text-[11px]">
        {startLabel && <span className="rounded-md border border-line-2 px-2 py-1 text-muted">Bắt đầu: <b className="font-medium text-text-2">{startLabel}</b></span>}
        {sorted.length === 0 ? (
          <span className="text-muted">Không có lỗi được tiêm; scenario chạy xuyên suốt theo cấu hình nền.</span>
        ) : sorted.map((event, index) => (
          <span key={`${event.label}-legend-${index}`} className="rounded-md border border-warn/30 bg-panel-2 px-2 py-1 text-text-2">
            <b className="font-semibold">{timeLabel(event.atS)}</b> · {event.label}{event.detail ? ` — ${event.detail}` : ''}
          </span>
        ))}
      </div>
    </div>
  )
}

export type ScenarioTimelineEvent = {
  atS: number
  label: string
  detail?: string
  kind?: string
  durationS?: number
}

const timeLabel = (seconds: number) => {
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes}p`
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  return rest ? `${hours}g${rest}` : `${hours}g`
}

/**
 * Timeline cấu hình scenario. Mỗi event có lane riêng nên các sự kiện gần nhau không che nhau;
 * planned stop dùng thanh thời lượng, failure dùng marker tại thời điểm xảy ra.
 */
export function ScenarioTimeline({ horizonS, events, startLabel }: {
  horizonS: number
  events: ScenarioTimelineEvent[]
  startLabel?: string
}) {
  const safeHorizon = Number.isFinite(horizonS) && horizonS > 0 ? horizonS : 1
  const sorted = [...events]
    .map((event) => ({
      ...event,
      atS: Number.isFinite(event.atS) ? event.atS : 0,
      durationS: typeof event.durationS === 'number' && Number.isFinite(event.durationS) && event.durationS > 0 ? event.durationS : undefined,
    }))
    .sort((a, b) => a.atS - b.atS)
  const ticks = [0, 0.25, 0.5, 0.75, 1]
  return (
    <div className="space-y-3" aria-label="Timeline scenario">
      <div className="space-y-1.5">
        {sorted.length === 0 ? (
          <div className="grid grid-cols-[minmax(100px,160px)_1fr] items-center gap-3 text-[11px]">
            <span className="text-muted">Không có sự kiện</span>
            <div className="h-px bg-line-2" />
          </div>
        ) : sorted.map((event, index) => {
          const startPct = Math.min(100, Math.max(0, event.atS / safeHorizon * 100))
          const endPct = event.durationS === undefined
            ? startPct
            : Math.min(100, Math.max(startPct, (event.atS + event.durationS) / safeHorizon * 100))
          const durationWidth = Math.min(100 - startPct, Math.max(1.5, endPct - startPct))
          const title = `${event.label}: ${event.detail ?? 'Sự kiện'} ở ${timeLabel(event.atS)}`
          return (
            <div key={`${event.label}-${event.atS}-${index}`} className="grid grid-cols-[minmax(100px,160px)_1fr] items-center gap-3 text-[11px]">
              <div className="min-w-0" title={`${event.label} — ${event.detail ?? 'Sự kiện'}`}>
                <div className="truncate font-medium text-text-2">{event.label}</div>
                <div className="truncate text-faint">{event.detail ?? 'Sự kiện'}</div>
              </div>
              <div className="relative h-7" title={title}>
                <div className="absolute inset-x-0 top-1/2 h-px bg-line-2" />
                {event.kind === 'planned_stop' && event.durationS !== undefined ? (
                  <div
                    className="absolute top-1/2 h-3 -translate-y-1/2 rounded-sm border border-warn/70 bg-warn/35"
                    style={{ left: `${startPct}%`, width: `${durationWidth}%` }}
                    aria-label={title}
                  />
                ) : (
                  <span
                    className={`absolute top-1/2 block h-4 w-4 -translate-y-1/2 rounded-full border-2 border-panel bg-warn shadow-sm ${startPct === 100 ? '-translate-x-full' : '-translate-x-1/2'}`}
                    style={{ left: `${startPct}%` }}
                    aria-label={title}
                  />
                )}
              </div>
            </div>
          )
        })}
        <div className="grid grid-cols-[minmax(100px,160px)_1fr] gap-3">
          <span />
          <div className="relative h-7 border-t border-line-2">
            {ticks.map((ratio) => (
              <span
                key={ratio}
                className={`absolute top-0 pt-1 text-[10px] tabular-nums text-faint ${ratio === 0 ? '' : ratio === 1 ? '-translate-x-full' : '-translate-x-1/2'}`}
                style={{ left: `${ratio * 100}%` }}
              >
                <i className="absolute left-1/2 top-0 h-1 w-px bg-line-2" />
                {timeLabel(safeHorizon * ratio)}
              </span>
            ))}
          </div>
        </div>
      </div>
      <div className="flex flex-wrap gap-2 text-[11px]">
        {startLabel && <span className="rounded-md border border-line-2 px-2 py-1 text-muted">Bắt đầu: <b className="font-medium text-text-2">{startLabel}</b></span>}
        {sorted.length === 0 ? (
          <span className="text-muted">Scenario chạy xuyên suốt theo cấu hình nền.</span>
        ) : sorted.map((event, index) => (
          <span key={`${event.label}-legend-${index}`} className="rounded-md border border-warn/30 bg-panel-2 px-2 py-1 text-text-2">
            <b className="font-semibold">{timeLabel(event.atS)}</b> · {event.label}{event.detail ? ` — ${event.detail}` : ''}
          </span>
        ))}
      </div>
    </div>
  )
}

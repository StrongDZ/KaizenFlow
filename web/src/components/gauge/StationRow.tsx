import { ChevronRight } from 'lucide-react'
import { Link } from 'react-router-dom'
import type { GaugeReading, GaugeStation } from '../../api/gauge'
import { ageLabel, attentionHint, fmtValue, kindLabel, latestReading, lineKey, stationKind, unitLabel } from '../../lib/gaugeView'
import { toneOf } from './tone'

/** Đồng hồ cần xem đứng trước, rồi theo thứ tự khai báo. */
const RANK: Record<string, number> = { alarm: 0, poor: 1, stale: 2, ok: 3 }
const MAX_CHIPS = 4

/** Một số đọc gọn, không khung: mã đồng hồ, giá trị, đơn vị. Chỉ đồng hồ có vấn đề mới có màu và chấm trạng thái. */
function Reading({ g }: { g: GaugeReading }) {
  const tone = toneOf(g.state)
  const alarm = g.state === 'alarm'
  return (
    <span className={`inline-flex items-baseline gap-1 whitespace-nowrap text-[11px] ${alarm ? tone.text : ''}`}>
      {g.state !== 'ok' && <i className={`h-1.5 w-1.5 flex-none self-center rounded-full ${tone.dot}`} aria-hidden />}
      <span className={alarm ? '' : 'text-muted'}>{g.gauge_id}</span>
      <b className={`font-semibold tabular-nums ${alarm ? '' : 'text-text'}`}>{g.state === 'stale' ? '—' : fmtValue(g.value, g.type)}</b>
      <span className={alarm ? 'opacity-80' : 'text-faint'}>{unitLabel(g.unit)}</span>
    </span>
  )
}

const fresh = (iso: string | null, now: number) => iso !== null && now - Date.parse(iso) < 60_000

export const STATION_GRID = 'grid grid-cols-[124px_minmax(120px,170px)_minmax(0,1fr)_92px_14px] items-center gap-x-4'

/** Một trạm trên màn tổng quan: trạng thái, số đọc của từng đồng hồ, việc nên kiểm tra và lần đọc gần nhất. Bấm để mở trạm. */
export function StationRow({ station, now, showLine = true }: { station: GaugeStation; now: number; showLine?: boolean }) {
  const kind = stationKind(station)
  const tone = toneOf(kind)
  const hint = attentionHint(station, now)
  const gauges = [...station.gauges].sort((a, b) => (RANK[a.state] ?? 3) - (RANK[b.state] ?? 3))
  return (
    <Link to={`/gauge-twin/${encodeURIComponent(station.machine_id)}`} className={`${STATION_GRID} border-t border-line px-3 py-2.5 first:border-t-0 hover:bg-panel`}>
      <span className={`flex items-center gap-2 text-xs ${kind === 'ok' ? 'text-text-2' : `font-medium ${tone.text}`}`}>
        <i className={`h-2 w-2 flex-none rounded-full ${tone.dot}`} aria-hidden />{kindLabel(kind)}
      </span>
      <span className="min-w-0 leading-tight">
        <span className="block truncate text-[12.5px] font-semibold text-text">{station.machine_id}</span>
        {showLine && <span className="block truncate text-[11px] text-faint">{lineKey(station)}</span>}
      </span>
      <span className="min-w-0">
        <span className="flex flex-wrap gap-x-3.5 gap-y-0.5">
          {gauges.length === 0 && <span className="text-[11px] text-muted">Chưa khai báo đồng hồ nào</span>}
          {gauges.slice(0, MAX_CHIPS).map((g) => <Reading key={g.gauge_id} g={g} />)}
          {gauges.length > MAX_CHIPS && <span className="self-center text-[11px] text-muted">+{gauges.length - MAX_CHIPS}</span>}
        </span>
        {hint && <span className={`mt-1 block truncate text-[11px] ${kind === 'alarm' ? tone.text : 'text-muted'}`}>{hint}</span>}
      </span>
      {/* Chỉ ghi lúc cập nhật khi số đã cũ: "vừa xong" ở mọi dòng là nhiễu. */}
      <span className="text-right text-[11px] tabular-nums text-muted">{fresh(latestReading(station), now) ? '' : ageLabel(latestReading(station), now)}</span>
      <ChevronRight size={14} className="text-faint" aria-hidden />
    </Link>
  )
}

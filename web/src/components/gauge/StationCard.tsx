import { Link } from 'react-router-dom'
import type { GaugeReading, GaugeStation } from '../../api/gauge'
import { fmtValue, kindLabel, splitTiles, stationKind, unitLabel } from '../../lib/gaugeView'
import { RoiPhoto } from './RoiPhoto'
import { toneOf } from './tone'

/** Một đồng hồ trên thẻ trạm: ảnh của chính nó trên camera, viền theo trạng thái, tên và giá trị ở dải dưới. */
function GaugeTile({ machine, gauge }: { machine: string; gauge: GaugeReading }) {
  const tone = toneOf(gauge.state)
  const silent = gauge.state === 'stale'
  return (
    <li className={`flex flex-col overflow-hidden rounded-lg border-2 bg-raised ${gauge.state === 'ok' ? 'border-raised' : tone.border}`}>
      <div className="relative aspect-[4/3] bg-panel-2">
        <RoiPhoto machine={machine} gauge={gauge} aspect={4 / 3} dimmed={silent} />
      </div>
      <div className="flex flex-col gap-0.5 px-2.5 py-2">
        <span className="truncate font-mono text-[11px] text-muted">{gauge.gauge_id}</span>
        <span className="flex items-baseline gap-1.5">
          <span className={`font-mono text-xl font-bold leading-none ${gauge.state === 'ok' ? 'text-text' : tone.text}`}>
            {silent ? '—' : fmtValue(gauge.value, gauge.type)}
          </span>
          <span className="text-xs text-muted">{unitLabel(gauge.unit)}</span>
        </span>
      </div>
    </li>
  )
}

/** Một đồng hồ dạng dòng gọn, cho máy có nhiều đồng hồ hơn số ô ảnh. */
function GaugeRow({ gauge }: { gauge: GaugeReading }) {
  const tone = toneOf(gauge.state)
  const silent = gauge.state === 'stale'
  return (
    <li className="flex items-center gap-2 px-2.5 py-1.5">
      <span className={`h-2 w-2 flex-none rounded-full ${tone.dot}`} aria-hidden />
      <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-muted">{gauge.gauge_id}</span>
      <span className={`font-mono text-sm font-bold ${gauge.state === 'ok' ? 'text-text' : tone.text}`}>{silent ? '—' : fmtValue(gauge.value, gauge.type)}</span>
      <span className="w-14 truncate text-[11px] text-muted">{unitLabel(gauge.unit)}</span>
    </li>
  )
}

/** Thẻ một trạm trên màn tổng quan: trạng thái và từng đồng hồ kèm ảnh của nó trên camera. Bấm để vào chi tiết. */
export function StationCard({ station }: { station: GaugeStation }) {
  const kind = stationKind(station)
  const tone = toneOf(kind)
  const [tiles, rest] = splitTiles(station.gauges)
  return (
    <Link
      to={`/gauge-twin/${encodeURIComponent(station.machine_id)}`}
      className={`flex flex-col gap-3 rounded-xl border-2 bg-panel p-3.5 hover:bg-panel-2 ${kind === 'ok' ? 'border-panel hover:border-line-2' : tone.border}`}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="font-mono text-base font-bold">{station.machine_id}</span>
        <span className={`rounded-full px-2.5 py-1 text-xs font-bold ${kind === 'ok' ? 'bg-raised text-text-2' : tone.bg}`}>{kindLabel(kind)}</span>
      </div>
      {station.gauges.length === 0 && <p className="py-6 text-center text-sm text-muted">Config chưa khai báo đồng hồ nào.</p>}
      {tiles.length > 0 && <ul className="grid grid-cols-2 gap-2">{tiles.map((g) => <GaugeTile key={g.gauge_id} machine={station.machine_id} gauge={g} />)}</ul>}
      {rest.length > 0 && (
        <ul className="flex flex-col divide-y divide-line rounded-lg bg-raised" aria-label={`${rest.length} đồng hồ khác`}>
          {rest.map((g) => <GaugeRow key={g.gauge_id} gauge={g} />)}
        </ul>
      )}
      <span className="text-xs text-muted">{station.edge?.edge_id ?? 'chưa có edge'}</span>
    </Link>
  )
}

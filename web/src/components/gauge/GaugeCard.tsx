import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { gaugeApi, type GaugeReading } from '../../api/gauge'
import { fmtValue, gaugeStateLabel, gaugeTypeLabel, sparkPoints, unitLabel } from '../../lib/gaugeView'
import { RoiPhoto } from './RoiPhoto'
import { toneOf } from './tone'

const SPARK = { width: 120, height: 32 }

/** Thẻ một đồng hồ trên màn trạm: giá trị, lý do trạng thái, xu hướng 15 phút, ngưỡng và độ tin cậy của lần đọc. */
export function GaugeCard({ machine, gauge, camera }: { machine: string; gauge: GaugeReading; camera?: string }) {
  const series = useQuery({
    queryKey: ['gauge', 'series', machine, gauge.gauge_id],
    queryFn: () => gaugeApi.series(machine, gauge.gauge_id),
    refetchInterval: 15_000,
  })
  const tone = toneOf(gauge.state)
  const points = sparkPoints(series.data?.points ?? [], SPARK.width, SPARK.height)
  const stale = gauge.state === 'stale'
  const quality = gauge.quality === null ? null : Math.round(gauge.quality * 100)
  return (
    <section className={`rounded-lg border bg-panel p-3 ${gauge.state === 'alarm' ? tone.border : 'border-line'}`}>
      <div className="flex items-center gap-2.5">
        <div className="relative h-8 w-10 flex-none overflow-hidden rounded bg-panel-2"><RoiPhoto machine={machine} gauge={gauge} aspect={10 / 8} /></div>
        <div className="min-w-0 flex-1 leading-tight">
          <h3 className="truncate text-[12.5px] font-semibold text-text">{gauge.gauge_id}</h3>
          <p className="truncate text-[11px] text-muted">{[gaugeTypeLabel(gauge.type), camera].filter(Boolean).join(', ')}</p>
        </div>
        <span className={`flex-none whitespace-nowrap rounded-[5px] border px-1.5 py-px text-[10.5px] ${tone.tag}`}>{gaugeStateLabel(gauge.state, gauge.flags)}</span>
      </div>
      <div className="mt-2 flex items-end gap-3">
        <span className="flex min-w-0 items-baseline gap-1.5">
          <span className={`text-2xl font-semibold leading-none tabular-nums ${stale ? 'text-faint' : tone.text}`}>{fmtValue(gauge.value, gauge.type)}</span>
          <span className="text-xs text-muted">{unitLabel(gauge.unit)}</span>
        </span>
        <Link to={`/gauge-twin/${encodeURIComponent(machine)}/history`} title="Xem lịch sử số liệu" className="ml-auto rounded hover:bg-raised">
          <svg viewBox={`0 0 ${SPARK.width} ${SPARK.height}`} width={SPARK.width} height={SPARK.height} preserveAspectRatio="none" className="block" role="img"
            aria-label={points ? `Xu hướng ${gauge.gauge_id} 15 phút gần nhất` : `Chưa đủ dữ liệu xu hướng của ${gauge.gauge_id}`}>
            {points && <polyline fill="none" stroke={tone.stroke} strokeWidth="1.5" strokeLinejoin="round" points={points} />}
          </svg>
        </Link>
      </div>
      <dl className="mt-2 grid grid-cols-3 gap-2 border-t border-line pt-2 text-[11px]">
        <div><dt className="text-muted">Ngưỡng</dt><dd className="tabular-nums text-text-2">{gauge.min ?? '…'} – {gauge.max ?? '…'}</dd></div>
        <div><dt className="text-muted">15 phút qua</dt><dd className="tabular-nums text-text-2">{fmtValue(gauge.v_min, gauge.type)} – {fmtValue(gauge.v_max, gauge.type)}</dd></div>
        <div><dt className="text-muted">Tin cậy</dt><dd className={`tabular-nums ${quality !== null && quality < 70 ? 'text-warn' : 'text-text-2'}`}>{quality === null ? '—' : `${quality}%`}</dd></div>
      </dl>
    </section>
  )
}

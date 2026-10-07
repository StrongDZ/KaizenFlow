import { useQuery } from '@tanstack/react-query'
import { gaugeApi, type GaugeReading } from '../../api/gauge'
import { fmtValue, gaugeStateLabel, sparkPoints, unitLabel } from '../../lib/gaugeView'
import { devicePhoto } from './devicePhotos'
import { toneOf } from './tone'

const SPARK = { width: 140, height: 44 }

/** Thẻ một đồng hồ trên màn chi tiết: giá trị, lý do trạng thái, xu hướng 15 phút, độ tin cậy. */
export function GaugeCard({ machine, gauge, camera }: { machine: string; gauge: GaugeReading; camera?: string }) {
  const series = useQuery({
    queryKey: ['gauge', 'series', machine, gauge.gauge_id],
    queryFn: () => gaugeApi.series(machine, gauge.gauge_id),
    refetchInterval: 15_000,
  })
  const tone = toneOf(gauge.state)
  const photo = devicePhoto(gauge.type)
  const points = sparkPoints(series.data?.points ?? [], SPARK.width, SPARK.height)
  const stale = gauge.state === 'stale'
  const quality = gauge.quality === null ? null : Math.round(gauge.quality * 100)
  return (
    <section className={`flex flex-col gap-3.5 rounded-xl border bg-panel px-4 py-3.5 ${gauge.state === 'ok' ? 'border-panel' : tone.border}`}>
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-3">
          {photo && <img src={photo.src} alt={photo.kind} title={`Ảnh minh hoạ: ${photo.kind}`} className="h-11 w-14 flex-none rounded-md object-cover" />}
          <div className="min-w-0">
            <h3 className="truncate font-mono text-sm">{gauge.gauge_id}</h3>
            <p className="text-xs text-muted">{[photo?.kind, camera].filter(Boolean).join(' · ')}</p>
          </div>
        </div>
        <span className={`flex-none whitespace-nowrap rounded-full px-2.5 py-1 text-xs font-bold ${gauge.state === 'ok' ? 'bg-raised text-text-2' : tone.bg}`}>
          {gaugeStateLabel(gauge.state, gauge.flags)}
        </span>
      </div>
      <div className="flex items-end justify-between gap-3">
        <div className="flex items-baseline gap-2">
          <span className={`text-5xl font-bold leading-none tracking-tight ${stale ? 'text-faint' : ''}`}>{fmtValue(gauge.value, gauge.type)}</span>
          <span className="text-lg text-muted">{unitLabel(gauge.unit)}</span>
        </div>
        <svg viewBox={`0 0 ${SPARK.width} ${SPARK.height}`} width={SPARK.width} height={SPARK.height} role="img"
          aria-label={points ? `Xu hướng ${gauge.gauge_id} 15 phút gần nhất` : `Chưa đủ dữ liệu xu hướng của ${gauge.gauge_id}`}>
          {points && <polyline fill="none" stroke={tone.stroke} strokeWidth="2" strokeLinejoin="round" points={points} />}
        </svg>
      </div>
      <div className="flex items-center gap-2.5 text-xs text-muted">
        <span>Độ tin cậy</span>
        <div className="h-1 flex-1 rounded-full bg-line">
          {quality !== null && <div className={`h-1 rounded-full ${quality < 70 ? 'bg-warn' : 'bg-ok'}`} style={{ width: `${quality}%` }} />}
        </div>
        <span className="font-mono text-text">{quality === null ? '—' : `${quality}%`}</span>
      </div>
      <dl className="flex justify-between font-mono text-xs text-muted">
        <div className="flex gap-1.5"><dt>min</dt><dd className="text-text-2">{fmtValue(gauge.v_min, gauge.type)}</dd></div>
        <div className="flex gap-1.5"><dt>max</dt><dd className="text-text-2">{fmtValue(gauge.v_max, gauge.type)}</dd></div>
        <div className="flex gap-1.5"><dt>ngưỡng</dt><dd className="text-text-2">{gauge.min ?? '—'} … {gauge.max ?? '—'}</dd></div>
      </dl>
    </section>
  )
}

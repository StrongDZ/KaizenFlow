import { useQuery } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { gaugeApi, type GaugeReading, type GaugeStation } from '../api/gauge'
import { ApiDownBanner, GaugeArea } from '../components/gauge/GaugeArea'
import { GaugeCard } from '../components/gauge/GaugeCard'
import { DEFAULT_FRAME, RoiSchematic } from '../components/gauge/RoiSchematic'
import { toneOf } from '../components/gauge/tone'
import {
  ageLabel, cameraLabel, filterStations, fmtValue, gaugesOn, kindLabel, lineKey, roiBox, sortStations, stationKind, unitLabel,
} from '../lib/gaugeView'

/** Nhãn giá trị gắn trên vùng đọc: nằm trên khung, hoặc dưới khung khi khung sát mép trên. */
function ValueTag({ gauge, frame }: { gauge: GaugeReading; frame: { width: number; height: number } }) {
  const box = roiBox(gauge.roi, frame.width, frame.height)
  if (!box) return null
  const above = box.top > 14
  const tone = toneOf(gauge.state)
  return (
    <div
      className={`absolute flex flex-col gap-0.5 rounded-lg px-2.5 py-1.5 ${tone.bg}`}
      style={{
        left: `${Math.min(box.left, 80)}%`,
        ...(above ? { bottom: `${100 - box.top + 1.2}%` } : { top: `${box.top + box.height + 1.2}%` }),
      }}
    >
      <span className="font-mono text-[11px] opacity-80">{gauge.gauge_id}</span>
      <span className="flex items-baseline gap-1.5">
        <span className="font-mono text-2xl font-bold leading-none">{gauge.state === 'stale' ? '—' : fmtValue(gauge.value, gauge.type)}</span>
        <span className="text-sm">{unitLabel(gauge.unit)}</span>
      </span>
    </div>
  )
}

function StationStrip({ current, stations }: { current: GaugeStation; stations: GaugeStation[] }) {
  // Trạm đang xem đứng đầu để luôn thấy mình đang ở đâu; phần còn lại theo mức cần chú ý.
  const others = sortStations(filterStations(stations, lineKey(current), 'all'))
    .filter((s) => stationKind(s) !== 'idle' && s.machine_id !== current.machine_id)
  const peers = [current, ...others]
  if (peers.length < 2) return null
  return (
    <nav aria-label="Trạm cùng dây chuyền" className="flex gap-2.5 overflow-x-auto pb-1">
      {peers.map((s) => {
        const kind = stationKind(s)
        const active = s.machine_id === current.machine_id
        return (
          <Link
            key={s.machine_id}
            to={`/gauge-twin/${encodeURIComponent(s.machine_id)}`}
            aria-current={active ? 'page' : undefined}
            className={`flex min-h-16 w-48 flex-none flex-col justify-center gap-1 rounded-xl border-2 bg-panel px-3.5 hover:bg-raised ${active ? 'border-accent' : 'border-panel'}`}
          >
            <span className="flex items-center gap-2">
              <span className={`h-2.5 w-2.5 flex-none rounded-full ${toneOf(kind).dot}`} />
              <span className="truncate font-mono text-sm">{s.machine_id}</span>
            </span>
            <span className="text-xs text-muted">{kindLabel(kind)}</span>
          </Link>
        )
      })}
    </nav>
  )
}

/** Tầng trong: một trạm, khung hình camera ở giữa với giá trị gắn ngay trên vùng đọc. */
export default function GaugeStationPage() {
  const machine = useParams().machine ?? ''
  const q = useQuery({ queryKey: ['gauge', 'station', machine], queryFn: () => gaugeApi.station(machine), refetchInterval: 2000 })
  const list = useQuery({ queryKey: ['gauge', 'stations'], queryFn: gaugeApi.stations, refetchInterval: 10_000 })
  // Một máy có thể cần nhiều camera; mỗi lúc xem một camera. null: camera đầu tiên của máy.
  const [pickedCamera, setPickedCamera] = useState<string | null>(null)
  const cameras = q.data?.cameras ?? []
  const camera = pickedCamera !== null && cameras.includes(pickedCamera) ? pickedCamera : cameras[0] ?? ''
  // Từng khung một, 5 giây một lần: edge không phát video. Lỗi camera không được che mất số liệu.
  const frame = useQuery({
    queryKey: ['gauge', 'frame', machine, camera], queryFn: () => gaugeApi.frame(machine, camera), refetchInterval: 5000, retry: false,
    enabled: cameras.length > 0,
  })
  const [showRoi, setShowRoi] = useState(true)
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [])

  const back = <Link to="/gauge-twin" className="text-sm text-muted underline decoration-dotted hover:text-text">← Tổng quan dây chuyền</Link>
  if (q.isPending) return <GaugeArea>{back}<p className="text-muted">Đang tải trạm {machine}…</p></GaugeArea>
  if (!q.data) {
    return (
      <GaugeArea>
        {back}
        {q.error instanceof Error && q.error.message === 'station not found'
          ? <p className="rounded-xl bg-panel px-5 py-8 text-center text-muted">Trạm <span className="font-mono text-text">{machine}</span> chưa có config.</p>
          : <ApiDownBanner error={q.error} />}
      </GaugeArea>
    )
  }

  const station = q.data
  const kind = stationKind(station)
  const size = frame.data ? { width: frame.data.width, height: frame.data.height } : DEFAULT_FRAME
  const image = frame.data ? `data:image/jpeg;base64,${frame.data.frame_jpeg}` : undefined
  const onCamera = gaugesOn(station.gauges, camera)
  const latest = station.gauges.map((g) => g.ts).filter((t): t is string => t !== null).sort().at(-1) ?? null

  return (
    <GaugeArea>
      {q.isError && <ApiDownBanner error={q.error} />}

      <div className="flex flex-wrap items-end gap-x-6 gap-y-2">
        <div>
          {back}
          <h1 className="mt-1 flex flex-wrap items-center gap-3 text-3xl font-bold tracking-tight">
            <span className="font-mono">{station.machine_id}</span>
            <span className={`rounded-full px-3 py-1 text-sm font-bold ${kind === 'ok' ? 'bg-raised text-text-2' : toneOf(kind).bg}`}>{kindLabel(kind)}</span>
          </h1>
        </div>
        <dl className="ml-auto flex flex-wrap gap-x-6 gap-y-1 font-mono text-xs text-muted">
          <div className="flex gap-1.5"><dt>dây chuyền</dt><dd className="text-text-2">{lineKey(station)}</dd></div>
          <div className="flex gap-1.5"><dt>edge</dt><dd className="text-text-2">{station.edge ? `${station.edge.edge_id} · ${station.edge.status}` : 'chưa có'}</dd></div>
          <div className="flex gap-1.5"><dt>config</dt><dd className="text-text-2">v{station.config_version}</dd></div>
          <div className="flex gap-1.5"><dt>số liệu</dt><dd className="text-text-2">{ageLabel(latest, now)}</dd></div>
        </dl>
      </div>

      <div className="flex flex-wrap gap-4">
        <div className="flex min-w-0 flex-[999_1_560px] flex-col gap-3">
          {cameras.length > 1 && (
            <div role="tablist" aria-label="Camera của máy" className="flex flex-wrap gap-2">
              {cameras.map((c) => (
                <button
                  key={c}
                  role="tab"
                  aria-selected={c === camera}
                  onClick={() => setPickedCamera(c)}
                  className={`min-h-11 rounded-full border px-4 text-sm ${c === camera ? 'border-accent font-bold text-text' : 'border-line-2 text-text-2 hover:border-muted'}`}
                >
                  {cameraLabel(c)} · {gaugesOn(station.gauges, c).length} đồng hồ
                </button>
              ))}
            </div>
          )}
          <RoiSchematic gauges={showRoi ? onCamera : []} frame={size} image={image} rounded="rounded-xl">
            {!image && (
              <p className="absolute inset-x-0 top-1/2 -translate-y-1/2 px-6 text-center font-mono text-sm text-faint">
                {cameras.length === 0 ? 'Máy này chưa có đồng hồ nào gắn với camera.'
                  : frame.isPending ? 'Đang lấy khung hình từ camera…' : 'Không lấy được khung hình từ camera. Sơ đồ vùng đọc và số liệu vẫn cập nhật.'}
              </p>
            )}
            {showRoi && onCamera.map((g) => <ValueTag key={g.gauge_id} gauge={g} frame={size} />)}
            <div className="absolute bottom-3 right-3 flex gap-2">
              <button
                onClick={() => setShowRoi((v) => !v)}
                aria-pressed={!showRoi}
                className="min-h-11 rounded-lg border border-line-2 bg-bg px-3.5 text-sm text-text hover:border-muted"
              >
                {showRoi ? 'Ẩn vùng đọc' : 'Hiện vùng đọc'}
              </button>
            </div>
            {image && (
              <span className="absolute left-3 top-3 rounded-md bg-bg px-2.5 py-1.5 font-mono text-xs text-text">
                {frame.isError ? 'khung hình cũ · camera không trả lời' : 'khung hình mới mỗi 5 giây'}
              </span>
            )}
          </RoiSchematic>
          {list.data && <StationStrip current={station} stations={list.data} />}
        </div>

        <aside className="flex min-w-0 flex-[1_1_340px] flex-col gap-3">
          {station.gauges.length === 0
            ? <p className="rounded-xl bg-panel px-5 py-8 text-center text-muted">Config của trạm này chưa khai báo đồng hồ nào.</p>
            : station.gauges.map((g) => (
              <GaugeCard key={g.gauge_id} machine={station.machine_id} gauge={g} camera={cameras.length > 1 ? cameraLabel(g.camera_id) : undefined} />
            ))}
        </aside>
      </div>
    </GaugeArea>
  )
}

import { useQuery } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { gaugeApi, type GaugeReading } from '../api/gauge'
import { ApiDownBanner, GaugeArea } from '../components/gauge/GaugeArea'
import { GaugeCard } from '../components/gauge/GaugeCard'
import { DEFAULT_FRAME, RoiSchematic } from '../components/gauge/RoiSchematic'
import { toneOf } from '../components/gauge/tone'
import {
  ageLabel, cameraLabel, fmtValue, gaugesOn, kindLabel, lineKey, MAX_TILES, roiBox, stationKind, unitLabel,
} from '../lib/gaugeView'

/** Nhãn giá trị gắn trên vùng đọc: nằm trên khung, hoặc dưới khung khi khung sát mép trên. */
function ValueTag({ gauge, frame, onFrame }: {
  gauge: GaugeReading
  frame: { width: number; height: number }
  /** Số đọc trên đúng khung hình đang hiển thị (xem trực tiếp); undefined thì dùng số mới nhất của đồng hồ. */
  onFrame?: number | null
}) {
  const box = roiBox(gauge.roi, frame.width, frame.height)
  if (!box) return null
  const tone = toneOf(gauge.state)
  // Vùng đọc cao (mặt đồng hồ kim quay gần): nhãn nằm trong góc trên của chính vùng đó, để không lấn sang đồng hồ bên cạnh.
  // Vùng thấp (màn hình số, đồng hồ nhỏ): nhãn nằm ngay trên vùng, hoặc ngay dưới khi vùng sát mép trên, để không che chữ số.
  const large = box.height > 30
  const place = large ? { left: `${box.left + 1}%`, top: `${box.top + 1.5}%` }
    : box.top > 14 ? { left: `${Math.min(box.left, 80)}%`, bottom: `${100 - box.top + 1.2}%` }
    : { left: `${Math.min(box.left, 80)}%`, top: `${box.top + box.height + 1.2}%` }
  return (
    <div
      className={`absolute flex flex-col gap-0.5 rounded-lg px-2.5 py-1.5 ${tone.bg}`}
      style={place}
    >
      <span className="font-mono text-[11px] opacity-80">{gauge.gauge_id}</span>
      <span className="flex items-baseline gap-1.5">
        <span className="font-mono text-2xl font-bold leading-none">
          {onFrame !== undefined ? fmtValue(onFrame, gauge.type) : gauge.state === 'stale' ? '—' : fmtValue(gauge.value, gauge.type)}
        </span>
        <span className="text-sm">{unitLabel(gauge.unit)}</span>
      </span>
    </div>
  )
}

/** Một camera của máy: khung hình trực tiếp với vùng đọc và giá trị của các đồng hồ nằm trên camera đó. */
function CameraView({ machine, camera, gauges, title, showRoi }: {
  machine: string
  camera: string
  gauges: GaugeReading[]
  /** Tên camera, chỉ hiện khi máy có nhiều camera. */
  title?: string
  showRoi: boolean
}) {
  // Xem trực tiếp: edge gửi khung hình nó vừa đọc kèm số đọc trên chính khung hình đó, nên ảnh và số luôn khớp.
  // Edge chỉ gửi trong lúc trang này còn hỏi; ảnh không được lưu ở đâu cả.
  const live = useQuery({
    queryKey: ['gauge', 'live-frame', machine, camera], queryFn: () => gaugeApi.liveFrame(machine, camera), refetchInterval: 1000, retry: false,
  })
  // Dự phòng khi chưa có xem trực tiếp: server tự kéo từng khung từ camera, 5 giây một lần. Ảnh này có thể lệch số.
  const pulled = useQuery({
    queryKey: ['gauge', 'frame', machine, camera], queryFn: () => gaugeApi.frame(machine, camera), refetchInterval: 5000, retry: false,
    enabled: !live.data,
  })
  const frame = live.data ?? pulled.data
  const size = frame ? { width: frame.width, height: frame.height } : DEFAULT_FRAME
  const image = frame ? `data:image/jpeg;base64,${frame.frame_jpeg}` : undefined
  const onFrame = (gaugeId: string) => live.data?.readings.find((r) => r.gauge_id === gaugeId)?.value
  return (
    <section className="flex flex-col gap-2">
      {title && <h2 className="text-sm font-bold text-text-2">{title} · {gauges.length} đồng hồ</h2>}
      <RoiSchematic gauges={showRoi ? gauges : []} frame={size} image={image} rounded="rounded-xl">
        {!image && (
          <p className="absolute inset-x-0 top-1/2 -translate-y-1/2 px-6 text-center font-mono text-sm text-faint">
            {pulled.isPending ? 'Đang lấy khung hình từ camera…' : 'Không lấy được khung hình từ camera. Sơ đồ vùng đọc và số liệu vẫn cập nhật.'}
          </p>
        )}
        {showRoi && gauges.map((g) => <ValueTag key={g.gauge_id} gauge={g} frame={size} onFrame={live.data ? onFrame(g.gauge_id) ?? null : undefined} />)}
        {image && (
          <span className="absolute bottom-3 left-3 rounded-md bg-bg px-2.5 py-1.5 font-mono text-xs text-text">
            {live.data
              ? `trực tiếp · ảnh và số cùng một khung hình · ${new Date(live.data.ts).toLocaleTimeString('vi-VN')}`
              : pulled.isError ? 'khung hình cũ · camera không trả lời' : 'khung hình mỗi 5 giây · số có thể lệch ảnh'}
          </span>
        )}
      </RoiSchematic>
    </section>
  )
}

/** Tầng trong: một máy. Mọi camera của máy và mọi đồng hồ của nó hiện cùng lúc, không phải bấm chọn gì. */
export default function GaugeStationPage() {
  const machine = useParams().machine ?? ''
  const q = useQuery({ queryKey: ['gauge', 'station', machine], queryFn: () => gaugeApi.station(machine), refetchInterval: 2000 })
  const cameras = q.data?.cameras ?? []
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
  const many = station.gauges.length > MAX_TILES
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
        <Link to={`/gauge-twin/${encodeURIComponent(station.machine_id)}/history`}
          className="ml-auto flex min-h-11 items-center rounded-lg border border-line-2 bg-panel px-4 text-sm text-text hover:border-muted">
          Lịch sử số liệu
        </Link>
        <dl className="flex flex-wrap gap-x-6 gap-y-1 font-mono text-xs text-muted">
          <div className="flex gap-1.5"><dt>dây chuyền</dt><dd className="text-text-2">{lineKey(station)}</dd></div>
          <div className="flex gap-1.5"><dt>edge</dt><dd className="text-text-2">{station.edge ? `${station.edge.edge_id} · ${station.edge.status}` : 'chưa có'}</dd></div>
          <div className="flex gap-1.5"><dt>config</dt><dd className="text-text-2">v{station.config_version}</dd></div>
          <div className="flex gap-1.5"><dt>số liệu</dt><dd className="text-text-2">{ageLabel(latest, now)}</dd></div>
        </dl>
      </div>

      {/* Máy nhiều đồng hồ: ảnh camera chiếm cả bề ngang, thẻ đồng hồ xếp lưới bên dưới thay vì một cột dài bên phải. */}
      <div className={many ? 'flex flex-col gap-4' : 'flex flex-wrap gap-4'}>
        <div className={many ? 'flex min-w-0 flex-col gap-4' : 'flex min-w-0 flex-[999_1_560px] flex-col gap-4'}>
          {cameras.length === 0 && <p className="rounded-xl bg-panel px-5 py-8 text-center text-muted">Máy này chưa có đồng hồ nào gắn với camera.</p>}
          {cameras.map((c) => (
            <CameraView key={c} machine={station.machine_id} camera={c} gauges={gaugesOn(station.gauges, c)} showRoi={showRoi}
              title={cameras.length > 1 ? cameraLabel(c) : undefined} />
          ))}
          {cameras.length > 0 && (
            <button
              onClick={() => setShowRoi((v) => !v)}
              aria-pressed={!showRoi}
              className="min-h-11 self-start rounded-lg border border-line-2 bg-panel px-3.5 text-sm text-text hover:border-muted"
            >
              {showRoi ? 'Ẩn vùng đọc trên ảnh' : 'Hiện vùng đọc trên ảnh'}
            </button>
          )}
        </div>

        <aside className={many ? 'grid grid-cols-[repeat(auto-fill,minmax(320px,1fr))] gap-3' : 'flex min-w-0 flex-[1_1_340px] flex-col gap-3'}>
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

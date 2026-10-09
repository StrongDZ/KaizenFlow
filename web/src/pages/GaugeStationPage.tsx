import { useQuery } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { gaugeApi, type GaugeReading } from '../api/gauge'
import { ApiDownBanner, GaugeArea } from '../components/gauge/GaugeArea'
import { EmptyState, Loading, btn } from '../components/ui'
import { GaugeCard } from '../components/gauge/GaugeCard'
import { DEFAULT_FRAME, RoiSchematic } from '../components/gauge/RoiSchematic'
import { toneOf } from '../components/gauge/tone'
import { ageLabel, cameraLabel, fmtValue, gaugesOn, latestReading, MAX_TILES, roiBox, unitLabel } from '../lib/gaugeView'

/** Thẻ đồng hồ cần xem đứng trước. */
const STATE_RANK: Record<string, number> = { alarm: 0, poor: 1, stale: 2, ok: 3 }

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
      className={`absolute flex flex-col rounded-md px-2 py-1 shadow ${tone.solid}`}
      style={place}
    >
      <span className="text-[10.5px] opacity-80">{gauge.gauge_id}</span>
      <span className="flex items-baseline gap-1">
        <span className="text-base font-semibold leading-tight tabular-nums">
          {onFrame !== undefined ? fmtValue(onFrame, gauge.type) : gauge.state === 'stale' ? '—' : fmtValue(gauge.value, gauge.type)}
        </span>
        <span className="text-[11px]">{unitLabel(gauge.unit)}</span>
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
      {title && <h2 className="text-xs font-semibold text-text-2">{title}, {gauges.length} đồng hồ</h2>}
      <RoiSchematic gauges={showRoi ? gauges : []} frame={size} image={image} rounded="rounded-lg">
        {!image && (
          <p className="absolute inset-x-0 top-1/2 -translate-y-1/2 px-6 text-center text-xs text-faint">
            {pulled.isPending ? 'Đang lấy khung hình từ camera…' : 'Không lấy được khung hình từ camera. Sơ đồ vùng đọc và số liệu vẫn cập nhật.'}
          </p>
        )}
        {showRoi && gauges.map((g) => <ValueTag key={g.gauge_id} gauge={g} frame={size} onFrame={live.data ? onFrame(g.gauge_id) ?? null : undefined} />)}
        {image && (
          <span className="absolute bottom-2 left-2 rounded bg-bg/85 px-2 py-1 text-[11px] text-text-2">
            {live.data
              ? `Trực tiếp lúc ${new Date(live.data.ts).toLocaleTimeString('vi-VN')}: ảnh và số cùng một khung hình`
              : pulled.isError ? 'Khung hình cũ: camera không trả lời' : 'Khung hình làm mới mỗi 5 giây, số có thể lệch ảnh một chút'}
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

  if (q.isPending) return <Loading />
  if (!q.data) {
    return (
      <GaugeArea>
        {q.error instanceof Error && q.error.message === 'station not found'
          ? <EmptyState title={`Trạm ${machine} chưa có config`}>Mở một camera ở mục Camera và khoanh đồng hồ cho máy này để tạo config. <Link to="/gauge-twin/cameras" className="text-accent underline">Mở danh sách camera</Link></EmptyState>
          : <ApiDownBanner error={q.error} />}
      </GaugeArea>
    )
  }

  const station = q.data
  const many = station.gauges.length > MAX_TILES
  const latest = latestReading(station)

  return (
    <GaugeArea>
      {q.isError && <ApiDownBanner error={q.error} />}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted">
        <span>{station.gauges.length} đồng hồ trên {Math.max(1, cameras.length)} camera, số đọc mới nhất {ageLabel(latest, now)}</span>
        {cameras.length > 0 && (
          <button onClick={() => setShowRoi((v) => !v)} aria-pressed={!showRoi} className={`${btn} ml-auto`}>
            {showRoi ? 'Ẩn vùng đọc trên ảnh' : 'Hiện vùng đọc trên ảnh'}
          </button>
        )}
      </div>

      {/* Máy nhiều đồng hồ: ảnh camera chiếm cả bề ngang, thẻ đồng hồ xếp lưới bên dưới thay vì một cột dài bên phải. */}
      <div className={many ? 'flex flex-col gap-4' : 'flex flex-wrap items-start gap-4'}>
        <div className={many ? 'flex min-w-0 flex-col gap-4' : 'flex min-w-0 flex-[999_1_560px] flex-col gap-4'}>
          {cameras.length === 0 && <p className="rounded-lg border border-line px-4 py-8 text-center text-xs text-muted">Máy này chưa có đồng hồ nào gắn với camera.</p>}
          {cameras.map((c) => (
            <CameraView key={c} machine={station.machine_id} camera={c} gauges={gaugesOn(station.gauges, c)} showRoi={showRoi}
              title={cameras.length > 1 ? cameraLabel(c) : undefined} />
          ))}
        </div>

        <aside className={many ? 'grid grid-cols-[repeat(auto-fill,minmax(300px,1fr))] gap-3' : 'flex min-w-0 flex-[1_1_320px] flex-col gap-3'}>
          {station.gauges.length === 0
            ? <p className="rounded-lg border border-line px-4 py-8 text-center text-xs text-muted">Config của trạm này chưa khai báo đồng hồ nào.</p>
            : [...station.gauges].sort((a, b) => STATE_RANK[a.state] - STATE_RANK[b.state]).map((g) => (
              <GaugeCard key={g.gauge_id} machine={station.machine_id} gauge={g} camera={cameras.length > 1 ? cameraLabel(g.camera_id) : undefined} />
            ))}
        </aside>
      </div>
    </GaugeArea>
  )
}

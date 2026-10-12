import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useParams, useSearchParams } from 'react-router-dom'
import { api } from '../api/client'
import { AssetDialog } from '../components/assets/AssetDialog'
import { gaugeConfigApi, type AcceptanceVerdict, type GaugeCandidate, type PreviewGauge } from '../api/gaugeConfig'
import { ActionError, GaugeArea, gtButton, gtField, gtPrimary } from '../components/gauge/GaugeArea'
import {
  buildGauge, calibPoint, calibToFrame, draftFromGauge, dragToRoi, emptyDraft, gaugesOnCamera, machineColor, mergeGauge, removeGauge, toFrame,
  upsertGauge, type GaugeDoc, type GaugeDraft, type GaugeType, type Point,
} from '../lib/gaugeCommission'
import { draftFromCandidate, moveCorner, TYPE_LABEL, type Corner } from '../lib/gaugeDiscovery'
import { fmtValue, unitLabel } from '../lib/gaugeView'

const TYPES: { value: GaugeType; label: string }[] = [
  { value: 'analog_dial', label: 'Đồng hồ kim' },
  { value: 'seg7', label: 'Đồng hồ số LED' },
  { value: 'timer_mmss', label: 'Màn hình thời gian mm:ss' },
  { value: 'rolling_counter', label: 'Bộ đếm số lăn' },
]

/** Việc con trỏ đang làm trên ảnh: kéo để khoanh vùng, hoặc bấm để chấm một điểm của đồng hồ kim. */
type Tool = 'roi' | 'center' | 'min_pt' | 'max_pt'
const POINTS: { tool: Exclude<Tool, 'roi'>; label: string; mark: string }[] = [
  { tool: 'center', label: 'Tâm kim', mark: 'T' },
  { tool: 'min_pt', label: 'Vạch min', mark: 'm' },
  { tool: 'max_pt', label: 'Vạch max', mark: 'M' },
]

function Field({ label, children, wide = false }: { label: string; children: React.ReactNode; wide?: boolean }) {
  return <label className={`flex flex-col gap-1.5 text-xs text-text-2 ${wide ? 'col-span-2' : ''}`}>{label}{children}</label>
}

const pct = (v: number, total: number) => `${(v * 100) / total}%`

const CORNERS: Corner[] = ['nw', 'ne', 'sw', 'se']

/** Vùng đọc như model sẽ thấy: vùng được kéo giãn về hình vuông (đồng hồ kim) hoặc giữ tỉ lệ và chia ô từng chữ số (màn số). */
function RegionPreview({ frameJpeg, size, roi, type, digits }: {
  frameJpeg: string; size: { width: number; height: number }; roi: number[]; type: GaugeType; digits: number
}) {
  const [x, y, w, h] = roi
  const square = type === 'analog_dial'
  const width = 160
  const height = square ? 160 : Math.max(32, Math.min(160, (width * h) / w))
  const slots = type === 'seg7' || type === 'rolling_counter' ? digits : type === 'timer_mmss' ? 4 : 0
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-xs text-text-2">Model sẽ thấy</span>
      <div className="relative overflow-hidden rounded-md bg-black" style={{ width, height }}>
        <img src={`data:image/jpeg;base64,${frameJpeg}`} alt="Vùng đọc sau khi cắt" draggable={false} className="absolute max-w-none"
          style={{ width: `${(size.width / w) * 100}%`, height: `${(size.height / h) * 100}%`, left: `${(-x / w) * 100}%`, top: `${(-y / h) * 100}%` }} />
        {Array.from({ length: Math.max(0, slots - 1) }, (_, i) => (
          <span key={i} className="absolute inset-y-0 w-px bg-warn/80" style={{ left: `${((i + 1) * 100) / slots}%` }} />
        ))}
      </div>
      <span className="text-[11px] text-muted">
        {square ? 'Mặt đồng hồ phải nằm trọn và gần đầy ô.' : `Mỗi ô vàng phải chứa đúng một chữ số (${slots} ô).`}
      </span>
    </div>
  )
}

/** Mở một camera: thấy nó đang quay gì, khoanh từng đồng hồ và chọn đồng hồ đó thuộc máy nào. */
/** Giá trị đặc biệt của ô chọn máy: mở hộp khai thiết bị mới ngay trong luồng gán đồng hồ. */
const NEW_ASSET = '__new_asset__'

export default function GaugeCameraPage() {
  const cameraId = useParams().camera ?? ''
  const [params, setParams] = useSearchParams()
  const qc = useQueryClient()
  const cameras = useQuery({ queryKey: ['gauge-config', 'cameras'], queryFn: gaugeConfigApi.cameras })
  // Danh mục Thiết bị của KaizenFlow: mã máy ở đây là mã thiết bị, nên gán đồng hồ xong là số đọc
  // gắn đúng thiết bị mà các mô hình đang dùng. API không chạy thì vẫn gán được như trước.
  const assets = useQuery({ queryKey: ['assets'], queryFn: api.assets, retry: false })
  const stations = useQuery({ queryKey: ['gauge-config', 'stations'], queryFn: gaugeConfigApi.stations })
  // Ảnh đứng yên trong lúc khoanh vùng; người dùng bấm để lấy khung hình mới.
  const frame = useQuery({
    queryKey: ['gauge-config', 'frame', cameraId], queryFn: () => gaugeConfigApi.frame({ camera_id: cameraId }),
    staleTime: Infinity, retry: false, refetchOnWindowFocus: false,
  })

  // Đồng hồ AI phát hiện trên camera này, chưa ai khai báo.
  const candidates = useQuery({
    queryKey: ['gauge-config', 'candidates', 'pending', cameraId], queryFn: () => gaugeConfigApi.candidates('pending', cameraId), refetchInterval: 30_000,
  })
  const camera = cameras.data?.find((c) => c.camera_id === cameraId)
  const onCamera = useMemo(() => gaugesOnCamera(stations.data ?? [], cameraId), [stations.data, cameraId])
  const machineIds = useMemo(() => [...new Set(onCamera.map((e) => e.machine_id))], [onCamera])
  const colorOf = (machine: string) => machineColor(Math.max(0, machineIds.indexOf(machine)))

  const [machine, setMachine] = useState({ machine_id: '', plant: '', line: '' })
  // Khai thiết bị mới ngay trong luồng gán đồng hồ (không phải rời trang sang mục Thiết bị).
  const [makingAsset, setMakingAsset] = useState(false)
  const [draft, setDraft] = useState<GaugeDraft>(() => emptyDraft('analog_dial'))
  // Đồng hồ đã lưu đang được sửa (để giữ các trường form không quản lý); null là đồng hồ mới.
  const [editing, setEditing] = useState<{ machine_id: string; gauge: GaugeDoc } | null>(null)
  // Đề xuất của AI đang được kiểm tra; null khi khai báo tay hoặc sửa đồng hồ đã có.
  const [fromCandidate, setFromCandidate] = useState<GaugeCandidate | null>(null)
  const [resize, setResize] = useState<Corner | null>(null)
  const [tool, setTool] = useState<Tool>('roi')
  const [drag, setDrag] = useState<{ from: Point; to: Point } | null>(null)
  const [reading, setReading] = useState<PreviewGauge | null>(null)
  const [truth, setTruth] = useState('')
  const [verdict, setVerdict] = useState<{ passed: boolean; value?: number; reason?: string; summary?: AcceptanceVerdict } | null>(null)
  const [saved, setSaved] = useState('')
  const imageRef = useRef<HTMLDivElement>(null)

  const size = frame.data ? { width: frame.data.width, height: frame.data.height } : { width: 1920, height: 1080 }
  const existing = stations.data?.find((s) => s.machine_id === machine.machine_id)
  const pickedAsset = assets.data?.find((a) => a.key === machine.machine_id)
  // Máy đã có đồng hồ từ trước mà chưa khai trong danh mục: vẫn phải chọn được để sửa đồng hồ cũ.
  const legacyMachine = machine.machine_id !== '' && !pickedAsset ? machine.machine_id : ''
  const built = buildGauge(draft, cameraId)
  const gauge = built.gauge ? mergeGauge(editing?.gauge, built.gauge) : undefined
  // Máy hợp lệ: một thiết bị trong danh mục, hoặc một máy cũ đã có cấu hình đồng hồ (để sửa tiếp).
  const machineOk = /^[A-Za-z0-9_.-]{1,64}$/.test(machine.machine_id)
    && (pickedAsset !== undefined || existing !== undefined)
    && (existing !== undefined || (machine.plant !== '' && machine.line !== ''))
  const problems = [...(machineOk ? [] : ['Chọn máy trong danh mục Thiết bị (hoặc khai thiết bị mới ngay tại đây).']), ...built.problems]

  const patch = (p: Partial<GaugeDraft>) => { setDraft((d) => ({ ...d, ...p })); setReading(null); setVerdict(null); setSaved('') }
  // Mã máy của gauge-twin LÀ mã thiết bị trong danh mục Thiết bị của KaizenFlow (machine_id = asset.key),
  // nên gán đồng hồ cho máy là chọn đúng thiết bị đó: nhà máy / dây chuyền điền theo danh mục.
  const pickMachine = (id: string) => {
    const known = stations.data?.find((s) => s.machine_id === id)
    if (known) {
      setMachine({ machine_id: id, plant: known.config.plant, line: known.config.line })
      setSaved('')
      return
    }
    const asset = assets.data?.find((a) => a.key === id)
    setMachine(asset
      ? { machine_id: id, plant: asset.plant || machine.plant, line: asset.line || machine.line }
      : { ...machine, machine_id: id })
    setSaved('')
  }
  const startNew = () => {
    setEditing(null); setFromCandidate(null); setDraft(emptyDraft('analog_dial')); setTool('roi'); setReading(null); setVerdict(null); setTruth(''); setSaved('')
  }
  const edit = (entry: { machine_id: string; gauge: GaugeDoc }) => {
    setFromCandidate(null)
    setEditing(entry); setDraft(draftFromGauge(entry.gauge)); pickMachine(entry.machine_id); setTool('roi'); setReading(null); setVerdict(null); setTruth('')
  }
  /** Kiểm tra một đề xuất của AI: form điền sẵn vùng, loại và các điểm; người dùng chỉnh rồi gán vào máy. */
  const review = (c: GaugeCandidate) => {
    setEditing(null); setFromCandidate(c); setDraft(draftFromCandidate(c)); setMachine({ machine_id: '', plant: '', line: '' })
    setTool('roi'); setReading(null); setVerdict(null); setTruth(''); setSaved('')
  }
  // Nhà máy / dây chuyền luôn theo thiết bị đã chọn (kể cả thiết bị vừa khai xong trong hộp bên
  // cạnh, lúc danh sách assets mới về): thiết bị là nguồn sự thật, không gõ lệch được.
  useEffect(() => {
    if (!pickedAsset || editing !== null) return
    setMachine((m) => (m.plant === (pickedAsset.plant || m.plant) && m.line === (pickedAsset.line || m.line)
      ? m
      : { ...m, plant: pickedAsset.plant || m.plant, line: pickedAsset.line || m.line }))
  }, [pickedAsset, editing])

  // Mở thẳng từ danh mục đồng hồ: ?candidate= một đề xuất, ?machine=&gauge= một đồng hồ đã có.
  const opened = useRef(false)
  useEffect(() => {
    if (opened.current) return
    const wanted = params.get('candidate')
    if (wanted && candidates.data) {
      opened.current = true
      const c = candidates.data.candidates.find((x) => String(x.candidate_id) === wanted)
      if (c) review(c)
    } else if (params.get('gauge') && stations.data) {
      opened.current = true
      const entry = onCamera.find((e) => e.machine_id === params.get('machine') && e.gauge.gauge_id === params.get('gauge'))
      if (entry) edit(entry)
    }
  }, [candidates.data, stations.data])

  const at = (e: React.PointerEvent): Point => {
    const box = imageRef.current!.getBoundingClientRect()
    return { x: e.clientX - box.left, y: e.clientY - box.top }
  }
  const shown = () => {
    const box = imageRef.current!.getBoundingClientRect()
    return { width: box.width, height: box.height }
  }
  const onDown = (e: React.PointerEvent) => {
    if (!frame.data) return
    if (tool === 'roi') {
      e.currentTarget.setPointerCapture(e.pointerId)
      setDrag({ from: at(e), to: at(e) })
    } else if (draft.roi) {
      patch({ [tool]: calibPoint(toFrame(at(e), shown(), size), draft.roi) })
      // Chấm xong một điểm thì chuyển sang điểm kế tiếp còn thiếu.
      const next = POINTS.find((p) => p.tool !== tool && !draft[p.tool])
      if (next) setTool(next.tool)
    }
  }
  /** Kéo một góc: vùng đổi, các điểm đã chấm của đồng hồ kim giữ nguyên chỗ trên ảnh. */
  const onResize = (e: React.PointerEvent) => {
    if (!resize || !draft.roi) return
    const roi = moveCorner(draft.roi, resize, toFrame(at(e), shown(), size))
    if (roi === draft.roi) return
    const keep = (p: [number, number] | null) => (p ? calibPoint(calibToFrame(p, draft.roi!), roi) : null)
    patch({ roi, center: keep(draft.center), min_pt: keep(draft.min_pt), max_pt: keep(draft.max_pt) })
  }
  const onUp = () => {
    if (resize) { setResize(null); return }
    if (!drag) return
    const roi = dragToRoi(drag.from, drag.to, shown(), size)
    setDrag(null)
    if (!roi) return
    // Vùng mới thì các điểm đã chấm không còn đúng chỗ.
    patch({ roi, center: null, min_pt: null, max_pt: null })
    if (draft.type === 'analog_dial') setTool('center')
  }

  const preview = useMutation({
    mutationFn: () => gaugeConfigApi.preview(machine.machine_id || 'PREVIEW', gauge!, frame.data!.frame_jpeg),
    onSuccess: setReading,
  })
  const refreshLists = () => {
    void qc.invalidateQueries({ queryKey: ['gauge-config', 'stations'] })
    void qc.invalidateQueries({ queryKey: ['gauge-config', 'cameras'] })
    void qc.invalidateQueries({ queryKey: ['gauge-config', 'candidates'] })
  }
  const ignore = useMutation({
    mutationFn: (candidateId: number) => gaugeConfigApi.ignoreCandidate(candidateId),
    onSuccess: () => { startNew(); refreshLists(); setParams({}, { replace: true }) },
  })
  const save = useMutation({
    mutationFn: () => gaugeConfigApi.putStation(upsertGauge(existing?.config ?? null, machine, gauge!)),
    onSuccess: (stored) => {
      setSaved(`Đã lưu vào ${stored.machine_id}. Config mới được đẩy xuống edge.${fromCandidate ? ' Đề xuất của AI được đánh dấu đã gán.' : ''}`)
      setFromCandidate(null)
      setEditing({ machine_id: stored.machine_id, gauge: gauge! })
      refreshLists()
    },
  })
  const remove = useMutation({
    mutationFn: () => {
      const station = stations.data!.find((s) => s.machine_id === editing!.machine_id)!
      return gaugeConfigApi.putStation(removeGauge(station.config, editing!.gauge.gauge_id))
    },
    onSuccess: () => { startNew(); refreshLists() },
  })
  // Nghiệm thu luôn dùng một khung hình vừa lấy, không dùng ảnh đang đứng yên trên màn hình.
  const accept = useMutation({
    mutationFn: async () => {
      const fresh = await gaugeConfigApi.frame({ camera_id: cameraId })
      qc.setQueryData(['gauge-config', 'frame', cameraId], fresh)
      return gaugeConfigApi.accept(machine.machine_id, gauge!, Number(truth), fresh.frame_jpeg)
    },
    onSuccess: (r) => setVerdict({
      passed: r.sample.passed, value: r.sample.value, reason: r.sample.reason, summary: r.gauges.find((g) => g.gauge_id === gauge!.gauge_id),
    }),
  })

  const back = <Link to="/gauge-twin/cameras" className="text-xs text-muted underline decoration-dotted hover:text-text">← Tất cả camera</Link>
  if (cameras.data && !camera) {
    return <GaugeArea>{back}<p className="rounded-lg bg-panel px-5 py-8 text-center text-muted">Không có camera <span className="tabular-nums text-text">{cameraId}</span>.</p></GaugeArea>
  }

  const dragBox = drag && {
    left: Math.min(drag.from.x, drag.to.x), top: Math.min(drag.from.y, drag.to.y),
    width: Math.abs(drag.from.x - drag.to.x), height: Math.abs(drag.from.y - drag.to.y),
  }
  const hint = !frame.data ? ''
    : tool === 'roi' ? 'Kéo chuột trên ảnh để khoanh sát quanh đồng hồ.'
    : !draft.roi ? 'Khoanh vùng trước, rồi mới chấm điểm.'
    : `Bấm lên ảnh để chấm: ${POINTS.find((p) => p.tool === tool)!.label.toLowerCase()}.`

  return (
    <GaugeArea>
      <div className="flex flex-wrap items-end gap-x-6 gap-y-2">
        <div>
          <h1 className="text-lg font-semibold text-text">{camera?.name || cameraId}</h1>
          <p className="text-xs text-muted">{cameraId}{camera?.location && `, ${camera.location}`}</p>
        </div>
        <p className="ml-auto text-xs text-text-2">
          {onCamera.length === 0 ? 'Chưa có đồng hồ nào trên camera này' : `${onCamera.length} đồng hồ của ${machineIds.length} máy`}
        </p>
      </div>

      {/* Ảnh camera ở trên, form khai báo bên dưới trải thành cột: bố cục chia ngang. */}
      <div className="flex flex-col gap-4">
        <div className="flex min-w-0 flex-col gap-3">
          <div className="flex flex-wrap items-center gap-2.5">
            <button className={gtButton} onClick={() => void frame.refetch()} disabled={frame.isFetching}>
              {frame.isFetching ? 'Đang lấy hình…' : 'Lấy khung hình mới'}
            </button>
            <span className="text-xs text-text-2">{hint}</span>
          </div>

          <div
            ref={imageRef}
            onPointerDown={onDown}
            onPointerMove={(e) => { if (resize) onResize(e); else if (drag) setDrag({ ...drag, to: at(e) }) }}
            onPointerUp={onUp}
            className={`relative mx-auto w-full touch-none select-none overflow-hidden rounded-lg bg-raised ${frame.data ? 'cursor-crosshair' : ''}`}
            style={{ aspectRatio: `${size.width} / ${size.height}`, maxWidth: `calc(66vh * ${size.width} / ${size.height})` }}
          >
            {frame.data
              ? <img src={`data:image/jpeg;base64,${frame.data.frame_jpeg}`} alt={`Khung hình từ camera ${cameraId}`} draggable={false} className="absolute inset-0 h-full w-full" />
              : <p className="absolute inset-x-0 top-1/2 -translate-y-1/2 px-6 text-center tabular-nums text-xs text-faint">
                  {frame.isPending ? 'Đang lấy khung hình từ camera…' : 'Không lấy được khung hình. Kiểm tra địa chỉ camera và kết nối mạng từ server tới camera.'}
                </p>}

            {onCamera.map((e) => {
              const active = editing?.machine_id === e.machine_id && editing.gauge.gauge_id === e.gauge.gauge_id
              if (active || e.gauge.roi.length !== 4) return null
              const [x, y, w, h] = e.gauge.roi
              return (
                <div key={`${e.machine_id}/${e.gauge.gauge_id}`} className="pointer-events-none absolute rounded-sm border-2"
                  style={{ left: pct(x, size.width), top: pct(y, size.height), width: pct(w, size.width), height: pct(h, size.height), borderColor: colorOf(e.machine_id) }}>
                  <span className="absolute bottom-full left-0 mb-0.5 whitespace-nowrap rounded px-1.5 py-0.5 tabular-nums text-[11px] font-semibold text-on-accent" style={{ background: colorOf(e.machine_id) }}>
                    {e.machine_id} · {e.gauge.gauge_id}
                  </span>
                </div>
              )
            })}

            {(candidates.data?.candidates ?? []).filter((c) => c.candidate_id !== fromCandidate?.candidate_id).map((c) => {
              const [x, y, w, h] = c.roi
              return (
                <button key={c.candidate_id} type="button" title="AI phát hiện đồng hồ chưa khai báo: bấm để kiểm tra và gán"
                  onPointerDown={(e) => e.stopPropagation()} onClick={() => review(c)}
                  className="absolute rounded-sm border-2 border-dashed border-warn hover:bg-warn/10"
                  style={{ left: pct(x, size.width), top: pct(y, size.height), width: pct(w, size.width), height: pct(h, size.height) }}>
                  <span className="absolute bottom-full left-0 mb-0.5 whitespace-nowrap rounded bg-warn px-1.5 py-0.5 text-[11px] font-semibold text-on-warn">
                    Mới · {TYPE_LABEL[c.type] ?? c.type}
                  </span>
                </button>
              )
            })}
            {draft.roi && tool === 'roi' && CORNERS.map((corner) => {
              const [x, y, w, h] = draft.roi!
              const cx = corner.includes('w') ? x : x + w, cy = corner.startsWith('n') ? y : y + h
              return (
                <span key={corner} role="presentation" title="Kéo để chỉnh vùng"
                  onPointerDown={(e) => { e.stopPropagation(); imageRef.current?.setPointerCapture(e.pointerId); setResize(corner) }}
                  className={`absolute z-10 h-3.5 w-3.5 -translate-x-1/2 -translate-y-1/2 rounded-sm border-2 border-bg bg-text ${corner === 'nw' || corner === 'se' ? 'cursor-nwse-resize' : 'cursor-nesw-resize'}`}
                  style={{ left: pct(cx, size.width), top: pct(cy, size.height) }} />
              )
            })}
            {draft.roi && (
              <div className="pointer-events-none absolute border-2 border-dashed border-text"
                style={{ left: pct(draft.roi[0], size.width), top: pct(draft.roi[1], size.height), width: pct(draft.roi[2], size.width), height: pct(draft.roi[3], size.height) }} />
            )}
            {draft.roi && draft.type === 'analog_dial' && POINTS.map((p) => {
              const c = draft[p.tool]
              if (!c) return null
              const f = calibToFrame(c, draft.roi!)
              return (
                <span key={p.tool} className="pointer-events-none absolute flex h-6 w-6 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full bg-text tabular-nums text-xs font-semibold text-bg"
                  style={{ left: pct(f.x, size.width), top: pct(f.y, size.height) }}>
                  {p.mark}
                </span>
              )
            })}
            {dragBox && <div className="pointer-events-none absolute border-2 border-dashed border-accent" style={dragBox} />}
          </div>
          <ActionError error={frame.error} />

          <section className="rounded-lg border border-line bg-panel p-3.5">
            <h2 className="text-[13px] font-semibold text-text">Đồng hồ trên camera này</h2>
            {(candidates.data?.candidates.length ?? 0) > 0 && (
              <p className="mt-1 text-xs text-warn">
                AI phát hiện {candidates.data!.candidates.length} đồng hồ chưa khai báo (khung viền đứt “Mới” trên ảnh). Bấm vào khung để kiểm tra và gán.
              </p>
            )}
            {onCamera.length === 0
              ? <p className="mt-1 text-xs text-muted">Chưa có. Khoanh đồng hồ đầu tiên trên ảnh rồi lưu ở khung bên phải.</p>
              : (
                <ul className="mt-2.5 flex flex-wrap gap-2">
                  {onCamera.map((e) => {
                    const active = editing?.machine_id === e.machine_id && editing.gauge.gauge_id === e.gauge.gauge_id
                    return (
                      <li key={`${e.machine_id}/${e.gauge.gauge_id}`}>
                        <button onClick={() => edit(e)} aria-pressed={active}
                          className={`flex min-h-8 items-center gap-2 rounded-lg border-2 bg-raised px-3 text-xs ${active ? 'border-text' : 'border-raised hover:border-line-2'}`}>
                          <span className="h-3 w-3 flex-none rounded-sm" style={{ background: colorOf(e.machine_id) }} />
                          <span className="tabular-nums">{e.machine_id}</span>
                          <span className="text-muted">·</span>
                          <span className="tabular-nums">{e.gauge.gauge_id}</span>
                        </button>
                      </li>
                    )
                  })}
                </ul>
              )}
          </section>
        </div>

        <section className="grid min-w-0 items-start gap-x-6 gap-y-4 rounded-lg border border-line bg-panel p-3.5 md:grid-cols-2 xl:grid-cols-4">
          <div className="col-span-full flex items-center justify-between gap-2">
            <h2 className="text-xs font-semibold">{editing ? 'Sửa đồng hồ' : fromCandidate ? 'Kiểm tra đồng hồ AI phát hiện' : 'Đồng hồ mới'}</h2>
            {(editing || fromCandidate) && <button className={gtButton} onClick={startNew}>Khai báo tay</button>}
          </div>
          {fromCandidate && (
            <div className="col-span-full flex flex-wrap items-center gap-x-4 gap-y-2 rounded-lg border border-dashed border-warn px-3 py-2.5 text-xs text-text-2">
              <p className="min-w-0 flex-1">
                AI đề xuất <b className="text-text">{TYPE_LABEL[fromCandidate.type] ?? fromCandidate.type}</b> (tin {Math.round(fromCandidate.score * 100)}%,
                thấy {fromCandidate.seen} lần quét). Kiểm tra trước khi gán: khung phải ôm sát {fromCandidate.type === 'analog_dial' ? 'mặt đồng hồ' : 'các chữ số'} (kéo bốn góc để chỉnh)
                {fromCandidate.type === 'analog_dial' ? ', ba điểm T, m, M phải nằm đúng tâm kim và hai vạch đầu cuối' : ', số chữ số phải đúng'}.
                Sau đó chọn máy, đặt tên, {fromCandidate.type === 'analog_dial' ? 'nhập giá trị hai đầu thang đo, ' : ''}bấm Đọc thử rồi Lưu.
              </p>
              <button className={gtButton} disabled={ignore.isPending} onClick={() => ignore.mutate(fromCandidate.candidate_id)}>
                Không phải đồng hồ cần đo
              </button>
              <ActionError error={ignore.error} />
            </div>
          )}

          {makingAsset && (
            <AssetDialog
              onClose={() => setMakingAsset(false)}
              onSaved={(key) => {
                setMakingAsset(false)
                void qc.invalidateQueries({ queryKey: ['assets'] })
                setMachine({ ...machine, machine_id: key })
              }}
            />
          )}

          <fieldset className="grid grid-cols-2 gap-3">
            <legend className="mb-2 text-xs font-semibold text-text">1. Đồng hồ này của máy nào</legend>
            {/* Máy phải CHỌN từ danh mục Thiết bị, không gõ tự do: mã máy ở đây chính là mã thiết bị,
                gõ tay sẽ sinh ra một cái máy chỉ khu Đồng hồ biết và số đọc không gắn vào đâu cả.
                Máy cũ chưa khai trong danh mục vẫn hiện (để sửa được đồng hồ đã gán), có ghi rõ. */}
            <Field label="Máy (chọn trong danh mục Thiết bị)" wide>
              <select className={`${gtField} tabular-nums`} value={machine.machine_id} disabled={editing !== null}
                onChange={(e) => { if (e.target.value === NEW_ASSET) setMakingAsset(true); else pickMachine(e.target.value) }}>
                <option value="">— chọn máy —</option>
                {legacyMachine && <option value={legacyMachine}>{legacyMachine} (chưa khai trong danh mục)</option>}
                {(assets.data ?? []).filter((a) => !a.retired).map((a) => (
                  <option key={a.key} value={a.key}>
                    {a.key}{a.name ? ` · ${a.name}` : ''}{(stations.data ?? []).some((s) => s.machine_id === a.key) ? ' · đã có đồng hồ' : ''}
                  </option>
                ))}
                <option value={NEW_ASSET}>+ Khai thiết bị mới…</option>
              </select>
            </Field>
            <Field label="Nhà máy">
              <input className={gtField} value={machine.plant} disabled={existing !== undefined || pickedAsset !== undefined}
                onChange={(e) => setMachine({ ...machine, plant: e.target.value })} />
            </Field>
            <Field label="Dây chuyền">
              <input className={gtField} value={machine.line} disabled={existing !== undefined || pickedAsset !== undefined}
                onChange={(e) => setMachine({ ...machine, line: e.target.value })} />
            </Field>
            {machine.machine_id !== '' && (
              pickedAsset
                ? <p className="col-span-2 text-xs text-text-2">
                    Khớp thiết bị <span className="font-mono">{pickedAsset.key}</span> trong danh mục Thiết bị
                    {pickedAsset.models.length ? ` (đang ở ${pickedAsset.models.join(', ')})` : ''}. Số đọc sẽ gắn đúng máy này.
                  </p>
                : <p className="col-span-2 text-xs text-warn">
                    <b>Chưa có trong danh mục Thiết bị.</b> Đồng hồ vẫn lưu và đọc được, nhưng số đọc chưa gắn vào thiết bị nào của
                    KaizenFlow. Khai nó bằng mục "+ Khai thiết bị mới…" ở ô trên, hoặc ở
                    trang <Link to="/assets" className="underline">Thiết bị</Link> — mã máy chính là mã thiết bị.
                  </p>
            )}
          </fieldset>

          <fieldset className="grid grid-cols-2 gap-3">
            <legend className="mb-2 text-xs font-semibold text-text">2. Đồng hồ</legend>
            <Field label="Mã đồng hồ">
              <input className={`${gtField} tabular-nums`} value={draft.gauge_id} disabled={editing !== null} onChange={(e) => patch({ gauge_id: e.target.value })} placeholder="OIL_TEMP" />
            </Field>
            <Field label="Đơn vị">
              <input className={gtField} value={draft.unit} onChange={(e) => patch({ unit: e.target.value })} placeholder="bar, V, degC…" />
            </Field>
            <Field label="Loại" wide>
              <select className={gtField} value={draft.type}
                onChange={(e) => { patch({ ...emptyDraft(e.target.value as GaugeType), gauge_id: draft.gauge_id, unit: draft.unit, roi: draft.roi }); setTool('roi') }}>
                {TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
              </select>
            </Field>
          </fieldset>

          <fieldset className="flex flex-col gap-3">
            <legend className="mb-2 text-xs font-semibold text-text">3. Vị trí trên ảnh</legend>
            <div className="flex flex-wrap gap-2">
              <button className={`${gtButton} ${tool === 'roi' ? 'border-accent' : ''}`} aria-pressed={tool === 'roi'} onClick={() => setTool('roi')}>
                {draft.roi ? 'Khoanh lại vùng' : 'Khoanh vùng'}
              </button>
              {draft.type === 'analog_dial' && POINTS.map((p) => (
                <button key={p.tool} className={`${gtButton} ${tool === p.tool ? 'border-accent' : ''}`} aria-pressed={tool === p.tool} disabled={!draft.roi} onClick={() => setTool(p.tool)}>
                  {p.label}{draft[p.tool] ? ' ✓' : ''}
                </button>
              ))}
            </div>
            <p className="tabular-nums text-xs text-muted">
              {draft.roi ? `vùng đọc: x ${draft.roi[0]}, y ${draft.roi[1]}, rộng ${draft.roi[2]}, cao ${draft.roi[3]}` : 'chưa khoanh vùng'}
            </p>
            {draft.type !== 'analog_dial' && <p className="text-xs text-muted">Với màn hình số, khoanh sát mép các chữ số, không lấy viền và nhãn.</p>}
            {draft.roi && frame.data && (
              <RegionPreview frameJpeg={frame.data.frame_jpeg} size={size} roi={draft.roi} type={draft.type} digits={Number(draft.digits) || 0} />
            )}
          </fieldset>

          <fieldset className="grid grid-cols-2 gap-3">
            <legend className="mb-2 text-xs font-semibold text-text">4. Thang đo</legend>
            {draft.type === 'analog_dial' && (
              <>
                <Field label="Giá trị ở vạch min"><input className={gtField} type="number" step="any" value={draft.min_val} onChange={(e) => patch({ min_val: e.target.value })} /></Field>
                <Field label="Giá trị ở vạch max"><input className={gtField} type="number" step="any" value={draft.max_val} onChange={(e) => patch({ max_val: e.target.value })} /></Field>
                <Field label="Chiều kim tăng" wide>
                  <select className={gtField} value={draft.sweep} onChange={(e) => patch({ sweep: e.target.value as 'cw' | 'ccw' })}>
                    <option value="cw">Cùng chiều kim đồng hồ</option>
                    <option value="ccw">Ngược chiều kim đồng hồ</option>
                  </select>
                </Field>
              </>
            )}
            {(draft.type === 'seg7' || draft.type === 'rolling_counter') && (
              <Field label="Số chữ số"><input className={gtField} type="number" min={1} max={10} value={draft.digits} onChange={(e) => patch({ digits: e.target.value })} /></Field>
            )}
            {draft.type === 'seg7' && (
              <>
                <Field label="Số chữ số trước dấu chấm"><input className={gtField} type="number" min={0} value={draft.decimal_pos} onChange={(e) => patch({ decimal_pos: e.target.value })} /></Field>
                <Field label="Màu chữ số" wide>
                  <select className={gtField} value={draft.color} onChange={(e) => patch({ color: e.target.value as GaugeDraft['color'] })}>
                    <option value="red_led">LED đỏ</option>
                    <option value="green_led">LED xanh</option>
                    <option value="lcd">LCD</option>
                  </select>
                </Field>
              </>
            )}
            {draft.type === 'rolling_counter' && (
              <Field label="Số chữ số thập phân"><input className={gtField} type="number" min={0} value={draft.decimal_digits} onChange={(e) => patch({ decimal_digits: e.target.value })} /></Field>
            )}
            {draft.type === 'timer_mmss' && <p className="col-span-2 text-xs text-muted">Bốn chữ số dạng phút:giây; giá trị gửi về tính bằng giây.</p>}
            <Field label="Ngưỡng dưới (tuỳ chọn)"><input className={gtField} type="number" step="any" value={draft.rule_min} onChange={(e) => patch({ rule_min: e.target.value })} /></Field>
            <Field label="Ngưỡng trên (tuỳ chọn)"><input className={gtField} type="number" step="any" value={draft.rule_max} onChange={(e) => patch({ rule_max: e.target.value })} /></Field>
          </fieldset>

          {problems.length > 0 && (
            <ul className="col-span-full list-disc rounded-lg bg-panel-2 py-2.5 pl-8 pr-3 text-xs text-text-2">
              {problems.map((p) => <li key={p}>{p}</li>)}
            </ul>
          )}

          <div className="col-span-full flex flex-wrap gap-2.5">
            <button className={gtButton} disabled={!gauge || !frame.data || preview.isPending} onClick={() => preview.mutate()}>
              {preview.isPending ? 'Đang đọc…' : 'Đọc thử trên ảnh này'}
            </button>
            <button className={gtPrimary} disabled={problems.length > 0 || save.isPending} onClick={() => save.mutate()}>
              {save.isPending ? 'Đang lưu…' : 'Lưu vào máy'}
            </button>
            {editing && (
              <button className={gtButton} disabled={remove.isPending}
                onClick={() => { if (window.confirm(`Gỡ ${editing.gauge.gauge_id} khỏi máy ${editing.machine_id}?`)) remove.mutate() }}>
                Gỡ khỏi máy
              </button>
            )}
          </div>
          {reading && (
            <p role="status" className="col-span-full rounded-lg bg-panel-2 px-3.5 py-2.5 text-xs">
              {reading.error ? <span className="text-warn">Chưa đọc được: {reading.error}</span> : (
                <>
                  Hệ thống đọc được{' '}
                  <span className="tabular-nums text-[13px] font-semibold text-text">{fmtValue(reading.value ?? null, draft.type)} {unitLabel(draft.unit)}</span>
                  <span className="text-muted"> · độ tin cậy {Math.round(reading.quality * 100)}%{reading.flags?.length ? ` · ${reading.flags.join(', ')}` : ''}</span>
                </>
              )}
            </p>
          )}
          {saved && <p role="status" className="col-span-full rounded-lg bg-panel-2 px-3.5 py-2.5 text-xs text-ok">{saved}</p>}
          {(preview.error ?? save.error ?? remove.error) && <div className="col-span-full"><ActionError error={preview.error ?? save.error ?? remove.error} /></div>}

          <fieldset className="col-span-full flex flex-col gap-3 border-t border-line pt-4">
            <legend className="sr-only">Nghiệm thu</legend>
            <h3 className="text-xs font-semibold text-text">5. Nghiệm thu tại chỗ</h3>
            <p className="text-xs text-muted">Nhập giá trị bạn đang thấy trên đồng hồ thật. Hệ thống lấy một khung hình mới, tự đọc và so sánh. Cần 3 mẫu đúng; mỗi mẫu được lưu kèm ảnh.</p>
            <div className="flex flex-wrap items-end gap-2.5">
              <label className="flex flex-col gap-1.5 text-xs text-text-2">
                Giá trị đang thấy
                <input className={`${gtField} w-36`} type="number" step="any" value={truth} onChange={(e) => setTruth(e.target.value)} />
              </label>
              <button className={gtButton} disabled={!gauge || !machineOk || truth === '' || accept.isPending} onClick={() => accept.mutate()}>
                {accept.isPending ? 'Đang lấy hình và đọc…' : 'Ghi mẫu nghiệm thu'}
              </button>
            </div>
            {verdict && (
              <p role="status" className="rounded-lg bg-panel-2 px-3.5 py-2.5 text-xs">
                <span className={`font-semibold ${verdict.passed ? 'text-ok' : 'text-bad'}`}>{verdict.passed ? 'Mẫu đạt' : 'Mẫu sai'}</span>
                {verdict.value !== undefined && <span> · hệ thống đọc {fmtValue(verdict.value, draft.type)}</span>}
                {verdict.reason && <span className="text-muted"> · {verdict.reason}</span>}
                {verdict.summary && <span className="text-muted"> · {verdict.summary.passed} đạt, {verdict.summary.failed} sai, cần {verdict.summary.needed}</span>}
              </p>
            )}
            <ActionError error={accept.error} />
          </fieldset>
        </section>
      </div>
    </GaugeArea>
  )
}

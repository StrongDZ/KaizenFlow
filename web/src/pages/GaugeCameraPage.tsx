import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useMemo, useRef, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { gaugeConfigApi, type AcceptanceVerdict, type PreviewGauge } from '../api/gaugeConfig'
import { ActionError, GaugeArea, gtButton, gtField, gtPrimary } from '../components/gauge/GaugeArea'
import {
  buildGauge, calibPoint, calibToFrame, draftFromGauge, dragToRoi, emptyDraft, gaugesOnCamera, machineColor, mergeGauge, removeGauge, toFrame,
  upsertGauge, type GaugeDoc, type GaugeDraft, type GaugeType, type Point,
} from '../lib/gaugeCommission'
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
  return <label className={`flex flex-col gap-1.5 text-sm text-text-2 ${wide ? 'col-span-2' : ''}`}>{label}{children}</label>
}

const pct = (v: number, total: number) => `${(v * 100) / total}%`

/** Mở một camera: thấy nó đang quay gì, khoanh từng đồng hồ và chọn đồng hồ đó thuộc máy nào. */
export default function GaugeCameraPage() {
  const cameraId = useParams().camera ?? ''
  const qc = useQueryClient()
  const cameras = useQuery({ queryKey: ['gauge-config', 'cameras'], queryFn: gaugeConfigApi.cameras })
  const stations = useQuery({ queryKey: ['gauge-config', 'stations'], queryFn: gaugeConfigApi.stations })
  // Ảnh đứng yên trong lúc khoanh vùng; người dùng bấm để lấy khung hình mới.
  const frame = useQuery({
    queryKey: ['gauge-config', 'frame', cameraId], queryFn: () => gaugeConfigApi.frame({ camera_id: cameraId }),
    staleTime: Infinity, retry: false, refetchOnWindowFocus: false,
  })

  const camera = cameras.data?.find((c) => c.camera_id === cameraId)
  const onCamera = useMemo(() => gaugesOnCamera(stations.data ?? [], cameraId), [stations.data, cameraId])
  const machineIds = useMemo(() => [...new Set(onCamera.map((e) => e.machine_id))], [onCamera])
  const colorOf = (machine: string) => machineColor(Math.max(0, machineIds.indexOf(machine)))

  const [machine, setMachine] = useState({ machine_id: '', plant: '', line: '' })
  const [draft, setDraft] = useState<GaugeDraft>(() => emptyDraft('analog_dial'))
  // Đồng hồ đã lưu đang được sửa (để giữ các trường form không quản lý); null là đồng hồ mới.
  const [editing, setEditing] = useState<{ machine_id: string; gauge: GaugeDoc } | null>(null)
  const [tool, setTool] = useState<Tool>('roi')
  const [drag, setDrag] = useState<{ from: Point; to: Point } | null>(null)
  const [reading, setReading] = useState<PreviewGauge | null>(null)
  const [truth, setTruth] = useState('')
  const [verdict, setVerdict] = useState<{ passed: boolean; value?: number; reason?: string; summary?: AcceptanceVerdict } | null>(null)
  const [saved, setSaved] = useState('')
  const imageRef = useRef<HTMLDivElement>(null)

  const size = frame.data ? { width: frame.data.width, height: frame.data.height } : { width: 1920, height: 1080 }
  const existing = stations.data?.find((s) => s.machine_id === machine.machine_id)
  const built = buildGauge(draft, cameraId)
  const gauge = built.gauge ? mergeGauge(editing?.gauge, built.gauge) : undefined
  const machineOk = /^[A-Za-z0-9_.-]{1,64}$/.test(machine.machine_id) && (existing !== undefined || (machine.plant !== '' && machine.line !== ''))
  const problems = [...(machineOk ? [] : ['Chọn máy có sẵn, hoặc nhập mã máy mới kèm nhà máy và dây chuyền.']), ...built.problems]

  const patch = (p: Partial<GaugeDraft>) => { setDraft((d) => ({ ...d, ...p })); setReading(null); setVerdict(null); setSaved('') }
  const pickMachine = (id: string) => {
    const known = stations.data?.find((s) => s.machine_id === id)
    setMachine(known ? { machine_id: id, plant: known.config.plant, line: known.config.line } : { ...machine, machine_id: id })
    setSaved('')
  }
  const startNew = () => {
    setEditing(null); setDraft(emptyDraft('analog_dial')); setTool('roi'); setReading(null); setVerdict(null); setTruth(''); setSaved('')
  }
  const edit = (entry: { machine_id: string; gauge: GaugeDoc }) => {
    setEditing(entry); setDraft(draftFromGauge(entry.gauge)); pickMachine(entry.machine_id); setTool('roi'); setReading(null); setVerdict(null); setTruth('')
  }

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
  const onUp = () => {
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
  }
  const save = useMutation({
    mutationFn: () => gaugeConfigApi.putStation(upsertGauge(existing?.config ?? null, machine, gauge!)),
    onSuccess: (stored) => {
      setSaved(`Đã lưu vào ${stored.machine_id}. Config mới được đẩy xuống edge.`)
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

  const back = <Link to="/gauge-twin/cameras" className="text-sm text-muted underline decoration-dotted hover:text-text">← Tất cả camera</Link>
  if (cameras.data && !camera) {
    return <GaugeArea>{back}<p className="rounded-xl bg-panel px-5 py-8 text-center text-muted">Không có camera <span className="font-mono text-text">{cameraId}</span>.</p></GaugeArea>
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
          {back}
          <h1 className="mt-1 text-3xl font-bold tracking-tight">{camera?.name || cameraId}</h1>
          <p className="font-mono text-xs text-muted">{cameraId}{camera?.location && ` · ${camera.location}`}</p>
        </div>
        <p className="ml-auto text-sm text-text-2">
          {onCamera.length === 0 ? 'Chưa có đồng hồ nào trên camera này' : `${onCamera.length} đồng hồ của ${machineIds.length} máy`}
        </p>
      </div>

      <div className="flex flex-wrap gap-4">
        <div className="flex min-w-0 flex-[999_1_560px] flex-col gap-3">
          <div className="flex flex-wrap items-center gap-2.5">
            <button className={gtButton} onClick={() => void frame.refetch()} disabled={frame.isFetching}>
              {frame.isFetching ? 'Đang lấy hình…' : 'Lấy khung hình mới'}
            </button>
            <span className="text-sm text-text-2">{hint}</span>
          </div>

          <div
            ref={imageRef}
            onPointerDown={onDown}
            onPointerMove={(e) => drag && setDrag({ ...drag, to: at(e) })}
            onPointerUp={onUp}
            className={`relative touch-none select-none overflow-hidden rounded-xl bg-raised ${frame.data ? 'cursor-crosshair' : ''}`}
            style={{ aspectRatio: `${size.width} / ${size.height}` }}
          >
            {frame.data
              ? <img src={`data:image/jpeg;base64,${frame.data.frame_jpeg}`} alt={`Khung hình từ camera ${cameraId}`} draggable={false} className="absolute inset-0 h-full w-full" />
              : <p className="absolute inset-x-0 top-1/2 -translate-y-1/2 px-6 text-center font-mono text-sm text-faint">
                  {frame.isPending ? 'Đang lấy khung hình từ camera…' : 'Không lấy được khung hình. Kiểm tra địa chỉ camera và kết nối mạng từ server tới camera.'}
                </p>}

            {onCamera.map((e) => {
              const active = editing?.machine_id === e.machine_id && editing.gauge.gauge_id === e.gauge.gauge_id
              if (active || e.gauge.roi.length !== 4) return null
              const [x, y, w, h] = e.gauge.roi
              return (
                <div key={`${e.machine_id}/${e.gauge.gauge_id}`} className="pointer-events-none absolute rounded-sm border-2"
                  style={{ left: pct(x, size.width), top: pct(y, size.height), width: pct(w, size.width), height: pct(h, size.height), borderColor: colorOf(e.machine_id) }}>
                  <span className="absolute bottom-full left-0 mb-0.5 whitespace-nowrap rounded px-1.5 py-0.5 font-mono text-[11px] font-bold text-on-accent" style={{ background: colorOf(e.machine_id) }}>
                    {e.machine_id} · {e.gauge.gauge_id}
                  </span>
                </div>
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
                <span key={p.tool} className="pointer-events-none absolute flex h-6 w-6 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full bg-text font-mono text-xs font-bold text-bg"
                  style={{ left: pct(f.x, size.width), top: pct(f.y, size.height) }}>
                  {p.mark}
                </span>
              )
            })}
            {dragBox && <div className="pointer-events-none absolute border-2 border-dashed border-accent" style={dragBox} />}
          </div>
          <ActionError error={frame.error} />

          <section className="rounded-xl bg-panel p-4">
            <h2 className="text-base font-bold">Đồng hồ trên camera này</h2>
            {onCamera.length === 0
              ? <p className="mt-1 text-sm text-muted">Chưa có. Khoanh đồng hồ đầu tiên trên ảnh rồi lưu ở khung bên phải.</p>
              : (
                <ul className="mt-2.5 flex flex-wrap gap-2">
                  {onCamera.map((e) => {
                    const active = editing?.machine_id === e.machine_id && editing.gauge.gauge_id === e.gauge.gauge_id
                    return (
                      <li key={`${e.machine_id}/${e.gauge.gauge_id}`}>
                        <button onClick={() => edit(e)} aria-pressed={active}
                          className={`flex min-h-11 items-center gap-2 rounded-lg border-2 bg-raised px-3 text-sm ${active ? 'border-text' : 'border-raised hover:border-line-2'}`}>
                          <span className="h-3 w-3 flex-none rounded-sm" style={{ background: colorOf(e.machine_id) }} />
                          <span className="font-mono">{e.machine_id}</span>
                          <span className="text-muted">·</span>
                          <span className="font-mono">{e.gauge.gauge_id}</span>
                        </button>
                      </li>
                    )
                  })}
                </ul>
              )}
          </section>
        </div>

        <aside className="flex min-w-0 flex-[1_1_380px] flex-col gap-4 rounded-xl bg-panel p-4">
          <div className="flex items-center justify-between gap-2">
            <h2 className="text-xl font-bold">{editing ? 'Sửa đồng hồ' : 'Đồng hồ mới'}</h2>
            {editing && <button className={gtButton} onClick={startNew}>Thêm đồng hồ khác</button>}
          </div>

          <fieldset className="grid grid-cols-2 gap-3">
            <legend className="mb-2 text-sm font-bold text-text">1. Đồng hồ này của máy nào</legend>
            <Field label="Mã máy" wide>
              <input className={`${gtField} font-mono`} list="gt-machines" value={machine.machine_id} disabled={editing !== null}
                onChange={(e) => pickMachine(e.target.value)} placeholder="Chọn máy có sẵn hoặc gõ mã máy mới" />
              <datalist id="gt-machines">{(stations.data ?? []).map((s) => <option key={s.machine_id} value={s.machine_id} />)}</datalist>
            </Field>
            <Field label="Nhà máy">
              <input className={gtField} value={machine.plant} disabled={existing !== undefined} onChange={(e) => setMachine({ ...machine, plant: e.target.value })} />
            </Field>
            <Field label="Dây chuyền">
              <input className={gtField} value={machine.line} disabled={existing !== undefined} onChange={(e) => setMachine({ ...machine, line: e.target.value })} />
            </Field>
            {machine.machine_id !== '' && !existing && <p className="col-span-2 text-xs text-warn">Máy mới: sẽ được tạo khi lưu đồng hồ đầu tiên.</p>}
          </fieldset>

          <fieldset className="grid grid-cols-2 gap-3">
            <legend className="mb-2 text-sm font-bold text-text">2. Đồng hồ</legend>
            <Field label="Mã đồng hồ">
              <input className={`${gtField} font-mono`} value={draft.gauge_id} disabled={editing !== null} onChange={(e) => patch({ gauge_id: e.target.value })} placeholder="OIL_TEMP" />
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
            <legend className="mb-2 text-sm font-bold text-text">3. Vị trí trên ảnh</legend>
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
            <p className="font-mono text-xs text-muted">
              {draft.roi ? `vùng đọc: x ${draft.roi[0]}, y ${draft.roi[1]}, rộng ${draft.roi[2]}, cao ${draft.roi[3]}` : 'chưa khoanh vùng'}
            </p>
            {draft.type !== 'analog_dial' && <p className="text-xs text-muted">Với màn hình số, khoanh sát mép các chữ số, không lấy viền và nhãn.</p>}
          </fieldset>

          <fieldset className="grid grid-cols-2 gap-3">
            <legend className="mb-2 text-sm font-bold text-text">4. Thang đo</legend>
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
            {draft.type === 'timer_mmss' && <p className="col-span-2 text-sm text-muted">Bốn chữ số dạng phút:giây; giá trị gửi về tính bằng giây.</p>}
            <Field label="Ngưỡng dưới (tuỳ chọn)"><input className={gtField} type="number" step="any" value={draft.rule_min} onChange={(e) => patch({ rule_min: e.target.value })} /></Field>
            <Field label="Ngưỡng trên (tuỳ chọn)"><input className={gtField} type="number" step="any" value={draft.rule_max} onChange={(e) => patch({ rule_max: e.target.value })} /></Field>
          </fieldset>

          {problems.length > 0 && (
            <ul className="list-disc rounded-lg bg-panel-2 py-2.5 pl-8 pr-3 text-sm text-text-2">
              {problems.map((p) => <li key={p}>{p}</li>)}
            </ul>
          )}

          <div className="flex flex-wrap gap-2.5">
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
            <p role="status" className="rounded-lg bg-panel-2 px-3.5 py-2.5 text-sm">
              {reading.error ? <span className="text-warn">Chưa đọc được: {reading.error}</span> : (
                <>
                  Hệ thống đọc được{' '}
                  <span className="font-mono text-lg font-bold text-text">{fmtValue(reading.value ?? null, draft.type)} {unitLabel(draft.unit)}</span>
                  <span className="text-muted"> · độ tin cậy {Math.round(reading.quality * 100)}%{reading.flags?.length ? ` · ${reading.flags.join(', ')}` : ''}</span>
                </>
              )}
            </p>
          )}
          {saved && <p role="status" className="rounded-lg bg-panel-2 px-3.5 py-2.5 text-sm text-ok">{saved}</p>}
          <ActionError error={preview.error ?? save.error ?? remove.error} />

          <fieldset className="flex flex-col gap-3 border-t border-line pt-4">
            <legend className="sr-only">Nghiệm thu</legend>
            <h3 className="text-sm font-bold text-text">5. Nghiệm thu tại chỗ</h3>
            <p className="text-xs text-muted">Nhập giá trị bạn đang thấy trên đồng hồ thật. Hệ thống lấy một khung hình mới, tự đọc và so sánh. Cần 3 mẫu đúng; mỗi mẫu được lưu kèm ảnh.</p>
            <div className="flex flex-wrap items-end gap-2.5">
              <label className="flex flex-col gap-1.5 text-sm text-text-2">
                Giá trị đang thấy
                <input className={`${gtField} w-36`} type="number" step="any" value={truth} onChange={(e) => setTruth(e.target.value)} />
              </label>
              <button className={gtButton} disabled={!gauge || !machineOk || truth === '' || accept.isPending} onClick={() => accept.mutate()}>
                {accept.isPending ? 'Đang lấy hình và đọc…' : 'Ghi mẫu nghiệm thu'}
              </button>
            </div>
            {verdict && (
              <p role="status" className="rounded-lg bg-panel-2 px-3.5 py-2.5 text-sm">
                <span className={`font-bold ${verdict.passed ? 'text-ok' : 'text-bad'}`}>{verdict.passed ? 'Mẫu đạt' : 'Mẫu sai'}</span>
                {verdict.value !== undefined && <span> · hệ thống đọc {fmtValue(verdict.value, draft.type)}</span>}
                {verdict.reason && <span className="text-muted"> · {verdict.reason}</span>}
                {verdict.summary && <span className="text-muted"> · {verdict.summary.passed} đạt, {verdict.summary.failed} sai, cần {verdict.summary.needed}</span>}
              </p>
            )}
            <ActionError error={accept.error} />
          </fieldset>
        </aside>
      </div>
    </GaugeArea>
  )
}

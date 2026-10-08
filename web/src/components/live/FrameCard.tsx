import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Crosshair, Equal, FlipVertical2, Move, RotateCw, Scaling, type LucideIcon } from 'lucide-react'
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { api } from '../../api/client'
import type { AgvMap, Frame, Vehicle } from '../../api/types'
import { IDENTITY_FRAME, isIdentityFrame, solveFrame, withFrame, type FramePair } from '../../lib/frame'
import { offMapShare } from '../../lib/mapGeom'
import { pointLabel } from '../../lib/mapTables'
import { Card, ErrorBox, Notice, btn, btnPrimary, input } from '../ui'

/** Ô nhập số cho phép gõ dở ("-", "1.") mà không bị ép về 0; chỉ báo ra ngoài khi chuỗi đã là số hợp lệ. */
const shown = (n: number) => String(Math.round(n * 1e6) / 1e6)

function NumField({ label, value, step, onChange }: { label: string; value: number; step: string; onChange: (n: number) => void }) {
  const [text, setText] = useState(shown(value))
  useEffect(() => { if (Number(text.replace(',', '.')) !== value) setText(shown(value)) }, [value]) // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <label className="space-y-1">
      <span className="block text-text-2">{label}</span>
      <input
        className={`${input} w-full tabular-nums`} inputMode="decimal" step={step} value={text}
        onChange={(e) => {
          setText(e.target.value)
          const n = Number(e.target.value.replace(',', '.'))
          if (e.target.value.trim() !== '' && Number.isFinite(n)) onChange(n)
        }}
      />
    </label>
  )
}

function FrameChip({ icon: Icon, children }: { icon: LucideIcon; children: ReactNode }) {
  return <span className="inline-flex items-center gap-1 rounded-md bg-panel-2 px-1.5 py-0.5 text-[11px] tabular-nums text-text-2"><Icon size={11} className="text-faint" aria-hidden />{children}</span>
}

const STATE: Record<string, string> = { MOVING: 'đang chạy', WAITING: 'chờ vào làn', LOADING: 'bốc dỡ', IDLE: 'nghỉ' }

const fmt = (n: number) => (Math.abs(n) >= 100 ? n.toFixed(0) : n.toFixed(2).replace(/\.?0+$/, ''))

/**
 * Khung toạ độ của đội xe: hãng xe báo vị trí theo hệ toạ độ riêng, khung đổi sang toạ độ bản đồ (mét) trước khi API khớp xe vào làn.
 * `draft` (giữ ở trang) là khung đang chỉnh; khi có thì canvas vẽ vị trí xe theo khung đó dạng chấm nét đứt để xem trước.
 */
export function FrameCard({ model, map, names, fleets, draft, onDraft, bare = false }: {
  model: string; map: AgvMap; names: Record<string, string>; fleets: Vehicle[][]; draft: Frame | null; onDraft: (f: Frame | null) => void
  /** Không bọc trong thẻ có tiêu đề: để đặt vào một mục của bảng bên. */
  bare?: boolean
}) {
  const qc = useQueryClient()
  const bindings = useQuery({ queryKey: ['bindings', model], queryFn: () => api.bindings(model) })
  const fleetBindings = useMemo(() => (bindings.data ?? []).filter((b) => b.signal === 'fleet' && b.mode !== 'derived'), [bindings.data])
  const saved = fleetBindings.find((b) => b.transform?.frame)?.transform?.frame ?? IDENTITY_FRAME
  const share = offMapShare(fleets)
  const vehicles = useMemo(() => fleets.flat().sort((a, b) => a.id.localeCompare(b.id)), [fleets])

  const [pairs, setPairs] = useState<(FramePair & { vehicle: string; point: string })[]>([])
  const [vehicleId, setVehicleId] = useState('')
  const [pointId, setPointId] = useState('')
  const [fit, setFit] = useState<{ rmsM: number; n: number } | null>(null)
  const chosenVehicle = vehicles.find((v) => v.id === (vehicleId || vehicles[0]?.id))
  const moving = chosenVehicle?.state === 'MOVING' || chosenVehicle?.state === 'WAITING'  // xe đang chạy hay chờ ở cuối làn không đứng ở một điểm đã biết
  const chosenPoint = map.points.find((p) => p.id === (pointId || map.points[0]?.id))

  const save = useMutation({
    mutationFn: (f: Frame) => api.saveBindings(model, fleetBindings.map((b) => withFrame(b, f))),
    onSuccess: () => {
      for (const k of ['bindings', 'live', 'live-check']) void qc.invalidateQueries({ queryKey: [k, model] })
      onDraft(null); setPairs([]); setFit(null)
    },
  })

  const open = (f: Frame) => { onDraft(f); setPairs([]); setFit(null) }
  const set = (patch: Partial<Frame>) => { if (draft) { onDraft({ ...draft, ...patch }); setFit(null) } }
  const addPair = () => {
    if (!chosenVehicle || !chosenPoint) return
    setPairs((cur) => [...cur, { vehicle: chosenVehicle.id, point: chosenPoint.id, raw: { x: chosenVehicle.raw_x, y: chosenVehicle.raw_y }, map: { x: chosenPoint.x, y: chosenPoint.y } }])
    setFit(null)
  }
  const solve = () => {
    const r = solveFrame(pairs, draft?.flip_y ?? false)
    if (r) { onDraft(r.frame); setFit({ rmsM: r.rmsM, n: pairs.length }) }
  }

  const badge = vehicles.length > 0 ? (
    <span className={`rounded-md border px-1.5 py-0.5 text-[11px] ${share.off > 0 ? 'border-warn text-warn' : 'border-line-2 text-muted'}`}>
      {share.off > 0 ? `${share.off}/${share.total} xe ngoài đường` : 'mọi xe trên làn'}
    </span>
  ) : undefined

  const body = (
      <div className="space-y-2.5 text-xs">
        {bare && badge && <div>{badge}</div>}
        {fleetBindings.length === 0 && bindings.isSuccess && (
          <Notice tone="lock">
            Chưa ghép tín hiệu "Vị trí từng xe".{' '}
            <Link to={`/models/${encodeURIComponent(model)}/connect`} className="font-medium underline">Ghép ở Kết nối dữ liệu</Link>
          </Notice>
        )}
        {share.total > 0 && share.off / share.total > 0.2 && !draft && (
          <Notice tone="lock">Nhiều xe nằm ngoài mọi làn: khung toạ độ có thể chưa đúng.</Notice>
        )}
        {!draft ? (
          <>
            <div className="flex flex-wrap gap-1.5">
              {isIdentityFrame(saved)
                ? <FrameChip icon={Equal}>Không đổi: toạ độ bản đồ (m)</FrameChip>
                : (
                  <>
                    <FrameChip icon={Move}>({fmt(saved.dx)}; {fmt(saved.dy)}) m</FrameChip>
                    <FrameChip icon={RotateCw}>{fmt(saved.rot_deg)}°</FrameChip>
                    <FrameChip icon={Scaling}>×{saved.scale}</FrameChip>
                    {saved.flip_y && <FrameChip icon={FlipVertical2}>lật Y</FrameChip>}
                  </>
                )}
            </div>
            <div className="flex items-center gap-2">
              <button className={btn} disabled={fleetBindings.length === 0} onClick={() => open(saved)}><Crosshair size={13} aria-hidden />Chỉnh khung</button>
              <details className="group min-w-0 flex-1 text-[11px] text-muted">
                <summary className="cursor-pointer list-none text-right hover:text-text">Khung toạ độ là gì?</summary>
                <p className="mt-1.5 leading-snug">Hãng xe báo vị trí theo hệ toạ độ riêng (thường là mm, trục xoay). Khung đổi vị trí đó sang mét trên bản đồ, rồi hệ thống khớp xe vào làn.</p>
              </details>
            </div>
          </>
        ) : (
          <>
            <div className="grid grid-cols-2 gap-2">
              <NumField label="Dịch X (m)" value={draft.dx} step="0.1" onChange={(n) => set({ dx: n })} />
              <NumField label="Dịch Y (m)" value={draft.dy} step="0.1" onChange={(n) => set({ dy: n })} />
              <NumField label="Góc xoay (độ)" value={draft.rot_deg} step="1" onChange={(n) => set({ rot_deg: n })} />
              <NumField label="Tỉ lệ (mét mỗi đơn vị)" value={draft.scale} step="0.001" onChange={(n) => set({ scale: n })} />
            </div>
            <label className="flex items-center gap-1.5 text-text-2">
              <input type="checkbox" checked={draft.flip_y} onChange={(e) => set({ flip_y: e.target.checked })} /> Hãng xe có trục Y ngược chiều
            </label>
            <p className="text-[11px] text-muted">Chấm nét đứt trên bản đồ là vị trí xe theo khung đang nhập: chỉnh cho chúng nằm trên làn.</p>

            <div className="space-y-1.5 rounded-lg border border-line bg-panel-2 p-2">
              <div className="font-semibold text-text">Hoặc tính tự động từ điểm mẫu</div>
              <ol className="space-y-0.5 text-[11px] text-muted">
                <li><b className="text-text-2">1.</b> Chọn một xe đang đứng yên ở chỗ đã biết (vd. đỗ ở kho).</li>
                <li><b className="text-text-2">2.</b> Chọn đúng điểm đó trên bản đồ, bấm Thêm cặp.</li>
                <li><b className="text-text-2">3.</b> Làm từ 2 cặp trở lên (3 cặp để biết sai số), rồi Tính khung.</li>
              </ol>
              <div className="grid grid-cols-1 gap-1.5">
                <select className={input} aria-label="Xe" value={chosenVehicle?.id ?? ''} onChange={(e) => setVehicleId(e.target.value)}>
                  {vehicles.map((v) => <option key={v.id} value={v.id}>{v.id}</option>)}
                </select>
                <select className={input} aria-label="Điểm trên bản đồ" value={chosenPoint?.id ?? ''} onChange={(e) => setPointId(e.target.value)}>
                  {map.points.map((p) => <option key={p.id} value={p.id}>{pointLabel(p, names)} ({fmt(p.x)}; {fmt(p.y)}) m</option>)}
                </select>
                {/* Giá trị đổi từng giây (toạ độ, trạng thái) nằm ở ô đọc có khung cố định chứ không ở nhãn của ô chọn, để ô chọn không giật. */}
                <div className="h-9 overflow-hidden whitespace-nowrap rounded-md border border-line bg-panel px-2 py-1 font-mono text-[11px] tabular-nums leading-tight text-text-2" aria-live="off">
                  {chosenVehicle ? (
                    <>
                      <div>báo ({fmt(chosenVehicle.raw_x)}; {fmt(chosenVehicle.raw_y)})</div>
                      <div className={moving ? 'text-warn' : ''}>{STATE[chosenVehicle.state] ?? chosenVehicle.state}{moving ? ': chờ xe đứng yên' : ''}</div>
                    </>
                  ) : '—'}
                </div>
                <button className={btn} disabled={!chosenVehicle || !chosenPoint || moving} onClick={addPair}>Thêm cặp</button>
              </div>
              {pairs.length > 0 && (
                <ul className="space-y-0.5">
                  {pairs.map((p, i) => (
                    <li key={i} className="flex items-center gap-1.5 text-text-2">
                      <span className="min-w-0 flex-1 truncate font-mono">{p.vehicle} → {p.point}</span>
                      <button className="text-muted hover:text-text" aria-label={`Bỏ cặp ${p.vehicle} → ${p.point}`} onClick={() => { setPairs((c) => c.filter((_, j) => j !== i)); setFit(null) }}>✕</button>
                    </li>
                  ))}
                </ul>
              )}
              <button className={btn} disabled={pairs.length < 2} onClick={solve}>Tính khung từ {pairs.length} cặp</button>
              {fit && (
                <p className={fit.n >= 3 && fit.rmsM > 1 ? 'text-bad-text' : 'text-text-2'}>
                  {fit.n >= 3
                    ? `Sai số ${fit.rmsM.toFixed(2).replace('.', ',')} m giữa các cặp${fit.rmsM > 1 ? ': các cặp không khớp nhau, kiểm tra lại điểm đã chọn hoặc ô "trục Y ngược chiều".' : '.'}`
                    : 'Đã tính từ 2 cặp (luôn khớp tuyệt đối); thêm cặp thứ ba để biết sai số.'}
                </p>
              )}
            </div>

            <ErrorBox error={save.error} />
            <div className="flex flex-wrap gap-2">
              <button className={btnPrimary} disabled={save.isPending} onClick={() => save.mutate(draft)}>Lưu khung</button>
              <button className={btn} onClick={() => { onDraft(null); setPairs([]); setFit(null) }}>Huỷ</button>
              <button className={btn} onClick={() => { onDraft({ ...IDENTITY_FRAME }); setFit(null) }}>Về không đổi</button>
            </div>
            <p className="text-[11px] text-faint">Áp dụng cho {fleetBindings.length} ghép nối "Vị trí từng xe".</p>
          </>
        )}
      </div>
  )
  return bare ? body : <Card title="Khung toạ độ xe" actions={badge}>{body}</Card>
}

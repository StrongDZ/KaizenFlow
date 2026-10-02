import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useMemo, useState } from 'react'
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

const STATE: Record<string, string> = { MOVING: 'đang chạy', WAITING: 'chờ vào làn', LOADING: 'bốc dỡ', IDLE: 'nghỉ' }

const fmt = (n: number) => (Math.abs(n) >= 100 ? n.toFixed(0) : n.toFixed(2).replace(/\.?0+$/, ''))

export function describeFrame(f: Frame): string {
  if (isIdentityFrame(f)) return 'Không đổi: xe báo thẳng toạ độ bản đồ (mét).'
  const parts = [`dịch (${fmt(f.dx)}; ${fmt(f.dy)}) m`, `xoay ${fmt(f.rot_deg)}°`, `tỉ lệ ${f.scale}`]
  if (f.flip_y) parts.push('lật trục Y')
  return parts.join(', ')
}

/**
 * Khung toạ độ của đội xe: hãng xe báo vị trí theo hệ toạ độ riêng, khung đổi sang toạ độ bản đồ (mét) trước khi API khớp xe vào làn.
 * `draft` (giữ ở trang) là khung đang chỉnh; khi có thì canvas vẽ vị trí xe theo khung đó dạng chấm nét đứt để xem trước.
 */
export function FrameCard({ model, map, names, fleets, draft, onDraft }: {
  model: string; map: AgvMap; names: Record<string, string>; fleets: Vehicle[][]; draft: Frame | null; onDraft: (f: Frame | null) => void
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

  return (
    <Card
      title="Khung toạ độ xe"
      actions={vehicles.length > 0 ? (
        <span className={`rounded-md border px-1.5 py-0.5 text-[11px] ${share.off > 0 ? 'border-warn text-warn' : 'border-line-2 text-muted'}`}>
          {share.off > 0 ? `${share.off}/${share.total} xe ngoài đường` : 'mọi xe trên làn'}
        </span>
      ) : undefined}
    >
      <div className="space-y-2.5 text-xs">
        <p className="text-muted">Hãng xe báo vị trí theo hệ toạ độ riêng. Khung này đổi sang toạ độ bản đồ (mét) rồi hệ thống khớp xe vào làn.</p>
        {fleetBindings.length === 0 && bindings.isSuccess && (
          <Notice tone="lock">Chưa có ghép nối "Vị trí từng xe" nào. Ghép ở trang Kết nối dữ liệu, tab Node, rồi quay lại đây.</Notice>
        )}
        {share.total > 0 && share.off / share.total > 0.2 && !draft && (
          <Notice tone="lock">Nhiều xe nằm ngoài mọi làn: nhiều khả năng khung toạ độ chưa đúng. Bấm "Chỉnh khung".</Notice>
        )}
        {!draft ? (
          <>
            <p className="text-text-2">{describeFrame(saved)}</p>
            <button className={btn} disabled={fleetBindings.length === 0} onClick={() => open(saved)}>Chỉnh khung</button>
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
            <p className="text-muted">Chấm nét đứt xanh trên bản đồ là vị trí xe nếu dùng khung đang nhập; chỉnh cho chúng nằm trên làn rồi Lưu.</p>

            <div className="space-y-1.5 rounded-lg border border-line bg-panel-2 p-2">
              <div className="font-semibold text-text">Căn chỉnh bằng điểm mẫu</div>
              <p className="text-muted">Chọn một xe đang đứng yên (nghỉ hoặc đang bốc dỡ) đúng ở một điểm đã biết (ví dụ đỗ ở kho), chọn điểm đó, bấm Thêm cặp. Xe đang chạy sẽ cho cặp sai. Cần ít nhất 2 cặp; thêm cặp thứ ba để biết sai số.</p>
              <div className="grid grid-cols-1 gap-1.5">
                <select className={input} aria-label="Xe" value={chosenVehicle?.id ?? ''} onChange={(e) => setVehicleId(e.target.value)}>
                  {vehicles.map((v) => <option key={v.id} value={v.id}>{v.id} ({STATE[v.state] ?? v.state}): báo ({fmt(v.raw_x)}; {fmt(v.raw_y)})</option>)}
                </select>
                <select className={input} aria-label="Điểm trên bản đồ" value={chosenPoint?.id ?? ''} onChange={(e) => setPointId(e.target.value)}>
                  {map.points.map((p) => <option key={p.id} value={p.id}>{pointLabel(p, names)} ({fmt(p.x)}; {fmt(p.y)}) m</option>)}
                </select>
                <button className={btn} disabled={!chosenVehicle || !chosenPoint} onClick={addPair}>Thêm cặp</button>
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
            <p className="text-faint">Lưu áp dụng cho mọi ghép nối "Vị trí từng xe" của mô hình ({fleetBindings.length}).</p>
          </>
        )}
      </div>
    </Card>
  )
}

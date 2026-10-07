import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { api } from '../../api/client'
import type { Incident, IncidentInput, MapLane } from '../../api/types'
import { fmtFactoryTime } from '../../lib/liveFormat'
import { ErrorBox, btn, btnWarn, input } from '../ui'

export type IncidentNode = { key: string; name: string; archetype: string; materials: string[] }

const KINDS: { kind: Incident['kind']; label: string; hint: string }[] = [
  { kind: 'machine_down', label: 'Máy hỏng', hint: 'Dừng một máy trong khoảng thời gian đã chọn. Kho phía trước máy sẽ đầy lên, kho phía sau cạn dần.' },
  { kind: 'lane_block', label: 'Chặn làn', hint: 'Chặn một làn của bản đồ AGV. Xe tự đi đường vòng, nếu hết đường thì chờ; hàng ứ lại phía sau.' },
  { kind: 'stock_drain', label: 'Rút kho', hint: 'Rút bớt một phần tồn của một kho (kiểm kê lệch, hàng lỗi bị loại bỏ). Kho có thể chuyển Vàng hoặc Đỏ.' },
]
const DURATIONS = [10, 30, 120, 480]

const label = (kind: Incident['kind']) => KINDS.find((k) => k.kind === kind)?.label ?? kind

/** Bảng bơm sự cố cho demo: chọn loại, đối tượng, thời lượng; danh sách sự cố còn hiệu lực kèm nút gỡ. */
export function IncidentPanel({ nodes, lanes, incidents, ready }: { nodes: IncidentNode[]; lanes: MapLane[]; incidents: Incident[]; ready: boolean }) {
  const qc = useQueryClient()
  const [kind, setKind] = useState<Incident['kind']>('machine_down')
  const [target, setTarget] = useState('')
  const [minutes, setMinutes] = useState(30)
  const [material, setMaterial] = useState('')
  const [fraction, setFraction] = useState(80)
  const refresh = () => void qc.invalidateQueries({ queryKey: ['feed-status'] })
  const add = useMutation({ mutationFn: (b: IncidentInput) => api.feed.addIncident(b), onSuccess: refresh })
  const clear = useMutation({ mutationFn: (id: number) => api.feed.clearIncident(id), onSuccess: refresh })

  const machines = nodes.filter((n) => n.archetype === 'PROCESS')
  const stores = nodes.filter((n) => n.archetype === 'STORAGE' && n.materials.length > 0)
  const nameOf = (key: string) => nodes.find((n) => n.key === key)?.name ?? key
  const hint = KINDS.find((k) => k.kind === kind)?.hint
  const storeMaterials = stores.find((n) => n.key === target)?.materials ?? []
  const effMaterial = storeMaterials.includes(material) ? material : storeMaterials[0] ?? ''
  const canGo = ready && target !== '' && (kind !== 'stock_drain' || effMaterial !== '')
  const go = () => {
    const body: IncidentInput = { kind, target }
    if (kind !== 'stock_drain') body.duration_s = minutes * 60
    else { body.material = effMaterial; body.fraction = fraction / 100 }
    add.mutate(body)
  }
  const active = incidents.filter((i) => i.active)

  return (
    <div className="space-y-2.5 text-xs">
      <div className="flex gap-1" role="tablist" aria-label="Loại sự cố">
        {KINDS.map((k) => (
          <button key={k.kind} role="tab" aria-selected={kind === k.kind} onClick={() => { setKind(k.kind); setTarget('') }}
            className={`flex-1 rounded-md border px-1.5 py-1 text-[11px] ${kind === k.kind ? 'border-text bg-text font-semibold text-bg' : 'border-line-2 text-muted hover:text-text'}`}>
            {k.label}
          </button>
        ))}
      </div>
      <p className="text-[11px] leading-snug text-muted">{hint}</p>
      <select className={`${input} w-full`} aria-label="Đối tượng" value={target} onChange={(e) => setTarget(e.target.value)}>
        <option value="">{kind === 'lane_block' ? 'Chọn làn…' : kind === 'machine_down' ? 'Chọn máy…' : 'Chọn kho…'}</option>
        {kind === 'machine_down' && machines.map((n) => <option key={n.key} value={n.key}>{n.name}</option>)}
        {kind === 'stock_drain' && stores.map((n) => <option key={n.key} value={n.key}>{n.name}</option>)}
        {kind === 'lane_block' && lanes.map((l) => <option key={l.id} value={l.id}>Làn {l.id} ({l.from} → {l.to})</option>)}
      </select>
      {kind === 'lane_block' && lanes.length === 0 && <p className="text-[11px] text-warn">Mô hình chưa có bản đồ AGV. Chạy scripts/seed_demo.py hoặc vẽ ở tab Bản đồ AGV.</p>}
      {kind === 'stock_drain' ? (
        <div className="grid grid-cols-2 gap-2">
          <select className={input} aria-label="Vật tư" value={effMaterial} onChange={(e) => setMaterial(e.target.value)} disabled={storeMaterials.length === 0}>
            {storeMaterials.length === 0 && <option value="">Vật tư</option>}
            {storeMaterials.map((m) => <option key={m} value={m}>{m}</option>)}
          </select>
          <select className={input} aria-label="Tỉ lệ rút" value={fraction} onChange={(e) => setFraction(Number(e.target.value))}>
            {[30, 50, 80, 100].map((f) => <option key={f} value={f}>Rút {f}% tồn</option>)}
          </select>
        </div>
      ) : (
        <select className={`${input} w-full`} aria-label="Thời lượng" value={minutes} onChange={(e) => setMinutes(Number(e.target.value))}>
          {DURATIONS.map((d) => <option key={d} value={d}>{d >= 60 ? `${d / 60} giờ` : `${d} phút`} (giờ nhà máy)</option>)}
        </select>
      )}
      <button className={`${btnWarn} w-full justify-center`} disabled={!canGo || add.isPending} onClick={go}>Bơm sự cố</button>
      {!ready && <p className="text-[11px] text-faint">Bật feed để bơm sự cố.</p>}
      <ErrorBox error={add.error ?? clear.error} />
      {active.length > 0 && (
        <div className="space-y-1 border-t border-line pt-2">
          <div className="text-[11px] font-semibold text-text-2">Đang hiệu lực</div>
          {active.map((i) => (
            <div key={i.id} className="flex items-center gap-2 rounded-md border border-line px-2 py-1.5">
              <span className="min-w-0 flex-1 text-[11.5px] text-text">
                {label(i.kind)}: <b>{i.kind === 'lane_block' ? `làn ${i.target}` : nameOf(i.target)}</b>
                <span className="block text-[10.5px] text-muted">đến {fmtFactoryTime(i.until)}</span>
              </span>
              <button className={btn} disabled={clear.isPending} onClick={() => clear.mutate(i.id)}>Gỡ</button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

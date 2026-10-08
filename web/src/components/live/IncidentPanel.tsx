import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Ban, Check, PackageMinus, Route, Wrench, X, type LucideIcon } from 'lucide-react'
import { useState } from 'react'
import { api } from '../../api/client'
import type { Incident, IncidentInput, MapLane } from '../../api/types'
import { fmtFactoryTime } from '../../lib/liveFormat'
import { ItemIdentity, NodeIdentity } from '../NodeIdentity'
import { ErrorBox, SearchBox, btn, btnWarn } from '../ui'

export type IncidentNode = { key: string; name: string; archetype: string; materials: string[]; icon?: string }

const KINDS: { kind: Incident['kind']; label: string; icon: LucideIcon; hint: string }[] = [
  { kind: 'machine_down', label: 'Máy hỏng', icon: Wrench, hint: 'Máy dừng: kho trước đầy lên, kho sau cạn dần.' },
  { kind: 'lane_block', label: 'Chặn làn', icon: Ban, hint: 'Xe đi đường vòng, hết đường thì chờ.' },
  { kind: 'stock_drain', label: 'Rút kho', icon: PackageMinus, hint: 'Rút bớt tồn (kiểm kê lệch, hàng lỗi).' },
]
const DURATIONS = [10, 30, 120, 480]
const FRACTIONS = [30, 50, 80, 100]

const kindOf = (kind: Incident['kind']) => KINDS.find((k) => k.kind === kind)

/** Nhóm nút chọn một: thay cho ô chọn của trình duyệt khi chỉ có vài lựa chọn. */
function Segmented<T extends string | number>({ label, value, options, onChange }: { label: string; value: T; options: { v: T; text: string }[]; onChange: (v: T) => void }) {
  return (
    <div role="radiogroup" aria-label={label} className="flex gap-1 rounded-lg bg-panel-2 p-0.5">
      {options.map((o) => (
        <button key={String(o.v)} type="button" role="radio" aria-checked={value === o.v} onClick={() => onChange(o.v)}
          className={`flex-1 rounded-md px-1.5 py-1 text-[11px] tabular-nums ${value === o.v ? 'bg-raised font-semibold text-text shadow-sm' : 'text-muted hover:text-text'}`}>
          {o.text}
        </button>
      ))}
    </div>
  )
}

/** Bảng bơm sự cố cho demo: chọn loại, chọn đối tượng trong danh sách có biểu tượng, chọn thời lượng; dưới là sự cố còn hiệu lực. */
export function IncidentPanel({ model, nodes, lanes, incidents, ready }: { /** Mô hình có feed nhận sự cố này */ model: string; nodes: IncidentNode[]; lanes: MapLane[]; incidents: Incident[]; ready: boolean }) {
  const qc = useQueryClient()
  const [kind, setKind] = useState<Incident['kind']>('machine_down')
  const [target, setTarget] = useState('')
  const [q, setQ] = useState('')
  const [minutes, setMinutes] = useState(30)
  const [material, setMaterial] = useState('')
  const [fraction, setFraction] = useState(80)
  const refresh = () => void qc.invalidateQueries({ queryKey: ['feed-status', model] })
  const add = useMutation({ mutationFn: (b: IncidentInput) => api.feed.addIncident(b), onSuccess: () => { refresh(); setTarget('') } })
  const clear = useMutation({ mutationFn: (id: number) => api.feed.clearIncident(model, id), onSuccess: refresh })

  const machines = nodes.filter((n) => n.archetype === 'PROCESS')
  const stores = nodes.filter((n) => n.archetype === 'STORAGE' && n.materials.length > 0)
  const nodeOf = (key: string) => nodes.find((n) => n.key === key)
  const meta = kindOf(kind)!
  const storeMaterials = stores.find((n) => n.key === target)?.materials ?? []
  const effMaterial = storeMaterials.includes(material) ? material : storeMaterials[0] ?? ''
  const canGo = ready && target !== '' && (kind !== 'stock_drain' || effMaterial !== '')
  const go = () => {
    const body: IncidentInput = { model, kind, target }
    if (kind !== 'stock_drain') body.duration_s = minutes * 60
    else { body.material = effMaterial; body.fraction = fraction / 100 }
    add.mutate(body)
  }
  const active = incidents.filter((i) => i.active)
  const needle = q.trim().toLowerCase()
  const match = (...t: string[]) => needle === '' || t.some((x) => x.toLowerCase().includes(needle))
  const options = kind === 'lane_block'
    ? lanes.filter((l) => match(l.id, l.from, l.to)).map((l) => ({ key: l.id, body: <ItemIdentity icon={Route} name={`Làn ${l.id}`} code={`${l.from} → ${l.to}`} color="var(--color-muted)" size={26} /> }))
    : (kind === 'machine_down' ? machines : stores).filter((n) => match(n.key, n.name)).map((n) => ({ key: n.key, body: <NodeIdentity name={n.name} code={n.key} icon={n.icon} archetype={n.archetype} size={26} /> }))
  const total = kind === 'lane_block' ? lanes.length : kind === 'machine_down' ? machines.length : stores.length

  return (
    <div className="space-y-2.5 text-xs">
      <Segmented label="Loại sự cố" value={kind} onChange={(k) => { setKind(k); setTarget(''); setQ('') }}
        options={KINDS.map((k) => ({ v: k.kind, text: k.label }))} />
      <p className="flex items-center gap-1.5 text-[11px] text-muted"><meta.icon size={12} className="flex-none" aria-hidden />{meta.hint}</p>
      {total > 6 && <SearchBox value={q} onChange={setQ} placeholder={kind === 'lane_block' ? 'Tìm làn' : 'Tìm theo tên hoặc mã'} className="w-full" />}
      <ul role="listbox" aria-label="Đối tượng" className="-mx-1 max-h-48 overflow-auto">
        {options.map((o) => (
          <li key={o.key} role="option" aria-selected={target === o.key}>
            <button type="button" onClick={() => setTarget(target === o.key ? '' : o.key)}
              className={`flex w-full items-center rounded-lg px-1.5 py-1 text-left ${target === o.key ? 'bg-raised ring-1 ring-warn/70' : 'hover:bg-panel-2'}`}>
              {o.body}
              {target === o.key && <Check size={14} className="ml-2 flex-none text-warn" aria-hidden />}
            </button>
          </li>
        ))}
        {total === 0 && (
          <li className="px-1.5 py-2 text-[11px] text-muted">
            {kind === 'lane_block' ? 'Mô hình chưa có bản đồ AGV: vẽ ở tab Bản đồ AGV.' : kind === 'machine_down' ? 'Sơ đồ không có máy nào.' : 'Không có kho nào khai báo vật tư.'}
          </li>
        )}
        {total > 0 && options.length === 0 && <li className="px-1.5 py-2 text-[11px] text-muted">Không có gì khớp "{q}".</li>}
      </ul>
      {kind === 'stock_drain' ? (
        <>
          {storeMaterials.length > 1 && <Segmented label="Vật tư" value={effMaterial} onChange={setMaterial} options={storeMaterials.map((m) => ({ v: m, text: m }))} />}
          <Segmented label="Tỉ lệ rút" value={fraction} onChange={setFraction} options={FRACTIONS.map((f) => ({ v: f, text: `${f}%` }))} />
        </>
      ) : (
        <Segmented label="Thời lượng (giờ nhà máy)" value={minutes} onChange={setMinutes}
          options={DURATIONS.map((d) => ({ v: d, text: d >= 60 ? `${d / 60} giờ` : `${d} phút` }))} />
      )}
      <button className={`${btnWarn} w-full justify-center`} disabled={!canGo || add.isPending} onClick={go}>
        <meta.icon size={13} aria-hidden />Bơm sự cố
      </button>
      {!ready && <p className="text-center text-[11px] text-faint">Bật feed để bơm sự cố.</p>}
      <ErrorBox error={add.error ?? clear.error} />
      {active.length > 0 && (
        <div className="space-y-1 border-t border-line pt-2.5">
          <div className="text-[11px] font-semibold text-text-2">Đang hiệu lực <span className="font-normal text-muted">{active.length}</span></div>
          {active.map((i) => {
            const k = kindOf(i.kind)
            const Icon = k?.icon ?? Wrench
            const n = nodeOf(i.target)
            return (
              <div key={i.id} className="flex items-center gap-2 rounded-lg bg-warn/8 px-2 py-1.5">
                <span className="flex h-7 w-7 flex-none items-center justify-center rounded-full bg-warn/15 text-warn" aria-hidden><Icon size={13} /></span>
                <span className="min-w-0 flex-1 leading-tight">
                  <span className="block truncate text-[11.5px] font-medium text-text">{i.kind === 'lane_block' ? `Làn ${i.target}` : n?.name ?? i.target}</span>
                  <span className="block text-[10.5px] text-muted">{k?.label ?? i.kind}, đến {fmtFactoryTime(i.until)}</span>
                </span>
                <button className={`${btn} !px-2`} disabled={clear.isPending} onClick={() => clear.mutate(i.id)} aria-label="Gỡ sự cố"><X size={12} aria-hidden />Gỡ</button>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

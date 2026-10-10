import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import type { GaugeReading } from '../api/gauge'
import { gaugeConfigApi } from '../api/gaugeConfig'
import { ActionError, GaugeArea } from '../components/gauge/GaugeArea'
import { AccuracyPanel } from '../components/gauge/AccuracyPanel'
import { RoiPhoto } from '../components/gauge/RoiPhoto'
import { btn, btnAccentOutline, btnDangerOutline, FilterChip, input, Loading } from '../components/ui'
import { removeGauge } from '../lib/gaugeCommission'
import {
  cameraOfRow, countStates, inventory, STATE_LABEL, TYPE_LABEL, type CandidateRow, type DeclaredRow, type InventoryState,
} from '../lib/gaugeDiscovery'
import { ageLabel, unitLabel } from '../lib/gaugeView'

const STATES: InventoryState[] = ['pending', 'reading', 'lost', 'ignored']

const STATE_HINT: Record<InventoryState, string> = {
  pending: 'AI vừa phát hiện trên camera, ở chỗ chưa khai báo đồng hồ nào. Kiểm tra vùng khoanh rồi gán vào máy, hoặc bỏ qua nếu không phải đồng hồ cần đo.',
  reading: 'Đồng hồ đã gán vào máy; edge đang đọc và gửi số.',
  lost: 'AI từng thấy đồng hồ này nhưng các lần quét gần đây không còn thấy: có thể bị tháo, bị che, hoặc camera đã xoay. Mở camera để kiểm tra.',
  ignored: 'Những chỗ đã đánh dấu không phải đồng hồ cần đo. AI không đề xuất lại; khôi phục nếu bấm nhầm.',
}

const thumb = 'relative h-16 w-20 flex-none overflow-hidden rounded-md bg-raised'

function CandidateLine({ row, cameraName }: { row: CandidateRow; cameraName: string }) {
  const qc = useQueryClient()
  const c = row.candidate
  const act = useMutation({
    mutationFn: () => (row.state === 'pending' ? gaugeConfigApi.ignoreCandidate(c.candidate_id) : gaugeConfigApi.restoreCandidate(c.candidate_id)),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['gauge-config', 'candidates'] }),
  })
  const now = Date.now()
  return (
    <li className="flex flex-wrap items-center gap-3 px-3 py-2.5">
      <div className={thumb}>
        {c.crop_jpeg
          ? <img src={`data:image/jpeg;base64,${c.crop_jpeg}`} alt="Vùng AI phát hiện" className={`absolute inset-0 h-full w-full object-contain ${row.state === 'ignored' ? 'opacity-50 grayscale' : ''}`} />
          : <span className="absolute inset-0 flex items-center justify-center text-[10px] text-faint">không có ảnh</span>}
      </div>
      <div className="min-w-0 flex-1">
        <p className="flex flex-wrap items-center gap-2 text-[13px] font-semibold text-text">
          {row.state === 'pending' && <span className="rounded border border-dashed border-warn px-1.5 text-[11px] font-semibold text-warn">Mới</span>}
          {TYPE_LABEL[c.type] ?? c.type}
          <span className="text-xs font-normal text-muted">AI tin {Math.round(c.score * 100)}%</span>
        </p>
        <p className="text-xs text-text-2">{cameraName} <span className="text-muted">· vùng {c.roi.join(', ')}</span></p>
        <p className="text-xs text-muted">thấy {c.seen} lần quét, gần nhất {ageLabel(c.last_seen, now)}</p>
      </div>
      <div className="flex flex-wrap gap-2">
        {row.state === 'pending' && (
          <Link to={`/gauge-twin/cameras/${encodeURIComponent(c.camera_id)}?candidate=${c.candidate_id}`} className={btnAccentOutline}>Kiểm tra và gán</Link>
        )}
        <button className={btn} disabled={act.isPending} onClick={() => act.mutate()}>{row.state === 'pending' ? 'Không phải đồng hồ cần đo' : 'Khôi phục'}</button>
      </div>
      <div className="basis-full empty:hidden"><ActionError error={act.error} /></div>
    </li>
  )
}

function DeclaredLine({ row, cameraName }: { row: DeclaredRow; cameraName: string }) {
  const qc = useQueryClient()
  const stations = useQuery({ queryKey: ['gauge-config', 'stations'], queryFn: gaugeConfigApi.stations })
  const remove = useMutation({
    mutationFn: () => {
      const station = stations.data!.find((s) => s.machine_id === row.machine_id)!
      return gaugeConfigApi.putStation(removeGauge(station.config, row.gauge.gauge_id))
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['gauge-config'] }),
  })
  const g = row.gauge
  const reading = { gauge_id: g.gauge_id, type: g.type, roi: g.roi, camera_id: g.camera_id ?? '' } as GaugeReading
  const sight = row.sight
  const now = Date.now()
  const sightText = !sight || sight.state === 'unscanned' ? 'camera chưa được AI quét'
    : sight.state === 'never' ? 'AI chưa nhận ra đồng hồ này (vẫn đọc bình thường)'
    : sight.state === 'lost' ? `AI thấy lần cuối ${ageLabel(sight.last_seen, now)}`
    : `AI vẫn thấy, quét ${ageLabel(sight.scanned_at, now)}`
  const edit = `/gauge-twin/cameras/${encodeURIComponent(row.camera_id)}?machine=${encodeURIComponent(row.machine_id)}&gauge=${encodeURIComponent(g.gauge_id)}`
  return (
    <li className="flex flex-wrap items-center gap-3 px-3 py-2.5">
      <div className={thumb}><RoiPhoto machine={row.machine_id} gauge={reading} aspect={20 / 16} dimmed={row.state === 'lost'} /></div>
      <div className="min-w-0 flex-1">
        <p className="flex flex-wrap items-center gap-2 text-[13px] font-semibold text-text">
          <Link to={`/gauge-twin/${encodeURIComponent(row.machine_id)}`} className="hover:underline">{row.machine_id}</Link>
          <span className="text-muted">·</span>{g.gauge_id}
        </p>
        <p className="text-xs text-text-2">{TYPE_LABEL[g.type] ?? g.type}{g.unit ? `, ${unitLabel(g.unit)}` : ''} · {cameraName}</p>
        <p className={`text-xs ${row.state === 'lost' ? 'text-warn' : 'text-muted'}`}>{sightText}</p>
      </div>
      <div className="flex flex-wrap gap-2">
        <Link to={edit} className={btnAccentOutline}>{row.state === 'lost' ? 'Mở camera kiểm tra' : 'Sửa vùng đọc'}</Link>
        <button className={btnDangerOutline} disabled={!stations.data || remove.isPending}
          onClick={() => { if (window.confirm(`Gỡ ${g.gauge_id} khỏi máy ${row.machine_id}? Lịch sử số liệu vẫn được giữ.`)) remove.mutate() }}>
          Gỡ khỏi máy
        </button>
      </div>
      <div className="basis-full empty:hidden"><ActionError error={remove.error} /></div>
    </li>
  )
}

/** Mọi đồng hồ ở một chỗ: chờ duyệt (AI vừa phát hiện), đang đọc, AI không còn thấy, đã bỏ qua. Lọc theo trạng thái và camera. */
export default function GaugeInventoryPage() {
  const stations = useQuery({ queryKey: ['gauge-config', 'stations'], queryFn: gaugeConfigApi.stations })
  const cameras = useQuery({ queryKey: ['gauge-config', 'cameras'], queryFn: gaugeConfigApi.cameras })
  const pending = useQuery({ queryKey: ['gauge-config', 'candidates', 'pending'], queryFn: () => gaugeConfigApi.candidates('pending'), refetchInterval: 30_000 })
  const ignored = useQuery({ queryKey: ['gauge-config', 'candidates', 'ignored'], queryFn: () => gaugeConfigApi.candidates('ignored') })
  const sights = useQuery({ queryKey: ['gauge-config', 'sightings'], queryFn: gaugeConfigApi.sightings, refetchInterval: 60_000 })
  const [state, setState] = useState<InventoryState | null>(null)
  const [camera, setCamera] = useState('')

  const rows = useMemo(
    () => inventory(stations.data ?? [], sights.data?.gauges ?? [], pending.data?.candidates ?? [], ignored.data?.candidates ?? []),
    [stations.data, sights.data, pending.data, ignored.data],
  )
  const onCamera = rows.filter((r) => camera === '' || cameraOfRow(r) === camera)
  const counts = countStates(onCamera)
  // Mặc định mở nhóm có việc cần làm.
  const shown: InventoryState = state ?? (counts.pending > 0 ? 'pending' : 'reading')
  const list = onCamera.filter((r) => r.state === shown)
  const names = new Map((cameras.data ?? []).map((c) => [c.camera_id, c.name || c.camera_id]))
  const nameOf = (id: string) => names.get(id) ?? (id || 'Camera chính')
  const lastScan = (sights.data?.scans ?? []).map((s) => s.scanned_at).sort().at(-1) ?? null

  if (stations.isPending) return <Loading />
  return (
    <GaugeArea>
      <header className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <h1 className="text-lg font-semibold text-text">Danh mục đồng hồ</h1>
        <span className="text-xs text-muted">
          {lastScan ? `AI quét camera lần gần nhất ${ageLabel(lastScan, Date.now())}` : 'AI chưa quét camera nào (dịch vụ discover-svc chưa chạy)'}
          {pending.data && `, đề xuất khi thấy ${pending.data.min_seen} lần quét liền`}
        </span>
        <label className="ml-auto flex items-center gap-2 text-xs text-muted">
          Camera
          <select value={camera} onChange={(e) => setCamera(e.target.value)} className={input}>
            <option value="">Tất cả</option>
            {(cameras.data ?? []).map((c) => <option key={c.camera_id} value={c.camera_id}>{c.name || c.camera_id}</option>)}
          </select>
        </label>
      </header>

      <div className="flex flex-wrap gap-1.5" role="group" aria-label="Lọc theo trạng thái">
        {STATES.map((s) => <FilterChip key={s} active={shown === s} onClick={() => setState(s)}>{STATE_LABEL[s]} {counts[s]}</FilterChip>)}
      </div>
      <p className="text-xs text-text-2">{STATE_HINT[shown]}</p>
      <ActionError error={stations.error ?? pending.error ?? sights.error} />

      <AccuracyPanel />
      <ul className="divide-y divide-line overflow-hidden rounded-lg border border-line bg-panel-2">
        {list.length === 0 && <li className="px-3 py-6 text-center text-xs text-muted">Không có đồng hồ nào ở nhóm “{STATE_LABEL[shown]}”.</li>}
        {list.map((r) => r.kind === 'candidate'
          ? <CandidateLine key={`c${r.candidate.candidate_id}`} row={r} cameraName={nameOf(r.candidate.camera_id)} />
          : <DeclaredLine key={`${r.machine_id}/${r.gauge.gauge_id}`} row={r} cameraName={nameOf(r.camera_id)} />)}
      </ul>
    </GaugeArea>
  )
}


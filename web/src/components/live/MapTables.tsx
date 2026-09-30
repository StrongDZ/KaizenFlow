import { useMemo, useState } from 'react'
import type { AgvMap } from '../../api/types'
import { filterLaneRows, filterPointRows, laneRows, pointRows } from '../../lib/mapTables'
import type { Occupancy } from '../../lib/mapGeom'
import { SearchBox } from '../ui'
import type { MapSelection } from './AgvMapCanvas'

/** Điểm và làn của bản đồ AGV dạng bảng có tìm kiếm: bấm một dòng để chọn đúng điểm hoặc làn đó trên bản đồ (khỏi dò từng chấm). */
export function MapTables({ map, names, occ, blocked, selected, onSelect }: {
  map: AgvMap; names: Record<string, string>; occ: Map<string, Occupancy>; blocked: Set<string>; selected: MapSelection; onSelect: (s: MapSelection) => void
}) {
  const [tab, setTab] = useState<'point' | 'lane'>('lane')
  const [q, setQ] = useState('')
  const points = useMemo(() => filterPointRows(pointRows(map, names), q), [map, names, q])
  const lanes = useMemo(() => filterLaneRows(laneRows(map, names, occ, blocked), q), [map, names, occ, blocked, q])
  const th = 'border-b border-line px-2 py-1.5 text-left text-[11px] font-medium text-muted'
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-4">
        <div role="tablist" aria-label="Điểm hoặc làn" className="flex gap-5 border-b border-line">
          {([['lane', `Làn (${map.lanes.length})`], ['point', `Điểm (${map.points.length})`]] as const).map(([t, label]) => (
            <button key={t} role="tab" aria-selected={tab === t} onClick={() => setTab(t)}
              className={`-mb-px border-b-2 pb-1.5 text-xs font-medium ${tab === t ? 'border-text font-semibold text-text' : 'border-transparent text-muted hover:text-text'}`}>{label}</button>
          ))}
        </div>
        <div className="ml-auto"><SearchBox value={q} onChange={setQ} placeholder={tab === 'lane' ? 'Tìm làn theo mã, điểm, trạng thái' : 'Tìm điểm theo mã, loại, node'} /></div>
      </div>
      <div className="max-h-72 overflow-auto rounded-lg border border-line">
        {tab === 'lane' ? (
          <table className="w-full border-collapse text-xs">
            <thead className="sticky top-0 bg-panel"><tr><th className={th}>Mã làn</th><th className={th}>Từ</th><th className={th}>Đến</th><th className={`${th} text-right`}>Dài (m)</th><th className={`${th} text-right`}>Sức chứa</th><th className={th}>Trạng thái</th></tr></thead>
            <tbody>
              {lanes.map((r) => (
                <tr key={r.id} tabIndex={0} aria-selected={selected?.kind === 'lane' && selected.id === r.id}
                  onClick={() => onSelect({ kind: 'lane', id: r.id })} onKeyDown={(e) => { if (e.key === 'Enter') onSelect({ kind: 'lane', id: r.id }) }}
                  className={`cursor-pointer border-b border-line/60 last:border-0 hover:bg-panel ${selected?.kind === 'lane' && selected.id === r.id ? 'bg-panel' : ''}`}>
                  <td className="px-2 py-1.5 font-mono text-[11px] text-text">{r.id}</td><td className="px-2 py-1.5">{r.from}</td><td className="px-2 py-1.5">{r.to}</td>
                  <td className="px-2 py-1.5 text-right tabular-nums">{Math.round(r.lengthM)}</td><td className="px-2 py-1.5 text-right tabular-nums">{r.capacity}</td>
                  <td className={`px-2 py-1.5 ${r.status === 'Đang bị chặn' || r.status === 'Có xe chờ' ? 'text-bad-text' : r.status === 'Đầy chỗ' ? 'text-lock-text' : 'text-muted'}`}>{r.status}</td>
                </tr>
              ))}
              {lanes.length === 0 && <tr><td colSpan={6} className="px-2 py-4 text-center text-muted">Không có làn nào khớp.</td></tr>}
            </tbody>
          </table>
        ) : (
          <table className="w-full border-collapse text-xs">
            <thead className="sticky top-0 bg-panel"><tr><th className={th}>Mã điểm</th><th className={th}>Loại</th><th className={th}>Node gắn</th><th className={`${th} text-right`}>Số làn</th><th className={`${th} text-right`}>Toạ độ</th></tr></thead>
            <tbody>
              {points.map((r) => (
                <tr key={r.id} tabIndex={0} aria-selected={selected?.kind === 'point' && selected.id === r.id}
                  onClick={() => onSelect({ kind: 'point', id: r.id })} onKeyDown={(e) => { if (e.key === 'Enter') onSelect({ kind: 'point', id: r.id }) }}
                  className={`cursor-pointer border-b border-line/60 last:border-0 hover:bg-panel ${selected?.kind === 'point' && selected.id === r.id ? 'bg-panel' : ''}`}>
                  <td className="px-2 py-1.5 font-mono text-[11px] text-text">{r.id}</td><td className="px-2 py-1.5">{r.kind}</td>
                  <td className={`px-2 py-1.5 ${r.node === 'chưa gắn' ? 'text-lock-text' : ''}`}>{r.node || '—'}</td>
                  <td className="px-2 py-1.5 text-right tabular-nums">{r.lanes}</td><td className="px-2 py-1.5 text-right tabular-nums text-muted">{Math.round(r.x)}, {Math.round(r.y)}</td>
                </tr>
              ))}
              {points.length === 0 && <tr><td colSpan={5} className="px-2 py-4 text-center text-muted">Không có điểm nào khớp.</td></tr>}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}

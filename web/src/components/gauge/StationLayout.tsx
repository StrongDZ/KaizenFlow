import { useQuery } from '@tanstack/react-query'
import { Outlet, useParams } from 'react-router-dom'
import { gaugeApi } from '../../api/gauge'
import { kindLabel, lineKey, stationKind } from '../../lib/gaugeView'
import { TabBar } from '../shell/TabBar'
import { toneOf } from './tone'

/** Khung của một trạm: tab Trực tiếp / Lịch sử ngay dưới header, bên phải là trạng thái, dây chuyền, edge và phiên bản config. */
export default function StationLayout() {
  const machine = useParams().machine ?? ''
  const base = `/gauge-twin/${encodeURIComponent(machine)}`
  const q = useQuery({ queryKey: ['gauge', 'station', machine], queryFn: () => gaugeApi.station(machine), refetchInterval: 2000 })
  const s = q.data
  const kind = s ? stationKind(s) : undefined
  return (
    <div className="flex h-full min-h-0 flex-col">
      <TabBar
        label={`Trạm ${machine}`}
        tabs={[{ label: 'Trực tiếp', to: base, end: true }, { label: 'Lịch sử', to: `${base}/history` }]}
        end={s && kind && (
          <span className="flex min-w-0 items-center gap-3 text-[11px] text-muted">
            <span className={`inline-flex items-center gap-1.5 rounded-[5px] border px-1.5 py-px ${toneOf(kind).tag}`}>
              <i className={`h-1.5 w-1.5 rounded-full ${toneOf(kind).dot}`} aria-hidden />{kindLabel(kind)}
            </span>
            <span className="hidden truncate lg:inline">
              {lineKey(s)}, edge {s.edge ? `${s.edge.edge_id} (${s.edge.status === 'online' ? 'đang kết nối' : s.edge.status})` : 'chưa có'}, config v{s.config_version}
            </span>
          </span>
        )}
      />
      <div className="min-h-0 flex-1 overflow-auto">
        <Outlet />
      </div>
    </div>
  )
}

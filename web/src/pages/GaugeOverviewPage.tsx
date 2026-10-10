import { useQuery } from '@tanstack/react-query'
import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { gaugeApi } from '../api/gauge'
import { gaugeConfigApi } from '../api/gaugeConfig'
import { AlertList, AlertToggle } from '../components/gauge/AlertList'
import { ApiDownBanner, GaugeArea, GaugeSetupSteps } from '../components/gauge/GaugeArea'
import { STATION_GRID, StationRow } from '../components/gauge/StationRow'
import { FilterChip, Loading, input } from '../components/ui'
import {
  countKinds, defaultLine, filterStations, kindLabel, linesOf, needsAttention, sortStations, stationKind, type StationKind,
} from '../lib/gaugeView'

const FILTERS: StationKind[] = ['alarm', 'poor', 'stale', 'lost', 'ok']

/** Danh sách trạm của một dây chuyền: trạm cần người xem đứng đầu, mỗi dòng nói nên kiểm tra gì. */
export default function GaugeOverviewPage() {
  const q = useQuery({ queryKey: ['gauge', 'stations'], queryFn: gaugeApi.stations, refetchInterval: 2000 })
  const all = useMemo(() => q.data ?? [], [q.data])
  // null: chưa chọn, dùng dây chuyền đang có nhiều trạm gửi dữ liệu nhất.
  const [picked, setPicked] = useState<string | null>(null)
  const [kind, setKind] = useState<StationKind | 'all'>('all')
  const [alertsOpen, setAlertsOpen] = useState(false)
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 5000)
    return () => clearInterval(t)
  }, [])

  const lines = useMemo(() => linesOf(all), [all])
  const line = picked ?? defaultLine(all)
  const inLine = useMemo(() => filterStations(all, line, 'all'), [all, line])
  const counts = useMemo(() => countKinds(inLine), [inLine])
  const shown = useMemo(() => sortStations(filterStations(inLine, '', kind)), [inLine, kind])
  // Trạm chưa từng gửi dữ liệu không phải việc của người trực ca: gom xuống cuối, mở ra khi cần.
  const rows = shown.filter((s) => stationKind(s) !== 'idle')
  const idle = kind === 'all' ? shown.filter((s) => stationKind(s) === 'idle') : []
  const attention = inLine.filter((s) => needsAttention(stationKind(s))).length
  const reporting = inLine.length - counts.idle
  // Chưa có trạm nào báo về: cho biết đang ở bước nào của ba bước thiết lập.
  const cameras = useQuery({ queryKey: ['gauge-config', 'cameras'], queryFn: gaugeConfigApi.cameras, enabled: q.isSuccess && reporting === 0, retry: false })
  const setupDone = all.length > 0 ? 2 : (cameras.data?.length ?? 0) > 0 ? 1 : 0
  const pending = useQuery({ queryKey: ['gauge-config', 'candidates', 'pending'], queryFn: () => gaugeConfigApi.candidates('pending'), refetchInterval: 30_000, retry: false })
  const newGauges = pending.data?.candidates.length ?? 0

  if (q.isPending) return <Loading />
  if (!q.data) {
    return (
      <GaugeArea>
        <h1 className="text-lg font-semibold text-text">Trạm đọc đồng hồ</h1>
        <ApiDownBanner error={q.error} />
      </GaugeArea>
    )
  }

  return (
    <GaugeArea>
      {q.isError && <ApiDownBanner error={q.error} />}
      <header className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <h1 className="text-lg font-semibold text-text">
          {reporting === 0 ? 'Chưa trạm nào gửi số đọc' : attention === 0 ? `${reporting} trạm đều bình thường` : `${attention} trạm cần xem`}
        </h1>
        {reporting > 0 && <span className="text-xs text-muted">trên {reporting} trạm đang gửi số đọc</span>}
        {lines.length > 1 && (
          <label className="ml-auto flex items-center gap-2 text-xs text-muted">
            Dây chuyền
            <select value={line} onChange={(e) => setPicked(e.target.value)} className={input}>
              <option value="">Tất cả</option>
              {lines.map((l) => <option key={l} value={l}>{l}</option>)}
            </select>
          </label>
        )}
      </header>

      {reporting === 0 ? (
        <GaugeSetupSteps done={setupDone} />
      ) : (
        <>
          {/* Một hàng: lọc theo trạng thái bên trái; sự cố và đồng hồ mới thu thành hai mục nhỏ bên phải. */}
          <div className="flex flex-wrap items-center gap-1.5">
            <div className="flex flex-wrap gap-1.5" role="group" aria-label="Lọc theo trạng thái">
              <FilterChip active={kind === 'all'} onClick={() => setKind('all')}>Tất cả {reporting}</FilterChip>
              {FILTERS.filter((k) => counts[k] > 0 || kind === k).map((k) => (
                <FilterChip key={k} active={kind === k} onClick={() => setKind(k)}>{kindLabel(k)} {counts[k]}</FilterChip>
              ))}
            </div>
            <span className="ml-auto flex flex-wrap items-center gap-1.5">
              <AlertToggle open={alertsOpen} onToggle={() => setAlertsOpen((v) => !v)} />
              {newGauges > 0 && (
                <Link to="/gauge-twin/gauges" className="inline-flex items-center gap-1.5 rounded-md border border-line-2 px-2.5 py-1 text-xs text-text-2 hover:bg-panel">
                  <span className="font-semibold text-warn">Mới</span>{newGauges} đồng hồ chưa khai báo
                </Link>
              )}
            </span>
          </div>
          {alertsOpen && <AlertList />}
          <section className="overflow-hidden rounded-lg border border-line bg-panel-2">
            <div className={`${STATION_GRID} border-b border-line px-3 py-1.5 text-[11px] text-muted`}>
              <span>Trạng thái</span><span>Trạm</span><span>Số đọc mới nhất</span><span className="text-right">Cập nhật</span><span />
            </div>
            {rows.length > 0
              ? rows.map((s) => <StationRow key={s.machine_id} station={s} now={now} showLine={line === ''} />)
              : <p className="px-3 py-6 text-center text-xs text-muted">Không có trạm nào ở trạng thái “{kind === 'all' ? '' : kindLabel(kind)}”.</p>}
          </section>
        </>
      )}

      {idle.length > 0 && (
        <details className="rounded-lg border border-line px-3 py-2 text-xs">
          <summary className="cursor-pointer text-text-2">{idle.length} trạm đã có config nhưng edge chưa gửi số đọc nào</summary>
          <ul className="flex flex-wrap gap-x-4 gap-y-1.5 pb-1 pt-2">
            {idle.map((s) => (
              <li key={s.machine_id}>
                <Link to={`/gauge-twin/${encodeURIComponent(s.machine_id)}`} className="text-muted underline decoration-dotted hover:text-text">{s.machine_id}</Link>
              </li>
            ))}
          </ul>
        </details>
      )}
    </GaugeArea>
  )
}

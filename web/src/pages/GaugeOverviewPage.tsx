import { useQuery } from '@tanstack/react-query'
import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { gaugeApi } from '../api/gauge'
import { ApiDownBanner, GaugeArea } from '../components/gauge/GaugeArea'
import { DEVICE_PHOTOS } from '../components/gauge/devicePhotos'
import { StationCard } from '../components/gauge/StationCard'
import {
  countKinds, defaultLine, filterStations, kindLabel, linesOf, needsAttention, sortStations, stationKind, type StationKind,
} from '../lib/gaugeView'

const FILTERS: StationKind[] = ['alarm', 'poor', 'stale', 'lost', 'ok']

function Chip({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      aria-pressed={active}
      className={`min-h-11 rounded-full border px-4 text-sm ${active ? 'border-accent font-bold text-text' : 'border-line-2 text-text-2 hover:border-muted'}`}
    >
      {children}
    </button>
  )
}

/** Tầng ngoài: cả dây chuyền trên một trang, trạm cần người xem đứng đầu. */
export default function GaugeOverviewPage() {
  const q = useQuery({ queryKey: ['gauge', 'stations'], queryFn: gaugeApi.stations, refetchInterval: 2000 })
  const all = useMemo(() => q.data ?? [], [q.data])
  // null: chưa chọn, dùng dây chuyền đang có nhiều trạm gửi dữ liệu nhất.
  const [picked, setPicked] = useState<string | null>(null)
  const [kind, setKind] = useState<StationKind | 'all'>('all')

  const lines = useMemo(() => linesOf(all), [all])
  const line = picked ?? defaultLine(all)
  const inLine = useMemo(() => filterStations(all, line, 'all'), [all, line])
  const counts = useMemo(() => countKinds(inLine), [inLine])
  const shown = useMemo(() => sortStations(filterStations(inLine, '', kind)), [inLine, kind])
  // Trạm chưa từng gửi dữ liệu không phải việc của người trực ca: gom xuống cuối, mở ra khi cần.
  const cards = shown.filter((s) => stationKind(s) !== 'idle')
  const idle = kind === 'all' ? shown.filter((s) => stationKind(s) === 'idle') : []
  const attention = inLine.filter((s) => needsAttention(stationKind(s))).length
  const reporting = inLine.length - counts.idle

  if (q.isPending) return <GaugeArea><p className="text-muted">Đang tải danh sách trạm…</p></GaugeArea>
  if (!q.data) return <GaugeArea><ApiDownBanner error={q.error} /></GaugeArea>

  return (
    <GaugeArea>
      {q.isError && <ApiDownBanner error={q.error} />}

      <div className="flex flex-wrap items-end gap-x-8 gap-y-3">
        <div>
          <label className="flex items-center gap-2 font-mono text-xs text-muted">
            Dây chuyền
            <select
              value={line}
              onChange={(e) => setPicked(e.target.value)}
              className="min-h-11 rounded-lg border border-line-2 bg-panel px-3 text-sm text-text"
            >
              <option value="">Tất cả</option>
              {lines.map((l) => <option key={l} value={l}>{l}</option>)}
            </select>
          </label>
          <h1 className="mt-2 text-4xl font-bold leading-tight tracking-tight">
            {reporting === 0 ? 'Chưa trạm nào gửi dữ liệu' : attention === 0 ? `${reporting} trạm đều bình thường` : `${attention} trạm cần bạn xem`}
          </h1>
        </div>
        <div className="ml-auto flex flex-wrap gap-2">
          <Chip active={kind === 'all'} onClick={() => setKind('all')}>Tất cả · {reporting}</Chip>
          {FILTERS.map((k) => (
            <Chip key={k} active={kind === k} onClick={() => setKind(k)}>{kindLabel(k)} · {counts[k]}</Chip>
          ))}
        </div>
      </div>

      {cards.length > 0 ? (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(320px,1fr))] gap-4">
          {cards.map((s) => <StationCard key={s.machine_id} station={s} />)}
        </div>
      ) : (
        <p className="rounded-xl bg-panel px-5 py-8 text-center text-muted">
          {kind === 'all' ? 'Dây chuyền này chưa có trạm nào gửi dữ liệu.' : `Không có trạm nào ở trạng thái “${kindLabel(kind)}”.`}
        </p>
      )}

      {idle.length > 0 && (
        <details className="rounded-xl bg-panel px-5 py-3">
          <summary className="flex min-h-11 cursor-pointer items-center text-sm text-text-2">
            {idle.length} trạm đã có config nhưng chưa gửi dữ liệu
          </summary>
          <ul className="flex flex-wrap gap-x-5 gap-y-2 pb-2 pt-1 font-mono text-xs">
            {idle.map((s) => (
              <li key={s.machine_id}>
                <Link to={`/gauge-twin/${encodeURIComponent(s.machine_id)}`} className="text-muted underline decoration-dotted hover:text-text">
                  {s.machine_id}
                </Link>
              </li>
            ))}
          </ul>
        </details>
      )}

      <p className="text-xs text-faint">
        Ảnh trên thẻ minh hoạ loại thiết bị, không phải ảnh chụp tại trạm; ảnh thật từ camera nằm ở trang chi tiết. Nguồn Wikimedia Commons:{' '}
        {DEVICE_PHOTOS.map((p, i) => (
          <span key={p.src}>
            {i > 0 && ' · '}
            <a href={p.page} target="_blank" rel="noreferrer" className="underline decoration-dotted hover:text-muted">{p.kind}</a> ({p.author}, {p.license})
          </span>
        ))}
      </p>
    </GaugeArea>
  )
}

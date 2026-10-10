import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { gaugeApi } from '../../api/gauge'
import { ageLabel } from '../../lib/gaugeView'

/** Sự cố đang mở (edge mất kết nối, máy im lặng, vượt ngưỡng, đọc không tin cậy kéo dài), nghiêm trọng trước.
    Thu gọn thành một nút nhỏ ở hàng lọc; bấm để xem danh sách ngay dưới. */
export function AlertToggle({ open, onToggle }: { open: boolean; onToggle: () => void }) {
  const q = useQuery({ queryKey: ['gauge', 'alerts'], queryFn: gaugeApi.alerts, refetchInterval: 15_000, retry: false })
  const alerts = q.data?.alerts ?? []
  if (alerts.length === 0) return null
  const critical = alerts.some((a) => a.severity === 'critical')
  return (
    <button onClick={onToggle} aria-expanded={open}
      className={`inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs hover:bg-panel ${critical ? 'border-bad/50 text-bad-text' : 'border-line-2 text-text-2'}`}>
      <i className={`h-1.5 w-1.5 rounded-full ${critical ? 'bg-bad' : 'bg-warn'}`} aria-hidden />
      {alerts.length} sự cố đang mở {open ? '▴' : '▾'}
    </button>
  )
}

export function AlertList() {
  const q = useQuery({ queryKey: ['gauge', 'alerts'], queryFn: gaugeApi.alerts, refetchInterval: 15_000, retry: false })
  const alerts = q.data?.alerts ?? []
  if (alerts.length === 0) return null
  const now = Date.now()
  return (
    <section aria-label="Sự cố đang mở" className="overflow-hidden rounded-lg border border-line bg-panel-2">
      {q.data?.webhook && q.data.webhook_error && (
        <p className="border-b border-line px-3 py-1.5 text-[11px] text-bad-text">Không gửi được cảnh báo ra ngoài: {q.data.webhook_error}</p>
      )}
      <ul>
        {alerts.map((a) => (
          <li key={a.key} className="flex items-center gap-2.5 border-t border-line px-3 py-1.5 text-xs first:border-t-0">
            <i className={`h-2 w-2 flex-none rounded-full ${a.severity === 'critical' ? 'bg-bad' : 'bg-warn'}`} aria-label={a.severity === 'critical' ? 'nghiêm trọng' : 'cảnh báo'} />
            {a.machine_id
              ? <Link to={`/gauge-twin/${encodeURIComponent(a.machine_id)}`} className="min-w-0 flex-1 truncate text-text hover:underline">{a.message}</Link>
              : <span className="min-w-0 flex-1 truncate text-text">{a.message}</span>}
            <span className="flex-none tabular-nums text-[11px] text-muted">từ {ageLabel(a.since, now)}</span>
          </li>
        ))}
      </ul>
    </section>
  )
}

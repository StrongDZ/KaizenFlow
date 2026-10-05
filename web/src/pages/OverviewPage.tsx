import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { api } from '../api/client'
import { Card, ErrorBox, Loading, PageBody, PageHeader, StatusChip, btn, btnPrimary } from '../components/ui'
import { fmtDateTime } from '../lib/format'
import { describeInsight } from '../lib/insights'

export default function OverviewPage() {
  const active = useQuery({ queryKey: ['runs', 'active'], queryFn: () => api.allRuns({ status: 'QUEUED,RUNNING', limit: 10 }) })
  const reds = useQuery({ queryKey: ['insights', 'red'], queryFn: () => api.insights({ kind: 'RED_RISK', limit: 5 }) })
  const models = useQuery({ queryKey: ['models'], queryFn: api.models })
  if (active.isLoading || reds.isLoading || models.isLoading) return <Loading />
  const recent = [...(models.data ?? [])]
    .sort((a, b) => (Date.parse(b.last_run_at ?? '') || 0) - (Date.parse(a.last_run_at ?? '') || 0))
    .slice(0, 5)
  const row = 'flex items-center justify-between gap-3 border-t border-line py-2 first:border-0 hover:text-text'
  return (
    <PageBody wide>
      <PageHeader
        title="Tổng quan"
        actions={
          <>
            <Link className={btn} to="/reports/warehouse">Điều khiển kho</Link>
            <Link className={btn} to="/reports/operations">Dashboard vận hành</Link>
            <Link className={btnPrimary} to="/reports/benchmarks">Benchmark FMCG</Link>
          </>
        }
      />
      <ErrorBox error={active.error ?? reds.error ?? models.error} />
      <div className="grid grid-cols-3 gap-4">
        <Card title="Đang chạy">
          {(active.data ?? []).length === 0 ? (
            <p className="text-xs text-muted">Không có lần chạy nào đang chạy.</p>
          ) : (
            (active.data ?? []).map((r) => (
              <Link key={r.id} to={`/runs/${r.id}`} className={row}>
                <span className="text-xs text-text">#{r.id} {r.model_key} v{r.version}<span className="block text-[11px] text-muted">{r.scenario_name}</span></span>
                <StatusChip status={r.status} />
              </Link>
            ))
          )}
        </Card>
        <Card title="Cảnh báo Đỏ mới nhất">
          {(reds.data ?? []).length === 0 ? (
            <p className="text-xs text-muted">Chưa có cảnh báo Đỏ nào.</p>
          ) : (
            (reds.data ?? []).map((i) => (
              <Link key={i.id} to={i.sim_run_id === null ? '/runs' : `/runs/${i.sim_run_id}`} className={row}>
                <span className="text-xs text-text">{describeInsight(i)}<span className="block text-[11px] text-muted">{i.model_key} v{i.version}, {i.scenario_name}</span></span>
              </Link>
            ))
          )}
        </Card>
        <Card title="Mô hình gần đây">
          {recent.length === 0 ? (
            <p className="text-xs text-muted">Chưa có mô hình nào. Tạo ở trang Mô hình.</p>
          ) : (
            recent.map((m) => (
              <Link key={m.model_key} to={`/versions/${m.latest_version_id}`} className={row}>
                <span className="text-xs text-text">{m.model_key} v{m.latest_version}<span className="block text-[11px] text-muted">{m.runs} lần chạy</span></span>
                <span className="text-[11px] text-muted">{fmtDateTime(m.last_run_at)}</span>
              </Link>
            ))
          )}
        </Card>
      </div>
    </PageBody>
  )
}

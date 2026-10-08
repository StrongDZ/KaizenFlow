import { useQuery } from '@tanstack/react-query'
import { Bell, Flame, LayoutGrid, Play, Radio, Workflow, type LucideIcon } from 'lucide-react'
import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { api } from '../api/client'
import { AlertKindIcon } from '../components/AlertKind'
import { Card, ErrorBox, Loading, PageBody, PageHeader, StatusChip, btn, btnPrimary } from '../components/ui'
import { useFeeds } from '../hooks/useLive'
import { fmtDateTime } from '../lib/format'
import { describeInsight } from '../lib/insights'

/** Một con số chính của cả hệ thống, bấm vào là tới chỗ xem chi tiết. */
function Stat({ icon: Icon, value, label, hint, to, tone = 'text-text' }: { icon: LucideIcon; value: ReactNode; label: string; hint?: string; to: string; tone?: string }) {
  return (
    <Link to={to} className="group flex items-center gap-3 rounded-xl border border-line bg-panel px-4 py-3 hover:border-line-2 hover:bg-raised">
      <span className="flex h-10 w-10 flex-none items-center justify-center rounded-lg bg-panel-2 text-muted group-hover:text-text" aria-hidden><Icon size={19} strokeWidth={1.7} /></span>
      <span className="min-w-0">
        <span className={`block text-xl font-semibold tabular-nums leading-tight ${tone}`}>{value}</span>
        <span className="block truncate text-[11.5px] text-muted">{label}{hint && <span className="text-faint">, {hint}</span>}</span>
      </span>
    </Link>
  )
}

/** Trạng thái trống nhỏ trong một thẻ. */
function Quiet({ icon: Icon, children }: { icon: LucideIcon; children: ReactNode }) {
  return (
    <div className="flex items-center gap-2.5 py-3 text-xs text-muted">
      <span className="flex h-8 w-8 flex-none items-center justify-center rounded-full bg-panel-2 text-faint" aria-hidden><Icon size={15} /></span>
      <span>{children}</span>
    </div>
  )
}

export default function OverviewPage() {
  const active = useQuery({ queryKey: ['runs', 'active'], queryFn: () => api.allRuns({ status: 'QUEUED,RUNNING', limit: 10 }) })
  const reds = useQuery({ queryKey: ['insights', 'red'], queryFn: () => api.insights({ kind: 'RED_RISK', limit: 5 }) })
  const alerts = useQuery({ queryKey: ['insights', 'all'], queryFn: () => api.insights({ limit: 500 }) })
  const models = useQuery({ queryKey: ['models'], queryFn: api.models })
  const feeds = useFeeds()
  if (active.isLoading || reds.isLoading || models.isLoading) return <Loading />
  const recent = [...(models.data ?? [])]
    .sort((a, b) => (Date.parse(b.last_run_at ?? '') || 0) - (Date.parse(a.last_run_at ?? '') || 0))
    .slice(0, 5)
  const live = new Set((feeds.data ?? []).filter((f) => f.state === 'running').map((f) => f.model ?? ''))
  const openAlerts = (alerts.data ?? []).filter((a) => a.status === 'OPEN')
  const openRed = openAlerts.filter((a) => a.kind === 'RED_RISK').length
  const row = 'flex items-center gap-3 border-t border-line py-2.5 first:border-0 hover:text-text'
  return (
    <PageBody wide>
      <PageHeader icon={LayoutGrid}
        title="Tổng quan"
        actions={
          <>
            <Link className={btn} to="/reports/operations">Dashboard vận hành</Link>
            <Link className={btnPrimary} to="/reports/benchmarks">Benchmark FMCG</Link>
          </>
        }
      />
      <ErrorBox error={active.error ?? reds.error ?? models.error} />
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat icon={Workflow} value={models.data?.length ?? 0} label="mô hình" to="/models" />
        <Stat icon={Radio} value={live.size} label="đang vận hành trực tiếp" to="/models" tone={live.size > 0 ? 'text-ok' : 'text-text'} />
        <Stat icon={Play} value={(active.data ?? []).length} label="lần chạy mô phỏng đang chạy" to="/runs" />
        <Stat icon={Bell} value={openAlerts.length} label="cảnh báo đang mở" hint={openRed > 0 ? `${openRed} sắp Đỏ` : undefined} to="/alerts" tone={openRed > 0 ? 'text-bad-text' : 'text-text'} />
      </div>
      <div className="grid gap-4 lg:grid-cols-3">
        <Card title="Đang chạy" icon={Play}>
          {(active.data ?? []).length === 0 ? (
            <Quiet icon={Play}>Không có lần chạy mô phỏng nào đang chạy.</Quiet>
          ) : (
            (active.data ?? []).map((r) => (
              <Link key={r.id} to={`/runs/${r.id}`} className={row}>
                <span className="min-w-0 flex-1 text-xs text-text">#{r.id} {r.model_key} v{r.version}<span className="block truncate text-[11px] text-muted">{r.scenario_name}</span></span>
                <StatusChip status={r.status} />
              </Link>
            ))
          )}
        </Card>
        <Card title="Cảnh báo Đỏ mới nhất" icon={Flame} actions={<Link className="text-[11px] font-medium text-accent hover:underline" to="/alerts">Xem mọi cảnh báo</Link>}>
          {(reds.data ?? []).length === 0 ? (
            <Quiet icon={Flame}>Chưa có cảnh báo Đỏ nào.</Quiet>
          ) : (
            (reds.data ?? []).map((i) => (
              <Link key={i.id} to={i.sim_run_id === null ? '/alerts' : `/runs/${i.sim_run_id}`} className={row}>
                <AlertKindIcon kind={i.kind} />
                <span className="min-w-0 flex-1 text-xs text-text">{describeInsight(i)}<span className="block truncate text-[11px] text-muted">{i.model_key} v{i.version}, {i.scenario_name}</span></span>
              </Link>
            ))
          )}
        </Card>
        <Card title="Mô hình gần đây" icon={Workflow}>
          {recent.length === 0 ? (
            <Quiet icon={Workflow}>Chưa có mô hình nào. <Link to="/models" className="font-medium text-accent hover:underline">Tạo mô hình</Link></Quiet>
          ) : (
            recent.map((m) => (
              <Link key={m.model_key} to={`/versions/${m.latest_version_id}`} className={row}>
                <span className="relative flex h-8 w-8 flex-none items-center justify-center rounded-lg bg-accent/12 text-accent" aria-hidden>
                  <Workflow size={15} />
                  {live.has(m.model_key) && <i className="absolute -right-0.5 -top-0.5 h-2.5 w-2.5 rounded-full border-2 border-panel bg-ok" />}
                </span>
                <span className="min-w-0 flex-1 text-xs text-text">{m.model_key} <span className="text-muted">v{m.latest_version}</span>
                  <span className="block text-[11px] text-muted">{m.runs} lần chạy{live.has(m.model_key) ? ', đang vận hành trực tiếp' : ''}</span></span>
                <span className="flex-none text-[11px] tabular-nums text-faint">{fmtDateTime(m.last_run_at)}</span>
              </Link>
            ))
          )}
        </Card>
      </div>
    </PageBody>
  )
}

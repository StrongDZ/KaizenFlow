import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Copy, MonitorPlay, Pencil, Play, Trash2 } from 'lucide-react'
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { api } from '../../api/client'
import type { Json, Run } from '../../api/types'
import { axisLine, axisTick, tooltipProps } from '../Charts'
import { DeleteDialog } from '../DeleteAction'
import { ScenarioTimeline } from '../scenario/ScenarioTimeline'
import { DataTable, type Column } from '../table/DataTable'
import { DetailShell, type DetailVariant } from '../SidePeek'
import { Card, EmptyState, ErrorBox, Notice, StatusChip, Tag } from '../ui'
import { fmtDateTime, fmtDuration } from '../../lib/format'
import { kpiP50 } from '../../lib/insights'
import { scenarioRules } from '../../lib/rules'
import { FULL_DETAIL_MAX_HORIZON_S, describeInjection, describeOverride, formatScenarioDuration, scenarioWarmupSeconds, startStateLabel } from '../../lib/scenarioView'

const kv = (label: string, value: string) => (
  <div key={label} className="flex justify-between gap-4 border-t border-line py-1.5 first:border-0">
    <span className="text-muted">{label}</span>
    <b className="font-medium tabular-nums text-text">{value}</b>
  </div>
)

const KIND = 'Chi tiết scenario'

function kpiText(run: Run, key: string, digits = 1) {
  const v = kpiP50(run.kpis, key)
  return v === undefined ? '—' : v.toFixed(digits).replace('.', ',')
}

function MetricTrend({ runs, metric, title, color, unit }: {
  runs: Run[]
  metric: string
  title: string
  color: string
  unit?: string
}) {
  const data = runs.map((run) => ({ run: run.id, value: kpiP50(run.kpis, metric) })).filter((row) => row.value !== undefined)
  return (
    <div className="rounded-lg border border-line bg-panel-2 p-2">
      <div className="px-1 text-[11px] font-medium text-text-2">{title}</div>
      {data.length === 0 ? <div className="flex h-32 items-center justify-center text-[11px] text-muted">Chưa có dữ liệu</div> : (
        <ResponsiveContainer width="100%" height={140}>
          <LineChart data={data} margin={{ top: 12, right: 10, bottom: 0, left: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--color-line)" />
            <XAxis dataKey="run" tickFormatter={(v) => `#${v}`} tick={axisTick} axisLine={axisLine} tickLine={false} />
            <YAxis tick={axisTick} axisLine={axisLine} tickLine={false} width={42} unit={unit} domain={['auto', 'auto']} />
            <Tooltip {...tooltipProps} labelFormatter={(v) => `Run #${v}`} formatter={(v) => [`${Number(v).toFixed(1).replace('.', ',')}${unit ?? ''}`, title]} />
            <Line dataKey="value" stroke={color} strokeWidth={2} dot={{ r: 3 }} name={title} isAnimationActive={false} />
          </LineChart>
        </ResponsiveContainer>
      )}
    </div>
  )
}
/** Chi tiết một scenario: thông số, lỗi đã tiêm, thay đổi nguồn lực, các lần chạy. Dùng ở trang riêng hoặc khung bên phải của danh sách scenario. */
export function ScenarioDetail({ id, variant, onClose, onSwitch }: { id: number; variant: DetailVariant; onClose?: () => void; onSwitch?: (id: number) => void }) {
  const navigate = useNavigate()
  const qc = useQueryClient()
  const [deleting, setDeleting] = useState(false)
  const sc = useQuery({ queryKey: ['scenario', id], queryFn: () => api.scenario(id) })
  const graph = useQuery({ queryKey: ['graph', sc.data?.model_version_id], queryFn: () => api.graph(sc.data!.model_version_id), enabled: !!sc.data })
  const runs = useQuery({ queryKey: ['runs', 'of', id], queryFn: () => api.runs(id) })
  const start = useMutation({ mutationFn: () => api.startRun(id), onSuccess: (r) => navigate(`/runs/${r.run_id}`) })
  const clone = useMutation({
    mutationFn: () => api.cloneScenario(id),
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: ['scenarios'] })
      // Trong khung chi tiết: bản nhân bản mở ngay trong khung; trang riêng thì sang trang của bản mới.
      if (variant === 'peek' && onSwitch) onSwitch(r.id)
      else navigate(`/scenarios/${r.id}`)
    },
  })
  if (sc.error) return <DetailShell variant={variant} kind={KIND} title={`Scenario #${id}`} onClose={onClose}><ErrorBox error={sc.error} /></DetailShell>
  if (!sc.data || !graph.data) return <DetailShell variant={variant} kind={KIND} title={`Scenario #${id}`} onClose={onClose} loading><span /></DetailShell>
  const s = sc.data
  const published = graph.data.status === 'PUBLISHED'
  const rules = runs.data ? scenarioRules(runs.data.length) : { canEdit: false, canDelete: true, banner: null }
  const completedRuns = (runs.data ?? []).filter((r) => r.status === 'DONE')
  const latestDone = [...completedRuns].sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))[0]
  const trendRuns = [...completedRuns].sort((a, b) => a.id - b.id)
  const timelineEvents = s.injections.map((i) => describeInjection(i))
  const warmupS = scenarioWarmupSeconds(s.start_state, graph.data.settings)
  const stop = (e: { stopPropagation: () => void }) => e.stopPropagation()
  const runColumns: Column<Run>[] = [
    { key: 'id', header: 'Lần chạy', cell: (r) => <span className="font-medium text-text">#{r.id}</span>, sort: (r) => r.id },
    { key: 'status', header: 'Trạng thái', cell: (r) => <StatusChip status={r.status} /> },
    { key: 'red', header: 'Phút Đỏ (p50)', cell: (r) => kpiText(r, 'red_minutes'), sort: (r) => kpiP50(r.kpis, 'red_minutes') ?? Number.POSITIVE_INFINITY, align: 'right' },
    { key: 'tp', header: 'Sản lượng (p50)', cell: (r) => kpiText(r, 'throughput'), sort: (r) => kpiP50(r.kpis, 'throughput') ?? -1, align: 'right' },
    { key: 'backorder', header: 'Nợ đơn cuối kỳ', cell: (r) => kpiText(r, 'backorder_end'), sort: (r) => kpiP50(r.kpis, 'backorder_end') ?? Number.POSITIVE_INFINITY, align: 'right' },
    { key: 'start', header: 'Bắt đầu', cell: (r) => fmtDateTime(r.created_at), sort: (r) => Date.parse(r.created_at) },
    { key: 'dur', header: 'Thời lượng', cell: (r) => fmtDuration(r.created_at, r.finished_at) },
    {
      key: 'open', header: '', align: 'right', cell: (r) => (
        <div className="flex justify-end gap-2" onClick={stop}>
          <Link className="text-[11px] text-accent hover:underline" to={`/runs/${r.id}`}>Control Room</Link>
          {r.status === 'DONE' && <Link className="text-[11px] text-accent hover:underline" to={`/runs/${r.id}/report`}>Báo cáo</Link>}
        </div>
      ),
    },
  ]
  return (
    <DetailShell
      variant={variant} kind={KIND} title={s.name || `Scenario #${s.id}`} subtitle={<Tag>{s.origin === 'RECOMMENDER' ? 'Từ đề xuất' : 'Người dùng'}</Tag>}
      back={{ to: `/versions/${s.model_version_id}/scenarios`, label: 'Danh sách scenario' }} onClose={onClose} fullPageTo={`/scenarios/${s.id}`}
      menu={[
        { key: 'run', label: 'Chạy', icon: Play, primary: true, disabled: !published || start.isPending, hint: 'Mô hình chưa Publish. Publish ở tab Sơ đồ trước.', onSelect: () => start.mutate() },
        { key: 'open', label: latestDone ? `Mở lần chạy #${latestDone.id}` : 'Mở lần chạy', icon: MonitorPlay, to: latestDone ? `/runs/${latestDone.id}` : undefined, disabled: !latestDone, hint: 'Chưa có lần chạy nào hoàn tất. Bấm Chạy trước.' },
        { key: 'edit', label: 'Sửa', icon: Pencil, to: `/scenarios/${s.id}/edit`, disabled: !rules.canEdit, hint: 'Đã có lần chạy nên không sửa được. Nhân bản để thử thông số khác.' },
        { key: 'clone', label: 'Nhân bản', icon: Copy, disabled: clone.isPending, onSelect: () => clone.mutate() },
        { key: 'delete', label: 'Xoá scenario', icon: Trash2, danger: true, onSelect: () => setDeleting(true) },
      ]}
    >
      <DeleteDialog
        open={deleting} onClose={() => setDeleting(false)} what={`scenario ${s.name || `#${s.id}`}`} run={(cascade) => api.deleteScenario(s.id, cascade)}
        onDone={() => {
          void qc.invalidateQueries({ queryKey: ['scenarios'] })
          if (variant === 'peek') onClose?.(); else navigate(`/versions/${s.model_version_id}/scenarios`)
        }}
      />
      {rules.banner && <Notice tone="lock">{rules.banner}</Notice>}
      {!published && <Notice tone="lock">Mô hình chưa Publish. Publish ở tab Sơ đồ trước khi chạy.</Notice>}
      {s.horizon_s > FULL_DETAIL_MAX_HORIZON_S && (
        <Notice>Scenario trên 12 giờ chỉ có KPI tổng hợp và forecast bands; backend không chạy Recommendation, sensor replay hoặc raw events.</Notice>
      )}
      <ErrorBox error={start.error ?? clone.error} />
      <div className={`grid gap-4 ${variant === 'peek' ? 'grid-cols-1' : 'md:grid-cols-2 xl:grid-cols-4'}`}>
        <Card title="Thông số">
          <div className="text-xs">
            {kv('Thời lượng', formatScenarioDuration(s.horizon_s))}
            {kv('Warm-up ngoài KPI', warmupS > 0 ? formatScenarioDuration(warmupS) : 'Không dùng')}
            {kv('Tổng mỗi lần chạy', formatScenarioDuration(s.horizon_s + warmupS))}
            {kv('Số lần lặp', String(s.replications))}
            {kv('Khởi đầu', startStateLabel(s.start_state))}
            {kv('Hạt giống', s.seed === null ? 'ngẫu nhiên' : String(s.seed))}
          </div>
        </Card>
        <Card title="Sự kiện đã thiết lập">
          {s.injections.length === 0 ? (
            <p className="text-xs text-muted">Không có lỗi máy hoặc dừng có kế hoạch.</p>
          ) : (
            <div className="text-xs">
              {s.injections.map((i: Json, n) => {
                const event = describeInjection(i)
                return <div key={n} className="flex justify-between gap-4 border-t border-line py-1.5 first:border-0">
                  <span className="text-muted">{event.label} · {event.detail}</span>
                  <b className="font-medium tabular-nums text-text">phút {Math.round(event.atS / 60)}</b>
                </div>
              })}
            </div>
          )}
        </Card>
        <Card title="Thay đổi nguồn lực">
          {s.overrides.length === 0 ? (
            <p className="text-xs text-muted">Không thay đổi nguồn lực nào.</p>
          ) : (
            <div className="text-xs">
              {s.overrides.map((o: Json, n) => {
                const d = describeOverride(o)
                return (
                  <div key={n} className="flex justify-between gap-4 border-t border-line py-1.5 first:border-0">
                    <span className="text-muted">{d.label}</span>
                    <b className="text-right font-medium tabular-nums text-text">{d.lines.map((l) => <span key={l} className="block">{l}</span>)}</b>
                  </div>
                )
              })}
            </div>
          )}
        </Card>
        <Card title="Hiệu suất sau chạy">
          {!latestDone ? (
            <p className="text-xs text-muted">Chưa có run hoàn tất nên chưa có KPI hiệu suất.</p>
          ) : (
            <div className="text-xs">
              {kv('Run gần nhất', `#${latestDone.id}`)}
              {kv('Sản lượng (p50)', kpiText(latestDone, 'throughput'))}
              {kv('Phút Đỏ (p50)', kpiText(latestDone, 'red_minutes'))}
              {kv('Nợ đơn cuối kỳ', kpiText(latestDone, 'backorder_end'))}
            </div>
          )}
        </Card>
      </div>
      <Card title="Timeline thiết lập">
        <ScenarioTimeline horizonS={s.horizon_s} events={timelineEvents} startLabel={startStateLabel(s.start_state)} />
      </Card>
      <Card title="Xu hướng KPI qua các lần chạy">
        <div className="mb-3 text-xs text-muted">
          Mỗi run đã tổng hợp nhiều lần lặp Monte Carlo. Biểu đồ dùng p50 để kiểm tra kết quả có ổn định giữa các lần chạy hay không; không nên chọn riêng run đẹp nhất.
        </div>
        <div className={`grid gap-3 ${variant === 'peek' ? 'grid-cols-1' : 'md:grid-cols-3'}`}>
          <MetricTrend runs={trendRuns} metric="throughput" title="Sản lượng p50 · càng cao càng tốt" color="var(--color-ok)" />
          <MetricTrend runs={trendRuns} metric="red_minutes" title="Phút Đỏ p50 · càng thấp càng tốt" color="var(--color-bad)" unit="p" />
          <MetricTrend runs={trendRuns} metric="backorder_end" title="Nợ đơn cuối kỳ · càng thấp càng tốt" color="var(--color-warn)" />
        </div>
      </Card>
      <div className={`grid gap-4 ${variant === 'peek' ? 'grid-cols-1' : 'md:grid-cols-2'}`}>
        <Card title="Cách đọc kết quả">
          <div className="space-y-2 text-xs text-text-2">
            <p><b>Sản lượng p50</b> càng cao càng tốt, nhưng cần đọc cùng nợ đơn và thời gian Đỏ.</p>
            <p><b>Phút Đỏ p50</b> và <b>nợ đơn cuối kỳ</b> càng thấp càng tốt.</p>
            <p>Muốn đánh giá một thay đổi cấu hình, hãy nhân bản scenario, giữ cùng horizon/lần lặp rồi so hai run; không so các run ngẫu nhiên như hai phương án khác nhau.</p>
          </div>
        </Card>
        <Card title="Báo cáo mới nhất">
          {!latestDone ? <p className="text-xs text-muted">Chưa có run hoàn tất để lập báo cáo.</p> : (
            <div className="space-y-3 text-xs">
              <div>
                {kv('Run', `#${latestDone.id}`)}
                {kv('Sản lượng (p50)', kpiText(latestDone, 'throughput'))}
                {kv('Phút Đỏ (p50)', kpiText(latestDone, 'red_minutes'))}
                {kv('Nợ đơn cuối kỳ', kpiText(latestDone, 'backorder_end'))}
              </div>
              <div className="flex gap-3">
                <Link className="font-medium text-accent hover:underline" to={`/runs/${latestDone.id}`}>Mở Control Room</Link>
                <Link className="font-medium text-accent hover:underline" to={`/runs/${latestDone.id}?story=1`}>Trình diễn có hướng dẫn</Link>
                <Link className="font-medium text-accent hover:underline" to={`/runs/${latestDone.id}/report`}>Xem / lưu PDF</Link>
              </div>
            </div>
          )}
        </Card>
      </div>
      <Card title="Các lần chạy">
        <div className="mb-3 rounded-lg border border-line bg-panel-2 px-3 py-2 text-xs text-text-2">
          Mở Control Room để xem diễn biến theo thời gian; mở Báo cáo để xem KPI, cảnh báo, đồ thị tồn kho và hành động đề xuất của đúng run đó.
        </div>
        <DataTable
          flat
          rows={runs.data ?? []}
          columns={runColumns}
          rowKey={(r) => r.id}
          onRowClick={(r) => navigate(`/runs/${r.id}`)}
          initialSort={{ key: 'id', dir: 'desc' }}
          empty={<EmptyState title="Scenario này chưa chạy lần nào">Bấm "Chạy" để mô phỏng.</EmptyState>}
        />
      </Card>
    </DetailShell>
  )
}

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Copy, Pencil, Play, Trash2 } from 'lucide-react'
import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { api } from '../../api/client'
import type { Json, Run } from '../../api/types'
import { DeleteDialog } from '../DeleteAction'
import { DataTable, type Column } from '../table/DataTable'
import { DetailShell, type DetailVariant } from '../SidePeek'
import { Card, EmptyState, ErrorBox, Notice, StatusChip, Tag } from '../ui'
import { fmtDateTime, fmtDuration } from '../../lib/format'
import { kpiP50 } from '../../lib/insights'
import { scenarioRules } from '../../lib/rules'
import { describeOverride } from '../../lib/scenarioView'

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

function quickRating(run: Run): { label: string; tone: string; note: string } {
  const red = kpiP50(run.kpis, 'red_minutes')
  const throughput = kpiP50(run.kpis, 'throughput')
  const backorder = kpiP50(run.kpis, 'backorder_end')
  if (run.status !== 'DONE' || red === undefined || throughput === undefined || backorder === undefined) {
    return { label: 'Chưa đủ dữ liệu', tone: 'border-line-2 text-muted', note: 'Cần run hoàn tất để chấm.' }
  }
  if (red <= 5 && backorder <= 2 && throughput >= 1) {
    return { label: 'Tốt', tone: 'border-ok/40 bg-panel-2 text-ok', note: 'Đỏ thấp, nợ đơn thấp, sản lượng ổn.' }
  }
  if (red <= 20 && backorder <= 8 && throughput >= 0.5) {
    return { label: 'Cần cải thiện', tone: 'border-warn/40 bg-panel-2 text-warn', note: 'Chạy được nhưng chưa thật sự tối ưu.' }
  }
  return { label: 'Rủi ro cao', tone: 'border-bad/40 bg-bad-bg text-bad-text', note: 'Đỏ hoặc nợ đơn còn cao.' }
}
const START_STATE: Record<string, string> = { EMPTY: 'Nhà máy rỗng', WARMUP: 'Làm nóng rồi mới ghi', LIVE_SNAPSHOT: 'Từ ảnh chụp trực tiếp' }

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
  const bestRun = [...completedRuns].sort((a, b) => {
    const redA = kpiP50(a.kpis, 'red_minutes') ?? Number.POSITIVE_INFINITY
    const redB = kpiP50(b.kpis, 'red_minutes') ?? Number.POSITIVE_INFINITY
    if (redA !== redB) return redA - redB
    const tpA = kpiP50(a.kpis, 'throughput') ?? Number.NEGATIVE_INFINITY
    const tpB = kpiP50(b.kpis, 'throughput') ?? Number.NEGATIVE_INFINITY
    return tpB - tpA
  })[0]
  const runColumns: Column<Run>[] = [
    { key: 'id', header: 'Lần chạy', cell: (r) => <span className="font-medium text-text">#{r.id}</span>, sort: (r) => r.id },
    { key: 'status', header: 'Trạng thái', cell: (r) => <StatusChip status={r.status} /> },
    {
      key: 'rating',
      header: 'Đánh giá nhanh',
      cell: (r) => {
        const rate = quickRating(r)
        return (
          <div className="space-y-1">
            <span className={`inline-flex rounded-full border px-2 py-0.5 text-[11px] font-semibold ${rate.tone}`}>{rate.label}</span>
            <div className="text-[11px] text-muted">{rate.note}</div>
          </div>
        )
      },
      sort: (r) => {
        const label = quickRating(r).label
        if (label === 'Tốt') return 3
        if (label === 'Cần cải thiện') return 2
        if (label === 'Rủi ro cao') return 1
        return 0
      },
    },
    { key: 'red', header: 'Phút Đỏ (p50)', cell: (r) => kpiText(r, 'red_minutes'), sort: (r) => kpiP50(r.kpis, 'red_minutes') ?? Number.POSITIVE_INFINITY, align: 'right' },
    { key: 'tp', header: 'Sản lượng (p50)', cell: (r) => kpiText(r, 'throughput'), sort: (r) => kpiP50(r.kpis, 'throughput') ?? -1, align: 'right' },
    { key: 'backorder', header: 'Nợ đơn cuối kỳ', cell: (r) => kpiText(r, 'backorder_end'), sort: (r) => kpiP50(r.kpis, 'backorder_end') ?? Number.POSITIVE_INFINITY, align: 'right' },
    { key: 'start', header: 'Bắt đầu', cell: (r) => fmtDateTime(r.created_at), sort: (r) => Date.parse(r.created_at) },
    { key: 'dur', header: 'Thời lượng', cell: (r) => fmtDuration(r.created_at, r.finished_at) },
  ]
  return (
    <DetailShell
      variant={variant} kind={KIND} title={s.name || `Scenario #${s.id}`} subtitle={<Tag>{s.origin === 'RECOMMENDER' ? 'Từ đề xuất' : 'Người dùng'}</Tag>}
      back={{ to: `/versions/${s.model_version_id}/scenarios`, label: 'Danh sách scenario' }} onClose={onClose} fullPageTo={`/scenarios/${s.id}`}
      menu={[
        { key: 'run', label: 'Chạy', icon: Play, primary: true, disabled: !published || start.isPending, hint: 'Mô hình chưa Publish. Publish ở tab Sơ đồ trước.', onSelect: () => start.mutate() },
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
      <ErrorBox error={start.error ?? clone.error} />
      <div className={`grid gap-4 ${variant === 'peek' ? 'grid-cols-1' : 'md:grid-cols-2 xl:grid-cols-4'}`}>
        <Card title="Thông số">
          <div className="text-xs">
            {kv('Thời lượng', `${s.horizon_s / 3600} giờ`)}
            {kv('Số lần lặp', String(s.replications))}
            {kv('Khởi đầu', START_STATE[s.start_state] ?? s.start_state)}
            {kv('Hạt giống', s.seed === null ? 'ngẫu nhiên' : String(s.seed))}
          </div>
        </Card>
        <Card title="Lỗi đã tiêm">
          {s.injections.length === 0 ? (
            <p className="text-xs text-muted">Không tiêm lỗi nào.</p>
          ) : (
            <div className="text-xs">
              {s.injections.map((i: Json, n) => (
                <div key={n} className="flex justify-between gap-4 border-t border-line py-1.5 first:border-0">
                  <span className="text-muted">{String(i.target)}, {String(i.failure)}</span>
                  <b className="font-medium tabular-nums text-text">phút {Math.round(Number(i.at_s) / 60)}</b>
                </div>
              ))}
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
      <div className={`grid gap-4 ${variant === 'peek' ? 'grid-cols-1' : 'md:grid-cols-2'}`}>
        <Card title="Đọc hiệu suất">
          <div className="space-y-2 text-xs text-text-2">
            <p>`Sản lượng (p50)` càng cao càng tốt vì thể hiện kịch bản giao được nhiều hàng hơn.</p>
            <p>`Phút Đỏ (p50)` càng thấp càng tốt vì phản ánh ít thời gian rơi vào trạng thái rủi ro.</p>
            <p>`Nợ đơn cuối kỳ` càng thấp càng tốt vì cho thấy khách ít bị thiếu hàng hơn sau khi chạy xong kịch bản.</p>
            <p>`Đánh giá nhanh` là lớp tóm tắt để xem nhanh từng run: xanh là tốt, vàng là còn tối ưu được, đỏ là vẫn còn nhiều rủi ro vận hành.</p>
          </div>
        </Card>
        <Card title="Run tốt nhất hiện tại">
          {!bestRun ? (
            <p className="text-xs text-muted">Chưa có run hoàn tất để chọn run tốt nhất.</p>
          ) : (
            <div className="text-xs">
              {kv('Run tốt nhất', `#${bestRun.id}`)}
              {kv('Phút Đỏ (p50)', kpiText(bestRun, 'red_minutes'))}
              {kv('Sản lượng (p50)', kpiText(bestRun, 'throughput'))}
              {kv('Nợ đơn cuối kỳ', kpiText(bestRun, 'backorder_end'))}
            </div>
          )}
        </Card>
      </div>
      <Card title="Các lần chạy">
        <div className="mb-3 rounded-lg border border-line bg-panel-2 px-3 py-2 text-xs text-text-2">
          Sau mỗi kịch bản, hãy đọc hiệu suất theo thứ tự: `Phút Đỏ` giảm xuống, `Nợ đơn cuối kỳ` giảm xuống, và `Sản lượng` giữ nguyên hoặc tăng lên. Đó là dấu hiệu kịch bản thực sự tốt hơn.
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

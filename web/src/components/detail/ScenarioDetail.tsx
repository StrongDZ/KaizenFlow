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

const kv = (label: string, value: string) => (
  <div key={label} className="flex justify-between gap-4 border-t border-line py-1.5 first:border-0">
    <span className="text-muted">{label}</span>
    <b className="font-medium tabular-nums text-text">{value}</b>
  </div>
)

const KIND = 'Chi tiết scenario'
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
  const runColumns: Column<Run>[] = [
    { key: 'id', header: 'Lần chạy', cell: (r) => <span className="font-medium text-text">#{r.id}</span>, sort: (r) => r.id },
    { key: 'status', header: 'Trạng thái', cell: (r) => <StatusChip status={r.status} /> },
    { key: 'red', header: 'Phút Đỏ (p50)', cell: (r) => { const v = kpiP50(r.kpis, 'red_minutes'); return v === undefined ? '—' : v.toFixed(1).replace('.', ',') }, align: 'right' },
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
      <div className={`grid gap-4 ${variant === 'peek' ? 'grid-cols-1' : 'grid-cols-3'}`}>
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
              {s.overrides.map((o: Json, n) => (
                <div key={n} className="flex justify-between gap-4 border-t border-line py-1.5 first:border-0">
                  <span className="text-muted">{String(o.target)}{String(o.path)}</span>
                  <b className="font-medium tabular-nums text-text">{String(o.value)}</b>
                </div>
              ))}
            </div>
          )}
        </Card>
      </div>
      <Card title="Các lần chạy">
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

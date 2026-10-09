import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Play } from 'lucide-react'
import { useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { api } from '../api/client'
import type { RunRow } from '../api/types'
import { DeleteAction } from '../components/DeleteAction'
import { ItemIdentity } from '../components/NodeIdentity'
import { DataTable, type Column } from '../components/table/DataTable'
import { EmptyState, ErrorBox, FilterChip, Loading, PageBody, PageHeader, StatusChip, btn, btnPrimary } from '../components/ui'
import { fmtDateTime, fmtDuration } from '../lib/format'
import { runRules } from '../lib/rules'
import { comparePath, toggleCompare } from '../lib/table'

const FILTERS = [
  { key: 'all', label: 'Tất cả', status: undefined },
  { key: 'active', label: 'Đang chạy', status: 'QUEUED,RUNNING' },
  { key: 'done', label: 'Đã xong', status: 'DONE' },
  { key: 'failed', label: 'Lỗi', status: 'FAILED' },
] as const


const RUN_COLOR: Record<string, string> = { DONE: 'var(--color-ok)', FAILED: 'var(--color-bad)', RUNNING: 'var(--color-accent)', QUEUED: 'var(--color-muted)' }
export default function RunsPage() {
  const versionId = Number(useParams().id)
  const navigate = useNavigate()
  const qc = useQueryClient()
  const [filter, setFilter] = useState<(typeof FILTERS)[number]['key']>('all')
  const [sel, setSel] = useState<number[]>([])
  const status = FILTERS.find((f) => f.key === filter)?.status
  const runs = useQuery({
    queryKey: ['runs', 'all', versionId, filter],
    queryFn: () => api.allRuns({ status, version: versionId, limit: 200 }),
  })
  if (runs.isLoading) return <Loading />
  const compare = comparePath(sel)
  const stop = (e: { stopPropagation: () => void }) => e.stopPropagation()
  const columns: Column<RunRow>[] = [
    {
      key: 'pick',
      header: '',
      cell: (r) => (
        <input
          type="checkbox"
          aria-label={`Chọn run ${r.id} để so sánh`}
          disabled={r.status !== 'DONE'}
          checked={sel.includes(r.id)}
          onClick={stop}
          onChange={() => setSel(toggleCompare(sel, r.id))}
        />
      ),
    },
    { key: 'id', header: 'Lần chạy', cell: (r) => <ItemIdentity icon={Play} name={`#${r.id}`} size={26} color={RUN_COLOR[r.status]} />, sort: (r) => r.id },
    { key: 'model', header: 'Mô hình', cell: (r) => `${r.model_key} v${r.version}`, sort: (r) => r.model_key },
    { key: 'scenario', header: 'Scenario', cell: (r) => r.scenario_name || `Scenario #${r.scenario_id}`, sort: (r) => r.scenario_name },
    { key: 'status', header: 'Trạng thái', cell: (r) => <StatusChip status={r.status} />, sort: (r) => r.status },
    {
      key: 'red',
      header: 'Phút Đỏ (p50)',
      cell: (r) => (r.red_minutes_p50 === null ? '—' : r.red_minutes_p50.toFixed(1).replace('.', ',')),
      sort: (r) => r.red_minutes_p50,
      align: 'right',
    },
    { key: 'start', header: 'Bắt đầu', cell: (r) => fmtDateTime(r.created_at), sort: (r) => Date.parse(r.created_at) },
    { key: 'dur', header: 'Thời lượng', cell: (r) => fmtDuration(r.created_at, r.finished_at) },
    {
      key: 'del',
      header: '',
      align: 'right',
      cell: (r) => (
        <div className="flex justify-end">
          <DeleteAction
            what={`lần chạy #${r.id}`}
            disabled={!runRules(r.status).canDelete}
            run={() => api.deleteRun(r.id)}
            onDone={() => {
              setSel((s) => s.filter((x) => x !== r.id))
              void qc.invalidateQueries({ queryKey: ['runs'] })
            }}
          />
        </div>
      ),
    },
  ]
  return (
    <PageBody wide>
      <PageHeader icon={Play}
        title="Lần chạy"
        subtitle={runs.data ? `${runs.data.length} lần chạy` : undefined}
        actions={compare ? <Link className={btnPrimary} to={compare}>So sánh 2 lần chạy</Link> : <button className={btn} disabled>So sánh 2 lần chạy</button>}
      />
      <div className="flex gap-2">
        {FILTERS.map((f) => (
          <FilterChip key={f.key} active={filter === f.key} onClick={() => setFilter(f.key)}>{f.label}</FilterChip>
        ))}
      </div>
      <p className="text-[11px] text-muted">Tick hai lần chạy đã xong để so sánh; lần chạy cũ hơn được coi là gốc.</p>
      <ErrorBox error={runs.error} />
      <DataTable
        rows={runs.data ?? []}
        columns={columns}
        rowKey={(r) => r.id}
        onRowClick={(r) => navigate(`/runs/${r.id}`)}
        initialSort={{ key: 'id', dir: 'desc' }}
        empty={
          <EmptyState icon={Play} title={filter === 'all' ? 'Chưa có lần chạy nào' : 'Không có lần chạy khớp bộ lọc'}>
            {filter === 'all' ? 'Chạy một scenario ở tab Scenario của mô hình để thấy kết quả ở đây.' : 'Đổi bộ lọc để xem các lần chạy khác.'}
          </EmptyState>
        }
      />
    </PageBody>
  )
}

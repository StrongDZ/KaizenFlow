import { useMutation, useQuery } from '@tanstack/react-query'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { api } from '../api/client'
import type { ScenarioRow } from '../api/types'
import { DataTable, type Column } from '../components/table/DataTable'
import { EmptyState, ErrorBox, Loading, Notice, PageBody, PageHeader, StatusChip, Tag, btn, btnPrimary } from '../components/ui'

export default function ScenariosPage() {
  const vid = Number(useParams().id)
  const navigate = useNavigate()
  const graph = useQuery({ queryKey: ['graph', vid], queryFn: () => api.graph(vid) })
  const scenarios = useQuery({ queryKey: ['scenarios', vid], queryFn: () => api.scenarios(vid) })
  const run = useMutation({ mutationFn: (sid: number) => api.startRun(sid), onSuccess: (r) => navigate(`/runs/${r.run_id}`) })
  if (scenarios.isLoading || !graph.data) return <Loading />
  const published = graph.data.status === 'PUBLISHED'
  const stop = (e: { stopPropagation: () => void }) => e.stopPropagation()
  const columns: Column<ScenarioRow>[] = [
    { key: 'name', header: 'Tên', cell: (s) => <span className="font-medium text-text">{s.name || `Scenario #${s.id}`}</span>, sort: (s) => s.name },
    { key: 'horizon', header: 'Thời lượng', cell: (s) => `${s.horizon_s / 3600} giờ`, sort: (s) => s.horizon_s, align: 'right' },
    { key: 'reps', header: 'Số lần lặp', cell: (s) => s.replications, sort: (s) => s.replications, align: 'right' },
    { key: 'origin', header: 'Nguồn gốc', cell: (s) => <Tag>{s.origin === 'RECOMMENDER' ? 'Từ đề xuất' : 'Người dùng'}</Tag>, sort: (s) => s.origin },
    { key: 'runs', header: 'Số run', cell: (s) => s.runs, sort: (s) => s.runs, align: 'right' },
    { key: 'last', header: 'Run gần nhất', cell: (s) => (s.last_run_status ? <StatusChip status={s.last_run_status} /> : '—') },
    {
      key: 'actions',
      header: '',
      align: 'right',
      cell: (s) => (
        <div className="flex justify-end" onClick={stop}>
          <button className={btn} disabled={!published || run.isPending} onClick={() => run.mutate(s.id)}>Chạy</button>
        </div>
      ),
    },
  ]
  return (
    <PageBody>
      <PageHeader
        title="Scenario"
        subtitle={`${graph.data.model_key} v${graph.data.version}`}
        actions={<Link className={btnPrimary} to={`/versions/${vid}/scenarios/new`}>Tạo scenario</Link>}
      />
      {!published && <Notice tone="lock">Mô hình chưa Publish. Publish ở tab Sơ đồ trước khi chạy scenario.</Notice>}
      <ErrorBox error={scenarios.error ?? run.error} />
      <DataTable
        rows={scenarios.data ?? []}
        columns={columns}
        rowKey={(s) => s.id}
        onRowClick={(s) => navigate(`/scenarios/${s.id}`)}
        empty={<EmptyState title="Chưa có scenario nào">Scenario là một tình huống what-if: thời lượng, lỗi máy tiêm vào, thay đổi nguồn lực. Bấm "Tạo scenario".</EmptyState>}
      />
    </PageBody>
  )
}

import { useMutation, useQuery } from '@tanstack/react-query'
import { FlaskConical, Lightbulb } from 'lucide-react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { api } from '../api/client'
import type { ScenarioRow } from '../api/types'
import { ScenarioDetail } from '../components/detail/ScenarioDetail'
import { PeekHost, usePeekParam } from '../components/SidePeek'
import { ItemIdentity } from '../components/NodeIdentity'
import { DataTable, type Column } from '../components/table/DataTable'
import { EmptyState, ErrorBox, Loading, Notice, PageBody, PageHeader, StatusChip, Tag, btnAccentOutline, btnPrimary } from '../components/ui'
import { formatScenarioDuration } from '../lib/scenarioView'

export default function ScenariosPage() {
  const vid = Number(useParams().id)
  const navigate = useNavigate()
  const graph = useQuery({ queryKey: ['graph', vid], queryFn: () => api.graph(vid) })
  const scenarios = useQuery({ queryKey: ['scenarios', vid], queryFn: () => api.scenarios(vid) })
  const [peek, setPeek] = usePeekParam()
  const run = useMutation({ mutationFn: (sid: number) => api.startRun(sid), onSuccess: (r) => navigate(`/runs/${r.run_id}`) })
  if (scenarios.isLoading || !graph.data) return <Loading />
  const published = graph.data.status === 'PUBLISHED'
  const stop = (e: { stopPropagation: () => void }) => e.stopPropagation()
  const columns: Column<ScenarioRow>[] = [
    { key: 'name', header: 'Scenario', cell: (s) => <ItemIdentity icon={s.origin === 'RECOMMENDER' ? Lightbulb : FlaskConical} name={s.name || `Scenario #${s.id}`} color={s.origin === 'RECOMMENDER' ? 'var(--color-ok)' : 'var(--color-accent)'} />, sort: (s) => s.name },
    { key: 'horizon', header: 'Thời lượng', cell: (s) => formatScenarioDuration(s.horizon_s), sort: (s) => s.horizon_s, align: 'right' },
    { key: 'reps', header: 'Số lần lặp', cell: (s) => s.replications, sort: (s) => s.replications, align: 'right' },
    {
      key: 'setup', header: 'Thiết lập', cell: (s) => (
        <div className="flex flex-wrap gap-1">
          <Tag>{s.injections.length === 0 ? 'Không sự kiện' : `${s.injections.length} sự kiện`}</Tag>
          <Tag>{s.overrides.length === 0 ? 'Cấu hình nền' : `${s.overrides.length} thay đổi`}</Tag>
        </div>
      ),
    },
    { key: 'origin', header: 'Nguồn gốc', cell: (s) => <Tag tone={s.origin === 'RECOMMENDER' ? 'ok' : 'neutral'}>{s.origin === 'RECOMMENDER' ? 'Từ đề xuất' : 'Người dùng'}</Tag>, sort: (s) => s.origin },
    { key: 'runs', header: 'Số run', cell: (s) => s.runs, sort: (s) => s.runs, align: 'right' },
    { key: 'last', header: 'Lần chạy gần nhất', cell: (s) => (s.last_run_status ? <StatusChip status={s.last_run_status} /> : '—') },
    {
      key: 'actions',
      header: '',
      align: 'right',
      cell: (s) => (
        <div className="flex justify-end" onClick={stop}>
          <button className={btnAccentOutline} disabled={!published || run.isPending} onClick={() => run.mutate(s.id)}>Chạy</button>
        </div>
      ),
    },
  ]
  return (
    <PeekHost onClose={() => setPeek(null)} peek={peek ? <ScenarioDetail key={peek} id={Number(peek)} variant="peek" onClose={() => setPeek(null)} onSwitch={(id) => setPeek(String(id))} /> : null}>
    <PageBody>
      <PageHeader icon={FlaskConical}
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
        onRowClick={(s) => setPeek(String(s.id))}
        selected={(s) => String(s.id) === peek}
        empty={<EmptyState icon={FlaskConical} title="Chưa có scenario nào">Scenario là một tình huống what-if: thời lượng, lỗi máy hoặc dừng có kế hoạch, thay đổi nguồn lực. Bấm "Tạo scenario".</EmptyState>}
      />
    </PageBody>
    </PeekHost>
  )
}

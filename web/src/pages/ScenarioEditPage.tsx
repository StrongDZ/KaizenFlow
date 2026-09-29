import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useMemo } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { api } from '../api/client'
import type { ScenarioBody } from '../api/types'
import { ScenarioFormView } from '../components/scenario/ScenarioFormView'
import { ErrorBox, Loading, Notice, PageBody, PageHeader, btn } from '../components/ui'
import { byCode } from '../lib/model'
import { scenarioRules } from '../lib/rules'
import { scenarioToForm } from '../lib/scenarioForm'

export default function ScenarioEditPage() {
  const id = Number(useParams().id)
  const qc = useQueryClient()
  const navigate = useNavigate()
  const sc = useQuery({ queryKey: ['scenario', id], queryFn: () => api.scenario(id) })
  const graph = useQuery({ queryKey: ['graph', sc.data?.model_version_id], queryFn: () => api.graph(sc.data!.model_version_id), enabled: !!sc.data })
  const types = useQuery({ queryKey: ['node-types'], queryFn: api.nodeTypes })
  const runs = useQuery({ queryKey: ['runs', 'of', id], queryFn: () => api.runs(id) })
  const typeMap = useMemo(() => byCode(types.data ?? []), [types.data])
  const update = useMutation({
    mutationFn: (b: ScenarioBody) => api.updateScenario(id, b),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['scenario', id] })
      void qc.invalidateQueries({ queryKey: ['scenarios'] })
      navigate(`/scenarios/${id}`)
    },
  })
  if (sc.error) return <PageBody><ErrorBox error={sc.error} /></PageBody>
  if (!sc.data || !graph.data || !types.data || !runs.data) return <Loading />
  const rules = scenarioRules(runs.data.length)
  if (!rules.canEdit) {
    return (
      <PageBody>
        <Notice tone="lock">{rules.banner}</Notice>
        <Link className={btn} to={`/scenarios/${id}`}>Về scenario</Link>
      </PageBody>
    )
  }
  return (
    <PageBody>
      <PageHeader title="Sửa scenario" subtitle={`${graph.data.model_key} v${graph.data.version}`} />
      <ScenarioFormView
        key={id} graph={graph.data} types={typeMap} initial={scenarioToForm(sc.data)} submitLabel="Lưu thay đổi"
        pending={update.isPending} error={update.error} cancelTo={`/scenarios/${id}`}
        onSubmit={(b) => update.mutate(b)}
      />
    </PageBody>
  )
}

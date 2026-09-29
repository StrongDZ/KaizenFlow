import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useMemo } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { api } from '../api/client'
import type { ScenarioBody } from '../api/types'
import { ScenarioFormView } from '../components/scenario/ScenarioFormView'
import { Loading, PageBody, PageHeader } from '../components/ui'
import { byCode } from '../lib/model'
import { EMPTY_FORM } from '../lib/scenarioForm'

export default function ScenarioNewPage() {
  const vid = Number(useParams().id)
  const qc = useQueryClient()
  const navigate = useNavigate()
  const graph = useQuery({ queryKey: ['graph', vid], queryFn: () => api.graph(vid) })
  const types = useQuery({ queryKey: ['node-types'], queryFn: api.nodeTypes })
  const typeMap = useMemo(() => byCode(types.data ?? []), [types.data])
  const create = useMutation({
    mutationFn: (b: ScenarioBody) => api.createScenario({ model_version_id: vid, ...b }),
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: ['scenarios', vid] })
      navigate(`/scenarios/${r.id}`)
    },
  })
  if (!graph.data || !types.data) return <Loading />
  return (
    <PageBody>
      <PageHeader title="Tạo scenario" subtitle={`${graph.data.model_key} v${graph.data.version}`} />
      <ScenarioFormView
        graph={graph.data} types={typeMap} initial={EMPTY_FORM} submitLabel="Tạo scenario"
        pending={create.isPending} error={create.error} cancelTo={`/versions/${vid}/scenarios`}
        onSubmit={(b) => create.mutate(b)}
      />
    </PageBody>
  )
}

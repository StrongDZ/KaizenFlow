import { useQuery } from '@tanstack/react-query'
import { api } from '../api/client'

export function useRunBundle(runId: number, needBands: boolean) {
  const run = useQuery({
    queryKey: ['run', runId], queryFn: () => api.run(runId),
    refetchInterval: (q) => (q.state.data && ['DONE', 'FAILED'].includes(q.state.data.status) ? false : 3000),
  })
  const scenario = useQuery({
    queryKey: ['scenario', run.data?.scenario_id], queryFn: () => api.scenario(run.data!.scenario_id), enabled: !!run.data,
  })
  const graph = useQuery({
    queryKey: ['graph', scenario.data?.model_version_id], queryFn: () => api.graph(scenario.data!.model_version_id), enabled: !!scenario.data,
  })
  const types = useQuery({ queryKey: ['node-types'], queryFn: api.nodeTypes })
  const bands = useQuery({ queryKey: ['bands', runId], queryFn: () => api.bands(runId), enabled: needBands && run.data?.status === 'DONE' })
  return { run, scenario, graph, types, bands }
}

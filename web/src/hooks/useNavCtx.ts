import { useQuery } from '@tanstack/react-query'
import { api } from '../api/client'
import type { NavCtx } from '../lib/nav'

/** Gom dữ liệu cho breadcrumb và tab từ URL; dùng chung cache với các trang. */
export function useNavCtx(path: string): NavCtx {
  const versionParam = path.match(/^\/versions\/(\d+)/)?.[1]
  const scenarioParam = path.match(/^\/scenarios\/(\d+)/)?.[1]
  const runParam = path.match(/^\/runs\/(\d+)/)?.[1]
  const keyParam = path.match(/^\/models\/([^/]+)\/versions/)?.[1]

  const runId = runParam ? Number(runParam) : undefined
  const run = useQuery({ queryKey: ['run', runId], queryFn: () => api.run(runId!), enabled: runId !== undefined })
  const scenarioId = scenarioParam ? Number(scenarioParam) : run.data?.scenario_id
  const scenario = useQuery({
    queryKey: ['scenario', scenarioId], queryFn: () => api.scenario(scenarioId!), enabled: scenarioId !== undefined,
  })
  const versionId = versionParam ? Number(versionParam) : scenario.data?.model_version_id
  const graph = useQuery({ queryKey: ['graph', versionId], queryFn: () => api.graph(versionId!), enabled: versionId !== undefined })
  const modelKey = graph.data?.model_key ?? (keyParam ? decodeURIComponent(keyParam) : undefined)
  const versions = useQuery({ queryKey: ['versions', modelKey], queryFn: () => api.versions(modelKey!), enabled: !!modelKey })
  const latest = versions.data?.length ? versions.data[versions.data.length - 1] : undefined

  return {
    modelKey,
    version: graph.data?.version,
    versionId,
    latestVersionId: latest?.id,
    versions: versions.data,
    scenarioName: scenario.data?.name || (scenario.data ? `Scenario #${scenario.data.id}` : undefined),
  }
}

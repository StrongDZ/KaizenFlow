import { useQuery } from '@tanstack/react-query'
import { api } from '../api/client'
import type { Graph, NodeType } from '../api/types'
import { byCode } from '../lib/model'

export type ModelGraph =
  | { status: 'loading' }
  | { status: 'none' }
  | { status: 'ready'; graph: Graph; types: Record<string, NodeType> }

/** Graph của version đã Publish mới nhất của mô hình, kèm catalog loại node: nền của mọi màn live. */
export function useModelGraph(model: string): ModelGraph {
  const versions = useQuery({ queryKey: ['versions', model], queryFn: () => api.versions(model) })
  const published = [...(versions.data ?? [])].reverse().find((v) => v.status === 'PUBLISHED')
  const graph = useQuery({ queryKey: ['graph', published?.id], queryFn: () => api.graph(published!.id), enabled: !!published })
  const types = useQuery({ queryKey: ['node-types'], queryFn: api.nodeTypes })
  if (versions.isLoading || graph.isLoading || types.isLoading) return { status: 'loading' }
  if (!published || !graph.data || !types.data) return { status: 'none' }
  return { status: 'ready', graph: graph.data, types: byCode(types.data) }
}

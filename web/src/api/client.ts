import type {
  BandRow, EventRow, Graph, GraphEdge, GraphNode, Issue, Json, Material, ModelSummary, NewScenario,
  NodeType, Run, RunDetail, Scenario, SignalRow, VersionInfo,
} from './types'

export const API_BASE: string = import.meta.env.VITE_API_URL ?? 'http://localhost:8080'
export const wsUrl = API_BASE.replace(/^http/, 'ws') + '/ws'

export class ApiError extends Error {
  status: number
  issues: Issue[]
  constructor(status: number, issues: Issue[], message: string) {
    super(message)
    this.status = status
    this.issues = issues
  }
}

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(API_BASE + path, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
  })
  if (res.status === 204) return undefined as T
  const text = await res.text()
  const body = text ? JSON.parse(text) : undefined
  if (!res.ok) {
    throw new ApiError(res.status, body?.issues ?? [], body?.error ?? res.statusText)
  }
  return body as T
}

function qs(params: Record<string, string | undefined>): string {
  const p = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) if (v) p.set(k, v)
  const s = p.toString()
  return s ? `?${s}` : ''
}

const post = <T>(path: string, body?: unknown) => req<T>(path, { method: 'POST', body: JSON.stringify(body ?? {}) })

export const api = {
  nodeTypes: () => req<NodeType[]>('/api/node-types'),
  materials: () => req<Material[]>('/api/materials'),
  models: () => req<ModelSummary[]>('/api/models'),
  createModel: (model_key: string, settings?: Json) => post<{ version_id: number }>('/api/models', { model_key, settings }),
  versions: (key: string) => req<VersionInfo[]>(`/api/models/${encodeURIComponent(key)}/versions`),
  graph: (id: number) => req<Graph>(`/api/versions/${id}`),
  saveGraph: (id: number, body: { nodes: GraphNode[]; edges: GraphEdge[]; settings?: Json }) =>
    req<void>(`/api/versions/${id}/graph`, { method: 'PUT', body: JSON.stringify(body) }),
  publish: (id: number) => post<{ status: string }>(`/api/versions/${id}/publish`),
  clone: (id: number) => post<{ version_id: number }>(`/api/versions/${id}/clone`),
  scenarios: (versionId: number) => req<Scenario[]>(`/api/versions/${versionId}/scenarios`),
  scenario: (id: number) => req<Scenario>(`/api/scenarios/${id}`),
  createScenario: (sc: NewScenario) => post<{ id: number }>('/api/scenarios', sc),
  startRun: (scenarioId: number, simStart?: string) =>
    post<{ run_id: number }>(`/api/scenarios/${scenarioId}/runs`, simStart ? { sim_start: simStart } : {}),
  runs: (scenarioId: number) => req<Run[]>(`/api/scenarios/${scenarioId}/runs`),
  run: (id: number) => req<RunDetail>(`/api/runs/${id}`),
  bands: (id: number, q: { subject?: string; metric?: string } = {}) => req<BandRow[]>(`/api/runs/${id}/bands${qs(q)}`),
  events: (id: number, q: { subject?: string; type?: string } = {}) => req<EventRow[]>(`/api/runs/${id}/events${qs(q)}`),
  signals: (id: number, q: { subject?: string; name?: string } = {}) => req<SignalRow[]>(`/api/runs/${id}/signals${qs(q)}`),
  applyInsight: (id: number, rank: number) => post<{ run_id: number }>(`/api/insights/${id}/apply`, { rank }),
  exportUrl: (id: number) => `${API_BASE}/api/runs/${id}/export.csv`,
}

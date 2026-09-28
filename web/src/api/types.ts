export type Archetype = 'SOURCE' | 'STORAGE' | 'PROCESS' | 'SINK' | 'RESOURCE_POOL'
export type Json = Record<string, unknown>

export type NodeType = {
  id: number
  code: string
  name: string
  archetype: Archetype
  param_schema: Json
  default_params: Json
  signals: Json[]
  failure_modes: Json[]
  ui: Json
  is_builtin: boolean
}

export type Material = { id: number; code: string; name: string; unit: string }
export type Pos = { x: number; y: number }

export type GraphNode = {
  key: string
  node_type: string
  archetype?: string
  name?: string
  params: Json
  canvas_pos?: Pos
}

export type GraphEdge = { key: string; src: string; dst: string; material: string; params: Json }

export type Graph = {
  version_id: number
  model_key: string
  version: number
  status: 'DRAFT' | 'PUBLISHED' | 'ARCHIVED'
  settings: Json
  nodes: GraphNode[]
  edges: GraphEdge[]
}

export type ModelSummary = { model_key: string; latest_version_id: number; latest_version: number; status: string }
export type VersionInfo = { id: number; version: number; status: string; created_at: string }

export type Scenario = {
  id: number
  model_version_id: number
  parent_id: number | null
  origin: string
  name: string
  horizon_s: number
  start_state: string
  overrides: Json[]
  injections: Json[]
  action: Json | null
  replications: number
  seed: number | null
  created_at: string
}

export type NewScenario = Pick<Scenario, 'model_version_id' | 'name' | 'horizon_s' | 'replications' | 'start_state' | 'overrides' | 'injections'>

export type RunStatus = 'QUEUED' | 'RUNNING' | 'DONE' | 'FAILED'

export type Run = {
  id: number
  scenario_id: number
  purpose: string
  status: RunStatus
  sim_start: string
  kpis: Json | null
  error: string | null
  engine_version: string | null
  created_at: string
  finished_at: string | null
}

export type Insight = {
  id: number
  sim_run_id: number | null
  kind: 'RED_RISK' | 'BOTTLENECK' | 'FAULT_RISK' | 'RECOMMENDATION'
  subject_key: string | null
  eta: string | null
  probability: number | null
  severity: number | null
  payload: Json
  status: string
  created_at: string
}

export type RunDetail = Run & { insights: Insight[] }
export type BandRow = { subject: string; metric: string; t: string; p10: number; p50: number; p90: number }
export type EventRow = { t: string; rep: number; subject: string; type: string; payload: Json }
export type SignalRow = { t: string; rep: number; subject: string; name: string; value: number }
export type Issue = { key: string; message: string }

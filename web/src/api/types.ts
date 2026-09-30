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
  used_in_versions?: number
}

export type Material = { id: number; code: string; name: string; unit: string; used_in_versions?: number }
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

export type ModelSummary = {
  model_key: string; latest_version_id: number; latest_version: number; status: string
  scenarios: number; runs: number; last_run_at: string | null
}
export type VersionInfo = { id: number; version: number; status: string; created_at: string; nodes: number; scenarios: number }

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
  kind: 'RED_RISK' | 'BOTTLENECK' | 'FAULT_RISK' | 'RECOMMENDATION' | 'DRIFT'
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

export type ScenarioRow = Scenario & { runs: number; last_run_status: RunStatus | null }

export type RunRow = {
  id: number
  scenario_id: number
  scenario_name: string
  model_key: string
  version_id: number
  version: number
  status: RunStatus
  purpose: string
  sim_start: string
  created_at: string
  finished_at: string | null
  red_minutes_p50: number | null
  error: string | null
}

export type InsightRow = Insight & { model_key: string; version: number; scenario_name: string }

export type VersionUse = { version_id: number; model_key: string; version: number; status: string; nodes: number }
export type NodeTypeDetail = NodeType & { usage: { versions: VersionUse[] } }

export type MaterialEdgeUse = { version_id: number; model_key: string; version: number; key: string; src: string; dst: string }
export type MaterialNodeUse = { version_id: number; model_key: string; version: number; key: string; node_type: string }
export type MaterialUsage = { edges: MaterialEdgeUse[]; nodes: MaterialNodeUse[]; node_types: string[] }
export type MaterialDetail = Material & { usage: MaterialUsage }

export type NewNodeType = {
  code: string; name: string; archetype: Archetype; default_params: Json; signals?: Json[]; failure_modes?: Json[]; ui?: Json
}
export type NewMaterial = { code: string; name: string; unit: string }
export type ScenarioBody = Pick<NewScenario, 'name' | 'horizon_s' | 'replications' | 'start_state' | 'injections' | 'overrides'>
export type NodeTypeUpdate = { name: string; default_params?: Json; signals?: Json[]; failure_modes?: Json[]; ui?: Json }
export type MaterialUpdate = { name: string; unit?: string }

// --- live twin: mapping dữ liệu realtime, trạng thái live, bản đồ AGV, feed demo ---
export type SignalDef = { name: string; label: string; kind: 'number' | 'text' | 'fleet' }
export type SubjectView = {
  subject: string
  kind: 'node' | 'edge'
  name: string
  node_type?: string
  archetype?: string
  material?: string
  mode?: string
  src?: string
  dst?: string
  signals: SignalDef[]
}
export type Subjects = { model: string; version_id: number; version: number; status: string; subjects: SubjectView[] }
export type Transform = { scale?: number; offset?: number; enum?: Record<string, string>; fields?: Record<string, string> }
export type Binding = {
  id: number; model_key: string; subject: string; signal: string; source: string; json_path: string; transform: Transform; enabled: boolean
}
export type BindingInput = { subject: string; signal: string; source: string; json_path: string; transform?: Transform; enabled?: boolean }

export type SigVal = { v: number; ts: string }
export type SubjectSnap = { state?: string; state_ts?: string; signals: Record<string, SigVal>; age_ms: number; rate?: number }
export type Vehicle = { id: string; x: number; y: number; state: string; lane: string; load: number; ts: string; age_ms: number }
export type SourceSnap = { source: string; desc: string; last_ts: string; age_ms: number; count: number; last: unknown; bound: boolean }
export type BindingError = { message: string; count: number; last: string }
export type LiveSnapshot = {
  model: string
  now: string
  subjects: Record<string, SubjectSnap>
  fleet: Record<string, Vehicle[]>
  sources: SourceSnap[]
  errors: BindingError[]
  bindings: number
}
export type LiveMsg = { type: 'live'; model: string; now: string; subjects: Record<string, SubjectSnap>; fleet: Record<string, Vehicle[]>; sources: number }

export type MapPoint = { id: string; x: number; y: number; kind: 'junction' | 'station' | 'charger'; node_key?: string }
export type MapLane = { id: string; from: string; to: string; capacity: number }
export type AgvMap = { unit_m: number; speed_mps: number; points: MapPoint[]; lanes: MapLane[] }

export type Incident = {
  id: number; kind: 'machine_down' | 'lane_block' | 'stock_drain'; target: string; started: string; until: string; active: boolean
  params: Json
}
export type FeedStatus = {
  state: 'idle' | 'running' | 'paused'
  model: string | null
  version_id: number | null
  speed: number
  virtual_now: string | null
  sent: number
  send_errors: number
  last_error: string | null
  truth: { cycle_factor: number; demand_factor: number } | null
  vehicles: number
  deadlock_breaks: number
  has_map: boolean
  incidents: Incident[]
}
export type IncidentInput = { kind: Incident['kind']; target: string; duration_s?: number; material?: string; fraction?: number }

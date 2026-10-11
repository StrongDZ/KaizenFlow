import type { Thresholds } from '../lib/replay'
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
export type Issue = { key: string; message: string; severity?: 'error' | 'warning'; code?: string }
export type CheckIssue = Issue
/** Thông số không đặt ở node nhưng có giá trị thay thế (mặc định loại node, mặc định ngầm của sim, hoặc gợi ý từ bản đồ AGV). */
export type CheckInferred = { key: string; param: string; value: string; source: 'node_type_default' | 'sim_default' | 'agv_map'; message: string }
export type CheckReport = { ok: boolean; issues: CheckIssue[]; inferred: CheckInferred[] }

export type ScenarioRow = Scenario & { runs: number; last_run_status: RunStatus | null }

export type RunRow = {
  id: number
  scenario_id: number
  scenario_name: string
  scenario_origin: 'USER' | 'RECOMMENDER' | 'NOWCAST'
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
/** Khung toạ độ của đội xe: từ toạ độ hãng xe báo sang toạ độ bản đồ (mét): lật Y → nhân scale → xoay → dịch. Cùng nghĩa với Frame của API. */
export type Frame = { dx: number; dy: number; rot_deg: number; scale: number; flip_y: boolean }
export type Transform = { scale?: number; offset?: number; enum?: Record<string, string>; fields?: Record<string, string>; frame?: Frame }
/** Công thức tự tính: cộng trừ các tín hiệu khác (có hệ số nhân), hoặc trạng thái máy suy từ việc một bộ đếm còn tăng. */
export type DeriveTerm = { subject: string; signal: string; sign: 1 | -1; factor?: number }
export type Derive = {
  kind: 'sum' | 'activity'; const?: number; terms?: DeriveTerm[]; watch?: { subject: string; signal: string }; idle_after_s?: number
  /** Số suy ra (chia đều, cân bằng kho) chứ không phải số đo. */
  estimate?: boolean
}
export type Binding = {
  id: number; model_key: string; subject: string; signal: string; source: string; json_path: string; transform: Transform; enabled: boolean
  mode: 'source' | 'derived'; derive?: Derive | null
}
export type BindingInput = {
  subject: string; signal: string; source?: string; json_path?: string; transform?: Transform; enabled?: boolean; mode?: 'source' | 'derived'; derive?: Derive
}

/** Độ phủ ghép nối (GET /api/models/{key}/live/check). */
export type CoverageStatus = 'source' | 'derived' | 'missing' | 'broken'
export type DeriveSuggestion = { derive: Derive; note: string }
/** Công thức tự tính `moved` cho một đường nối chưa có dữ liệu (GET /api/models/{key}/live/edge-plan). */
export type PlannedEdge = { subject: string; signal: string; derive: Derive; note: string; estimate: boolean }
export type SkippedEdge = { subject: string; signal: string; reason: string }
export type EdgePlan = { items: PlannedEdge[]; skipped: SkippedEdge[] }
export type SignalCoverage = {
  subject: string; signal: string; label: string; status: CoverageStatus; need: string[]; reason?: string; suggestions?: DeriveSuggestion[]
}
export type Readiness = { feature: string; ok: boolean; missing: { subject: string; signal: string }[] }
export type CoverageReport = {
  summary: { signals: number; source: number; derived: number; missing: number; broken: number }
  readiness: Readiness[]
  signals: SignalCoverage[]
  problems: { subject: string; signal: string; severity: string; message: string }[]
}

export type SigVal = { v: number; ts: string }
export type SubjectSnap = { state?: string; state_ts?: string; signals: Record<string, SigVal>; age_ms: number; rate?: number }
/** x, y: toạ độ bản đồ (mét) sau khi đổi khung; raw_x, raw_y: toạ độ hãng xe báo; s: mét dọc làn; off_map: xe không nằm trên làn nào. */
export type Vehicle = {
  id: string; x: number; y: number; raw_x: number; raw_y: number; heading?: number; state: string; lane: string; s: number; off_map: boolean
  load: number; ts: string; age_ms: number
  /** Chỉ có khi thiết bị báo (AMR): tốc độ m/s, phần trăm pin, điểm đích và các điểm còn phải qua. */
  speed?: number; battery?: number; dest?: string; route?: string[]
}
export type SourceSnap = { source: string; desc: string; last_ts: string; age_ms: number; count: number; last: unknown; bound: boolean }
/** Một nguồn dữ liệu đã đăng ký của mô hình (GET /api/models/{key}/sources). */
export type SourceBindingRef = { subject: string; signal: string }
export type DataSourceRow = {
  source: string; desc: string; origin: 'feed' | 'manual'; first_seen: string; last_seen: string; count: number
  sample: unknown; live: boolean; age_ms: number; per_min: number; bindings: SourceBindingRef[]
}
export type SourceTestResult = { matched: number; readings: { subject: string; signal: string; value?: number; text?: string }[]; errors: string[] }
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
export type Pt = { x: number; y: number }
/** path: các điểm uốn giữa hai đầu (không gồm hai đầu); bỏ trống là đoạn thẳng. */
export type MapLane = { id: string; from: string; to: string; capacity: number; path?: Pt[] }
/**
 * Ảnh mặt bằng làm nền: góc trên trái ảnh (khi chưa xoay) ở (x, y) mét, mỗi pixel ảnh là m_per_px mét, `rot` là góc xoay (độ, chiều kim
 * đồng hồ) quanh tâm ảnh. `rev` đổi mỗi lần tải ảnh mới (phá bộ nhớ đệm).
 */
export type MapBG = { x: number; y: number; m_per_px: number; w_px: number; h_px: number; rev?: number; calibrated?: boolean; rot?: number }
/** Vùng xe không được vào: đa giác khép kín từ 3 đỉnh (mét). */
export type MapKeepout = { id: string; poly: Pt[] }
/** Bản đồ v2: toạ độ tính bằng mét. */
export type AgvMap = { v?: number; speed_mps: number; bg?: MapBG; keepouts?: MapKeepout[]; points: MapPoint[]; lanes: MapLane[] }

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
  /** Hệ toạ độ hãng xe mà feed đang giả lập (null: phát thẳng toạ độ bản đồ). */
  frame: (Frame & { noise_m: number }) | null
  incidents: Incident[]
}
export type IncidentInput = { model: string; kind: Incident['kind']; target: string; duration_s?: number; material?: string; fraction?: number }

export type Calibration = {
  edge: string; name: string; material: string; n: number
  mean_s: number; sd_s: number; p50_s: number; p90_s: number
  current_mean_s: number; delta_pct: number; significant: boolean; suggested: Json
}
export type CalibrationResp = { min_trips: number; edges: Calibration[]; waiting: { edge: string; name: string; n: number }[] }
export type CalibrationApplied = { baseline_scenario_id: number; scenario_id: number; baseline_run_id: number; run_id: number; edges: number }

export type BenchmarkRating = 'TỐT' | 'CẦN CẢI THIỆN' | 'RỦI RO CAO'

export type WarehouseSeriesEntry = {
  ts_s: number
  sku: string
  node_key: string
  level: number
  capacity: number
  coverage_h: number
  color: string
  inbound_qty?: number
  outbound_qty?: number
}

export type WarehouseSkuRow = {
  sku: string
  max: number
  current: number
  coverageH?: number
  thresholds?: Thresholds
}

export type WarehouseAlertKind = 'OVERSTOCK' | 'UNDERSTOCK' | 'OVERLOAD_INBOUND' | 'OVERLOAD_DEMAND' | 'SLA_BREACH'
export type WarehouseAlertRow = {
  alert_id: string
  kind: WarehouseAlertKind
  sku?: string
  severity: 'HIGH' | 'MEDIUM' | 'LOW'
  title: string
  detail: string
  value_current: number
  value_threshold: number
  started_at: string
  acknowledged?: boolean
}
export type WarehouseEfficiencyRow = {
  window_days: number
  oee_pct: number
  accuracy_pct: number
  availability_pct: number
  avg_turnover_per_day: number
  avg_fill_rate_pct: number
}
export type WarehouseDashboardView = {
  node_key: string
  node_name: string
  model_key: string
  as_of: string
  hero: {
    on_hand_total: number
    capacity_total: number
    fill_pct: number
    coverage_remaining_h: number
    inbound_last_24h: number
    outbound_last_24h: number
    net_flow_last_24h: number
    high_alert_count: number
  }
  pipeline: WarehousePipelineView
  history_14d: WarehouseSeriesEntry[]
  efficiency: WarehouseEfficiencyRow
  alerts: WarehouseAlertRow[]
  sku_rows: WarehouseSkuRow[]
}

export type BenchmarkReport = {
  provider: string
  latency_ms: number
  records_per_s: number
  non_blocking_p95_ms: number
  rating: BenchmarkRating
  notes: string[]
}

export type Benchmark7DayResp = {
  run_id: number
  scenario_id?: number
  model_key: string
  version_id: number
  horizon_s: number
  step_s: number
  warmup_s: number
  replications: number
  benchmark_ready: boolean
  warehouse_series_log_summary: { count: number }
  warehouse_series_log?: WarehouseSeriesEntry[]
}

// -------- Dashboard hiệu năng tổng thể (OverviewPage) -----------------------------
// Hình dạng API sẽ trả về sau này (UI dùng mock shape tương thích).
// Backend chỉ cần implement 1 endpoint tương tự:
//     GET  /api/performance/kpis?window=14d&top_n=5
export type PerfSeriesPoint = { t: string; v: number }

export type PerfMachineRow = {
  key: string
  name: string
  node_type: string
  model_key: string
  /** OEE tổng hợp theo 14 ngày gần nhất (0-100%) */
  oee: number
  availability: number
  performance: number
  quality: number
  /** Năng suất TB / giờ */
  throughput_ph: number
  /** Thay đổi OEE so với 14 ngày trước (%), âm = cải thiện tốt hơn */
  wow_delta_oee: number
  /** 14 ngày OEE series (ngày cũ → mới, t = YYYY-MM-DD) */
  oee_series_14d: PerfSeriesPoint[]
  state: 'RUNNING' | 'IDLE' | 'BLOCKED' | 'DOWN' | 'UNKNOWN'
}

export type PerfFleetRow = {
  key: string
  name: string
  kind: 'AGV' | 'TUGGER' | 'FORKLIFT'
  model_key: string
  pallets_ph: number
  km_total_14d: number
  wait_pool_avg_min: number
  delivery_lateness_pct: number
  wow_delta_pallets: number
  series_14d: PerfSeriesPoint[]
  state: 'ACTIVE' | 'IDLE' | 'MAINTENANCE' | 'CHARGING' | 'UNKNOWN'
}

export type PerfStorageRow = {
  key: string
  name: string
  node_type: string
  model_key: string
  coverage_h_avg: number
  inbound_ph: number
  outbound_ph: number
  red_minutes_14d: number
  fill_pct_avg: number
  wow_delta_coverage: number
  coverage_series_14d: PerfSeriesPoint[]
  band_color: 'GREEN' | 'YELLOW' | 'RED'
}

export type PerformanceKpis = {
  as_of: string
  hero: {
    oee_avg_pct:    number; oee_wow_pct: number
    pallets_ph_avg: number; pallets_wow_pct: number
    coverage_h_avg: number; coverage_wow_pct: number
  }
  machines: PerfMachineRow[]
  fleet: PerfFleetRow[]
  storage: PerfStorageRow[]
  top_n: number
}

// -------- Warehouse Pipeline View (Demand / Inbound / Adequacy) --------------------
// Backend sau này implement (dữ liệu từ live.State RAM hoặc sim tally), trả về đúng shape
// → UI WarehousePopover & Sidebar tổng hợp kho tự động hoạt động không sửa 1 dòng.
export type InboundRow = {
  lot_id: string
  eta_ts: string
  qty: number
  sku: string
  source?: string
  status: 'IN_TRANSIT' | 'DOCKED' | 'BOOKED'
}
export type DemandRow = {
  order_id: string
  due_ts: string
  qty: number
  sku: string
  destination?: string
  priority: 'LOW' | 'NORMAL' | 'HIGH' | 'CRITICAL'
}
export type PipelinePoint = { t: string; on_hand: number; inbound: number; demand: number; net: number }
export type WarehouseAdequacy = 'ĐỦ HÀNG' | 'CẢNH BÁO' | 'THIẾU HÀNG'

export type WarehousePipelineView = {
  node_key: string
  horizon_h: number
  as_of: string
  totals: {
    on_hand_current: number
    inbound_total_horizon: number
    demand_total_horizon: number
    available_final: number
    shortage_qty: number
    coverage_remaining_h: number
  }
  adequacy: WarehouseAdequacy
  inbound: InboundRow[]
  demand: DemandRow[]
  timeline_h: PipelinePoint[]
}

// -------- Machine Pipeline View (Input / Running / Output) --------------------------
export type MachineInboundRow = {
  lot_id: string; eta_ts: string; qty: number; sku: string; from_node?: string
  status: 'TRANSFER' | 'WAIT_BUFFER' | 'ALLOCATED'
}
export type MachineBatchRow = {
  batch_id: string
  recipe_sku_in: string; qty_in: number
  recipe_sku_out: string; qty_out: number
  start_ts: string; end_ts: string
  progress_pct: number
  stage: 'QUEUED' | 'RUNNING' | 'FINALIZING'
}
export type MachineOutputRow = {
  lot_id: string; ready_ts: string; qty: number; sku: string; to_node?: string
  priority: 'LOW' | 'NORMAL' | 'HIGH' | 'URGENT'
}
export type MachineTimelinePoint = { t: string; inbound_load: number; run_capacity: number; output_load: number; queue_after: number }
export type MachineVerdict = 'ĐANG CHẠY' | 'CHỜ NGUYÊN LIỆU' | 'TẮC NGÕ RA' | 'LỖI'

export type MachinePipelineView = {
  node_key: string; horizon_h: number; as_of: string
  totals: {
    input_pending_qty: number; current_batch_pct: number; output_pending_qty: number
    oee_pct: number; batches_done_last_8h: number; batches_planned_next_8h: number
  }
  verdict: MachineVerdict
  input_pending: MachineInboundRow[]
  current_batch: MachineBatchRow | null
  output_upcoming: MachineOutputRow[]
  timeline_h: MachineTimelinePoint[]
  recipe?: ProcessRecipeContract
}

// -------- Process Recipe SSoT (Input Contract · Processing · Output Contract · Chain) ------
export type ProcessRecipeStage = { key: string; name: string; duration_pct: number }
export type ChainVerdict = 'ĐỒNG BỘ TỐT' | 'CÓ CHẶN' | 'ĐOẠN GÃY'

export type ProcessRecipeContract = {
  node_key: string
  recipe_code: string
  recipe_name: string

  input: {
    sku: string; sku_name: string
    from_node_key: string; from_node_name: string
    qty_per_cycle: number
    replenish_cycle_min: number
    uom: string
    current_coverage_h: number
  }
  processing: {
    cycle_time_min: number
    standard_yield_pct: number
    stages: ProcessRecipeStage[]
  }
  output: {
    sku: string; sku_name: string
    to_node_key: string; to_node_name: string
    qty_per_cycle: number
    loss_pct: number
    uom: string
    downstream_depot_node_key?: string
    downstream_depot_name?: string
  }

  full_chain: {
    upstream_nodes: { key: string; name: string; archetype: string; status: 'OK' | 'WARN' | 'BAD' }[]
    downstream_nodes: { key: string; name: string; archetype: string; status: 'OK' | 'WARN' | 'BAD' }[]
    chain_health_score: number
    chain_verdict: ChainVerdict
    chain_blockers: string[]
  }
}

// -------- Chain Summary Row (Sidebar Tab Dây chuyền vật tư) ----------------------------
export type ChainSummaryRow = {
  chain_id: string
  chain_name: string
  verdict: ChainVerdict
  upstream: { supplier_name: string; raw_sku: string; raw_qty_total: number }
  process: { node_key: string; node_name: string; machine_verdict: MachineVerdict; cycle_min: number; std_yield_pct: number }
  downstream: { fg_sku: string; fg_node_name: string; fg_coverage_h: number; depot_name: string; depot_backorder: number }
  chain_health_pct: number
}

// -------- Scenario Compare Before/After (Tab 6 Đánh giá Kịch bản) ----------------------
export type BeforeAfterHours = { before_h: number; after_h: number; delta_pct: number }

export type ScenarioCompareRow = {
  /** Scope: 'ALL' = tổng hệ thống / 'CHAIN_A' / 'CHAIN_B' / 'CHAIN_C' = từng dây */
  scope_id: string
  scope_name: string
  stockout: BeforeAfterHours
  overstock: BeforeAfterHours
  machine_downtime_h?: BeforeAfterHours
  order_fulfill_rate_pct?: BeforeAfterHours
  quick_rating: BenchmarkRating
  /** Explainer 1 dòng cho Hội đồng chấm */
  explainer: string
}
